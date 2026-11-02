// Server aplikasi: REST API + Socket.IO realtime.
// Logika aplikasi kasir (berjalan di dalam Durable Object Cloudflare).
import QRCode from 'qrcode';
import { tx, hashPin, verifyPin, randomCode, randomToken, DEFAULT_SETTINGS } from './db.js';
import { Router } from './router.js';
import { inspectQris, qrisWithAmount } from './qris.js';

export class HttpError extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}
const bad = (msg) => new HttpError(400, msg);

const ACTIVE_STATUSES = ['pending', 'preparing', 'ready'];
const ALL_STATUSES = ['pending', 'preparing', 'ready', 'done', 'cancelled'];

// db: pembungkus SQL (lihat db.js), broadcast(room|null, event, data): kirim ke WebSocket
export function createStore({ db, broadcast }) {
  const io = {
    to: (room) => ({ emit: (event, data) => broadcast(room, event, data) }),
    emit: (event, data) => broadcast(null, event, data),
  };

  // ---------- Helpers ----------
  const getSettings = () => {
    const out = { ...DEFAULT_SETTINGS };
    for (const r of db.prepare('SELECT key, value FROM settings').all()) out[r.key] = r.value;
    return out;
  };
  const publicSettings = (s = getSettings()) => ({
    store_name: s.store_name,
    store_address: s.store_address,
    store_phone: s.store_phone,
    receipt_footer: s.receipt_footer,
    tax_percent: Number(s.tax_percent) || 0,
    service_percent: Number(s.service_percent) || 0,
    tax_inclusive: s.tax_inclusive === '1',
    extra_fees: parseFees(s),
    qris_enabled: qrisInfo(s) !== null,
    qris_merchant: qrisInfo(s)?.merchant_name || '',
    voice_template: s.voice_template,
    voice_repeat: Number(s.voice_repeat) || 1,
    voice_rate: Number(s.voice_rate) || 1,
    queue_prefix: s.queue_prefix || '',
    payment_methods: String(s.payment_methods || 'Tunai').split(',').map((x) => x.trim()).filter(Boolean),
    require_payment_first: s.require_payment_first === '1',
    auto_accept: s.auto_accept === '1',
  });

  // Biaya tambahan otomatis dari pengaturan (+ service charge lama bila diisi).
  const parseFees = (s) => {
    let list = [];
    try {
      list = JSON.parse(s.extra_fees || '[]');
    } catch {
      list = [];
    }
    if (!Array.isArray(list)) list = [];
    const out = list
      .filter((f) => f && String(f.name || '').trim() && Number(f.value) > 0)
      .map((f) => ({
        name: String(f.name).trim().slice(0, 40),
        type: f.type === 'fixed' ? 'fixed' : 'percent',
        value: Number(f.value),
        applies: ['dine_in', 'takeaway'].includes(f.applies) ? f.applies : 'all',
      }));
    if (Number(s.service_percent) > 0) out.unshift({ name: 'Service charge', type: 'percent', value: Number(s.service_percent), applies: 'all' });
    return out;
  };

  // QRIS toko (null bila belum diaktifkan / kode tidak valid)
  const qrisInfo = (s) => {
    if (s.qris_enabled !== '1' || !s.qris_payload) return null;
    try {
      return inspectQris(s.qris_payload);
    } catch {
      return null;
    }
  };
  const qrisSvg = async (amount) => {
    const info = qrisInfo(getSettings());
    if (!info) throw bad('QRIS belum diaktifkan di Pengaturan');
    const payload = qrisWithAmount(info.payload, amount);
    const svg = await QRCode.toString(payload, { type: 'svg', margin: 2, width: 320, errorCorrectionLevel: 'M' });
    return { svg, payload, amount: Math.round(amount), merchant_name: info.merchant_name, merchant_city: info.merchant_city };
  };

  const nowIso = () => new Date().toISOString();
  const businessDate = (date = new Date()) => {
    const tz = getSettings().timezone || 'Asia/Jakarta';
    // en-CA menghasilkan format YYYY-MM-DD
    return new Intl.DateTimeFormat('en-CA', { timeZone: tz, year: 'numeric', month: '2-digit', day: '2-digit' }).format(date);
  };

  const parseProduct = (p) => p && { ...p, available: !!p.available, options: safeJson(p.options, []) };
  const safeJson = (s, fallback) => {
    try {
      return JSON.parse(s);
    } catch {
      return fallback;
    }
  };

  const loadOrder = (id) => {
    const o = db.prepare('SELECT * FROM orders WHERE id = ?').get(id);
    if (!o) return null;
    o.items = db
      .prepare('SELECT * FROM order_items WHERE order_id = ? ORDER BY id')
      .all(id)
      .map((it) => ({ ...it, options: safeJson(it.options, []) }));
    o.queue_label = `${getSettings().queue_prefix || ''}${String(o.queue_no).padStart(3, '0')}`;
    o.fees = safeJson(o.fees, []);
    o.tax_inclusive = !!o.tax_inclusive;
    return o;
  };

  // Versi pesanan yang aman untuk publik (meja & monitor) — tanpa data kasir.
  const publicOrder = (o) => ({
    id: o.id,
    queue_no: o.queue_no,
    queue_label: o.queue_label,
    table_name: o.table_name,
    customer_name: o.customer_name,
    status: o.status,
    payment_status: o.payment_status,
    order_type: o.order_type,
    total: o.total,
    subtotal: o.subtotal,
    service: o.service,
    tax: o.tax,
    discount: o.discount,
    fees: o.fees,
    tax_inclusive: o.tax_inclusive,
    payment_request: o.payment_request,
    note: o.note,
    created_at: o.created_at,
    ready_at: o.ready_at,
    items: o.items?.map((i) => ({ name: i.name, qty: i.qty, options: i.options, note: i.note, unit_price: i.unit_price, line_total: i.line_total })),
  });

  const queueSnapshot = () => {
    const date = businessDate();
    const rows = db
      .prepare(
        `SELECT id FROM orders WHERE business_date = ? AND (status IN ('pending','preparing','ready') OR (status = 'done' AND completed_at >= ?))
         ORDER BY queue_no`
      )
      .all(date, new Date(Date.now() - 5 * 60 * 1000).toISOString());
    return rows.map((r) => publicOrder(loadOrder(r.id)));
  };

  const broadcastOrder = (order) => {
    io.to('staff').emit('order:update', order);
    if (order.table_id) {
      const t = db.prepare('SELECT code FROM tables WHERE id = ?').get(order.table_id);
      if (t) io.to(`table:${t.code}`).emit('order:update', publicOrder(order));
    }
    io.to('monitor').emit('queue:update', queueSnapshot());
  };

  const announce = (order) => {
    const payload = {
      id: order.id,
      queue_no: order.queue_no,
      queue_label: order.queue_label,
      customer_name: order.customer_name,
      table_name: order.table_name,
      order_type: order.order_type,
      call_count: order.call_count,
      at: nowIso(),
    };
    io.to('monitor').emit('queue:announce', payload);
    io.to('staff').emit('queue:announce', payload);
    if (order.table_id) {
      const t = db.prepare('SELECT code FROM tables WHERE id = ?').get(order.table_id);
      if (t) io.to(`table:${t.code}`).emit('queue:announce', payload);
    }
  };

  // Menghitung harga dari data produk di server (harga dari klien tidak dipercaya).
  const priceItems = (items) => {
    if (!Array.isArray(items) || items.length === 0) throw bad('Keranjang masih kosong');
    if (items.length > 100) throw bad('Terlalu banyak item');
    const getProd = db.prepare('SELECT * FROM products WHERE id = ?');
    return items.map((raw) => {
      const p = parseProduct(getProd.get(Number(raw.product_id)));
      if (!p) throw bad('Produk tidak ditemukan');
      if (!p.available) throw bad(`${p.name} sedang habis`);
      const qty = Math.trunc(Number(raw.qty));
      if (!Number.isFinite(qty) || qty < 1 || qty > 99) throw bad(`Jumlah ${p.name} tidak valid`);
      const chosen = raw.options && typeof raw.options === 'object' ? raw.options : {};
      const picked = [];
      let extra = 0;
      for (const group of p.options) {
        let sel = chosen[group.name];
        if (sel == null || sel === '') sel = [];
        if (!Array.isArray(sel)) sel = [sel];
        if (!group.multi && sel.length > 1) throw bad(`Pilih satu ${group.name} untuk ${p.name}`);
        if (group.required && sel.length === 0) throw bad(`Pilih ${group.name} untuk ${p.name}`);
        for (const name of sel) {
          const c = group.choices.find((x) => x.name === name);
          if (!c) throw bad(`Pilihan ${group.name} tidak valid untuk ${p.name}`);
          extra += Number(c.price) || 0;
          picked.push({ group: group.name, name: c.name, price: Number(c.price) || 0 });
        }
      }
      const unit = p.price + extra;
      return {
        product_id: p.id,
        name: p.name,
        unit_price: unit,
        qty,
        options: picked,
        note: String(raw.note || '').slice(0, 200),
        line_total: unit * qty,
      };
    });
  };

  // Perhitungan total (sama persis dengan calcTotals di public/js/common.js).
  // Harga sudah termasuk PPN: PPN = bagian dari total, tidak ditambahkan.
  const computeTotals = (base, type, s) => {
    const fees = s.extra_fees
      .filter((f) => f.applies === 'all' || f.applies === type)
      .map((f) => ({ name: f.name, amount: Math.round(f.type === 'fixed' ? f.value : (base * f.value) / 100) }))
      .filter((f) => f.amount > 0 && base > 0);
    const service = fees.reduce((a, f) => a + f.amount, 0);
    const gross = base + service;
    const tax = s.tax_inclusive ? Math.round((gross * s.tax_percent) / (100 + s.tax_percent)) : Math.round((gross * s.tax_percent) / 100);
    const total = s.tax_inclusive ? gross : gross + tax;
    return { fees, service, tax, total };
  };

  const createOrder = ({ items, table, customer_name, note, order_type, source, cashier_id, discount = 0, payment_request = '' }) => {
    const priced = priceItems(items);
    const s = publicSettings();
    const subtotal = priced.reduce((a, b) => a + b.line_total, 0);
    const disc = Math.max(0, Math.min(subtotal, Math.trunc(Number(discount) || 0)));
    const base = subtotal - disc;
    const type = order_type === 'takeaway' ? 'takeaway' : 'dine_in';
    const t = computeTotals(base, type, s);
    const { service, tax, total, fees } = t;
    const date = businessDate();
    const autoAccept = source === 'kasir' || s.auto_accept;

    const id = tx(db, () => {
      const next = db.prepare('SELECT COALESCE(MAX(queue_no), 0) + 1 AS n FROM orders WHERE business_date = ?').get(date).n;
      const now = nowIso();
      const res = db
        .prepare(
          `INSERT INTO orders (queue_no, business_date, table_id, table_name, customer_name, note, order_type, source, status,
             subtotal, discount, service, tax, total, cashier_id, created_at, accepted_at, fees, tax_inclusive, payment_request)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
        )
        .run(
          next,
          date,
          table?.id ?? null,
          table?.name ?? '',
          String(customer_name || '').trim().slice(0, 40),
          String(note || '').slice(0, 300),
          type,
          source,
          autoAccept && !(s.require_payment_first && source !== 'kasir') ? 'preparing' : 'pending',
          subtotal,
          disc,
          service,
          tax,
          total,
          cashier_id ?? null,
          now,
          autoAccept ? now : null,
          JSON.stringify(fees),
          s.tax_inclusive ? 1 : 0,
          payment_request
        );
      const orderId = Number(res.lastInsertRowid);
      const insItem = db.prepare(
        'INSERT INTO order_items (order_id, product_id, name, unit_price, qty, options, note, line_total) VALUES (?, ?, ?, ?, ?, ?, ?, ?)'
      );
      for (const it of priced) insItem.run(orderId, it.product_id, it.name, it.unit_price, it.qty, JSON.stringify(it.options), it.note, it.line_total);
      const created = loadOrder(orderId);
      if (created.status !== 'pending') deductStock(created, cashier_id);
      return orderId;
    });
    const order = loadOrder(id);
    broadcastOrder(order);
    checkLowStock();
    if (order.status === 'pending') io.to('staff').emit('order:new', order);
    return order;
  };

  // ---------- Stok & HPP ----------
  // Kebutuhan bahan untuk 1 porsi item (resep dasar + resep per pilihan opsi).
  const itemRecipe = (productId, options) => {
    const chosen = new Set((options || []).map((o) => o.name));
    return db
      .prepare(
        `SELECT r.ingredient_id, r.qty, r.option_name, i.cost_per_unit FROM recipes r JOIN ingredients i ON i.id = r.ingredient_id WHERE r.product_id = ?`
      )
      .all(productId)
      .filter((r) => !r.option_name || chosen.has(r.option_name));
  };
  const productHasRecipe = (productId) => !!db.prepare('SELECT 1 FROM recipes WHERE product_id = ? LIMIT 1').get(productId);

  const deductStock = (order, userId) => {
    const date = order.business_date;
    const now = nowIso();
    const move = db.prepare(
      `INSERT INTO stock_movements (ingredient_id, type, qty, unit_cost, total_cost, order_id, note, business_date, user_id, created_at)
       VALUES (?, 'sale', ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    const updStock = db.prepare('UPDATE ingredients SET stock = stock - ? WHERE id = ?');
    const updItem = db.prepare('UPDATE order_items SET unit_cost = ? WHERE id = ?');
    let cogs = 0;
    for (const it of order.items) {
      let unitCost = 0;
      if (it.product_id && productHasRecipe(it.product_id)) {
        for (const r of itemRecipe(it.product_id, it.options)) {
          const used = r.qty * it.qty;
          unitCost += r.qty * r.cost_per_unit;
          updStock.run(used, r.ingredient_id);
          move.run(r.ingredient_id, -used, r.cost_per_unit, -Math.round(used * r.cost_per_unit), order.id, `Pesanan ${order.queue_label}`, date, userId ?? null, now);
        }
      } else if (it.product_id) {
        unitCost = db.prepare('SELECT cost FROM products WHERE id = ?').get(it.product_id)?.cost || 0;
      }
      unitCost = Math.round(unitCost);
      updItem.run(unitCost, it.id);
      cogs += unitCost * it.qty;
    }
    db.prepare('UPDATE orders SET stock_deducted = 1, cogs = ? WHERE id = ?').run(cogs, order.id);
  };

  const restoreStock = (order, userId) => {
    const now = nowIso();
    const sales = db.prepare(`SELECT ingredient_id, qty, unit_cost FROM stock_movements WHERE order_id = ? AND type = 'sale'`).all(order.id);
    const move = db.prepare(
      `INSERT INTO stock_movements (ingredient_id, type, qty, unit_cost, total_cost, order_id, note, business_date, user_id, created_at)
       VALUES (?, 'return', ?, ?, ?, ?, ?, ?, ?, ?)`
    );
    for (const m of sales) {
      db.prepare('UPDATE ingredients SET stock = stock + ? WHERE id = ?').run(-m.qty, m.ingredient_id);
      move.run(m.ingredient_id, -m.qty, m.unit_cost, -Math.round(m.qty * m.unit_cost), order.id, `Batal ${order.queue_label}`, order.business_date, userId ?? null, now);
    }
    db.prepare('UPDATE orders SET stock_deducted = 0, cogs = 0 WHERE id = ?').run(order.id);
  };

  const lowStockList = () =>
    db.prepare('SELECT id, name, unit, stock, min_stock FROM ingredients WHERE active = 1 AND min_stock > 0 AND stock <= min_stock ORDER BY name').all();
  let lastLowStockKey = '';
  const checkLowStock = () => {
    const list = lowStockList();
    const key = list.map((x) => x.id).join(',');
    if (key !== lastLowStockKey) {
      lastLowStockKey = key;
      io.to('staff').emit('stock:low', list);
    }
  };

  const setStatus = (id, status, extra = {}) => {
    const o = loadOrder(id);
    if (!o) throw new HttpError(404, 'Pesanan tidak ditemukan');
    if (!ALL_STATUSES.includes(status)) throw bad('Status tidak valid');
    if (['done', 'cancelled'].includes(o.status) && status !== o.status && !extra.force) {
      throw bad('Pesanan sudah ditutup');
    }
    const now = nowIso();
    const fields = { status };
    if (status === 'preparing' && !o.accepted_at) fields.accepted_at = now;
    if (status === 'ready') {
      fields.ready_at = now;
      fields.call_count = o.call_count + 1;
    }
    if (status === 'done') fields.completed_at = now;
    if (status === 'cancelled') fields.cancel_reason = String(extra.reason || '').slice(0, 200);
    const keys = Object.keys(fields);
    tx(db, () => {
      db.prepare(`UPDATE orders SET ${keys.map((k) => `${k} = ?`).join(', ')} WHERE id = ?`).run(...keys.map((k) => fields[k]), id);
      if (['preparing', 'ready', 'done'].includes(status) && !o.stock_deducted) deductStock(o, extra.userId);
      if (status === 'cancelled' && o.stock_deducted) restoreStock(o, extra.userId);
    });
    const updated = loadOrder(id);
    checkLowStock();
    broadcastOrder(updated);
    if (status === 'ready') announce(updated);
    return updated;
  };

  // ---------- Auth ----------
  const loginAttempts = new Map(); // ip -> {count, until}
  const auth = (...roles) => (req) => {
    const h = req.get('authorization') || '';
    const token = h.startsWith('Bearer ') ? h.slice(7) : '';
    const user = token && userFromToken(token);
    if (!user) throw new HttpError(401, 'Silakan login ulang');
    if (roles.length && !roles.includes(user.role) && user.role !== 'superadmin') {
      throw new HttpError(403, 'Akses ditolak untuk peran ini');
    }
    req.user = user;
  };
  const userFromToken = (token) => {
    const row = db
      .prepare(
        `SELECT u.id, u.name, u.role FROM sessions s JOIN users u ON u.id = s.user_id
         WHERE s.token = ? AND u.active = 1 AND s.last_seen >= datetime('now', '-14 days')`
      )
      .get(token);
    if (row) db.prepare("UPDATE sessions SET last_seen = datetime('now') WHERE token = ?").run(token);
    return row || null;
  };

  const api = new Router();
  const wrap = (fn) => fn;

  api.post(
    '/auth/login',
    wrap(async (req) => {
      const ip = req.ip;
      const att = loginAttempts.get(ip) || { count: 0, until: 0 };
      if (att.until > Date.now()) throw new HttpError(429, 'Terlalu banyak percobaan, tunggu 1 menit');
      const pin = String(req.body?.pin || '');
      const users = db.prepare('SELECT * FROM users WHERE active = 1').all();
      let user = null;
      for (const u of users) if (await verifyPin(pin, u.pin_hash)) { user = u; break; }
      if (!user) {
        att.count += 1;
        if (att.count >= 5) Object.assign(att, { count: 0, until: Date.now() + 60_000 });
        loginAttempts.set(ip, att);
        throw new HttpError(401, 'PIN salah');
      }
      loginAttempts.delete(ip);
      const token = randomToken(24);
      db.prepare('INSERT INTO sessions (token, user_id) VALUES (?, ?)').run(token, user.id);
      return { token, user: { id: user.id, name: user.name, role: user.role } };
    })
  );
  api.get('/auth/me', auth(), wrap((req) => ({ user: req.user })));
  api.post(
    '/auth/logout',
    auth(),
    wrap((req) => {
      db.prepare('DELETE FROM sessions WHERE token = ?').run(req.get('authorization').slice(7));
      return { ok: true };
    })
  );

  // ---------- Publik (tablet meja & monitor) ----------
  const menu = (onlyAvailable) => ({
    categories: db.prepare('SELECT * FROM categories ORDER BY sort, id').all(),
    products: db
      .prepare('SELECT * FROM products ORDER BY sort, id')
      .all()
      .map(parseProduct)
      .map((p) => (onlyAvailable ? (({ cost, ...rest }) => rest)(p) : p)),
  });

  api.get('/public/settings', wrap(() => publicSettings()));
  api.get('/public/menu', wrap(() => menu(true)));
  const tableByCode = (code) => {
    const t = db.prepare('SELECT id, name, code FROM tables WHERE code = ? AND active = 1').get(String(code));
    if (!t) throw new HttpError(404, 'Meja tidak dikenal. Hubungi kasir.');
    return t;
  };
  api.get('/public/tables/:code', wrap((req) => tableByCode(req.params.code)));
  api.get(
    '/public/tables/:code/orders',
    wrap((req) => {
      const t = tableByCode(req.params.code);
      const rows = db
        .prepare(`SELECT id FROM orders WHERE table_id = ? AND business_date = ? AND status != 'cancelled' ORDER BY id DESC LIMIT 20`)
        .all(t.id, businessDate());
      return rows.map((r) => publicOrder(loadOrder(r.id)));
    })
  );
  const tableOrderRate = new Map(); // code -> timestamps
  api.post(
    '/public/tables/:code/orders',
    wrap((req) => {
      const t = tableByCode(req.params.code);
      const now = Date.now();
      const recent = (tableOrderRate.get(t.code) || []).filter((x) => now - x < 60_000);
      if (recent.length >= 5) throw new HttpError(429, 'Terlalu banyak pesanan dalam 1 menit, mohon tunggu sebentar');
      recent.push(now);
      tableOrderRate.set(t.code, recent);
      const b = req.body || {};
      const order = createOrder({
        items: b.items,
        table: t,
        customer_name: b.customer_name,
        note: b.note,
        order_type: b.order_type,
        source: 'meja',
        payment_request: b.payment === 'qris' && publicSettings().qris_enabled ? 'QRIS' : '',
      });
      return publicOrder(order);
    })
  );
  const waiterCalls = new Map();
  api.post(
    '/public/tables/:code/call-waiter',
    wrap((req) => {
      const t = tableByCode(req.params.code);
      const last = waiterCalls.get(t.code) || 0;
      if (Date.now() - last < 30_000) return { ok: true, throttled: true };
      waiterCalls.set(t.code, Date.now());
      const reason = String(req.body?.reason || 'Memanggil pelayan').slice(0, 80);
      io.to('staff').emit('waiter:call', { table_name: t.name, reason, at: nowIso() });
      return { ok: true };
    })
  );
  // ---------- QRIS ----------
  const tableOrder = (code, id) => {
    const t = tableByCode(code);
    const o = loadOrder(Number(id));
    if (!o || o.table_id !== t.id) throw new HttpError(404, 'Pesanan tidak ditemukan');
    return o;
  };
  api.get(
    '/public/tables/:code/orders/:id/qris',
    wrap(async (req) => {
      const o = tableOrder(req.params.code, req.params.id);
      if (o.payment_status === 'paid') throw bad('Pesanan sudah lunas');
      if (o.status === 'cancelled') throw bad('Pesanan dibatalkan');
      if (o.payment_request !== 'QRIS' && o.payment_request !== 'QRIS_CLAIMED') {
        db.prepare("UPDATE orders SET payment_request = 'QRIS' WHERE id = ?").run(o.id);
        broadcastOrder(loadOrder(o.id));
      }
      return { ...(await qrisSvg(o.total)), queue_label: o.queue_label };
    })
  );
  // Pelanggan menekan "Saya sudah bayar" -> kasir mendapat notifikasi untuk verifikasi
  api.post(
    '/public/tables/:code/orders/:id/qris-claim',
    wrap((req) => {
      const o = tableOrder(req.params.code, req.params.id);
      if (o.payment_status === 'paid') return publicOrder(o);
      db.prepare("UPDATE orders SET payment_request = 'QRIS_CLAIMED' WHERE id = ?").run(o.id);
      const updated = loadOrder(o.id);
      broadcastOrder(updated);
      io.to('staff').emit('payment:claim', { id: o.id, queue_label: o.queue_label, table_name: o.table_name, customer_name: o.customer_name, total: o.total });
      return publicOrder(updated);
    })
  );
  api.get('/qris', auth('kasir'), wrap((req) => qrisSvg(Number(req.query.amount))));
  api.get('/orders/:id/qris', auth('kasir'), wrap((req) => {
    const o = loadOrder(Number(req.params.id));
    if (!o) throw new HttpError(404, 'Pesanan tidak ditemukan');
    return qrisSvg(o.total);
  }));
  api.post(
    '/admin/qris/inspect',
    auth('superadmin'),
    wrap(async (req) => {
      try {
        const info = inspectQris(req.body?.payload);
        const sample = qrisWithAmount(info.payload, 1000);
        return { ...info, sample_svg: await QRCode.toString(sample, { type: 'svg', margin: 2, width: 240 }) };
      } catch (e) {
        throw bad(e.message);
      }
    })
  );

  api.get('/public/queue', wrap(() => ({ settings: publicSettings(), orders: queueSnapshot() })));

  // ---------- Pesanan (staf) ----------
  api.get(
    '/orders',
    auth('kasir'),
    wrap((req) => {
      const date = /^\d{4}-\d{2}-\d{2}$/.test(req.query.date || '') ? req.query.date : businessDate();
      let sql = 'SELECT id FROM orders WHERE business_date = ?';
      const params = [date];
      if (req.query.scope === 'active') sql += ` AND status IN ('pending','preparing','ready')`;
      sql += ' ORDER BY queue_no DESC';
      return { date, orders: db.prepare(sql).all(...params).map((r) => loadOrder(r.id)) };
    })
  );
  api.get(
    '/orders/:id',
    auth('kasir'),
    wrap((req) => {
      const o = loadOrder(Number(req.params.id));
      if (!o) throw new HttpError(404, 'Pesanan tidak ditemukan');
      return o;
    })
  );
  api.post(
    '/orders',
    auth('kasir'),
    wrap((req) => {
      const b = req.body || {};
      let table = null;
      if (b.table_id) {
        table = db.prepare('SELECT id, name, code FROM tables WHERE id = ?').get(Number(b.table_id));
        if (!table) throw bad('Meja tidak ditemukan');
      }
      const order = createOrder({
        items: b.items,
        table,
        customer_name: b.customer_name,
        note: b.note,
        order_type: b.order_type,
        source: 'kasir',
        cashier_id: req.user.id,
        discount: b.discount,
      });
      if (b.payment) return payOrder(order.id, b.payment, req.user);
      return order;
    })
  );
  const payOrder = (id, { method, paid_amount }, user) => {
    const o = loadOrder(id);
    if (!o) throw new HttpError(404, 'Pesanan tidak ditemukan');
    if (o.status === 'cancelled') throw bad('Pesanan dibatalkan');
    if (o.payment_status === 'paid') throw bad('Pesanan sudah lunas');
    const methods = publicSettings().payment_methods;
    if (!methods.includes(method)) throw bad('Metode pembayaran tidak valid');
    const paid = method === 'Tunai' ? Math.trunc(Number(paid_amount) || 0) : o.total;
    if (paid < o.total) throw bad('Uang yang dibayarkan kurang');
    const now = nowIso();
    db.prepare(
      `UPDATE orders SET payment_status = 'paid', payment_method = ?, paid_amount = ?, change_amount = ?, paid_at = ?, cashier_id = ? WHERE id = ?`
    ).run(method, paid, paid - o.total, now, user.id, id);
    let updated = loadOrder(id);
    // Pesanan yang sudah lunas otomatis masuk antrean dapur.
    if (updated.status === 'pending') {
      updated = setStatus(id, 'preparing', { userId: user.id });
    } else broadcastOrder(updated);
    return updated;
  };
  api.post('/orders/:id/pay', auth('kasir'), wrap((req) => payOrder(Number(req.params.id), req.body || {}, req.user)));
  api.post(
    '/orders/:id/status',
    auth('kasir'),
    wrap((req) => {
      const status = String(req.body?.status || '');
      return setStatus(Number(req.params.id), status, { reason: req.body?.reason, userId: req.user.id });
    })
  );
  api.post(
    '/orders/:id/call',
    auth('kasir'),
    wrap((req) => {
      const o = loadOrder(Number(req.params.id));
      if (!o) throw new HttpError(404, 'Pesanan tidak ditemukan');
      if (o.status !== 'ready') throw bad('Pesanan belum siap');
      db.prepare('UPDATE orders SET call_count = call_count + 1 WHERE id = ?').run(o.id);
      const updated = loadOrder(o.id);
      announce(updated);
      io.to('staff').emit('order:update', updated);
      return updated;
    })
  );

  // ---------- Admin: menu ----------
  api.get('/admin/menu', auth('kasir'), wrap((req) => {
    const m = menu(false);
    if (req.user.role !== 'superadmin') m.products = m.products.map(({ cost, ...p }) => p);
    else {
      const recipeCost = db.prepare(`SELECT r.product_id, SUM(r.qty * i.cost_per_unit) AS c, COUNT(*) AS n FROM recipes r JOIN ingredients i ON i.id = r.ingredient_id WHERE r.option_name = '' GROUP BY r.product_id`).all();
      const hasRecipe = new Set(db.prepare('SELECT DISTINCT product_id FROM recipes').all().map((r) => r.product_id));
      m.products = m.products.map((p) => ({ ...p, has_recipe: hasRecipe.has(p.id), hpp: hasRecipe.has(p.id) ? Math.round(recipeCost.find((r) => r.product_id === p.id)?.c || 0) : p.cost }));
    }
    return m;
  }));
  api.patch(
    '/products/:id/availability',
    auth('kasir'),
    wrap((req) => {
      db.prepare('UPDATE products SET available = ? WHERE id = ?').run(req.body?.available ? 1 : 0, Number(req.params.id));
      io.emit('menu:changed');
      return parseProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(Number(req.params.id)));
    })
  );
  const validOptions = (opts) => {
    if (!Array.isArray(opts)) return [];
    return opts
      .filter((g) => g && String(g.name || '').trim())
      .map((g) => ({
        name: String(g.name).trim().slice(0, 40),
        required: !!g.required,
        multi: !!g.multi,
        choices: (Array.isArray(g.choices) ? g.choices : [])
          .filter((c) => c && String(c.name || '').trim())
          .map((c) => ({ name: String(c.name).trim().slice(0, 40), price: Math.max(0, Math.trunc(Number(c.price) || 0)) })),
      }))
      .filter((g) => g.choices.length > 0);
  };
  const productFields = (b) => {
    const name = String(b.name || '').trim();
    if (!name) throw bad('Nama produk wajib diisi');
    const price = Math.trunc(Number(b.price));
    if (!Number.isFinite(price) || price < 0) throw bad('Harga tidak valid');
    const image = String(b.image || '');
    if (image && !/^data:image\/(png|jpe?g|webp|gif);base64,/.test(image) && !/^https?:\/\//.test(image) && !image.startsWith('/')) {
      throw bad('Format gambar tidak didukung');
    }
    return [
      b.category_id ? Number(b.category_id) : null,
      name.slice(0, 80),
      String(b.description || '').slice(0, 300),
      price,
      Math.max(0, Math.trunc(Number(b.cost) || 0)),
      image,
      JSON.stringify(validOptions(b.options)),
      b.available === false ? 0 : 1,
      Math.trunc(Number(b.sort) || 0),
    ];
  };
  api.post(
    '/admin/products',
    auth('superadmin'),
    wrap((req) => {
      const r = db
        .prepare('INSERT INTO products (category_id, name, description, price, cost, image, options, available, sort) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)')
        .run(...productFields(req.body || {}));
      io.emit('menu:changed');
      return parseProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(r.lastInsertRowid));
    })
  );
  api.put(
    '/admin/products/:id',
    auth('superadmin'),
    wrap((req) => {
      const id = Number(req.params.id);
      db.prepare('UPDATE products SET category_id = ?, name = ?, description = ?, price = ?, cost = ?, image = ?, options = ?, available = ?, sort = ? WHERE id = ?').run(
        ...productFields(req.body || {}),
        id
      );
      io.emit('menu:changed');
      return parseProduct(db.prepare('SELECT * FROM products WHERE id = ?').get(id));
    })
  );
  api.delete(
    '/admin/products/:id',
    auth('superadmin'),
    wrap((req) => {
      db.prepare('DELETE FROM products WHERE id = ?').run(Number(req.params.id));
      io.emit('menu:changed');
      return { ok: true };
    })
  );
  api.post(
    '/admin/categories',
    auth('superadmin'),
    wrap((req) => {
      const name = String(req.body?.name || '').trim();
      if (!name) throw bad('Nama kategori wajib diisi');
      const r = db.prepare('INSERT INTO categories (name, icon, sort) VALUES (?, ?, ?)').run(name.slice(0, 40), String(req.body?.icon || '').slice(0, 8), Math.trunc(Number(req.body?.sort) || 0));
      io.emit('menu:changed');
      return db.prepare('SELECT * FROM categories WHERE id = ?').get(r.lastInsertRowid);
    })
  );
  api.put(
    '/admin/categories/:id',
    auth('superadmin'),
    wrap((req) => {
      const name = String(req.body?.name || '').trim();
      if (!name) throw bad('Nama kategori wajib diisi');
      db.prepare('UPDATE categories SET name = ?, icon = ?, sort = ? WHERE id = ?').run(name.slice(0, 40), String(req.body?.icon || '').slice(0, 8), Math.trunc(Number(req.body?.sort) || 0), Number(req.params.id));
      io.emit('menu:changed');
      return db.prepare('SELECT * FROM categories WHERE id = ?').get(Number(req.params.id));
    })
  );
  api.delete(
    '/admin/categories/:id',
    auth('superadmin'),
    wrap((req) => {
      db.prepare('DELETE FROM categories WHERE id = ?').run(Number(req.params.id));
      io.emit('menu:changed');
      return { ok: true };
    })
  );

  // ---------- Admin: meja ----------
  api.get('/tables', auth('kasir'), wrap(() => db.prepare('SELECT * FROM tables ORDER BY id').all()));
  api.post(
    '/admin/tables',
    auth('superadmin'),
    wrap((req) => {
      const name = String(req.body?.name || '').trim();
      if (!name) throw bad('Nama meja wajib diisi');
      const r = db.prepare('INSERT INTO tables (name, code) VALUES (?, ?)').run(name.slice(0, 30), randomCode(6));
      return db.prepare('SELECT * FROM tables WHERE id = ?').get(r.lastInsertRowid);
    })
  );
  api.put(
    '/admin/tables/:id',
    auth('superadmin'),
    wrap((req) => {
      const id = Number(req.params.id);
      const name = String(req.body?.name || '').trim();
      if (!name) throw bad('Nama meja wajib diisi');
      db.prepare('UPDATE tables SET name = ?, active = ? WHERE id = ?').run(name.slice(0, 30), req.body?.active === false ? 0 : 1, id);
      if (req.body?.regenerate) db.prepare('UPDATE tables SET code = ? WHERE id = ?').run(randomCode(6), id);
      return db.prepare('SELECT * FROM tables WHERE id = ?').get(id);
    })
  );
  api.delete(
    '/admin/tables/:id',
    auth('superadmin'),
    wrap((req) => {
      db.prepare('DELETE FROM tables WHERE id = ?').run(Number(req.params.id));
      return { ok: true };
    })
  );
  api.get(
    '/tables/:id/qr',
    auth('kasir'),
    wrap(async (req) => {
      const t = db.prepare('SELECT * FROM tables WHERE id = ?').get(Number(req.params.id));
      if (!t) throw new HttpError(404, 'Meja tidak ditemukan');
      const base = String(req.query.base || req.origin).replace(/\/$/, '');
      const url = `${base}/meja.html?t=${t.code}`;
      const svg = await QRCode.toString(url, { type: 'svg', margin: 1, width: 300 });
      return { url, svg };
    })
  );

  // ---------- Admin: pengguna ----------
  api.get('/admin/users', auth('superadmin'), wrap(() => db.prepare('SELECT id, name, role, active, created_at FROM users ORDER BY id').all()));
  const pinTaken = async (pin, exceptId) => {
    for (const u of db.prepare('SELECT id, pin_hash FROM users').all()) {
      if (u.id !== exceptId && (await verifyPin(pin, u.pin_hash))) return true;
    }
    return false;
  };
  const checkPin = (pin) => {
    if (!/^\d{4,8}$/.test(pin)) throw bad('PIN harus 4–8 digit angka');
  };
  api.post(
    '/admin/users',
    auth('superadmin'),
    wrap(async (req) => {
      const { name, role } = req.body || {};
      const pin = String(req.body?.pin || '');
      if (!String(name || '').trim()) throw bad('Nama wajib diisi');
      if (!['superadmin', 'kasir'].includes(role)) throw bad('Peran tidak valid');
      checkPin(pin);
      if (await pinTaken(pin)) throw bad('PIN sudah dipakai pengguna lain');
      const r = db.prepare('INSERT INTO users (name, role, pin_hash) VALUES (?, ?, ?)').run(String(name).trim().slice(0, 40), role, await hashPin(pin));
      return db.prepare('SELECT id, name, role, active FROM users WHERE id = ?').get(r.lastInsertRowid);
    })
  );
  api.put(
    '/admin/users/:id',
    auth('superadmin'),
    wrap(async (req) => {
      const id = Number(req.params.id);
      const { name, role } = req.body || {};
      const active = req.body?.active === false ? 0 : 1;
      if (!String(name || '').trim()) throw bad('Nama wajib diisi');
      if (!['superadmin', 'kasir'].includes(role)) throw bad('Peran tidak valid');
      if (id === req.user.id && (role !== 'superadmin' || !active)) throw bad('Tidak bisa menurunkan/menonaktifkan akun sendiri');
      db.prepare('UPDATE users SET name = ?, role = ?, active = ? WHERE id = ?').run(String(name).trim().slice(0, 40), role, active, id);
      if (req.body?.pin) {
        const pin = String(req.body.pin);
        checkPin(pin);
        if (await pinTaken(pin, id)) throw bad('PIN sudah dipakai pengguna lain');
        db.prepare('UPDATE users SET pin_hash = ? WHERE id = ?').run(await hashPin(pin), id);
      }
      if (!active) db.prepare('DELETE FROM sessions WHERE user_id = ?').run(id);
      return db.prepare('SELECT id, name, role, active FROM users WHERE id = ?').get(id);
    })
  );
  api.delete(
    '/admin/users/:id',
    auth('superadmin'),
    wrap((req) => {
      const id = Number(req.params.id);
      if (id === req.user.id) throw bad('Tidak bisa menghapus akun sendiri');
      db.prepare('DELETE FROM users WHERE id = ?').run(id);
      return { ok: true };
    })
  );

  // ---------- Admin: pengaturan ----------
  api.get('/admin/settings', auth('superadmin'), wrap(() => getSettings()));
  api.put(
    '/admin/settings',
    auth('superadmin'),
    wrap((req) => {
      const b = req.body || {};
      const up = db.prepare('INSERT INTO settings (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value');
      const merged = { ...getSettings(), ...b };
      if (String(merged.qris_enabled) === '1' && !String(merged.qris_payload || '').trim()) throw bad('Isi kode QRIS terlebih dahulu sebelum mengaktifkan QRIS');
      for (const key of Object.keys(DEFAULT_SETTINGS)) {
        if (b[key] === undefined) continue;
        let v = String(b[key]).slice(0, key === 'extra_fees' || key === 'qris_payload' ? 4000 : 500);
        if (key === 'extra_fees') {
          let parsed;
          try {
            parsed = JSON.parse(v);
          } catch {
            throw bad('Format biaya tambahan tidak valid');
          }
          if (!Array.isArray(parsed)) throw bad('Format biaya tambahan tidak valid');
          v = JSON.stringify(parseFees({ extra_fees: v, service_percent: 0 }));
        }
        if (key === 'tax_percent' && !(Number(v) >= 0 && Number(v) <= 100)) throw bad('Persentase PPN tidak valid');
        if (key === 'qris_payload' && v.trim()) {
          try {
            v = inspectQris(v).payload;
          } catch (e) {
            throw bad(e.message);
          }
        }
        if (key === 'timezone') {
          try {
            new Intl.DateTimeFormat('en', { timeZone: v });
          } catch {
            throw bad('Zona waktu tidak valid');
          }
        }
        up.run(key, v);
      }
      const s = publicSettings();
      io.emit('settings:changed', s);
      return getSettings();
    })
  );

  // ---------- Stok bahan baku ----------
  const ingredientFields = (b) => {
    const name = String(b.name || '').trim();
    if (!name) throw bad('Nama bahan wajib diisi');
    const num = (v, label) => {
      const n = Number(v ?? 0);
      if (!Number.isFinite(n) || n < 0) throw bad(`${label} tidak valid`);
      return n;
    };
    return [name.slice(0, 60), String(b.unit || 'pcs').trim().slice(0, 10) || 'pcs', num(b.min_stock, 'Stok minimum'), num(b.cost_per_unit, 'Harga per satuan'), b.active === false ? 0 : 1];
  };
  api.get(
    '/stock/ingredients',
    auth('kasir'),
    wrap(() => db.prepare('SELECT *, (min_stock > 0 AND stock <= min_stock) AS low FROM ingredients ORDER BY active DESC, name').all())
  );
  api.post(
    '/stock/ingredients',
    auth('superadmin'),
    wrap((req) => {
      const f = ingredientFields(req.body || {});
      const r = db.prepare('INSERT INTO ingredients (name, unit, min_stock, cost_per_unit, active) VALUES (?, ?, ?, ?, ?)').run(...f);
      const id = Number(r.lastInsertRowid);
      const initial = Number(req.body?.stock) || 0;
      if (initial > 0) addMovement({ ingredient_id: id, type: 'adjust', qty: initial, note: 'Stok awal' }, req.user.id);
      return db.prepare('SELECT * FROM ingredients WHERE id = ?').get(id);
    })
  );
  api.put(
    '/stock/ingredients/:id',
    auth('superadmin'),
    wrap((req) => {
      const id = Number(req.params.id);
      db.prepare('UPDATE ingredients SET name = ?, unit = ?, min_stock = ?, cost_per_unit = ?, active = ? WHERE id = ?').run(...ingredientFields(req.body || {}), id);
      checkLowStock();
      return db.prepare('SELECT * FROM ingredients WHERE id = ?').get(id);
    })
  );
  api.delete(
    '/stock/ingredients/:id',
    auth('superadmin'),
    wrap((req) => {
      db.prepare('DELETE FROM ingredients WHERE id = ?').run(Number(req.params.id));
      return { ok: true };
    })
  );

  // Mutasi stok manual: pembelian (stok masuk), opname (penyesuaian ke jumlah fisik), terbuang/rusak.
  const addMovement = ({ ingredient_id, type, qty, total_cost, counted, note }, userId) => {
    const ing = db.prepare('SELECT * FROM ingredients WHERE id = ?').get(Number(ingredient_id));
    if (!ing) throw new HttpError(404, 'Bahan tidak ditemukan');
    let delta;
    let unitCost = ing.cost_per_unit;
    if (type === 'purchase') {
      delta = Number(qty);
      if (!(delta > 0)) throw bad('Jumlah pembelian harus lebih dari 0');
      const cost = Math.trunc(Number(total_cost));
      if (!Number.isFinite(cost) || cost < 0) throw bad('Total harga beli tidak valid');
      unitCost = cost / delta;
      // Harga pokok rata-rata tertimbang (moving average)
      const oldQty = Math.max(0, ing.stock);
      const newAvg = oldQty + delta > 0 ? (oldQty * ing.cost_per_unit + cost) / (oldQty + delta) : unitCost;
      db.prepare('UPDATE ingredients SET cost_per_unit = ? WHERE id = ?').run(Math.round(newAvg * 100) / 100, ing.id);
    } else if (type === 'waste') {
      delta = -Math.abs(Number(qty));
      if (!delta) throw bad('Jumlah tidak valid');
    } else if (type === 'adjust') {
      if (counted !== undefined && counted !== null && counted !== '') {
        const c = Number(counted);
        if (!Number.isFinite(c) || c < 0) throw bad('Jumlah fisik tidak valid');
        delta = c - ing.stock;
      } else delta = Number(qty);
      if (!Number.isFinite(delta)) throw bad('Jumlah tidak valid');
    } else throw bad('Jenis mutasi tidak valid');
    const totalCost = type === 'purchase' ? Math.trunc(Number(total_cost)) : Math.round(delta * unitCost);
    tx(db, () => {
      db.prepare('UPDATE ingredients SET stock = stock + ? WHERE id = ?').run(delta, ing.id);
      db.prepare(
        `INSERT INTO stock_movements (ingredient_id, type, qty, unit_cost, total_cost, note, business_date, user_id, created_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
      ).run(ing.id, type, delta, unitCost, totalCost, String(note || '').slice(0, 200), businessDate(), userId ?? null, nowIso());
    });
    checkLowStock();
    return db.prepare('SELECT * FROM ingredients WHERE id = ?').get(ing.id);
  };
  api.post(
    '/stock/movements',
    auth('kasir'),
    wrap((req) => {
      const b = req.body || {};
      if (req.user.role !== 'superadmin' && b.type === 'adjust') throw new HttpError(403, 'Stok opname hanya untuk superadmin');
      return addMovement(b, req.user.id);
    })
  );
  api.get(
    '/stock/movements',
    auth('kasir'),
    wrap((req) => {
      const re = /^\d{4}-\d{2}-\d{2}$/;
      const from = re.test(req.query.from || '') ? req.query.from : businessDate();
      const to = re.test(req.query.to || '') ? req.query.to : from;
      const params = [from, to];
      let extra = '';
      if (req.query.ingredient_id) {
        extra = ' AND m.ingredient_id = ?';
        params.push(Number(req.query.ingredient_id));
      }
      if (req.query.type) {
        extra += ' AND m.type = ?';
        params.push(String(req.query.type));
      }
      return db
        .prepare(
          `SELECT m.*, i.name AS ingredient_name, i.unit, u.name AS user_name FROM stock_movements m
           JOIN ingredients i ON i.id = m.ingredient_id LEFT JOIN users u ON u.id = m.user_id
           WHERE m.business_date BETWEEN ? AND ?${extra} ORDER BY m.id DESC LIMIT 500`
        )
        .all(...params);
    })
  );

  // Resep per produk
  api.get(
    '/products/:id/recipe',
    auth('superadmin'),
    wrap((req) => {
      const id = Number(req.params.id);
      const rows = db
        .prepare(`SELECT r.*, i.name AS ingredient_name, i.unit, i.cost_per_unit FROM recipes r JOIN ingredients i ON i.id = r.ingredient_id WHERE r.product_id = ? ORDER BY r.option_name, r.id`)
        .all(id);
      const base = rows.filter((r) => !r.option_name).reduce((a, r) => a + r.qty * r.cost_per_unit, 0);
      return { items: rows, base_cost: Math.round(base) };
    })
  );
  api.put(
    '/products/:id/recipe',
    auth('superadmin'),
    wrap((req) => {
      const id = Number(req.params.id);
      if (!db.prepare('SELECT 1 FROM products WHERE id = ?').get(id)) throw new HttpError(404, 'Produk tidak ditemukan');
      const items = Array.isArray(req.body?.items) ? req.body.items : [];
      tx(db, () => {
        db.prepare('DELETE FROM recipes WHERE product_id = ?').run(id);
        const ins = db.prepare('INSERT INTO recipes (product_id, ingredient_id, qty, option_name) VALUES (?, ?, ?, ?)');
        for (const it of items) {
          const qty = Number(it.qty);
          if (!(qty > 0)) continue;
          if (!db.prepare('SELECT 1 FROM ingredients WHERE id = ?').get(Number(it.ingredient_id))) throw bad('Bahan tidak ditemukan');
          ins.run(id, Number(it.ingredient_id), qty, String(it.option_name || '').slice(0, 40));
        }
      });
      return { ok: true };
    })
  );

  // ---------- Keuangan: pengeluaran & pemasukan lain ----------
  api.get(
    '/finance/entries',
    auth('kasir'),
    wrap((req) => {
      const re = /^\d{4}-\d{2}-\d{2}$/;
      const from = re.test(req.query.from || '') ? req.query.from : businessDate();
      const to = re.test(req.query.to || '') ? req.query.to : from;
      return db
        .prepare(`SELECT c.*, u.name AS user_name FROM cash_entries c LEFT JOIN users u ON u.id = c.user_id WHERE c.business_date BETWEEN ? AND ? ORDER BY c.business_date DESC, c.id DESC`)
        .all(from, to);
    })
  );
  api.post(
    '/finance/entries',
    auth('kasir'),
    wrap((req) => {
      const b = req.body || {};
      if (!['expense', 'income'].includes(b.type)) throw bad('Jenis transaksi tidak valid');
      const amount = Math.trunc(Number(b.amount));
      if (!(amount > 0)) throw bad('Nominal harus lebih dari 0');
      const category = String(b.category || '').trim();
      if (!category) throw bad('Kategori wajib diisi');
      let date = businessDate();
      if (/^\d{4}-\d{2}-\d{2}$/.test(b.business_date || '')) {
        if (req.user.role !== 'superadmin' && b.business_date !== date) throw new HttpError(403, 'Kasir hanya dapat mencatat transaksi hari ini');
        date = b.business_date;
      }
      const r = db
        .prepare('INSERT INTO cash_entries (type, category, description, amount, business_date, user_id, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)')
        .run(b.type, category.slice(0, 40), String(b.description || '').slice(0, 200), amount, date, req.user.id, nowIso());
      return db.prepare('SELECT * FROM cash_entries WHERE id = ?').get(r.lastInsertRowid);
    })
  );
  api.delete(
    '/finance/entries/:id',
    auth('superadmin'),
    wrap((req) => {
      db.prepare('DELETE FROM cash_entries WHERE id = ?').run(Number(req.params.id));
      return { ok: true };
    })
  );

  // ---------- Laporan ----------
  // period: day (YYYY-MM-DD) | month (YYYY-MM) | year (YYYY) | range (from,to)
  const resolvePeriod = (q) => {
    const today = businessDate();
    const period = ['day', 'month', 'year', 'range'].includes(q.period) ? q.period : 'day';
    let from, to, groupExpr, label;
    if (period === 'day') {
      from = to = /^\d{4}-\d{2}-\d{2}$/.test(q.value || '') ? q.value : today;
      label = from;
    } else if (period === 'month') {
      const m = /^\d{4}-\d{2}$/.test(q.value || '') ? q.value : today.slice(0, 7);
      const [y, mm] = m.split('-').map(Number);
      const last = new Date(Date.UTC(y, mm, 0)).getUTCDate();
      from = `${m}-01`;
      to = `${m}-${String(last).padStart(2, '0')}`;
      label = m;
    } else if (period === 'year') {
      const y = /^\d{4}$/.test(q.value || '') ? q.value : today.slice(0, 4);
      from = `${y}-01-01`;
      to = `${y}-12-31`;
      label = y;
    } else {
      const re = /^\d{4}-\d{2}-\d{2}$/;
      from = re.test(q.from || '') ? q.from : today;
      to = re.test(q.to || '') ? q.to : from;
      if (to < from) [from, to] = [to, from];
      label = `${from} s/d ${to}`;
    }
    groupExpr = period === 'year' ? 'substr(business_date, 1, 7)' : 'business_date';
    return { period, from, to, label, groupExpr };
  };

  const buildReport = (q, withProfit) => {
    const { period, from, to, label, groupExpr } = resolvePeriod(q);
    const paid = `business_date BETWEEN ? AND ? AND status != 'cancelled' AND payment_status = 'paid'`;
    const sales = db
      .prepare(
        `SELECT COUNT(*) AS orders, COALESCE(SUM(subtotal),0) AS gross, COALESCE(SUM(discount),0) AS discount,
           COALESCE(SUM(service),0) AS service, COALESCE(SUM(tax),0) AS tax, COALESCE(SUM(total),0) AS total, COALESCE(SUM(cogs),0) AS cogs
         FROM orders WHERE ${paid}`
      )
      .get(from, to);
    const itemsSold = db
      .prepare(`SELECT COALESCE(SUM(i.qty),0) AS n FROM order_items i JOIN orders o ON o.id = i.order_id WHERE o.business_date BETWEEN ? AND ? AND o.status != 'cancelled' AND o.payment_status = 'paid'`)
      .get(from, to).n;
    const byMethod = db.prepare(`SELECT payment_method AS method, COUNT(*) AS orders, SUM(total) AS total FROM orders WHERE ${paid} GROUP BY payment_method ORDER BY total DESC`).all(from, to);
    const topItems = db
      .prepare(
        `SELECT i.name, SUM(i.qty) AS qty, SUM(i.line_total) AS revenue, SUM(i.unit_cost * i.qty) AS cost FROM order_items i JOIN orders o ON o.id = i.order_id
         WHERE o.business_date BETWEEN ? AND ? AND o.status != 'cancelled' AND o.payment_status = 'paid'
         GROUP BY i.name ORDER BY qty DESC LIMIT 20`
      )
      .all(from, to);
    const byHour = period === 'day'
      ? db.prepare(`SELECT created_at FROM orders WHERE ${paid}`).all(from, to)
      : [];
    const unpaid = db.prepare(`SELECT COUNT(*) AS orders, COALESCE(SUM(total),0) AS amount FROM orders WHERE business_date BETWEEN ? AND ? AND status != 'cancelled' AND payment_status = 'unpaid'`).get(from, to);
    const cancelled = db.prepare(`SELECT COUNT(*) AS orders FROM orders WHERE business_date BETWEEN ? AND ? AND status = 'cancelled'`).get(from, to).orders;
    const avgPrep = db
      .prepare(`SELECT AVG((julianday(ready_at) - julianday(accepted_at)) * 1440) AS minutes FROM orders WHERE business_date BETWEEN ? AND ? AND ready_at IS NOT NULL AND accepted_at IS NOT NULL`)
      .get(from, to).minutes;

    const netSales = sales.total - sales.tax; // PPN = titipan negara, bukan pendapatan (berlaku untuk harga termasuk/belum termasuk PPN)
    const report = {
      period, from, to, label,
      sales: { ...sales, net_sales: netSales, items_sold: itemsSold, avg_ticket: sales.orders ? Math.round(sales.total / sales.orders) : 0 },
      byMethod, topItems, unpaid, cancelled, avg_prep_minutes: avgPrep,
    };
    // Distribusi jam (untuk laporan harian)
    if (period === 'day') {
      const tz = getSettings().timezone || 'Asia/Jakarta';
      const fmt = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour: '2-digit', hour12: false });
      const hours = {};
      for (const r of byHour) {
        const h = fmt.format(new Date(r.created_at)).padStart(2, '0');
        hours[h] = (hours[h] || 0) + 1;
      }
      report.byHour = Object.entries(hours).sort().map(([hour, orders]) => ({ hour, orders }));
    }
    if (!withProfit) {
      delete report.sales.cogs;
      report.topItems = topItems.map(({ cost, ...r }) => r);
      return report;
    }

    const cash = db.prepare(`SELECT type, category, SUM(amount) AS amount FROM cash_entries WHERE business_date BETWEEN ? AND ? GROUP BY type, category ORDER BY amount DESC`).all(from, to);
    const expenses = cash.filter((c) => c.type === 'expense');
    const otherIncome = cash.filter((c) => c.type === 'income');
    const sumAmt = (a) => a.reduce((x, y) => x + y.amount, 0);
    const stock = db
      .prepare(`SELECT type, COALESCE(SUM(total_cost),0) AS amount FROM stock_movements WHERE business_date BETWEEN ? AND ? GROUP BY type`)
      .all(from, to);
    const stockOf = (t) => stock.find((x) => x.type === t)?.amount || 0;
    const stockLoss = -(stockOf('waste') + stockOf('adjust')); // positif = rugi
    const grossProfit = netSales - sales.cogs;
    const opex = sumAmt(expenses);
    const other = sumAmt(otherIncome);
    report.profit_loss = {
      net_sales: netSales,
      cogs: sales.cogs,
      gross_profit: grossProfit,
      gross_margin: netSales ? grossProfit / netSales : 0,
      stock_loss: stockLoss,
      expenses, total_expenses: opex,
      other_income: otherIncome, total_other_income: other,
      net_profit: grossProfit - stockLoss - opex + other,
      tax_collected: sales.tax,
      stock_purchases: stockOf('purchase'),
    };
    // Rincian per hari (bulanan/rentang) atau per bulan (tahunan)
    const salesRows = db
      .prepare(`SELECT ${groupExpr} AS k, COUNT(*) AS orders, SUM(total - tax) AS net_sales, SUM(total) AS total, SUM(cogs) AS cogs FROM orders WHERE ${paid} GROUP BY k`)
      .all(from, to);
    const expRows = db.prepare(`SELECT ${groupExpr} AS k, SUM(CASE WHEN type='expense' THEN amount ELSE 0 END) AS expenses, SUM(CASE WHEN type='income' THEN amount ELSE 0 END) AS income FROM cash_entries WHERE business_date BETWEEN ? AND ? GROUP BY k`).all(from, to);
    const lossRows = db.prepare(`SELECT ${groupExpr} AS k, -SUM(total_cost) AS loss FROM stock_movements WHERE business_date BETWEEN ? AND ? AND type IN ('waste','adjust') GROUP BY k`).all(from, to);
    if (period !== 'day') {
      const keys = new Set([...salesRows, ...expRows, ...lossRows].map((r) => r.k));
      report.breakdown = [...keys].sort().map((k) => {
        const s = salesRows.find((r) => r.k === k) || { orders: 0, net_sales: 0, total: 0, cogs: 0 };
        const e = expRows.find((r) => r.k === k) || { expenses: 0, income: 0 };
        const l = lossRows.find((r) => r.k === k)?.loss || 0;
        return {
          key: k, orders: s.orders, net_sales: s.net_sales, total: s.total, cogs: s.cogs,
          gross_profit: s.net_sales - s.cogs, expenses: e.expenses, other_income: e.income, stock_loss: l,
          net_profit: s.net_sales - s.cogs - e.expenses + e.income - l,
        };
      });
    }
    report.low_stock = lowStockList();
    report.stock_value = Math.round(db.prepare('SELECT COALESCE(SUM(MAX(stock,0) * cost_per_unit),0) AS v FROM ingredients WHERE active = 1').get().v);
    return report;
  };

  // Kasir: ringkasan penjualan (tanpa laba). Superadmin: lengkap dengan laba rugi.
  api.get('/reports', auth('kasir'), wrap((req) => {
    const isAdmin = req.user.role === 'superadmin';
    if (!isAdmin && req.query.period && req.query.period !== 'day') throw new HttpError(403, 'Kasir hanya dapat melihat laporan harian');
    return buildReport(req.query, isAdmin);
  }));
  api.get('/reports/export.csv', auth('superadmin'), (req) => {
    {
      const r = buildReport(req.query, true);
      const esc = (v) => `"${String(v ?? '').replaceAll('"', '""')}"`;
      const lines = [];
      lines.push(['Laporan', getSettings().store_name, r.label].map(esc).join(','));
      lines.push('');
      lines.push(['LABA RUGI', 'Nominal'].map(esc).join(','));
      const pl = r.profit_loss;
      for (const [k, v] of [
        ['Penjualan kotor', r.sales.gross], ['Diskon', -r.sales.discount], ['Biaya tambahan', r.sales.service], ['PPN', -r.sales.tax], ['Penjualan bersih (tanpa PPN)', pl.net_sales],
        ['HPP (harga pokok penjualan)', -pl.cogs], ['Laba kotor', pl.gross_profit], ['Selisih/kerugian stok', -pl.stock_loss],
        ...pl.expenses.map((e) => [`Biaya: ${e.category}`, -e.amount]), ['Total biaya operasional', -pl.total_expenses],
        ...pl.other_income.map((e) => [`Pendapatan lain: ${e.category}`, e.amount]), ['Laba bersih', pl.net_profit], ['PPN terkumpul (disetor)', pl.tax_collected],
      ]) lines.push([k, v].map(esc).join(','));
      if (r.breakdown) {
        lines.push('');
        lines.push(['Periode', 'Pesanan', 'Penjualan bersih', 'HPP', 'Laba kotor', 'Biaya', 'Pendapatan lain', 'Kerugian stok', 'Laba bersih'].map(esc).join(','));
        for (const b of r.breakdown) lines.push([b.key, b.orders, b.net_sales, b.cogs, b.gross_profit, b.expenses, b.other_income, b.stock_loss, b.net_profit].map(esc).join(','));
      }
      lines.push('');
      lines.push(['Produk terlaris', 'Qty', 'Pendapatan', 'HPP'].map(esc).join(','));
      for (const t of r.topItems) lines.push([t.name, t.qty, t.revenue, t.cost].map(esc).join(','));
      return new Response('\uFEFF' + lines.join('\r\n'), {
        headers: {
          'Content-Type': 'text/csv; charset=utf-8',
          'Content-Disposition': `attachment; filename="laporan-${r.label.replaceAll(' ', '_').replaceAll('/', '-')}.csv"`,
        },
      });
    }
  });

  api.get('/health', () => ({ ok: true, time: nowIso(), business_date: businessDate() }));

  // Menentukan "room" WebSocket untuk koneksi baru (dipanggil Durable Object).
  const socketRooms = (params) => {
    const rooms = [];
    const token = params.get('token');
    if (token && userFromToken(token)) rooms.push('staff');
    if (params.get('role') === 'monitor') rooms.push('monitor');
    const table = params.get('table');
    if (table) {
      const t = db.prepare('SELECT code FROM tables WHERE code = ? AND active = 1').get(String(table));
      if (t) rooms.push(`table:${t.code}`);
    }
    return rooms;
  };

  return { api, socketRooms, queueSnapshot, publicSettings };
}
