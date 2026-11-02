import { $, esc, api, Realtime, setConn, LOGO_SVG, requireLogin, logout, toast, modal, chime, minutesSince, keepAwake, storage, unlockAudio, timeOf } from '/js/common.js';

$('#logo').innerHTML = LOGO_SVG;
keepAwake();
let orders = [];
let soundOn = storage.get('f5_dapur_sound') !== '0';
const LATE_MIN = 12;

function ticket(o) {
  const mins = minutesSince(o.accepted_at || o.created_at);
  const late = o.status === 'preparing' && mins >= LATE_MIN;
  const actions = {
    pending: '<span class="small muted">Menunggu dikonfirmasi kasir</span>',
    preparing: `<button class="btn ok lg block" data-act="ready" data-id="${o.id}">✅ Selesai dibuat — Panggil</button>`,
    ready: `<div class="row"><button class="btn grow" data-act="call" data-id="${o.id}">🔊 Panggil ulang (${o.call_count}×)</button><button class="btn primary grow" data-act="done" data-id="${o.id}">Sudah diambil</button></div>`,
  }[o.status];
  return `<article class="ticket ${o.status} ${late ? 'late' : ''}">
    <div class="row"><span class="q">${esc(o.queue_label)}</span><div class="grow"><b>${esc(o.customer_name || '-')}</b><div class="small muted">${esc(o.table_name || 'Kasir')} · ${o.order_type === 'takeaway' ? '🛍️ Bawa pulang' : '🍽️ Di tempat'}</div></div>
      <span class="timer ${late ? 'late' : ''}" title="Masuk ${timeOf(o.created_at)}">${o.status === 'ready' ? '✔ ' + timeOf(o.ready_at) : mins + ' mnt'}</span></div>
    <ul>${o.items
      .map(
        (i) => `<li><b>${i.qty}×</b><div><div>${esc(i.name)}</div>${i.options?.length ? `<div class="opts">${esc(i.options.map((x) => x.name).join(' · '))}</div>` : ''}${i.note ? `<div class="note">📝 ${esc(i.note)}</div>` : ''}</div></li>`
      )
      .join('')}</ul>
    ${o.note ? `<div class="note" style="margin-bottom:8px">📝 ${esc(o.note)}</div>` : ''}
    ${actions}
  </article>`;
}

function render() {
  for (const s of ['pending', 'preparing', 'ready']) {
    const list = orders.filter((o) => o.status === s).sort((a, b) => a.queue_no - b.queue_no);
    $(`#l-${s}`).innerHTML = list.map(ticket).join('') || '<div class="empty small">Kosong</div>';
    $(`#n-${s}`).textContent = list.length;
  }
}

async function load() {
  const r = await api('/orders?scope=active');
  orders = r.orders;
  render();
}

document.addEventListener('click', async (e) => {
  const b = e.target.closest('[data-act]');
  if (!b) return;
  b.disabled = true;
  const id = b.dataset.id;
  try {
    if (b.dataset.act === 'call') await api(`/orders/${id}/call`, { method: 'POST' });
    else await api(`/orders/${id}/status`, { method: 'POST', body: { status: b.dataset.act } });
    if (b.dataset.act === 'ready') toast('Pesanan dipanggil di monitor antrean 🔊', 'ok');
  } catch (err) {
    toast(err.message, 'bad');
    b.disabled = false;
  }
});

$('#btn-sound').onclick = () => {
  soundOn = !soundOn;
  storage.set('f5_dapur_sound', soundOn ? '1' : '0');
  $('#btn-sound').textContent = soundOn ? '🔔 Suara: Aktif' : '🔕 Suara: Mati';
  unlockAudio();
};
$('#btn-sound').textContent = soundOn ? '🔔 Suara: Aktif' : '🔕 Suara: Mati';
$('#btn-logout').onclick = logout;

$('#btn-stock').onclick = async () => {
  const menu = await api('/admin/menu');
  const m = modal({
    title: 'Tandai menu habis / tersedia',
    wide: true,
    body: `<p class="small muted" style="margin:0">Menu yang ditandai habis tidak bisa dipesan dari meja.</p>
      <div class="product-grid">${menu.products
        .map((p) => `<label class="card pad check" style="justify-content:space-between"><span>${esc(p.name)}</span><input type="checkbox" data-pid="${p.id}" ${p.available ? 'checked' : ''}></label>`)
        .join('')}</div>`,
  });
  m.el.addEventListener('change', async (e) => {
    const c = e.target.closest('[data-pid]');
    if (!c) return;
    try {
      await api(`/products/${c.dataset.pid}/availability`, { method: 'PATCH', body: { available: c.checked } });
      toast(c.checked ? 'Menu tersedia kembali' : 'Menu ditandai habis', 'ok', 1500);
    } catch (err) {
      toast(err.message, 'bad');
      c.checked = !c.checked;
    }
  });
};

(async () => {
  const user = await requireLogin({ title: 'Masuk Barista / Dapur' });
  $('#who').textContent = user.name;
  await load();
  const rt = new Realtime({ staff: 1 });
  rt.onstatus = (on) => setConn($('#conn'), on);
  rt.on('open', load);
  rt.on('order:update', (o) => {
    const i = orders.findIndex((x) => x.id === o.id);
    const wasPreparing = i >= 0 && orders[i].status === 'preparing';
    if (['pending', 'preparing', 'ready'].includes(o.status)) i >= 0 ? (orders[i] = o) : orders.push(o);
    else if (i >= 0) orders.splice(i, 1);
    if (o.status === 'preparing' && !wasPreparing && soundOn) chime({ notes: [988, 1319, 988], gap: 0.18, volume: 0.25 });
    render();
  });
  setInterval(render, 30000);
  document.addEventListener('pointerdown', unlockAudio, { once: true });
})();
