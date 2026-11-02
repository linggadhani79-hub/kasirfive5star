import {
  $, $$, esc, api, rupiah, toast, modal, Realtime, setConn, LOGO_SVG, STATUS_LABEL, storage, requireLogin,
  productDialog, unitPrice, optionText, calcTotals, totalsRows, chime, speak, unlockAudio, callSentence, keepAwake, timeOf, registerSW,
} from '/js/common.js';

$('#logo').innerHTML = LOGO_SVG;
registerSW();
keepAwake();

const params = new URLSearchParams(location.search);
let code = params.get('t') || storage.get('f5_table');
let table, settings, menu = { categories: [], products: [] };
let cart = [];
let orderType = 'dine_in';
let myOrders = [];
let activeCat = 'all';

const CART_KEY = () => `f5_cart_${code}`;
const saveCart = () => storage.set(CART_KEY(), JSON.stringify(cart));

async function setupTable() {
  // Tablet belum diset ke meja tertentu: staf login lalu memilih meja.
  document.body.insertAdjacentHTML('beforeend', '<div class="empty" id="setup"><div class="big">🪑</div><h2>Tablet belum diatur ke meja</h2><p>Staf perlu login untuk memilih meja untuk tablet ini, atau pindai QR di meja.</p><button class="btn gold lg" id="do-setup">Atur Meja</button></div>');
  $('#layout').classList.add('hidden');
  $('#do-setup').onclick = async () => {
    $('#setup').remove();
    await requireLogin({ title: 'Atur Tablet Meja' });
    const tables = await api('/tables');
    const m = modal({
      title: 'Pilih meja untuk tablet ini',
      body: `<div class="grid-3">${tables.filter((t) => t.active).map((t) => `<button class="btn lg" data-code="${esc(t.code)}">${esc(t.name)}</button>`).join('')}</div>`,
    });
    m.el.addEventListener('click', (e) => {
      const b = e.target.closest('[data-code]');
      if (!b) return;
      storage.set('f5_table', b.dataset.code);
      storage.set('f5_mode', '/meja.html');
      location.href = '/meja.html';
    });
  };
}

async function init() {
  if (!code) return setupTable();
  try {
    [table, settings, menu] = await Promise.all([api(`/public/tables/${encodeURIComponent(code)}`), api('/public/settings'), api('/public/menu')]);
  } catch (e) {
    if (e.status === 404) {
      storage.set('f5_table', null);
      toast(e.message, 'bad', 6000);
      code = null;
      return setupTable();
    }
    toast(e.message, 'bad', 6000);
    return setTimeout(init, 5000);
  }
  if (params.get('t') && params.get('setmeja') === '1') storage.set('f5_table', code);
  document.title = `${table.name} — ${settings.store_name}`;
  $('#store').textContent = settings.store_name;
  $('#table-name').textContent = table.name;
  try {
    cart = JSON.parse(storage.get(CART_KEY()) || '[]');
  } catch {
    cart = [];
  }
  cart = cart.filter((c) => menu.products.some((p) => p.id === c.product_id));
  renderMenu();
  renderCart();
  loadOrders();

  const rt = new Realtime({ table: code });
  rt.onstatus = (on) => setConn($('#conn'), on);
  rt.on('open', loadOrders);
  rt.on('order:update', (o) => {
    const i = myOrders.findIndex((x) => x.id === o.id);
    if (i >= 0) myOrders[i] = o;
    else myOrders.unshift(o);
    renderOrdersCount();
    if ($('#orders-modal')) showOrders();
  });
  rt.on('queue:announce', (a) => readyAlert(a));
  rt.on('menu:changed', async () => {
    menu = await api('/public/menu');
    renderMenu();
    renderCart();
  });
  rt.on('settings:changed', (s) => {
    settings = s;
    renderCart();
  });
}

// ---------- Menu ----------
function renderMenu() {
  const q = $('#search').value.trim().toLowerCase();
  const cats = [{ id: 'all', name: 'Semua', icon: '✨' }, ...menu.categories];
  $('#cats').innerHTML = cats.map((c) => `<button class="tab ${activeCat == c.id ? 'active' : ''}" data-cat="${c.id}">${esc(c.icon || '')} ${esc(c.name)}</button>`).join('');
  const groups = menu.categories.map((c) => ({ ...c, items: menu.products.filter((p) => p.category_id === c.id) }));
  const orphans = menu.products.filter((p) => !menu.categories.some((c) => c.id === p.category_id));
  if (orphans.length) groups.push({ id: 'other', name: 'Lainnya', icon: '•', items: orphans });
  const inCart = (id) => cart.filter((c) => c.product_id === id).reduce((a, b) => a + b.qty, 0);
  const html = groups
    .filter((g) => activeCat === 'all' || g.id == activeCat)
    .map((g) => ({ ...g, items: g.items.filter((p) => !q || p.name.toLowerCase().includes(q) || (p.description || '').toLowerCase().includes(q)) }))
    .filter((g) => g.items.length)
    .map(
      (g) => `<h2 class="cat-title">${esc(g.icon || '')} ${esc(g.name)}</h2>
      <div class="product-grid">${g.items
        .map(
          (p) => `<button class="product ${p.available ? '' : 'soldout'}" data-id="${p.id}">
            ${inCart(p.id) ? `<span class="qty-pill">${inCart(p.id)}</span>` : ''}
            <div class="thumb">${p.image ? `<img src="${esc(p.image)}" alt="" loading="lazy">` : esc(g.icon || '☕')}</div>
            <div class="body"><span class="name">${esc(p.name)}</span><span class="desc">${esc(p.description || '')}</span><span class="price">${rupiah(p.price)}</span></div>
          </button>`
        )
        .join('')}</div>`
    )
    .join('');
  $('#menu').innerHTML = html || '<div class="empty"><div class="big">🔍</div>Menu tidak ditemukan</div>';
}

$('#cats').addEventListener('click', (e) => {
  const b = e.target.closest('[data-cat]');
  if (!b) return;
  activeCat = b.dataset.cat === 'all' ? 'all' : Number(b.dataset.cat) || b.dataset.cat;
  renderMenu();
  $('#menu-pane').scrollTo({ top: 0, behavior: 'smooth' });
});
$('#search').addEventListener('input', renderMenu);
$('#menu').addEventListener('click', async (e) => {
  const b = e.target.closest('.product');
  if (!b) return;
  unlockAudio();
  const p = menu.products.find((x) => x.id === Number(b.dataset.id));
  const r = p.options.length ? await productDialog(p) : { options: {}, qty: 1, note: '' };
  if (!r) return;
  const key = JSON.stringify([p.id, r.options, r.note]);
  const same = cart.find((c) => c.key === key);
  if (same) same.qty = Math.min(99, same.qty + r.qty);
  else cart.push({ key, product_id: p.id, options: r.options, note: r.note, qty: r.qty });
  saveCart();
  renderCart();
  renderMenu();
  toast(`${p.name} ditambahkan`, 'ok', 1400);
});

// ---------- Keranjang ----------
function totals() {
  const sub = cart.reduce((a, c) => {
    const p = menu.products.find((x) => x.id === c.product_id);
    return a + (p ? unitPrice(p, c.options) * c.qty : 0);
  }, 0);
  return { sub, ...calcTotals(sub, orderType, settings) };
}

function renderCart() {
  const t = totals();
  const count = cart.reduce((a, b) => a + b.qty, 0);
  $('#cart-items').innerHTML = cart.length
    ? cart
        .map((c, i) => {
          const p = menu.products.find((x) => x.id === c.product_id);
          return `<div class="cart-item"><div class="grow"><div class="nm">${esc(p.name)}</div>
            ${optionText(c.options) ? `<div class="small muted">${esc(optionText(c.options))}</div>` : ''}
            ${c.note ? `<div class="small muted">📝 ${esc(c.note)}</div>` : ''}
            <div class="small" style="font-weight:700;margin-top:4px">${rupiah(unitPrice(p, c.options) * c.qty)}</div></div>
            <div class="stepper sm"><button data-dec="${i}">−</button><span>${c.qty}</span><button data-inc="${i}">+</button></div></div>`;
        })
        .join('')
    : '<div class="empty"><div class="big">🛒</div>Belum ada pesanan.<br>Pilih menu di sebelah kiri.</div>';
  $('#totals').innerHTML = `
    <div class="tot"><span>Subtotal</span><span>${rupiah(t.sub)}</span></div>
    ${totalsRows(t, settings?.tax_inclusive, settings?.tax_percent)}
    <div class="tot big"><span>Total</span><span>${rupiah(t.total)}</span></div>`;
  $('#btn-submit').disabled = !cart.length;
  $('#cart-bar-text').textContent = count ? `🛒 ${count} item — lihat keranjang` : 'Keranjang kosong';
  $('#cart-bar-total').textContent = count ? rupiah(t.total) : '';
}

$('#cart-items').addEventListener('click', (e) => {
  const inc = e.target.closest('[data-inc]');
  const dec = e.target.closest('[data-dec]');
  if (inc) cart[inc.dataset.inc].qty = Math.min(99, cart[inc.dataset.inc].qty + 1);
  if (dec) {
    const c = cart[dec.dataset.dec];
    c.qty -= 1;
    if (c.qty <= 0) cart.splice(dec.dataset.dec, 1);
  }
  if (inc || dec) {
    saveCart();
    renderCart();
    renderMenu();
  }
});
$('#cart-clear').onclick = () => {
  cart = [];
  saveCart();
  renderCart();
  renderMenu();
};
$('#otype').addEventListener('click', (e) => {
  const b = e.target.closest('[data-v]');
  if (!b) return;
  orderType = b.dataset.v;
  $$('#otype button').forEach((x) => x.classList.toggle('on', x === b));
  renderCart();
});
$('#cart-bar').onclick = () => $('#cart').classList.add('open');
$('#cart-close').onclick = () => $('#cart').classList.remove('open');

$('#btn-submit').onclick = async () => {
  const name = $('#cust-name').value.trim();
  if (!name) {
    toast('Isi nama Anda agar mudah dipanggil 😊', 'bad');
    return $('#cust-name').focus();
  }
  const btn = $('#btn-submit');
  btn.disabled = true;
  btn.textContent = 'Mengirim…';
  try {
    const o = await api(`/public/tables/${encodeURIComponent(code)}/orders`, {
      method: 'POST',
      body: {
        customer_name: name,
        note: $('#order-note').value.trim(),
        order_type: orderType,
        items: cart.map((c) => ({ product_id: c.product_id, qty: c.qty, options: c.options, note: c.note })),
      },
    });
    cart = [];
    saveCart();
    $('#order-note').value = '';
    $('#cart').classList.remove('open');
    renderCart();
    renderMenu();
    if (!myOrders.some((x) => x.id === o.id)) myOrders.unshift(o);
    renderOrdersCount();
    chime({ notes: [880, 1175], volume: 0.2 });
    modal({
      title: 'Pesanan terkirim! 🎉',
      body: `<div style="text-align:center"><div class="muted">Nomor antrean Anda</div>
        <div style="font-size:72px;font-weight:900;color:var(--brand-2);line-height:1.1">${esc(o.queue_label)}</div>
        <p>${o.status === 'pending' ? 'Pesanan menunggu konfirmasi kasir.' : 'Pesanan sedang dibuat.'}<br>
        ${settings.require_payment_first ? '<b>Silakan lakukan pembayaran di kasir.</b><br>' : ''}
        Nomor Anda akan dipanggil lewat suara saat pesanan siap.</p>
        <div class="tot big"><span>Total</span><span>${rupiah(o.total)}</span></div></div>`,
      foot: '<button class="btn gold lg block" data-close>Oke</button>',
    });
  } catch (e) {
    toast(e.message, 'bad', 5000);
  } finally {
    btn.disabled = !cart.length;
    btn.textContent = 'Pesan Sekarang';
  }
};

// ---------- Pesanan saya ----------
async function loadOrders() {
  try {
    myOrders = await api(`/public/tables/${encodeURIComponent(code)}/orders`);
    renderOrdersCount();
  } catch {
    /* coba lagi saat tersambung */
  }
}
function renderOrdersCount() {
  const active = myOrders.filter((o) => ['pending', 'preparing', 'ready'].includes(o.status)).length;
  $('#orders-count').textContent = active ? `(${active})` : '';
}
function showOrders() {
  const step = { pending: 1, preparing: 2, ready: 3, done: 4 };
  const body = myOrders.length
    ? myOrders
        .map(
          (o) => `<div class="card order-card"><div class="row"><span class="q">${esc(o.queue_label)}</span><span class="grow">${esc(o.customer_name || '')}<div class="small muted">${timeOf(o.created_at)} · ${o.order_type === 'takeaway' ? 'Bawa pulang' : 'Makan di sini'}</div></span>
          <span class="badge ${o.status}">${STATUS_LABEL[o.status]}</span></div>
          <div class="steps">${[1, 2, 3, 4].map((s) => `<i class="${(step[o.status] || 0) >= s ? 'on' : ''}"></i>`).join('')}</div>
          <div class="small">${o.items.map((i) => `${i.qty}× ${esc(i.name)}${i.options?.length ? ` <span class="muted">(${esc(i.options.map((x) => x.name).join(', '))})</span>` : ''}`).join('<br>')}</div>
          <div class="row"><span class="badge ${o.payment_status}">${o.payment_status === 'paid' ? 'Lunas' : 'Belum bayar'}</span><span class="grow"></span><b>${rupiah(o.total)}</b></div></div>`
        )
        .join('')
    : '<div class="empty"><div class="big">🧾</div>Belum ada pesanan hari ini dari meja ini.</div>';
  const existing = $('#orders-modal');
  if (existing) return (existing.querySelector('.modal-body').innerHTML = body);
  const m = modal({ title: `Pesanan ${esc(table.name)}`, body });
  m.el.id = 'orders-modal';
}
$('#btn-orders').onclick = () => {
  unlockAudio();
  loadOrders().then(showOrders);
};

$('#btn-waiter').onclick = async () => {
  unlockAudio();
  const m = modal({
    title: 'Panggil pelayan',
    body: `<div class="grid-2">${['Minta bill / bayar', 'Tambah pesanan', 'Minta alat makan', 'Butuh bantuan'].map((r) => `<button class="btn lg" data-r="${r}">${r}</button>`).join('')}</div>`,
  });
  m.el.addEventListener('click', async (e) => {
    const b = e.target.closest('[data-r]');
    if (!b) return;
    m.close();
    try {
      await api(`/public/tables/${encodeURIComponent(code)}/call-waiter`, { method: 'POST', body: { reason: b.dataset.r } });
      toast('Pelayan sudah dipanggil, mohon tunggu sebentar 🙏', 'ok');
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
};

// Notifikasi pesanan siap di tablet meja
let alertTimer;
async function readyAlert(a) {
  $('.ready-alert')?.remove();
  clearTimeout(alertTimer);
  const el = document.createElement('div');
  el.className = 'ready-alert';
  el.innerHTML = `<div class="box"><div style="font-size:22px;font-weight:700">Pesanan Anda sudah siap! ☕</div><div class="no">${esc(a.queue_label)}</div>
    <div style="font-size:20px">${esc(a.customer_name || '')}</div><p>${a.order_type === 'takeaway' ? 'Silakan ambil di kasir.' : 'Silakan ambil di counter atau tunggu diantar.'}</p>
    <button class="btn lg" style="margin-top:10px">Oke</button></div>`;
  el.onclick = () => el.remove();
  document.body.append(el);
  alertTimer = setTimeout(() => el.remove(), 20000);
  await chime();
  speak(callSentence(a, settings), { rate: settings.voice_rate });
}

document.addEventListener('pointerdown', unlockAudio, { once: true });
init();
