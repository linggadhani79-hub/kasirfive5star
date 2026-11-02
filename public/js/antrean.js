import { $, esc, api, Realtime, setConn, LOGO_SVG, chime, speak, unlockAudio, callSentence, keepAwake, hasIndonesianVoice, toast } from '/js/common.js';

$('#logo').innerHTML = LOGO_SVG;
keepAwake();

let settings = {};
let orders = [];
const flashIds = new Set();
const queue = [];
let busy = false;

function clock() {
  const d = new Date();
  $('#clock').textContent = d.toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' });
  $('#date').textContent = d.toLocaleDateString('id-ID', { weekday: 'long', day: 'numeric', month: 'long', year: 'numeric' });
}
setInterval(clock, 10000);
clock();

function render() {
  const prep = orders.filter((o) => o.status === 'preparing' || o.status === 'pending');
  const ready = orders.filter((o) => o.status === 'ready').sort((a, b) => (b.ready_at || '').localeCompare(a.ready_at || ''));
  const card = (o) => `<div class="num-card ${o.status === 'pending' ? 'pending' : ''} ${flashIds.has(o.id) ? 'flash' : ''}"><b>${esc(o.queue_label)}</b><span>${esc(o.customer_name || (o.order_type === 'takeaway' ? 'Bawa pulang' : ''))}${o.table_name ? ' · ' + esc(o.table_name) : ''}</span></div>`;
  $('#prep').innerHTML = prep.length ? prep.map(card).join('') : '<div class="empty-col">Belum ada pesanan diproses</div>';
  $('#ready').innerHTML = ready.length ? ready.map(card).join('') : '<div class="empty-col">Nomor yang siap akan muncul di sini</div>';
  $('#c-prep').textContent = prep.length;
  $('#c-ready').textContent = ready.length;
}

async function processQueue() {
  if (busy) return;
  busy = true;
  while (queue.length) {
    const a = queue.shift();
    flashIds.add(a.id);
    render();
    const el = document.createElement('div');
    el.className = 'call';
    el.innerHTML = `<div class="box"><div class="lbl">Nomor Antrean</div><div class="no">${esc(a.queue_label)}</div>
      ${a.customer_name ? `<div class="who">${esc(a.customer_name)}</div>` : ''}
      <div class="where">${a.table_name ? esc(a.table_name) + ' · ' : ''}Pesanan Anda sudah siap ☕</div></div>`;
    document.body.append(el);
    const text = callSentence(a, settings);
    const repeat = Math.max(1, Math.min(5, settings.voice_repeat || 2));
    for (let i = 0; i < repeat; i++) {
      await chime();
      await speak(text, { rate: settings.voice_rate || 0.95 });
      await new Promise((r) => setTimeout(r, 600));
    }
    el.remove();
    setTimeout(() => {
      flashIds.delete(a.id);
      render();
    }, 6000);
  }
  busy = false;
}

async function start() {
  try {
    const q = await api('/public/queue');
    settings = q.settings;
    orders = q.orders;
    $('#store').textContent = settings.store_name;
    document.title = `Antrean — ${settings.store_name}`;
    $('#ticker').textContent = `Selamat datang di ${settings.store_name} ☕  Pesan langsung dari tablet di meja Anda — nomor antrean akan dipanggil saat pesanan siap.  ${settings.store_address || ''}`;
    render();
  } catch (e) {
    toast(e.message, 'bad');
  }
  const rt = new Realtime({ role: 'monitor' });
  rt.onstatus = (on) => setConn($('#conn'), on);
  rt.on('queue:update', (list) => {
    orders = list;
    render();
  });
  rt.on('queue:announce', (a) => {
    queue.push(a);
    processQueue();
  });
  rt.on('settings:changed', (s) => (settings = s));
}

function unlock() {
  unlockAudio();
  $('#unlock').remove();
  document.documentElement.requestFullscreen?.().catch(() => {});
  if (!hasIndonesianVoice()) setTimeout(() => !hasIndonesianVoice() && toast('Suara Bahasa Indonesia tidak ditemukan di perangkat ini; memakai suara bawaan. Pasang "Google Text-to-Speech" bahasa Indonesia.', '', 8000), 1500);
}
// Di APK Android, TTS native tidak butuh ketukan pertama.
if (window.AndroidBridge) $('#unlock').remove();
else $('#unlock').addEventListener('click', unlock);

$('#btn-test').onclick = () => {
  queue.push({ id: -1, queue_no: 1, queue_label: `${settings.queue_prefix || ''}001`, customer_name: 'Tes Suara', table_name: 'Meja 1' });
  processQueue();
};
$('#btn-full').onclick = () => document.documentElement.requestFullscreen?.();

start();
