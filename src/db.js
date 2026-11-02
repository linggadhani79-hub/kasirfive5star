import { MENU_SEED } from './menu-seed.js';

// Lapisan database: SQLite milik Durable Object (ctx.storage.sql), dibungkus agar mirip API prepare().
const enc = new TextEncoder();
const toHex = (buf) => [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
const fromHex = (hex) => new Uint8Array(hex.match(/.{2}/g).map((h) => parseInt(h, 16)));

async function pbkdf2(pin, saltHex) {
  const key = await crypto.subtle.importKey('raw', enc.encode(String(pin)), 'PBKDF2', false, ['deriveBits']);
  const bits = await crypto.subtle.deriveBits({ name: 'PBKDF2', hash: 'SHA-256', salt: fromHex(saltHex), iterations: 100000 }, key, 256);
  return toHex(bits);
}

export async function hashPin(pin) {
  const salt = toHex(crypto.getRandomValues(new Uint8Array(16)));
  return `${salt}:${await pbkdf2(pin, salt)}`;
}

export async function verifyPin(pin, stored) {
  if (!stored || !stored.includes(':')) return false;
  const [salt, hash] = stored.split(':');
  const test = await pbkdf2(pin, salt);
  // perbandingan waktu-konstan
  let diff = test.length ^ hash.length;
  for (let i = 0; i < Math.min(test.length, hash.length); i++) diff |= test.charCodeAt(i) ^ hash.charCodeAt(i);
  return diff === 0;
}

export function randomToken(bytes = 24) {
  return toHex(crypto.getRandomValues(new Uint8Array(bytes)));
}

export function randomCode(len = 8) {
  const alphabet = 'abcdefghjkmnpqrstuvwxyz23456789';
  const bytes = crypto.getRandomValues(new Uint8Array(len));
  let out = '';
  for (let i = 0; i < len; i++) out += alphabet[bytes[i] % alphabet.length];
  return out;
}

const SCHEMA = `
CREATE TABLE IF NOT EXISTS settings (
  key TEXT PRIMARY KEY,
  value TEXT
);
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('superadmin','kasir')),
  pin_hash TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS sessions (
  token TEXT PRIMARY KEY,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  created_at TEXT NOT NULL DEFAULT (datetime('now')),
  last_seen TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE TABLE IF NOT EXISTS categories (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  icon TEXT DEFAULT '',
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS products (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  category_id INTEGER REFERENCES categories(id) ON DELETE SET NULL,
  name TEXT NOT NULL,
  description TEXT DEFAULT '',
  price INTEGER NOT NULL DEFAULT 0,
  cost INTEGER NOT NULL DEFAULT 0,
  image TEXT DEFAULT '',
  options TEXT NOT NULL DEFAULT '[]',
  available INTEGER NOT NULL DEFAULT 1,
  sort INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS tables (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  code TEXT NOT NULL UNIQUE,
  active INTEGER NOT NULL DEFAULT 1
);
CREATE TABLE IF NOT EXISTS orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  queue_no INTEGER NOT NULL,
  business_date TEXT NOT NULL,
  table_id INTEGER,
  table_name TEXT DEFAULT '',
  customer_name TEXT DEFAULT '',
  note TEXT DEFAULT '',
  order_type TEXT NOT NULL DEFAULT 'dine_in',
  source TEXT NOT NULL DEFAULT 'meja',
  status TEXT NOT NULL DEFAULT 'pending',
  payment_status TEXT NOT NULL DEFAULT 'unpaid',
  payment_method TEXT DEFAULT '',
  subtotal INTEGER NOT NULL DEFAULT 0,
  discount INTEGER NOT NULL DEFAULT 0,
  service INTEGER NOT NULL DEFAULT 0,
  tax INTEGER NOT NULL DEFAULT 0,
  total INTEGER NOT NULL DEFAULT 0,
  paid_amount INTEGER NOT NULL DEFAULT 0,
  change_amount INTEGER NOT NULL DEFAULT 0,
  cashier_id INTEGER,
  cancel_reason TEXT DEFAULT '',
  call_count INTEGER NOT NULL DEFAULT 0,
  cogs INTEGER NOT NULL DEFAULT 0,
  fees TEXT NOT NULL DEFAULT '[]',
  tax_inclusive INTEGER NOT NULL DEFAULT 0,
  payment_request TEXT NOT NULL DEFAULT '',
  stock_deducted INTEGER NOT NULL DEFAULT 0,
  created_at TEXT NOT NULL,
  accepted_at TEXT,
  ready_at TEXT,
  completed_at TEXT,
  paid_at TEXT,
  UNIQUE (business_date, queue_no)
);
CREATE INDEX IF NOT EXISTS idx_orders_date ON orders(business_date);
CREATE INDEX IF NOT EXISTS idx_orders_status ON orders(status);
CREATE TABLE IF NOT EXISTS order_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  order_id INTEGER NOT NULL REFERENCES orders(id) ON DELETE CASCADE,
  product_id INTEGER,
  name TEXT NOT NULL,
  unit_price INTEGER NOT NULL,
  qty INTEGER NOT NULL,
  options TEXT NOT NULL DEFAULT '[]',
  note TEXT DEFAULT '',
  line_total INTEGER NOT NULL,
  unit_cost INTEGER NOT NULL DEFAULT 0
);
CREATE INDEX IF NOT EXISTS idx_items_order ON order_items(order_id);
-- Bahan baku / stok
CREATE TABLE IF NOT EXISTS ingredients (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  name TEXT NOT NULL,
  unit TEXT NOT NULL DEFAULT 'gr',
  stock REAL NOT NULL DEFAULT 0,
  min_stock REAL NOT NULL DEFAULT 0,
  cost_per_unit REAL NOT NULL DEFAULT 0,
  active INTEGER NOT NULL DEFAULT 1
);
-- Resep: kebutuhan bahan per 1 porsi produk (dasar) atau per pilihan opsi
CREATE TABLE IF NOT EXISTS recipes (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  product_id INTEGER NOT NULL REFERENCES products(id) ON DELETE CASCADE,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  qty REAL NOT NULL,
  option_name TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_recipes_product ON recipes(product_id);
CREATE TABLE IF NOT EXISTS stock_movements (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  ingredient_id INTEGER NOT NULL REFERENCES ingredients(id) ON DELETE CASCADE,
  type TEXT NOT NULL CHECK (type IN ('purchase','sale','adjust','waste','return')),
  qty REAL NOT NULL,
  unit_cost REAL NOT NULL DEFAULT 0,
  total_cost INTEGER NOT NULL DEFAULT 0,
  order_id INTEGER,
  note TEXT DEFAULT '',
  business_date TEXT NOT NULL,
  user_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_moves_date ON stock_movements(business_date);
CREATE INDEX IF NOT EXISTS idx_moves_ing ON stock_movements(ingredient_id);
-- Kas: pengeluaran operasional & pemasukan lain
CREATE TABLE IF NOT EXISTS cash_entries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  type TEXT NOT NULL CHECK (type IN ('expense','income')),
  category TEXT NOT NULL,
  description TEXT DEFAULT '',
  amount INTEGER NOT NULL,
  business_date TEXT NOT NULL,
  user_id INTEGER,
  created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_cash_date ON cash_entries(business_date);
`;

export const DEFAULT_SETTINGS = {
  store_name: 'Five5Star Coffee',
  store_address: 'Jl. Kopi Bintang No. 5',
  store_phone: '',
  receipt_footer: 'Terima kasih, sampai jumpa lagi! ☕',
  tax_percent: '11',
  // 1 = harga menu sudah termasuk PPN (PPN dihitung dari dalam harga, tidak ditambahkan)
  tax_inclusive: '1',
  service_percent: '0',
  // Biaya tambahan otomatis: [{name, type:'percent'|'fixed', value, applies:'all'|'dine_in'|'takeaway'}]
  extra_fees: '[]',
  // QRIS statis milik toko (isi kode dari stiker QRIS); diubah jadi QRIS bernominal per pesanan
  qris_enabled: '0',
  qris_payload: '',
  timezone: 'Asia/Jakarta',
  auto_accept: '0',
  require_payment_first: '0',
  voice_template: 'Nomor antrean {nomor}{nama_kalimat}{meja_kalimat}. Pesanan Anda sudah siap.',
  voice_repeat: '2',
  voice_rate: '0.95',
  queue_prefix: 'A',
  payment_methods: 'Tunai,QRIS,Debit,Transfer',
  expense_categories: 'Gaji Karyawan,Sewa Tempat,Listrik & Air,Internet,Marketing,Perawatan,Gas,Lain-lain',
  income_categories: 'Pendapatan Lain,Modal Masuk',
};

async function seed(db, env) {
  const setIns = db.prepare('INSERT OR IGNORE INTO settings (key, value) VALUES (?, ?)');
  for (const [k, v] of Object.entries(DEFAULT_SETTINGS)) setIns.run(k, v);

  const userCount = db.prepare('SELECT COUNT(*) AS n FROM users').get().n;
  if (userCount === 0) {
    const ins = db.prepare('INSERT INTO users (name, role, pin_hash) VALUES (?, ?, ?)');
    ins.run('Super Admin', 'superadmin', await hashPin(env.SUPERADMIN_PIN || '123456'));
    ins.run('Kasir 1', 'kasir', await hashPin(env.KASIR_PIN || '1111'));
  }

  const tableCount = db.prepare('SELECT COUNT(*) AS n FROM tables').get().n;
  if (tableCount === 0) {
    const ins = db.prepare('INSERT INTO tables (name, code) VALUES (?, ?)');
    for (let i = 1; i <= 10; i++) ins.run(`Meja ${i}`, randomCode(6));
  }

  const catCount = db.prepare('SELECT COUNT(*) AS n FROM categories').get().n;
  if (catCount === 0) {
    // Menu asli dari buku menu Five5Star (lihat scripts/extract_menu.py)
    const insCat = db.prepare('INSERT INTO categories (name, icon, sort) VALUES (?, ?, ?)');
    const insProd = db.prepare(
      'INSERT INTO products (category_id, name, description, price, image, options, sort) VALUES (?, ?, ?, ?, ?, ?, ?)'
    );
    let sort = 0;
    MENU_SEED.forEach((cat, ci) => {
      const catId = Number(insCat.run(cat.name, cat.icon, ci + 1).lastInsertRowid);
      for (const p of cat.products) {
        const options = [];
        if (p.large) {
          options.push({ name: 'Ukuran', required: true, multi: false, choices: [{ name: 'Regular', price: 0 }, { name: 'Large', price: p.large - p.price }] });
        }
        if (p.name === 'Black' || p.name === 'White') {
          options.push({ name: 'Suhu', required: true, multi: false, choices: [{ name: 'Hot', price: 0 }, { name: 'Ice', price: 0 }] });
        }
        insProd.run(catId, p.name, p.description, p.price, p.image, JSON.stringify(options), sort++);
      }
    });
  }

  // Daftar bahan baku awal (stok & harga diisi superadmin lewat menu Stok; resep/HPP diatur per produk).
  const ingCount = db.prepare('SELECT COUNT(*) AS n FROM ingredients').get().n;
  if (ingCount === 0) {
    const insIng = db.prepare('INSERT INTO ingredients (name, unit, stock, min_stock, cost_per_unit) VALUES (?, ?, 0, 0, 0)');
    for (const [name, unit] of [
      ['Biji Kopi Arabica', 'gr'], ['Susu Segar', 'ml'], ['Gula Aren Cair', 'ml'], ['Sirup Gula', 'ml'], ['Es Batu', 'gr'],
      ['Cup Plastik + Tutup', 'pcs'], ['Sedotan', 'pcs'], ['Bubuk Matcha', 'gr'], ['Bubuk Ube', 'gr'], ['Bubuk Cokelat', 'gr'],
      ['Teh', 'gr'], ['Lemon', 'pcs'], ['Jeruk', 'pcs'], ['Yoghurt', 'ml'], ['Coconut Water', 'ml'],
      ['Beras', 'gr'], ['Ayam Fillet', 'gr'], ['Daging Sapi', 'gr'], ['Telur', 'pcs'], ['Kwetiau', 'gr'], ['Mie', 'gr'],
      ['Kentang Beku', 'gr'], ['Minyak Goreng', 'ml'], ['Roti Tawar', 'pcs'], ['Donat', 'pcs'], ['Air Mineral Botol', 'pcs'],
    ]) insIng.run(name, unit);
  }
}

// Pembungkus ctx.storage.sql agar bisa dipakai seperti better-sqlite3: db.prepare(q).get/all/run
export function wrapSql(storage) {
  const sql = storage.sql;
  const norm = (args) => args.map((v) => (v === undefined ? null : typeof v === 'boolean' ? (v ? 1 : 0) : v));
  return {
    exec: (q) => sql.exec(q),
    prepare: (q) => ({
      get: (...a) => sql.exec(q, ...norm(a)).toArray()[0],
      all: (...a) => sql.exec(q, ...norm(a)).toArray(),
      run: (...a) => {
        const cur = sql.exec(q, ...norm(a));
        cur.toArray();
        const id = sql.exec('SELECT last_insert_rowid() AS id').one().id;
        return { changes: cur.rowsWritten, lastInsertRowid: id };
      },
    }),
    transaction: (fn) => storage.transactionSync(fn),
  };
}

// Migrasi ringan untuk database yang sudah berjalan (kolom baru).
function migrate(db) {
  const cols = new Set(db.prepare("SELECT name FROM pragma_table_info('orders')").all().map((c) => c.name));
  if (!cols.has('fees')) db.exec("ALTER TABLE orders ADD COLUMN fees TEXT NOT NULL DEFAULT '[]'");
  if (!cols.has('tax_inclusive')) db.exec('ALTER TABLE orders ADD COLUMN tax_inclusive INTEGER NOT NULL DEFAULT 0');
  if (!cols.has('payment_request')) db.exec("ALTER TABLE orders ADD COLUMN payment_request TEXT NOT NULL DEFAULT ''");
}

export async function initDb(storage, env = {}) {
  const db = wrapSql(storage);
  db.exec(SCHEMA);
  migrate(db);
  await seed(db, env);
  return db;
}

// Menjalankan fungsi dalam transaksi atomik.
export function tx(db, fn) {
  return db.transaction(fn);
}
