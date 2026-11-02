import {
  $, $$, esc, api, rupiah, num, toast, modal, confirmBox, Realtime, setConn, LOGO_SVG, STATUS_LABEL, requireLogin, logout,
  productDialog, unitPrice, optionText, calcTotals, totalsRows, chime, unlockAudio, printReceipt, timeOf, keepAwake, minutesSince,
} from '/js/common.js';

$('#logo').innerHTML = LOGO_SVG;
keepAwake();

let user, settings;
let orders = [];
let menu = { categories: [], products: [] };
let tables = [];
let view = 'orders';
let filter = 'pending';
let selectedId = null;
let lowStock = [];

// ---------- Navigasi ----------
$('#side').addEventListener('click', (e) => {
  const b = e.target.closest('[data-view]');
  if (!b) return;
  view = b.dataset.view;
  $$('#side button').forEach((x) => x.classList.toggle('active', x === b));
  render();
});
$('#btn-logout').onclick = logout;

function render() {
  ({ orders: renderOrders, pos: renderPos, stock: renderStock, cash: renderCash, report: renderReport })[view]();
}

// ---------- Pesanan ----------
const FILTERS = [
  ['pending', 'Baru', (o) => o.status === 'pending'],
  ['preparing', 'Dibuat', (o) => o.status === 'preparing'],
  ['ready', 'Siap', (o) => o.status === 'ready'],
  ['unpaid', 'Belum bayar', (o) => o.payment_status === 'unpaid' && o.status !== 'cancelled'],
  ['all', 'Semua', () => true],
];

function updateBadges() {
  const n = orders.filter((o) => o.status === 'pending').length;
  $('#dot-orders').textContent = n;
  $('#dot-orders').classList.toggle('hidden', !n);
  $('#dot-stock').textContent = lowStock.length;
  $('#dot-stock').classList.toggle('hidden', !lowStock.length);
}

function renderOrders() {
  updateBadges();
  const fn = FILTERS.find((f) => f[0] === filter)[2];
  const list = orders.filter(fn);
  const sel = orders.find((o) => o.id === selectedId);
  $('#view').innerHTML = `<div class="split">
    <section class="pane">
      <div class="tabs">${FILTERS.map(([k, label, f]) => `<button class="tab ${filter === k ? 'active' : ''}" data-filter="${k}">${label}${k !== 'all' && orders.filter(f).length ? `<span class="count">${orders.filter(f).length}</span>` : ''}</button>`).join('')}</div>
      <div class="olist">${list
        .map(
          (o) => `<button class="orow ${o.id === selectedId ? 'sel' : ''}" data-oid="${o.id}"><span class="q">${esc(o.queue_label)}</span>
          <span class="grow"><b>${esc(o.customer_name || '-')}</b><div class="small muted">${esc(o.table_name || (o.source === 'kasir' ? 'Kasir' : ''))} · ${timeOf(o.created_at)} · ${o.items.reduce((a, b) => a + b.qty, 0)} item</div></span>
          <span class="stack" style="align-items:flex-end;gap:4px"><span class="badge ${o.status}">${STATUS_LABEL[o.status]}</span><span class="badge ${o.payment_status}">${o.payment_status === 'paid' ? 'Lunas' : rupiah(o.total)}</span>${o.payment_status !== 'paid' && o.payment_request === 'QRIS_CLAIMED' ? '<span class="badge pending">📱 Cek QRIS</span>' : o.payment_status !== 'paid' && o.payment_request === 'QRIS' ? '<span class="badge">📱 QRIS</span>' : ''}</span></button>`
        )
        .join('') || '<div class="empty"><div class="big">☕</div>Tidak ada pesanan</div>'}</div>
    </section>
    <section class="pane" id="detail">${sel ? detailHtml(sel) : '<div class="empty"><div class="big">👈</div>Pilih pesanan untuk melihat detail</div>'}</section>
  </div>`;
}

function detailHtml(o) {
  const can = (s) => !['done', 'cancelled'].includes(o.status) && s;
  return `<div class="stack" style="gap:14px">
    <div class="row wrap"><h2 style="font-size:34px">${esc(o.queue_label)}</h2><span class="badge ${o.status}">${STATUS_LABEL[o.status]}</span><span class="badge ${o.payment_status}">${o.payment_status === 'paid' ? 'Lunas · ' + esc(o.payment_method) : 'Belum bayar'}</span></div>
    <div class="grid-3 small">
      <div><div class="muted">Pelanggan</div><b>${esc(o.customer_name || '-')}</b></div>
      <div><div class="muted">Meja / Tipe</div><b>${esc(o.table_name || '-')}</b> · ${o.order_type === 'takeaway' ? 'Bawa pulang' : 'Di tempat'}</div>
      <div><div class="muted">Masuk</div><b>${timeOf(o.created_at)}</b> (${minutesSince(o.created_at)} mnt lalu)</div>
    </div>
    ${o.note ? `<div class="card pad small" style="background:var(--warn-soft)">📝 ${esc(o.note)}</div>` : ''}
    <div class="card"><table class="tbl items-tbl"><tbody>${o.items
      .map((i) => `<tr><td style="width:44px"><b>${i.qty}×</b></td><td>${esc(i.name)}${i.options?.length ? `<div class="small muted">${esc(i.options.map((x) => x.name).join(', '))}</div>` : ''}${i.note ? `<div class="small muted">📝 ${esc(i.note)}</div>` : ''}</td><td class="num">${rupiah(i.line_total)}</td></tr>`)
      .join('')}</tbody></table>
      <div style="padding:10px 12px" class="stack">
        <div class="tot"><span>Subtotal</span><span>${rupiah(o.subtotal)}</span></div>
        ${o.discount ? `<div class="tot"><span>Diskon</span><span>-${rupiah(o.discount)}</span></div>` : ''}
        ${(o.fees?.length ? o.fees : o.service ? [{ name: 'Biaya tambahan', amount: o.service }] : []).map((f) => `<div class="tot"><span>${esc(f.name)}</span><span>${rupiah(f.amount)}</span></div>`).join('')}
        ${o.tax ? `<div class="tot muted"><span>${o.tax_inclusive ? 'Termasuk PPN' : 'PPN'}</span><span>${rupiah(o.tax)}</span></div>` : ''}
        <div class="tot big"><span>Total</span><span>${rupiah(o.total)}</span></div>
        ${o.payment_status === 'paid' ? `<div class="tot small muted"><span>Dibayar ${esc(o.payment_method)}</span><span>${rupiah(o.paid_amount)} · kembali ${rupiah(o.change_amount)}</span></div>` : ''}
      </div></div>
    ${o.payment_status === 'unpaid' && o.status !== 'cancelled' && o.payment_request ? `<div class="card pad stack" style="background:${o.payment_request === 'QRIS_CLAIMED' ? 'var(--warn-soft)' : 'var(--info-soft)'}">
      <b>${o.payment_request === 'QRIS_CLAIMED' ? '📱 Pelanggan menyatakan SUDAH membayar QRIS' : '📱 Pelanggan memilih bayar QRIS'} — ${rupiah(o.total)}</b>
      <span class="small">Cek notifikasi / mutasi di aplikasi QRIS merchant (nominal ${rupiah(o.total)}). Jika dana sudah masuk, tekan tombol di bawah — pesanan otomatis lunas & masuk antrean dapur.</span>
      <div class="row wrap"><button class="btn ok lg" data-act="qrisok">✅ QRIS sudah masuk</button><button class="btn" data-act="showqris">Tampilkan QRIS</button></div></div>` : ''}
    <div class="detail-actions">
      ${o.status === 'pending' ? `<button class="btn ok lg" data-act="preparing">✅ Terima → Barista</button>` : ''}
      ${o.status === 'preparing' ? `<button class="btn ok lg" data-act="ready">🔔 Tandai Siap & Panggil</button>` : ''}
      ${o.status === 'ready' ? `<button class="btn lg" data-act="call">🔊 Panggil Ulang</button><button class="btn primary lg" data-act="done">✔ Sudah Diambil</button>` : ''}
      ${o.payment_status === 'unpaid' && o.status !== 'cancelled' ? `<button class="btn gold lg" data-act="pay">💳 Bayar ${rupiah(o.total)}</button>` : ''}
      ${o.payment_status === 'unpaid' && o.status !== 'cancelled' && settings.qris_enabled && !o.payment_request ? `<button class="btn lg" data-act="showqris">📱 Tampilkan QRIS</button>` : ''}
      <button class="btn lg" data-act="print">🖨️ Cetak Struk</button>
      ${can(true) ? `<button class="btn outline-bad lg" data-act="cancel">✕ Batalkan</button>` : ''}
    </div>
    ${o.status === 'cancelled' && o.cancel_reason ? `<p class="small muted">Alasan batal: ${esc(o.cancel_reason)}</p>` : ''}
  </div>`;
}

$('#view').addEventListener('click', async (e) => {
  if (view !== 'orders') return;
  const f = e.target.closest('[data-filter]');
  if (f) {
    filter = f.dataset.filter;
    return renderOrders();
  }
  const r = e.target.closest('[data-oid]');
  if (r) {
    selectedId = Number(r.dataset.oid);
    return renderOrders();
  }
  const a = e.target.closest('[data-act]');
  if (!a) return;
  const o = orders.find((x) => x.id === selectedId);
  if (!o) return;
  const act = a.dataset.act;
  try {
    if (act === 'pay') return payDialog(o);
    if (act === 'showqris') return showQris(`/orders/${o.id}/qris`, o.queue_label);
    if (act === 'qrisok') {
      if (!(await confirmBox(`Pastikan dana ${rupiah(o.total)} sudah masuk di aplikasi QRIS. Tandai lunas & kirim ke dapur?`, { ok: 'Ya, sudah masuk' }))) return;
      const paid = await api(`/orders/${o.id}/pay`, { method: 'POST', body: { method: qrisMethod() } });
      upsert(paid);
      render();
      return toast(`${paid.queue_label} lunas via QRIS — masuk antrean dapur`, 'ok', 4000);
    }
    if (act === 'print') return printReceipt(o, settings);
    if (act === 'call') {
      await api(`/orders/${o.id}/call`, { method: 'POST' });
      return toast('Dipanggil ulang di monitor 🔊', 'ok');
    }
    if (act === 'cancel') {
      const m = modal({
        title: `Batalkan ${esc(o.queue_label)}?`,
        body: '<label class="field"><span>Alasan</span><input class="input" data-reason placeholder="mis. pelanggan batal, salah input"></label><p class="small muted" style="margin:0">Stok bahan yang sudah terpakai akan dikembalikan.</p>',
        foot: '<button class="btn" data-close>Tidak</button><button class="btn bad" data-ok>Batalkan Pesanan</button>',
      });
      m.$('[data-ok]').onclick = async () => {
        try {
          upsert(await api(`/orders/${o.id}/status`, { method: 'POST', body: { status: 'cancelled', reason: m.$('[data-reason]').value } }));
          m.close();
          render();
        } catch (err) {
          toast(err.message, 'bad');
        }
      };
      return;
    }
    if (settings.require_payment_first && act === 'preparing' && o.payment_status !== 'paid') {
      if (!(await confirmBox('Pesanan belum dibayar. Tetap kirim ke barista?', { ok: 'Kirim' }))) return;
    }
    upsert(await api(`/orders/${o.id}/status`, { method: 'POST', body: { status: act } }));
    if (act === 'ready') toast('Pesanan dipanggil di monitor antrean 🔊', 'ok');
    render();
  } catch (err) {
    toast(err.message, 'bad');
  }
});

function upsert(o) {
  const i = orders.findIndex((x) => x.id === o.id);
  if (i >= 0) orders[i] = o;
  else orders.unshift(o);
}

// ---------- QRIS ----------
const qrisMethod = () => settings.payment_methods.find((m) => /qris/i.test(m)) || 'QRIS';
async function showQris(path, label = '') {
  try {
    const q = await api(path);
    modal({
      title: `QRIS ${esc(label)}`,
      body: `<div style="text-align:center" class="stack"><div style="display:flex;justify-content:center">${q.svg.replace('<svg', '<svg style="width:300px;height:300px;background:#fff;border-radius:12px"')}</div>
        <div style="font-size:32px;font-weight:900">${rupiah(q.amount)}</div><div class="small muted">a.n. ${esc(q.merchant_name)} · nominal terisi otomatis</div></div>`,
    });
  } catch (err) {
    toast(err.message, 'bad');
  }
}
function claimPopup(c) {
  const el = document.createElement('div');
  el.className = 'waiter';
  el.style.background = 'var(--ok)';
  el.style.color = '#fff';
  el.innerHTML = `<span style="font-size:26px">📱</span><div><div>${esc(c.queue_label)} · ${esc(c.table_name || '')} sudah bayar QRIS</div><div class="small">${esc(c.customer_name || '')} · ${rupiah(c.total)} — cek & konfirmasi</div></div><button class="btn sm">Lihat</button>`;
  el.querySelector('button').onclick = () => {
    el.remove();
    view = 'orders';
    selectedId = c.id;
    filter = 'unpaid';
    $$('#side button').forEach((x) => x.classList.toggle('active', x.dataset.view === 'orders'));
    render();
  };
  document.body.append(el);
  setTimeout(() => el.remove(), 120000);
}

// ---------- Pembayaran ----------
function payDialog(o, { onPaid } = {}) {
  let method = settings.payment_methods[0];
  const quick = [...new Set([o.total, Math.ceil(o.total / 10000) * 10000, Math.ceil(o.total / 50000) * 50000, Math.ceil(o.total / 100000) * 100000, 50000, 100000].filter((x) => x >= o.total))]
    .sort((a, b) => a - b)
    .slice(0, 6);
  const m = modal({
    title: `Pembayaran ${esc(o.queue_label || '')}`,
    body: `<div class="tot big"><span>Total tagihan</span><span>${rupiah(o.total)}</span></div>
      <div class="methods">${settings.payment_methods.map((pm) => `<button class="btn ${pm === method ? 'on' : ''}" data-m="${esc(pm)}">${esc(pm)}</button>`).join('')}</div>
      <div data-cash class="stack">
        <label class="field"><span>Uang diterima</span><input class="input num" data-paid inputmode="numeric" style="font-size:24px;font-weight:800" value="${o.total}"></label>
        <div class="cash-grid">${quick.map((q) => `<button class="btn" data-q="${q}">${q === o.total ? 'Uang pas' : rupiah(q)}</button>`).join('')}</div>
        <div class="tot big"><span>Kembalian</span><span data-change>Rp0</span></div>
      </div>
      <div data-qris class="hidden" style="text-align:center"></div>`,
    foot: '<button class="btn" data-close>Batal</button><button class="btn gold lg" data-ok>Konfirmasi Bayar</button>',
  });
  const paidVal = () => Number(m.$('[data-paid]').value.replace(/\D/g, '')) || 0;
  const draw = () => {
    m.$$('[data-m]').forEach((b) => b.classList.toggle('on', b.dataset.m === method));
    m.$('[data-cash]').classList.toggle('hidden', method !== 'Tunai');
    const isQris = /qris/i.test(method) && settings.qris_enabled;
    m.$('[data-qris]').classList.toggle('hidden', !isQris);
    if (isQris && !m.$('[data-qris]').dataset.loaded) {
      m.$('[data-qris]').dataset.loaded = '1';
      m.$('[data-qris]').innerHTML = '<div class="muted small">Memuat QRIS…</div>';
      api(`/qris?amount=${o.total}`)
        .then((q) => (m.$('[data-qris]').innerHTML = `<div style="display:flex;justify-content:center">${q.svg.replace('<svg', '<svg style="width:240px;height:240px;background:#fff;border-radius:12px"')}</div><div class="small muted">Minta pelanggan scan · a.n. ${esc(q.merchant_name)} · konfirmasi setelah dana masuk</div>`))
        .catch((err) => (m.$('[data-qris]').innerHTML = `<div class="small" style="color:var(--bad)">${esc(err.message)}</div>`));
    }
    const ch = paidVal() - o.total;
    m.$('[data-change]').textContent = ch >= 0 ? rupiah(ch) : 'Kurang ' + rupiah(-ch);
  };
  m.el.addEventListener('click', (e) => {
    const b = e.target.closest('[data-m]');
    if (b) (method = b.dataset.m), draw();
    const q = e.target.closest('[data-q]');
    if (q) (m.$('[data-paid]').value = q.dataset.q), draw();
  });
  m.$('[data-paid]').addEventListener('input', draw);
  m.$('[data-ok]').onclick = async () => {
    try {
      const body = { method, paid_amount: method === 'Tunai' ? paidVal() : o.total };
      const paid = onPaid ? await onPaid(body) : await api(`/orders/${o.id}/pay`, { method: 'POST', body });
      upsert(paid);
      m.close();
      render();
      toast(`Pembayaran berhasil${paid.change_amount ? ' · Kembalian ' + rupiah(paid.change_amount) : ''}`, 'ok', 5000);
      if (await confirmBox('Cetak struk sekarang?', { ok: 'Cetak' })) printReceipt(paid, settings);
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
  draw();
}

// ---------- POS (order dari kasir) ----------
let posCart = [];
let posCat = 'all';
const pos = { table_id: '', customer_name: '', order_type: 'dine_in', discount: 0, note: '' };

function posTotals() {
  const sub = posCart.reduce((a, c) => a + unitPrice(menu.products.find((p) => p.id === c.product_id), c.options) * c.qty, 0);
  const disc = Math.min(sub, Number(pos.discount) || 0);
  return { sub, disc, ...calcTotals(sub - disc, pos.order_type, settings) };
}

function renderPos() {
  const t = posTotals();
  const prods = menu.products.filter((p) => posCat === 'all' || p.category_id === posCat);
  $('#view').innerHTML = `<div class="pos">
    <section class="menu">
      <div class="tabs" style="margin-bottom:12px"><button class="tab ${posCat === 'all' ? 'active' : ''}" data-cat="all">Semua</button>${menu.categories.map((c) => `<button class="tab ${posCat === c.id ? 'active' : ''}" data-cat="${c.id}">${esc(c.icon)} ${esc(c.name)}</button>`).join('')}</div>
      <div class="product-grid">${prods
        .map((p) => `<button class="product ${p.available ? '' : 'soldout'}" data-pid="${p.id}"><div class="thumb" style="aspect-ratio:16/9;font-size:30px">${p.image ? `<img src="${esc(p.image)}" alt="">` : esc(menu.categories.find((c) => c.id === p.category_id)?.icon || '☕')}</div><div class="body"><span class="name">${esc(p.name)}</span><span class="price">${rupiah(p.price)}</span></div></button>`)
        .join('')}</div>
    </section>
    <aside class="cart">
      <div class="cart-items">${posCart
        .map((c, i) => {
          const p = menu.products.find((x) => x.id === c.product_id);
          return `<div class="ci"><div class="grow"><b>${esc(p.name)}</b>${optionText(c.options) ? `<div class="small muted">${esc(optionText(c.options))}</div>` : ''}${c.note ? `<div class="small muted">📝 ${esc(c.note)}</div>` : ''}<div class="small">${rupiah(unitPrice(p, c.options) * c.qty)}</div></div>
            <div class="stepper sm"><button data-dec="${i}">−</button><span>${c.qty}</span><button data-inc="${i}">+</button></div></div>`;
        })
        .join('') || '<div class="empty"><div class="big">🛒</div>Ketuk menu untuk menambah</div>'}</div>
      <div class="cart-foot">
        <div class="grid-2">
          <select class="input" data-f="table_id"><option value="">Tanpa meja</option>${tables.filter((x) => x.active).map((x) => `<option value="${x.id}" ${String(pos.table_id) === String(x.id) ? 'selected' : ''}>${esc(x.name)}</option>`).join('')}</select>
          <select class="input" data-f="order_type"><option value="dine_in" ${pos.order_type === 'dine_in' ? 'selected' : ''}>Di tempat</option><option value="takeaway" ${pos.order_type === 'takeaway' ? 'selected' : ''}>Bawa pulang</option></select>
        </div>
        <div class="grid-2"><input class="input" data-f="customer_name" placeholder="Nama pelanggan" value="${esc(pos.customer_name)}"><input class="input" data-f="discount" inputmode="numeric" placeholder="Diskon (Rp)" value="${pos.discount || ''}"></div>
        <input class="input" data-f="note" placeholder="Catatan" value="${esc(pos.note)}">
        <div class="tot"><span>Subtotal</span><span>${rupiah(t.sub)}</span></div>
        ${t.disc ? `<div class="tot"><span>Diskon</span><span>-${rupiah(t.disc)}</span></div>` : ''}
        ${totalsRows(t, settings.tax_inclusive, settings.tax_percent)}
        <div class="tot big"><span>Total</span><span>${rupiah(t.total)}</span></div>
        <div class="grid-2"><button class="btn lg" data-save ${posCart.length ? '' : 'disabled'}>Simpan (bayar nanti)</button><button class="btn gold lg" data-paynow ${posCart.length ? '' : 'disabled'}>Bayar</button></div>
      </div>
    </aside></div>`;
}

$('#view').addEventListener('click', async (e) => {
  if (view !== 'pos') return;
  const c = e.target.closest('[data-cat]');
  if (c) return (posCat = c.dataset.cat === 'all' ? 'all' : Number(c.dataset.cat)), renderPos();
  const p = e.target.closest('[data-pid]');
  if (p) {
    const prod = menu.products.find((x) => x.id === Number(p.dataset.pid));
    const r = prod.options.length ? await productDialog(prod) : { options: {}, qty: 1, note: '' };
    if (!r) return;
    const key = JSON.stringify([prod.id, r.options, r.note]);
    const same = posCart.find((x) => x.key === key);
    if (same) same.qty += r.qty;
    else posCart.push({ key, product_id: prod.id, ...r });
    return renderPos();
  }
  const inc = e.target.closest('[data-inc]');
  const dec = e.target.closest('[data-dec]');
  if (inc) return posCart[inc.dataset.inc].qty++, renderPos();
  if (dec) {
    if (--posCart[dec.dataset.dec].qty <= 0) posCart.splice(dec.dataset.dec, 1);
    return renderPos();
  }
  const body = () => ({
    ...pos,
    discount: Number(String(pos.discount).replace(/\D/g, '')) || 0,
    items: posCart.map((x) => ({ product_id: x.product_id, qty: x.qty, options: x.options, note: x.note })),
  });
  const reset = () => {
    posCart = [];
    Object.assign(pos, { table_id: '', customer_name: '', order_type: 'dine_in', discount: 0, note: '' });
  };
  if (e.target.closest('[data-save]')) {
    try {
      const o = await api('/orders', { method: 'POST', body: body() });
      upsert(o);
      reset();
      renderPos();
      toast(`Pesanan ${o.queue_label} dikirim ke barista`, 'ok');
    } catch (err) {
      toast(err.message, 'bad');
    }
  }
  if (e.target.closest('[data-paynow]')) {
    const t = posTotals();
    payDialog(
      { total: t.total, queue_label: '' },
      {
        onPaid: async (payment) => {
          const o = await api('/orders', { method: 'POST', body: { ...body(), payment } });
          reset();
          return o;
        },
      }
    );
  }
});
$('#view').addEventListener('change', (e) => {
  if (view !== 'pos') return;
  const f = e.target.closest('[data-f]');
  if (f) {
    pos[f.dataset.f] = f.value;
    if (['discount', 'table_id', 'order_type'].includes(f.dataset.f)) renderPos();
  }
});

// ---------- Stok ----------
async function renderStock() {
  const ings = await api('/stock/ingredients');
  const moves = await api('/stock/movements');
  $('#view').innerHTML = `<div class="page stack">
    <div class="row wrap"><h2 class="grow">Stok Bahan Baku</h2>
      <button class="btn gold" data-mv="purchase">➕ Catat Pembelian / Stok Masuk</button>
      <button class="btn" data-mv="waste">🗑️ Catat Terbuang / Rusak</button></div>
    ${lowStock.length ? `<div class="card pad" style="background:var(--bad-soft)">⚠️ <b>${lowStock.length} bahan menipis:</b> ${lowStock.map((x) => esc(x.name)).join(', ')}</div>` : ''}
    <div class="card table-wrap"><table class="tbl"><thead><tr><th>Bahan</th><th class="num">Stok</th><th class="num">Minimum</th><th>Satuan</th></tr></thead><tbody>
      ${ings.filter((i) => i.active).map((i) => `<tr class="${i.low ? 'low' : ''}"><td>${esc(i.name)}</td><td class="num"><b>${num(i.stock)}</b></td><td class="num">${num(i.min_stock)}</td><td>${esc(i.unit)}</td></tr>`).join('')}
    </tbody></table></div>
    <h3>Mutasi hari ini</h3>
    <div class="card table-wrap"><table class="tbl"><thead><tr><th>Jam</th><th>Bahan</th><th>Jenis</th><th class="num">Jumlah</th><th>Catatan</th></tr></thead><tbody>
      ${moves.filter((m) => m.type !== 'sale').map((m) => `<tr><td>${timeOf(m.created_at)}</td><td>${esc(m.ingredient_name)}</td><td>${MV[m.type]}</td><td class="num">${num(m.qty)} ${esc(m.unit)}</td><td class="small">${esc(m.note)} <span class="muted">${esc(m.user_name || '')}</span></td></tr>`).join('') || '<tr><td colspan="5" class="muted">Belum ada mutasi manual hari ini</td></tr>'}
    </tbody></table></div>
  </div>`;
  $('#view').onclick = (e) => {
    const b = e.target.closest('[data-mv]');
    if (b && view === 'stock') movementDialog(b.dataset.mv, ings);
  };
}
const MV = { purchase: '📥 Pembelian', sale: '☕ Terjual', adjust: '⚖️ Opname', waste: '🗑️ Terbuang', return: '↩️ Batal' };

function movementDialog(type, ings) {
  const m = modal({
    title: type === 'purchase' ? 'Catat pembelian / stok masuk' : 'Catat bahan terbuang / rusak',
    body: `<label class="field"><span>Bahan</span><select class="input" data-ing>${ings.filter((i) => i.active).map((i) => `<option value="${i.id}">${esc(i.name)} (${esc(i.unit)}) — stok ${num(i.stock)}</option>`).join('')}</select></label>
      <label class="field"><span>Jumlah</span><input class="input" data-qty inputmode="decimal"></label>
      ${type === 'purchase' ? '<label class="field"><span>Total harga beli (Rp)</span><input class="input" data-cost inputmode="numeric"></label>' : ''}
      <label class="field"><span>Catatan</span><input class="input" data-note placeholder="${type === 'purchase' ? 'mis. supplier, no. nota' : 'mis. tumpah, kedaluwarsa'}"></label>`,
    foot: '<button class="btn" data-close>Batal</button><button class="btn gold" data-ok>Simpan</button>',
  });
  m.$('[data-ok]').onclick = async () => {
    try {
      await api('/stock/movements', {
        method: 'POST',
        body: { type, ingredient_id: Number(m.$('[data-ing]').value), qty: Number(m.$('[data-qty]').value.replace(',', '.')), total_cost: Number(m.$('[data-cost]')?.value.replace(/\D/g, '') || 0), note: m.$('[data-note]').value },
      });
      m.close();
      toast('Stok tersimpan', 'ok');
      renderStock();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
}

// ---------- Kas ----------
async function renderCash() {
  const entries = await api('/finance/entries');
  const sum = (t) => entries.filter((x) => x.type === t).reduce((a, b) => a + b.amount, 0);
  $('#view').innerHTML = `<div class="page stack">
    <div class="row wrap"><h2 class="grow">Kas Hari Ini</h2><button class="btn gold" data-cash="expense">➖ Catat Pengeluaran</button><button class="btn" data-cash="income">➕ Pemasukan Lain</button></div>
    <div class="stats"><div class="card stat"><div class="label">Pengeluaran</div><div class="value neg">${rupiah(sum('expense'))}</div></div><div class="card stat"><div class="label">Pemasukan lain</div><div class="value pos">${rupiah(sum('income'))}</div></div></div>
    <div class="card table-wrap"><table class="tbl"><thead><tr><th>Jam</th><th>Jenis</th><th>Kategori</th><th>Keterangan</th><th class="num">Nominal</th></tr></thead><tbody>
      ${entries.map((x) => `<tr><td>${timeOf(x.created_at)}</td><td>${x.type === 'expense' ? '<span class="badge unpaid">Keluar</span>' : '<span class="badge paid">Masuk</span>'}</td><td>${esc(x.category)}</td><td>${esc(x.description)} <span class="small muted">${esc(x.user_name || '')}</span></td><td class="num">${rupiah(x.amount)}</td></tr>`).join('') || '<tr><td colspan="5" class="muted">Belum ada catatan kas hari ini</td></tr>'}
    </tbody></table></div></div>`;
  $('#view').onclick = (e) => {
    const b = e.target.closest('[data-cash]');
    if (b && view === 'cash') cashDialog(b.dataset.cash);
  };
}

async function cashDialog(type) {
  const s = await api('/public/settings').catch(() => settings);
  const cats = (type === 'expense' ? settings.expense_categories : settings.income_categories) || [];
  const m = modal({
    title: type === 'expense' ? 'Catat pengeluaran' : 'Catat pemasukan lain',
    body: `<label class="field"><span>Kategori</span><input class="input" data-cat list="cat-list" value="${esc(cats[0] || '')}"><datalist id="cat-list">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label>
      <label class="field"><span>Nominal (Rp)</span><input class="input" data-amt inputmode="numeric"></label>
      <label class="field"><span>Keterangan</span><input class="input" data-desc></label>`,
    foot: '<button class="btn" data-close>Batal</button><button class="btn gold" data-ok>Simpan</button>',
  });
  void s;
  m.$('[data-ok]').onclick = async () => {
    try {
      await api('/finance/entries', { method: 'POST', body: { type, category: m.$('[data-cat]').value, amount: Number(m.$('[data-amt]').value.replace(/\D/g, '')), description: m.$('[data-desc]').value } });
      m.close();
      toast('Tersimpan', 'ok');
      renderCash();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
}

// ---------- Laporan hari ini ----------
async function renderReport() {
  const r = await api('/reports?period=day');
  const s = r.sales;
  $('#view').innerHTML = `<div class="page stack">
    <div class="row"><h2 class="grow">Ringkasan Penjualan ${esc(r.label)}</h2><button class="btn" id="print-close">🖨️ Cetak Tutup Kasir</button></div>
    <div class="stats">
      <div class="card stat"><div class="label">Total diterima</div><div class="value">${rupiah(s.total)}</div></div>
      <div class="card stat"><div class="label">Transaksi lunas</div><div class="value">${s.orders}</div></div>
      <div class="card stat"><div class="label">Item terjual</div><div class="value">${s.items_sold}</div></div>
      <div class="card stat"><div class="label">Rata-rata/transaksi</div><div class="value">${rupiah(s.avg_ticket)}</div></div>
      <div class="card stat"><div class="label">Belum dibayar</div><div class="value neg">${rupiah(r.unpaid.amount)} <span class="small">(${r.unpaid.orders})</span></div></div>
      <div class="card stat"><div class="label">Rata-rata waktu buat</div><div class="value">${r.avg_prep_minutes ? num(r.avg_prep_minutes, 1) + ' mnt' : '-'}</div></div>
    </div>
    <div class="grid-2">
      <div class="card table-wrap"><table class="tbl"><thead><tr><th>Metode bayar</th><th class="num">Trx</th><th class="num">Total</th></tr></thead><tbody>${r.byMethod.map((m) => `<tr><td>${esc(m.method)}</td><td class="num">${m.orders}</td><td class="num">${rupiah(m.total)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Belum ada</td></tr>'}</tbody></table></div>
      <div class="card table-wrap"><table class="tbl"><thead><tr><th>Terlaris</th><th class="num">Qty</th><th class="num">Omzet</th></tr></thead><tbody>${r.topItems.slice(0, 10).map((m) => `<tr><td>${esc(m.name)}</td><td class="num">${m.qty}</td><td class="num">${rupiah(m.revenue)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Belum ada</td></tr>'}</tbody></table></div>
    </div></div>`;
  $('#print-close').onclick = () => {
    let area = $('#print-area');
    if (!area) document.body.insertAdjacentHTML('beforeend', '<div id="print-area"></div>'), (area = $('#print-area'));
    area.className = 'receipt';
    const l = (a, b) => `<div class="l"><span>${a}</span><span>${b}</span></div>`;
    area.innerHTML = `<h2>${esc(settings.store_name)}</h2><div class="c">TUTUP KASIR ${esc(r.label)}<br>${esc(user.name)} · ${new Date().toLocaleTimeString('id-ID')}</div><hr>
      ${l('Transaksi', s.orders)}${l('Penjualan kotor', rupiah(s.gross))}${l('Diskon', '-' + rupiah(s.discount))}${l('Biaya tambahan', rupiah(s.service))}${l('<b>Total</b>', '<b>' + rupiah(s.total) + '</b>')}${l('PPN di dalamnya', rupiah(s.tax))}<hr>
      ${r.byMethod.map((m) => l(esc(m.method), rupiah(m.total))).join('')}<hr>${l('Belum bayar', rupiah(r.unpaid.amount))}${l('Dibatalkan', r.cancelled)}`;
    setTimeout(() => print(), 50);
  };
}

// ---------- Realtime & notifikasi ----------
function waiterPopup(w) {
  const el = document.createElement('div');
  el.className = 'waiter';
  el.innerHTML = `<span style="font-size:26px">🙋</span><div><div>${esc(w.table_name)}</div><div class="small">${esc(w.reason)}</div></div><button class="btn sm">OK</button>`;
  el.querySelector('button').onclick = () => el.remove();
  document.body.append(el);
  setTimeout(() => el.remove(), 60000);
}

async function loadAll() {
  const [o, m, t, s] = await Promise.all([api('/orders'), api('/admin/menu'), api('/tables'), api('/public/settings')]);
  orders = o.orders;
  menu = m;
  tables = t;
  settings = s;
  const ings = await api('/stock/ingredients');
  lowStock = ings.filter((i) => i.active && i.low);
  $('#store').textContent = settings.store_name;
  if (view !== 'stock' && view !== 'cash' && view !== 'report') render();
  updateBadges();
}

(async () => {
  user = await requireLogin({ title: 'Masuk Kasir' });
  $('#who').textContent = `${user.name} · ${user.role === 'superadmin' ? 'Superadmin' : 'Kasir'}`;
  $('#btn-admin').classList.toggle('hidden', user.role !== 'superadmin');
  // Kategori kas dari pengaturan (publik untuk staf)
  await loadAll();
  try {
    if (user.role === 'superadmin') {
      const full = await api('/admin/settings');
      settings.expense_categories = full.expense_categories.split(',').map((x) => x.trim()).filter(Boolean);
      settings.income_categories = full.income_categories.split(',').map((x) => x.trim()).filter(Boolean);
    }
  } catch {
    /* abaikan */
  }
  settings.expense_categories ||= ['Gaji Karyawan', 'Sewa Tempat', 'Listrik & Air', 'Internet', 'Marketing', 'Perawatan', 'Gas', 'Lain-lain'];
  settings.income_categories ||= ['Pendapatan Lain', 'Modal Masuk'];
  const rt = new Realtime({ staff: 1 });
  rt.onstatus = (on) => setConn($('#conn'), on);
  rt.on('open', loadAll);
  rt.on('order:update', (o) => {
    upsert(o);
    if (view === 'orders') renderOrders();
    else updateBadges();
  });
  rt.on('order:new', (o) => {
    chime({ notes: [660, 880, 1100], gap: 0.16, volume: 0.3 });
    toast(`🔔 Pesanan baru ${o.queue_label} — ${o.table_name || 'Kasir'} (${o.customer_name || '-'})`, 'gold', 6000);
  });
  rt.on('payment:claim', (c) => {
    chime({ notes: [784, 988, 1175, 1568], gap: 0.13, volume: 0.3 });
    claimPopup(c);
  });
  rt.on('waiter:call', (w) => {
    chime({ notes: [523, 659, 784, 1047], gap: 0.14, volume: 0.3 });
    waiterPopup(w);
  });
  rt.on('stock:low', (list) => {
    lowStock = list;
    updateBadges();
    if (list.length) toast(`⚠️ Stok menipis: ${list.slice(0, 3).map((x) => x.name).join(', ')}${list.length > 3 ? ` +${list.length - 3} lainnya` : ''}`, 'bad', 6000);
  });
  rt.on('menu:changed', async () => {
    menu = await api('/admin/menu');
    if (view === 'pos') renderPos();
  });
  rt.on('settings:changed', (s) => Object.assign(settings, s));
  document.addEventListener('pointerdown', unlockAudio, { once: true });
  setInterval(() => view === 'orders' && renderOrders(), 60000);
})();
