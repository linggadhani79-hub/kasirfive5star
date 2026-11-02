import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { crc16, inspectQris, qrisWithAmount, parseTLV } from '../src/qris.js';

// Menjalankan Worker asli (workerd) via `wrangler dev` dengan penyimpanan sementara.
let proc, base, persist;
const call = async (method, path, body, token) => {
  const res = await fetch(base + path, {
    method,
    headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}) },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.headers.get('content-type')?.includes('json') ? await res.json() : await res.text();
  return { status: res.status, data };
};

before(async () => {
  persist = fs.mkdtempSync(path.join(os.tmpdir(), 'kasir-test-'));
  const port = 8800 + Math.floor(Math.random() * 100);
  proc = spawn('npx', ['wrangler', 'dev', '--port', String(port), '--ip', '127.0.0.1', '--persist-to', persist], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, WRANGLER_SEND_METRICS: 'false' },
  });
  let log = '';
  proc.stdout.on('data', (d) => (log += d));
  proc.stderr.on('data', (d) => (log += d));
  base = `http://127.0.0.1:${port}/api`;
  for (let i = 0; i < 120; i++) {
    try {
      if ((await fetch(base + '/health')).ok) return;
    } catch {}
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error('wrangler dev gagal start:\n' + log);
});
after(() => {
  proc?.kill('SIGTERM');
  fs.rmSync(persist, { recursive: true, force: true });
});

const ingredient = async (name, token) => (await call('GET', '/stock/ingredients', null, token)).data.find((i) => i.name === name);

let admin, kasir, tableCode;

test('login superadmin & kasir dengan PIN', async () => {
  const a = await call('POST', '/auth/login', { pin: '123456' });
  assert.equal(a.status, 200);
  assert.equal(a.data.user.role, 'superadmin');
  admin = a.data.token;
  const k = await call('POST', '/auth/login', { pin: '1111' });
  assert.equal(k.data.user.role, 'kasir');
  kasir = k.data.token;
  assert.equal((await call('POST', '/auth/login', { pin: '0000' })).status, 401);
});

test('kasir tidak boleh akses menu superadmin', async () => {
  assert.equal((await call('GET', '/admin/users', null, kasir)).status, 403);
  assert.equal((await call('GET', '/reports?period=month', null, kasir)).status, 403);
  const r = await call('GET', '/reports', null, kasir);
  assert.equal(r.status, 200);
  assert.equal(r.data.profit_loss, undefined);
});

test('menu publik tidak membocorkan HPP', async () => {
  const m = await call('GET', '/public/menu');
  assert.ok(m.data.products.length > 5);
  assert.equal(m.data.products[0].cost, undefined);
});

test('menu asli Five5Star ter-seed lengkap dengan gambar & ukuran', async () => {
  const m = (await call('GET', '/public/menu')).data;
  assert.ok(m.products.length >= 110);
  const matcha = m.products.find((p) => p.name === 'Matcha');
  assert.equal(matcha.price, 25000);
  assert.equal(matcha.options[0].choices.find((c) => c.name === 'Large').price, 5000);
  assert.match(matcha.image, /^\/img\/menu\/.+\.jpg$/);
});

let kopi, susu, cup;
test('superadmin membuat bahan & resep (HPP)', async () => {
  const mk = async (name, unit) => (await call('POST', '/stock/ingredients', { name, unit, min_stock: 100 }, admin)).data;
  kopi = await mk('Kopi Tes', 'gr');
  susu = await mk('Susu Tes', 'ml');
  cup = await mk('Cup Tes', 'pcs');
  // stok masuk: 1000 gr kopi Rp250.000 => Rp250/gr ; susu 10.000 ml Rp200.000 => Rp20/ml ; 100 cup Rp100.000
  await call('POST', '/stock/movements', { ingredient_id: kopi.id, type: 'purchase', qty: 1000, total_cost: 250000 }, kasir);
  await call('POST', '/stock/movements', { ingredient_id: susu.id, type: 'purchase', qty: 10000, total_cost: 200000 }, kasir);
  await call('POST', '/stock/movements', { ingredient_id: cup.id, type: 'purchase', qty: 100, total_cost: 100000 }, kasir);
  const menu = (await call('GET', '/public/menu')).data;
  const white = menu.products.find((p) => p.name === 'White');
  const r = await call('PUT', `/products/${white.id}/recipe`, { items: [
    { ingredient_id: kopi.id, qty: 18 },
    { ingredient_id: susu.id, qty: 150 },
    { ingredient_id: cup.id, qty: 1, option_name: 'Ice' },
  ] }, admin);
  assert.equal(r.status, 200);
  const rec = (await call('GET', `/products/${white.id}/recipe`, null, admin)).data;
  assert.equal(rec.base_cost, 18 * 250 + 150 * 20);
});

test('pesan dari meja -> terima -> stok berkurang -> siap -> bayar -> laba rugi', async () => {
  const tables = await call('GET', '/tables', null, kasir);
  tableCode = tables.data[0].code;
  const menu = (await call('GET', '/public/menu')).data;
  const white = menu.products.find((p) => p.name === 'White');
  const coffee = async () => (await ingredient('Kopi Tes', kasir)).stock;
  const cups = async () => (await ingredient('Cup Tes', kasir)).stock;
  const before = await coffee();

  // harga dihitung server: harga palsu dari klien diabaikan
  const o = await call('POST', `/public/tables/${tableCode}/orders`, {
    customer_name: 'Budi',
    items: [{ product_id: white.id, qty: 2, price: 1, options: { Suhu: 'Ice' } }],
  });
  assert.equal(o.status, 200, JSON.stringify(o.data));
  assert.equal(o.data.status, 'pending');
  assert.equal(o.data.total, 25000 * 2);
  assert.equal(await coffee(), before, 'stok belum berkurang sebelum diterima');

  // opsi wajib
  const bad = await call('POST', `/public/tables/${tableCode}/orders`, { items: [{ product_id: white.id, qty: 1, options: {} }] });
  assert.equal(bad.status, 400);

  await call('POST', `/orders/${o.data.id}/status`, { status: 'preparing' }, kasir);
  assert.equal(await coffee(), before - 36);
  assert.equal(await cups(), 98, 'resep opsi Ice memakai cup');

  const ready = await call('POST', `/orders/${o.data.id}/status`, { status: 'ready' }, kasir);
  assert.equal(ready.data.status, 'ready');
  assert.equal(ready.data.cogs, 2 * (18 * 250 + 150 * 20 + 1000));

  const q = await call('GET', '/public/queue');
  assert.ok(q.data.orders.some((x) => x.id === o.data.id && x.status === 'ready'));

  const short = await call('POST', `/orders/${o.data.id}/pay`, { method: 'Tunai', paid_amount: 100 }, kasir);
  assert.equal(short.status, 400);
  const pay = await call('POST', `/orders/${o.data.id}/pay`, { method: 'Tunai', paid_amount: 100000 }, kasir);
  assert.equal(pay.data.change_amount, 50000);

  await call('POST', '/finance/entries', { type: 'expense', category: 'Listrik & Air', amount: 10000 }, kasir);
  const rep = await call('GET', '/reports?period=day', null, admin);
  const pl = rep.data.profit_loss;
  // harga sudah termasuk PPN 11%: total tetap 50.000, PPN di dalamnya = 50.000 x 11/111
  assert.equal(o.data.tax_inclusive, true);
  assert.equal(pay.data.tax, Math.round((50000 * 11) / 111));
  assert.equal(pl.net_sales, 50000 - pay.data.tax);
  assert.equal(pl.tax_collected, pay.data.tax);
  assert.equal(pl.cogs, ready.data.cogs);
  assert.equal(pl.gross_profit, pl.net_sales - pl.cogs);
  assert.equal(pl.net_profit, pl.gross_profit - 10000 - pl.stock_loss);

  const month = await call('GET', '/reports?period=month', null, admin);
  assert.equal(month.data.breakdown.length, 1);
  const year = await call('GET', '/reports?period=year', null, admin);
  assert.equal(year.data.breakdown[0].key.length, 7);
});

test('batal mengembalikan stok', async () => {
  const menu = (await call('GET', '/public/menu')).data;
  const white = menu.products.find((p) => p.name === 'White');
  const stock = async () => (await ingredient('Kopi Tes', kasir)).stock;
  const s0 = await stock();
  const o = await call('POST', '/orders', { items: [{ product_id: white.id, qty: 3, options: { Suhu: 'Hot' } }] }, kasir);
  assert.equal(o.data.status, 'preparing');
  assert.equal(await stock(), s0 - 54);
  await call('POST', `/orders/${o.data.id}/status`, { status: 'cancelled', reason: 'test' }, kasir);
  assert.equal(await stock(), s0);
});

test('pembelian stok memakai harga rata-rata & opname', async () => {
  const ing = await ingredient('Cup Tes', kasir);
  const after = await call('POST', '/stock/movements', { ingredient_id: ing.id, type: 'purchase', qty: 50, total_cost: 75000 }, kasir);
  assert.equal(after.data.stock, ing.stock + 50);
  assert.equal(after.data.cost_per_unit, Math.round(((ing.stock * ing.cost_per_unit + 75000) / (ing.stock + 50)) * 100) / 100);
  assert.equal((await call('POST', '/stock/movements', { ingredient_id: ing.id, type: 'adjust', counted: 10 }, kasir)).status, 403);
  const adj = await call('POST', '/stock/movements', { ingredient_id: ing.id, type: 'adjust', counted: 10 }, admin);
  assert.equal(adj.data.stock, 10);
  const rep = await call('GET', '/reports?period=day', null, admin);
  assert.ok(rep.data.profit_loss.stock_loss > 0);
  const csv = await call('GET', '/reports/export.csv?period=month', null, admin);
  assert.match(csv.data, /Laba bersih/);
});

test('aset statis & gambar menu tersaji', async () => {
  const root = base.replace('/api', '');
  assert.equal((await fetch(root + '/kasir.html')).status, 200);
  assert.equal((await fetch(root + '/img/menu/matcha.jpg')).status, 200);
});

test('biaya tambahan otomatis (persen & nominal per jenis pesanan) + PPN termasuk', async () => {
  const fees = [
    { name: 'Service charge', type: 'percent', value: 5, applies: 'dine_in' },
    { name: 'Biaya kemasan', type: 'fixed', value: 2000, applies: 'takeaway' },
  ];
  const up = await call('PUT', '/admin/settings', { extra_fees: JSON.stringify(fees), tax_percent: '11', tax_inclusive: '1' }, admin);
  assert.equal(up.status, 200, JSON.stringify(up.data));
  const menu = (await call('GET', '/public/menu')).data;
  const espresso = menu.products.find((p) => p.name === 'Espresso'); // Rp14.000
  const dine = await call('POST', `/public/tables/${tableCode}/orders`, { customer_name: 'A', order_type: 'dine_in', items: [{ product_id: espresso.id, qty: 2 }] });
  assert.equal(dine.data.subtotal, 28000);
  assert.deepEqual(dine.data.fees, [{ name: 'Service charge', amount: 1400 }]);
  assert.equal(dine.data.total, 29400);
  assert.equal(dine.data.tax, Math.round((29400 * 11) / 111));
  const take = await call('POST', `/public/tables/${tableCode}/orders`, { customer_name: 'B', order_type: 'takeaway', items: [{ product_id: espresso.id, qty: 1 }] });
  assert.deepEqual(take.data.fees, [{ name: 'Biaya kemasan', amount: 2000 }]);
  assert.equal(take.data.total, 16000);
  // mode PPN belum termasuk: PPN ditambahkan
  await call('PUT', '/admin/settings', { extra_fees: '[]', tax_inclusive: '0' }, admin);
  const excl = await call('POST', '/orders', { items: [{ product_id: espresso.id, qty: 1 }] }, kasir);
  assert.equal(excl.data.tax, 1540);
  assert.equal(excl.data.total, 15540);
  const bad = await call('PUT', '/admin/settings', { extra_fees: 'bukan json' }, admin);
  assert.equal(bad.status, 400);
  await call('PUT', '/admin/settings', { tax_inclusive: '1' }, admin);
});

// QRIS statis contoh (struktur EMVCo seperti stiker QRIS bank)
const tlv = (id, v) => `${id}${String(v.length).padStart(2, '0')}${v}`;
const STATIC_QRIS = (() => {
  const body =
    tlv('00', '01') + tlv('01', '11') +
    tlv('26', tlv('00', 'ID.CO.BANKCONTOH.WWW') + tlv('01', '936000140000000001') + tlv('02', '000000000001') + tlv('03', 'UMI')) +
    tlv('51', tlv('00', 'ID.CO.QRIS.WWW') + tlv('02', 'ID1026000000001') + tlv('03', 'UMI')) +
    tlv('52', '5814') + tlv('53', '360') + tlv('58', 'ID') + tlv('59', 'FIVE5STAR COFFEE') + tlv('60', 'MATARAM') + tlv('61', '83121') + '6304';
  return body + crc16(body);
})();

test('QRIS statis -> QRIS bernominal (CRC & tag valid)', () => {
  assert.equal(crc16('123456789'), '29B1'); // vektor uji CRC-16/CCITT-FALSE
  const info = inspectQris(STATIC_QRIS);
  assert.equal(info.merchant_name, 'FIVE5STAR COFFEE');
  assert.equal(info.dynamic, false);
  const dyn = qrisWithAmount(STATIC_QRIS, 56175);
  const d = inspectQris(dyn);
  assert.equal(d.dynamic, true);
  assert.equal(d.amount, 56175);
  const ids = parseTLV(dyn).map((t) => t.id);
  assert.deepEqual(ids, [...ids].sort((a, b) => Number(a) - Number(b)));
  assert.equal(ids.at(-1), '63');
  assert.throws(() => inspectQris(STATIC_QRIS.slice(0, -1) + '0'), /CRC/);
});

test('alur QRIS: meja bayar -> klaim -> kasir konfirmasi -> lunas & masuk dapur', async () => {
  // aktifkan tanpa kode QRIS ditolak
  assert.equal((await call('PUT', '/admin/settings', { qris_enabled: '1', qris_payload: '' }, admin)).status, 400);
  assert.equal((await call('PUT', '/admin/settings', { qris_payload: '000201xyz' }, admin)).status, 400);
  const up = await call('PUT', '/admin/settings', { qris_enabled: '1', qris_payload: STATIC_QRIS, extra_fees: '[]', require_payment_first: '0', auto_accept: '0' }, admin);
  assert.equal(up.status, 200, JSON.stringify(up.data));
  assert.equal((await call('GET', '/public/settings')).data.qris_enabled, true);

  const menu = (await call('GET', '/public/menu')).data;
  const espresso = menu.products.find((p) => p.name === 'Espresso');
  const o = (await call('POST', `/public/tables/${tableCode}/orders`, { customer_name: 'Q', payment: 'qris', items: [{ product_id: espresso.id, qty: 1 }] })).data;
  assert.equal(o.payment_request, 'QRIS');
  assert.equal(o.status, 'pending');

  const q = await call('GET', `/public/tables/${tableCode}/orders/${o.id}/qris`);
  assert.equal(q.status, 200);
  assert.match(q.data.svg, /<svg/);
  assert.equal(inspectQris(q.data.payload).amount, o.total);
  // meja lain tidak bisa mengakses pesanan ini
  const other = (await call('GET', '/tables', null, kasir)).data[5].code;
  assert.equal((await call('GET', `/public/tables/${other}/orders/${o.id}/qris`)).status, 404);

  const claim = await call('POST', `/public/tables/${tableCode}/orders/${o.id}/qris-claim`);
  assert.equal(claim.data.payment_request, 'QRIS_CLAIMED');

  const paid = await call('POST', `/orders/${o.id}/pay`, { method: 'QRIS' }, kasir);
  assert.equal(paid.data.payment_status, 'paid');
  assert.equal(paid.data.payment_method, 'QRIS');
  assert.equal(paid.data.status, 'preparing', 'lunas -> otomatis masuk antrean dapur');
  assert.equal((await call('GET', `/public/tables/${tableCode}/orders/${o.id}/qris`)).status, 400);
});
