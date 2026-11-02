// Utilitas bersama: API, realtime WebSocket, suara panggilan, format, UI kecil.
// Di APK Android, window.print() WebView tidak berfungsi: arahkan ke PrintManager native.
if (window.AndroidBridge?.print) window.print = () => window.AndroidBridge.print();

export const $ = (sel, root = document) => root.querySelector(sel);
export const $$ = (sel, root = document) => [...root.querySelectorAll(sel)];

export const esc = (s) =>
  String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]);

export const rupiah = (n) => 'Rp' + Math.round(Number(n) || 0).toLocaleString('id-ID');
export const num = (n, d = 2) => (Number(n) || 0).toLocaleString('id-ID', { maximumFractionDigits: d });
export const timeOf = (iso) => (iso ? new Date(iso).toLocaleTimeString('id-ID', { hour: '2-digit', minute: '2-digit' }) : '');
export const dateTimeOf = (iso) => (iso ? new Date(iso).toLocaleString('id-ID', { dateStyle: 'medium', timeStyle: 'short' }) : '');
export const minutesSince = (iso) => (iso ? Math.max(0, Math.floor((Date.now() - new Date(iso).getTime()) / 60000)) : 0);

export const STATUS_LABEL = {
  pending: 'Menunggu konfirmasi',
  preparing: 'Sedang dibuat',
  ready: 'Siap diambil',
  done: 'Selesai',
  cancelled: 'Dibatalkan',
};

export const LOGO_SVG = `<svg class="brand-logo" viewBox="0 0 64 64" aria-hidden="true">
  <circle cx="32" cy="32" r="30" fill="#d29b2e"/>
  <path d="M18 26h24v10a12 12 0 0 1-24 0z" fill="#3b2418"/>
  <path d="M42 28h3a5 5 0 0 1 0 10h-4" fill="none" stroke="#3b2418" stroke-width="3"/>
  <path d="M32 9l2.4 4.9 5.4.8-3.9 3.8.9 5.4-4.8-2.6-4.8 2.6.9-5.4-3.9-3.8 5.4-.8z" fill="#fff8e7"/>
  <text x="32" y="56" text-anchor="middle" font-size="9" font-weight="800" fill="#3b2418" font-family="system-ui">FIVE5★</text>
</svg>`;

// ---------- Sesi staf ----------
const TOKEN_KEY = 'f5_token';
const USER_KEY = 'f5_user';
const store = {
  get(k) {
    try {
      return localStorage.getItem(k);
    } catch {
      return null;
    }
  },
  set(k, v) {
    try {
      v == null ? localStorage.removeItem(k) : localStorage.setItem(k, v);
    } catch {
      /* penyimpanan tidak tersedia */
    }
  },
};
export const storage = store;
export const session = {
  get token() {
    return store.get(TOKEN_KEY);
  },
  get user() {
    try {
      return JSON.parse(store.get(USER_KEY) || 'null');
    } catch {
      return null;
    }
  },
  save(token, user) {
    store.set(TOKEN_KEY, token);
    store.set(USER_KEY, JSON.stringify(user));
  },
  clear() {
    store.set(TOKEN_KEY, null);
    store.set(USER_KEY, null);
  },
};

export class ApiError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export async function api(path, { method = 'GET', body, raw } = {}) {
  const headers = { 'content-type': 'application/json' };
  if (session.token) headers.authorization = `Bearer ${session.token}`;
  let res;
  try {
    res = await fetch('/api' + path, { method, headers, body: body ? JSON.stringify(body) : undefined });
  } catch {
    throw new ApiError(0, 'Tidak terhubung ke server. Periksa koneksi internet.');
  }
  if (raw) return res;
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    if (res.status === 401 && session.token) {
      session.clear();
      window.dispatchEvent(new Event('f5:logout'));
    }
    throw new ApiError(res.status, data.error || 'Terjadi kesalahan');
  }
  return data;
}

// ---------- Realtime (WebSocket dengan auto-reconnect) ----------
export class Realtime {
  constructor(params = {}) {
    this.params = params;
    this.handlers = {};
    this.retry = 0;
    this.onstatus = () => {};
    this.connect();
    document.addEventListener('visibilitychange', () => {
      if (document.visibilityState === 'visible' && (!this.ws || this.ws.readyState > 1)) this.connect();
    });
  }
  on(event, fn) {
    (this.handlers[event] ||= []).push(fn);
    return this;
  }
  connect() {
    clearTimeout(this.timer);
    const qs = new URLSearchParams({ ...this.params, ...(session.token && this.params.staff ? { token: session.token } : {}) });
    qs.delete('staff');
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    const ws = new WebSocket(`${proto}://${location.host}/ws?${qs}`);
    this.ws = ws;
    ws.onopen = () => {
      this.retry = 0;
      this.onstatus(true);
      this.ping = setInterval(() => ws.readyState === 1 && ws.send('ping'), 25000);
      (this.handlers.open || []).forEach((fn) => fn());
    };
    ws.onmessage = (e) => {
      if (e.data === 'pong') return;
      try {
        const { event, data } = JSON.parse(e.data);
        (this.handlers[event] || []).forEach((fn) => fn(data));
      } catch {
        /* abaikan pesan rusak */
      }
    };
    ws.onclose = () => {
      clearInterval(this.ping);
      this.onstatus(false);
      if (this.ws !== ws) return;
      const delay = Math.min(15000, 1000 * 2 ** this.retry++);
      this.timer = setTimeout(() => this.connect(), delay);
    };
    ws.onerror = () => ws.close();
  }
}

// ---------- Suara ----------
let audioCtx;
export function unlockAudio() {
  try {
    audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
    if (audioCtx.state === 'suspended') audioCtx.resume();
    // "Pemanasan" speechSynthesis agar diizinkan browser setelah interaksi pengguna.
    if ('speechSynthesis' in window && !window.AndroidBridge) {
      const u = new SpeechSynthesisUtterance(' ');
      u.volume = 0;
      speechSynthesis.speak(u);
    }
  } catch {
    /* audio tidak didukung */
  }
}

// Bunyi "ding-dong" khas panggilan antrean.
export function chime({ notes = [784, 622], gap = 0.42, volume = 0.35 } = {}) {
  return new Promise((resolve) => {
    try {
      audioCtx ||= new (window.AudioContext || window.webkitAudioContext)();
      const t0 = audioCtx.currentTime + 0.02;
      notes.forEach((f, i) => {
        const o = audioCtx.createOscillator();
        const g = audioCtx.createGain();
        o.type = 'sine';
        o.frequency.value = f;
        g.gain.setValueAtTime(0, t0 + i * gap);
        g.gain.linearRampToValueAtTime(volume, t0 + i * gap + 0.02);
        g.gain.exponentialRampToValueAtTime(0.001, t0 + i * gap + 1.1);
        o.connect(g).connect(audioCtx.destination);
        o.start(t0 + i * gap);
        o.stop(t0 + i * gap + 1.2);
      });
      setTimeout(resolve, (notes.length - 1) * gap * 1000 + 900);
    } catch {
      resolve();
    }
  });
}

function pickVoice() {
  if (!('speechSynthesis' in window)) return null;
  const voices = speechSynthesis.getVoices();
  return voices.find((v) => /^id(-|_)?ID/i.test(v.lang)) || voices.find((v) => /^id/i.test(v.lang)) || voices.find((v) => /indonesia/i.test(v.name)) || null;
}
if ('speechSynthesis' in window) speechSynthesis.onvoiceschanged = () => pickVoice();

export function hasIndonesianVoice() {
  return !!window.AndroidBridge || !!pickVoice();
}

// Bicara (Android WebView memakai TextToSpeech native lewat AndroidBridge).
export function speak(text, { rate = 0.95 } = {}) {
  return new Promise((resolve) => {
    if (window.AndroidBridge?.speak) {
      try {
        window.AndroidBridge.speak(text, rate);
        // Perkiraan durasi bicara agar antrean pengumuman tidak tumpang tindih.
        setTimeout(resolve, Math.max(2500, text.length * 75 / rate));
        return;
      } catch {
        /* lanjut ke Web Speech */
      }
    }
    if (!('speechSynthesis' in window)) return resolve();
    const u = new SpeechSynthesisUtterance(text);
    u.lang = 'id-ID';
    const v = pickVoice();
    if (v) u.voice = v;
    u.rate = rate;
    u.pitch = 1;
    let done = false;
    const finish = () => !done && ((done = true), resolve());
    u.onend = finish;
    u.onerror = finish;
    setTimeout(finish, Math.max(4000, text.length * 120));
    speechSynthesis.cancel();
    speechSynthesis.speak(u);
  });
}

// Kalimat panggilan dari template pengaturan.
export function callSentence(order, settings) {
  const spokenNo = `${settings?.queue_prefix ? settings.queue_prefix + ' ' : ''}${order.queue_no}`;
  const tpl = settings?.voice_template || 'Nomor antrean {nomor}{nama_kalimat}{meja_kalimat}. Pesanan Anda sudah siap.';
  return tpl
    .replaceAll('{nomor}', spokenNo)
    .replaceAll('{nama}', order.customer_name || '')
    .replaceAll('{meja}', order.table_name || '')
    .replaceAll('{nama_kalimat}', order.customer_name ? `, atas nama ${order.customer_name}` : '')
    .replaceAll('{meja_kalimat}', order.table_name ? `, ${order.table_name}` : order.order_type === 'takeaway' ? ', bawa pulang' : '');
}

// ---------- UI kecil ----------
export function toast(msg, type = '', ms = 3200) {
  let box = $('#toasts');
  if (!box) {
    box = document.createElement('div');
    box.id = 'toasts';
    document.body.append(box);
  }
  const el = document.createElement('div');
  el.className = `toast ${type}`;
  el.textContent = msg;
  box.append(el);
  setTimeout(() => el.remove(), ms);
}

export function modal({ title, body, foot = '', wide = false, onClose } = {}) {
  const back = document.createElement('div');
  back.className = 'modal-back';
  back.innerHTML = `<div class="modal ${wide ? 'wide' : ''}" role="dialog" aria-modal="true">
    <div class="modal-head"><h3>${title}</h3><button class="btn ghost icon-btn" data-close aria-label="Tutup">✕</button></div>
    <div class="modal-body">${body}</div>
    ${foot ? `<div class="modal-foot">${foot}</div>` : ''}
  </div>`;
  const close = () => {
    back.remove();
    onClose?.();
  };
  back.addEventListener('click', (e) => {
    if (e.target === back || e.target.closest('[data-close]')) close();
  });
  document.body.append(back);
  return { el: back, close, $: (s) => back.querySelector(s), $$: (s) => [...back.querySelectorAll(s)] };
}

export function confirmBox(message, { ok = 'Ya', danger = false } = {}) {
  return new Promise((resolve) => {
    const m = modal({
      title: 'Konfirmasi',
      body: `<p style="margin:0">${esc(message)}</p>`,
      foot: `<button class="btn" data-close>Batal</button><button class="btn ${danger ? 'bad' : 'primary'}" data-ok>${esc(ok)}</button>`,
      onClose: () => resolve(false),
    });
    m.$('[data-ok]').onclick = () => {
      m.el.remove();
      resolve(true);
    };
  });
}

export function setConn(el, on) {
  if (el) {
    el.classList.toggle('on', on);
    el.title = on ? 'Terhubung realtime' : 'Terputus — menyambung ulang…';
  }
}

// Layar login PIN untuk kasir/superadmin. resolve(user) setelah berhasil.
export function requireLogin({ roles = ['kasir', 'superadmin'], title = 'Masuk Staf' } = {}) {
  return new Promise(async (resolve) => {
    if (session.token) {
      try {
        const { user } = await api('/auth/me');
        if (roles.includes(user.role)) {
          session.save(session.token, user);
          return resolve(user);
        }
      } catch {
        /* token kedaluwarsa */
      }
    }
    const wrap = document.createElement('div');
    wrap.className = 'login-wrap';
    wrap.innerHTML = `<div class="login-card">
      <div style="display:flex;justify-content:center">${LOGO_SVG.replace('brand-logo', 'brand-logo" style="width:72px;height:72px')}</div>
      <h2 style="margin-top:10px">${esc(title)}</h2>
      <p class="muted small" style="margin:4px 0 0">Masukkan PIN Anda</p>
      <div class="pin-dots">${'<i></i>'.repeat(6)}</div>
      <div class="pinpad">${[1, 2, 3, 4, 5, 6, 7, 8, 9].map((n) => `<button data-n="${n}">${n}</button>`).join('')}
        <button data-c>⌫</button><button data-n="0">0</button><button data-ok style="background:var(--gold);color:#2a1c14">OK</button></div>
      <p class="small muted" style="margin:16px 0 0"><a href="/">← Kembali ke menu utama</a></p>
    </div>`;
    document.body.append(wrap);
    let pin = '';
    const dots = $$('.pin-dots i', wrap);
    const draw = () => dots.forEach((d, i) => d.classList.toggle('on', i < pin.length));
    const submit = async () => {
      if (pin.length < 4) return;
      try {
        const r = await api('/auth/login', { method: 'POST', body: { pin } });
        if (!roles.includes(r.user.role)) {
          toast('Peran ini tidak punya akses ke layar ini', 'bad');
          pin = '';
          return draw();
        }
        session.save(r.token, r.user);
        wrap.remove();
        unlockAudio();
        resolve(r.user);
      } catch (e) {
        toast(e.message, 'bad');
        pin = '';
        draw();
      }
    };
    wrap.addEventListener('click', (e) => {
      const b = e.target.closest('button');
      if (!b) return;
      if (b.dataset.n !== undefined && pin.length < 8) pin += b.dataset.n;
      if (b.hasAttribute('data-c')) pin = pin.slice(0, -1);
      if (b.hasAttribute('data-ok')) return submit();
      draw();
      if (pin.length === 6) submit();
    });
    document.addEventListener('keydown', function onKey(e) {
      if (!wrap.isConnected) return document.removeEventListener('keydown', onKey);
      if (/^\d$/.test(e.key) && pin.length < 8) pin += e.key;
      else if (e.key === 'Backspace') pin = pin.slice(0, -1);
      else if (e.key === 'Enter') return submit();
      draw();
    });
  });
}

export async function logout() {
  try {
    await api('/auth/logout', { method: 'POST' });
  } catch {
    /* tetap keluar */
  }
  session.clear();
  location.reload();
}

// Struk pembayaran untuk dicetak (printer thermal 58/80mm lewat dialog cetak).
export function printReceipt(order, settings) {
  let area = $('#print-area');
  if (!area) {
    area = document.createElement('div');
    area.id = 'print-area';
    document.body.append(area);
  }
  area.className = 'receipt';
  const line = (l, r) => `<div class="l"><span>${l}</span><span>${r}</span></div>`;
  area.innerHTML = `
    <h2>${esc(settings.store_name)}</h2>
    <div class="c">${esc(settings.store_address || '')}${settings.store_phone ? '<br>' + esc(settings.store_phone) : ''}</div>
    <hr>
    ${line('No. Antrean', `<b>${esc(order.queue_label)}</b>`)}
    ${line('Tanggal', dateTimeOf(order.created_at))}
    ${order.table_name ? line('Meja', esc(order.table_name)) : line('Tipe', order.order_type === 'takeaway' ? 'Bawa pulang' : 'Makan di tempat')}
    ${order.customer_name ? line('Nama', esc(order.customer_name)) : ''}
    <hr>
    ${order.items
      .map(
        (i) => `<div>${esc(i.name)}</div>${line(`&nbsp;${i.qty} x ${rupiah(i.unit_price)}`, rupiah(i.line_total))}
        ${i.options?.length ? `<div class="opt">${i.options.map((o) => esc(o.name)).join(', ')}</div>` : ''}
        ${i.note ? `<div class="opt">* ${esc(i.note)}</div>` : ''}`
      )
      .join('')}
    <hr>
    ${line('Subtotal', rupiah(order.subtotal))}
    ${order.discount ? line('Diskon', '-' + rupiah(order.discount)) : ''}
    ${(order.fees?.length ? order.fees : order.service ? [{ name: 'Biaya tambahan', amount: order.service }] : []).map((f) => line(esc(f.name), rupiah(f.amount))).join('')}
    ${!order.tax_inclusive && order.tax ? line('PPN', rupiah(order.tax)) : ''}
    ${line('<b>TOTAL</b>', `<b>${rupiah(order.total)}</b>`)}
    ${order.tax_inclusive && order.tax ? line('Termasuk PPN', rupiah(order.tax)) : ''}
    ${order.payment_status === 'paid'
      ? line(esc(order.payment_method), rupiah(order.paid_amount)) + (order.change_amount ? line('Kembali', rupiah(order.change_amount)) : '')
      : '<div class="c"><b>BELUM DIBAYAR</b></div>'}
    <hr>
    <div class="c">${esc(settings.receipt_footer || '')}</div>
  `;
  setTimeout(() => window.print(), 50);
}

// Kompres gambar menu di perangkat sebelum diunggah (maks ~600px, JPEG).
export function resizeImage(file, max = 600) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => {
      const s = Math.min(1, max / Math.max(img.width, img.height));
      const c = document.createElement('canvas');
      c.width = Math.round(img.width * s);
      c.height = Math.round(img.height * s);
      c.getContext('2d').drawImage(img, 0, 0, c.width, c.height);
      resolve(c.toDataURL('image/jpeg', 0.8));
      URL.revokeObjectURL(img.src);
    };
    img.onerror = reject;
    img.src = URL.createObjectURL(file);
  });
}

// Wake lock agar layar tablet/monitor tidak mati.
export async function keepAwake() {
  try {
    if ('wakeLock' in navigator) {
      let lock = await navigator.wakeLock.request('screen');
      document.addEventListener('visibilitychange', async () => {
        if (document.visibilityState === 'visible') lock = await navigator.wakeLock.request('screen').catch(() => lock);
      });
    }
  } catch {
    /* tidak didukung */
  }
}

export function registerSW() {
  if ('serviceWorker' in navigator && location.protocol === 'https:') navigator.serviceWorker.register('/sw.js').catch(() => {});
}

// Pemilih opsi produk (dipakai di layar meja & kasir). resolve({options, qty, note}) atau null.
export function productDialog(p, { qty = 1 } = {}) {
  return new Promise((resolve) => {
    const sel = {};
    for (const g of p.options) sel[g.name] = g.required && !g.multi && g.choices[0] ? [g.choices[0].name] : [];
    let count = qty;
    const m = modal({
      title: esc(p.name),
      body: `
        ${p.image ? `<img src="${esc(p.image)}" alt="" style="border-radius:14px;max-height:220px;width:100%;object-fit:cover">` : ''}
        ${p.description ? `<p class="muted" style="margin:0">${esc(p.description)}</p>` : ''}
        ${p.options
          .map(
            (g, gi) => `<div class="opt-group"><h4>${esc(g.name)} ${g.required ? '<span class="badge pending">Wajib</span>' : '<span class="badge">Opsional</span>'} ${g.multi ? '<span class="muted small">boleh lebih dari satu</span>' : ''}</h4>
            <div class="chips">${g.choices.map((c) => `<button class="chip" data-g="${gi}" data-c="${esc(c.name)}">${esc(c.name)}${c.price ? `<small>+${rupiah(c.price)}</small>` : ''}</button>`).join('')}</div></div>`
          )
          .join('')}
        <label class="field"><span>Catatan (opsional)</span><input class="input" data-note maxlength="200" placeholder="mis. es sedikit, tanpa sedotan"></label>
        <div class="row"><span class="grow" style="font-weight:700">Jumlah</span><div class="stepper"><button data-minus>−</button><span data-qty>${count}</span><button data-plus>+</button></div></div>`,
      foot: `<button class="btn gold lg block" data-add>Tambah — <span data-total></span></button>`,
      onClose: () => resolve(null),
    });
    const draw = () => {
      m.$$('.chip').forEach((b) => b.classList.toggle('on', sel[p.options[b.dataset.g].name].includes(b.dataset.c)));
      let unit = p.price;
      for (const g of p.options) for (const n of sel[g.name]) unit += g.choices.find((c) => c.name === n)?.price || 0;
      m.$('[data-total]').textContent = rupiah(unit * count);
      m.$('[data-qty]').textContent = count;
    };
    m.el.addEventListener('click', (e) => {
      const chip = e.target.closest('.chip');
      if (chip) {
        const g = p.options[chip.dataset.g];
        const cur = sel[g.name];
        const has = cur.includes(chip.dataset.c);
        if (g.multi) sel[g.name] = has ? cur.filter((x) => x !== chip.dataset.c) : [...cur, chip.dataset.c];
        else sel[g.name] = has && !g.required ? [] : [chip.dataset.c];
        draw();
      }
      if (e.target.closest('[data-minus]')) count = Math.max(1, count - 1), draw();
      if (e.target.closest('[data-plus]')) count = Math.min(99, count + 1), draw();
    });
    m.$('[data-add]').onclick = () => {
      const missing = p.options.find((g) => g.required && sel[g.name].length === 0);
      if (missing) return toast(`Pilih ${missing.name} dulu`, 'bad');
      const options = {};
      for (const g of p.options) if (sel[g.name].length) options[g.name] = g.multi ? sel[g.name] : sel[g.name][0];
      m.el.remove();
      resolve({ options, qty: count, note: m.$('[data-note]').value.trim() });
    };
    draw();
  });
}

// Total pesanan di sisi klien (hanya tampilan; logika sama dengan computeTotals di server).
// base = subtotal - diskon. Harga sudah termasuk PPN bila settings.tax_inclusive.
export function calcTotals(base, orderType, settings) {
  const fees = (settings?.extra_fees || [])
    .filter((f) => f.applies === 'all' || f.applies === orderType)
    .map((f) => ({ name: f.name, amount: Math.round(f.type === 'fixed' ? f.value : (base * f.value) / 100) }))
    .filter((f) => f.amount > 0 && base > 0);
  const service = fees.reduce((a, f) => a + f.amount, 0);
  const gross = base + service;
  const pct = Number(settings?.tax_percent) || 0;
  const tax = settings?.tax_inclusive ? Math.round((gross * pct) / (100 + pct)) : Math.round((gross * pct) / 100);
  return { fees, service, tax, total: settings?.tax_inclusive ? gross : gross + tax };
}

// Baris rincian biaya + PPN (dipakai layar meja, kasir).
export function totalsRows({ fees, tax }, taxInclusive, taxPercent) {
  return `${fees.map((f) => `<div class="tot"><span>${esc(f.name)}</span><span>${rupiah(f.amount)}</span></div>`).join('')}
    ${tax ? `<div class="tot muted"><span>${taxInclusive ? `Termasuk PPN ${num(taxPercent, 2)}%` : `PPN ${num(taxPercent, 2)}%`}</span><span>${rupiah(tax)}</span></div>` : ''}`;
}

// Harga satuan item keranjang di sisi klien (hanya tampilan; server menghitung ulang).
export function unitPrice(p, options) {
  let unit = p.price;
  for (const g of p.options) {
    const v = options[g.name];
    for (const n of Array.isArray(v) ? v : v ? [v] : []) unit += g.choices.find((c) => c.name === n)?.price || 0;
  }
  return unit;
}
export const optionText = (options) =>
  Object.values(options || {})
    .flat()
    .join(', ');
