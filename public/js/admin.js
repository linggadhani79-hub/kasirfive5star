import { $, $$, esc, api, rupiah, num, toast, modal, confirmBox, LOGO_SVG, requireLogin, logout, resizeImage, dateTimeOf, timeOf } from '/js/common.js';

$('#logo').innerHTML = LOGO_SVG;
$('#btn-logout').onclick = logout;

let tab = 'report';
const today = () => new Date(Date.now() - new Date().getTimezoneOffset() * 60000).toISOString().slice(0, 10);
const rp = { period: 'day', value: today(), from: today(), to: today() };
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
const signed = (n) => `<span class="${n < 0 ? 'neg' : ''}">${n < 0 ? '−' : ''}${rupiah(Math.abs(n))}</span>`;

$('#tabs').addEventListener('click', (e) => {
  const b = e.target.closest('[data-tab]');
  if (!b) return;
  tab = b.dataset.tab;
  $$('#tabs .tab').forEach((x) => x.classList.toggle('active', x === b));
  render();
});

function render() {
  $('#main').onclick = null;
  $('#main').onchange = null;
  $('#main').innerHTML = '<div class="empty">Memuat…</div>';
  ({ report: renderReport, menu: renderMenu, stock: renderStock, finance: renderFinance, tables: renderTables, users: renderUsers, settings: renderSettings })[tab]().catch((e) => {
    $('#main').innerHTML = `<div class="empty">⚠️ ${esc(e.message)}</div>`;
  });
}

// ===================== LAPORAN & LABA RUGI =====================
function periodQuery() {
  if (rp.period === 'range') return `period=range&from=${rp.from}&to=${rp.to}`;
  return `period=${rp.period}&value=${rp.value}`;
}
function periodInput() {
  if (rp.period === 'day') return `<input type="date" class="input" data-rp="value" value="${rp.value}" style="max-width:180px">`;
  if (rp.period === 'month') return `<input type="month" class="input" data-rp="value" value="${rp.value}" style="max-width:180px">`;
  if (rp.period === 'year') return `<input type="number" class="input" data-rp="value" value="${rp.value}" min="2020" max="2100" style="max-width:120px">`;
  return `<input type="date" class="input" data-rp="from" value="${rp.from}" style="max-width:170px"><span>s/d</span><input type="date" class="input" data-rp="to" value="${rp.to}" style="max-width:170px">`;
}
function keyLabel(k, period) {
  if (period === 'year') return MONTHS[Number(k.slice(5, 7)) - 1] + ' ' + k.slice(0, 4);
  const d = new Date(k + 'T00:00:00');
  return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
}

async function renderReport() {
  const r = await api('/reports?' + periodQuery());
  const s = r.sales;
  const pl = r.profit_loss;
  const max = Math.max(1, ...(r.breakdown || []).map((b) => Math.max(b.net_sales, Math.abs(b.net_profit))));
  $('#main').innerHTML = `<div class="stack" style="gap:16px">
    <div class="card pad row wrap">
      <div class="tabs">${[['day', 'Harian'], ['month', 'Bulanan'], ['year', 'Tahunan'], ['range', 'Rentang']].map(([k, l]) => `<button class="tab ${rp.period === k ? 'active' : ''}" data-period="${k}">${l}</button>`).join('')}</div>
      ${periodInput()}
      <span class="grow"></span>
      <button class="btn" data-export>⬇️ Unduh CSV</button>
      <button class="btn" data-print>🖨️ Cetak</button>
    </div>
    <h2>Laporan ${esc({ day: 'Harian', month: 'Bulanan', year: 'Tahunan', range: 'Periode' }[r.period])} · ${esc(r.label)}</h2>
    <div class="stats">
      <div class="card stat"><div class="label">Penjualan bersih</div><div class="value">${rupiah(pl.net_sales)}</div></div>
      <div class="card stat"><div class="label">HPP</div><div class="value">${rupiah(pl.cogs)}</div></div>
      <div class="card stat"><div class="label">Laba kotor</div><div class="value ${pl.gross_profit >= 0 ? 'pos' : 'neg'}">${rupiah(pl.gross_profit)}</div><div class="small muted">Margin ${num(pl.gross_margin * 100, 1)}%</div></div>
      <div class="card stat"><div class="label">Biaya operasional</div><div class="value neg">${rupiah(pl.total_expenses)}</div></div>
      <div class="card stat"><div class="label">LABA BERSIH</div><div class="value ${pl.net_profit >= 0 ? 'pos' : 'neg'}">${signed(pl.net_profit)}</div></div>
      <div class="card stat"><div class="label">Transaksi</div><div class="value">${s.orders}</div><div class="small muted">${s.items_sold} item · rata-rata ${rupiah(s.avg_ticket)}</div></div>
      <div class="card stat"><div class="label">Belum dibayar</div><div class="value neg">${rupiah(r.unpaid.amount)}</div><div class="small muted">${r.unpaid.orders} pesanan · ${r.cancelled} batal</div></div>
      <div class="card stat"><div class="label">Nilai stok saat ini</div><div class="value">${rupiah(r.stock_value)}</div><div class="small muted">${r.low_stock.length} bahan menipis</div></div>
    </div>
    <div class="grid-2" style="align-items:start">
      <div class="card"><div style="padding:14px 14px 4px"><h3>Laporan Laba Rugi</h3><p class="small muted" style="margin:4px 0 10px">Periode ${esc(r.from)} s/d ${esc(r.to)} · hanya pesanan lunas</p></div>
        <table class="pl">
          <tr><td>Penjualan kotor</td><td>${rupiah(s.gross)}</td></tr>
          <tr class="sub"><td>Diskon</td><td>${signed(-s.discount)}</td></tr>
          <tr class="sub"><td>Biaya tambahan otomatis</td><td>${rupiah(s.service)}</td></tr>
          <tr class="sub"><td>PPN ${'(termasuk dalam harga, disetor)'}</td><td>${signed(-s.tax)}</td></tr>
          <tr class="total"><td>Penjualan bersih (tanpa PPN)</td><td>${rupiah(pl.net_sales)}</td></tr>
          <tr><td>Harga pokok penjualan (HPP)</td><td>${signed(-pl.cogs)}</td></tr>
          <tr class="total"><td>Laba kotor</td><td>${signed(pl.gross_profit)}</td></tr>
          <tr><td>Selisih / kerugian stok (terbuang, opname)</td><td>${signed(-pl.stock_loss)}</td></tr>
          <tr><td>Biaya operasional</td><td>${signed(-pl.total_expenses)}</td></tr>
          ${pl.expenses.map((x) => `<tr class="sub"><td>${esc(x.category)}</td><td>${signed(-x.amount)}</td></tr>`).join('')}
          <tr><td>Pendapatan lain</td><td>${rupiah(pl.total_other_income)}</td></tr>
          ${pl.other_income.map((x) => `<tr class="sub"><td>${esc(x.category)}</td><td>${rupiah(x.amount)}</td></tr>`).join('')}
          <tr class="grand"><td>LABA BERSIH</td><td>${signed(pl.net_profit)}</td></tr>
          <tr class="sub"><td>PPN terkumpul (wajib disetor, bukan laba)</td><td>${rupiah(pl.tax_collected)}</td></tr>
          <tr class="sub"><td>Pembelian stok periode ini (arus kas)</td><td>${rupiah(pl.stock_purchases)}</td></tr>
        </table></div>
      <div class="stack">
        ${r.breakdown?.length ? `<div class="card pad stack"><div class="row"><h3 class="grow">${r.period === 'year' ? 'Per bulan' : 'Per hari'}</h3><div class="legend"><span><i style="background:var(--gold)"></i>Penjualan</span><span><i style="background:var(--ok)"></i>Laba bersih</span></div></div>
          <div class="bars">${r.breakdown
            .map(
              (b) => `<div class="bar-row" title="Penjualan ${rupiah(b.net_sales)} · HPP ${rupiah(b.cogs)} · Biaya ${rupiah(b.expenses)} · Laba ${rupiah(b.net_profit)}"><span>${esc(keyLabel(b.key, r.period))}</span>
              <div class="bar-track"><div class="bar-fill" style="width:${(b.net_sales / max) * 100}%;bottom:45%"></div><div class="bar-fill ${b.net_profit >= 0 ? 'profit' : 'loss'}" style="width:${(Math.abs(b.net_profit) / max) * 100}%"></div></div>
              <span class="right num">${rupiah(b.net_sales)}<br><span class="small ${b.net_profit < 0 ? 'neg' : 'pos'}">${b.net_profit < 0 ? '−' : ''}${rupiah(Math.abs(b.net_profit))}</span></span></div>`
            )
            .join('')}</div></div>` : ''}
        ${r.byHour?.length ? `<div class="card pad stack"><h3>Jam ramai</h3><div class="bars">${r.byHour.map((h) => `<div class="bar-row"><span>${h.hour}:00</span><div class="bar-track"><div class="bar-fill" style="width:${(h.orders / Math.max(...r.byHour.map((x) => x.orders))) * 100}%"></div></div><span class="right">${h.orders} trx</span></div>`).join('')}</div></div>` : ''}
        <div class="card table-wrap"><table class="tbl"><thead><tr><th>Metode bayar</th><th class="num">Trx</th><th class="num">Total</th></tr></thead><tbody>${r.byMethod.map((m) => `<tr><td>${esc(m.method)}</td><td class="num">${m.orders}</td><td class="num">${rupiah(m.total)}</td></tr>`).join('') || '<tr><td colspan="3" class="muted">Belum ada transaksi</td></tr>'}</tbody></table></div>
      </div>
    </div>
    <div class="card table-wrap"><table class="tbl"><thead><tr><th>Produk terlaris</th><th class="num">Qty</th><th class="num">Omzet</th><th class="num">HPP</th><th class="num">Laba kotor</th><th class="num">Margin</th></tr></thead><tbody>
      ${r.topItems.map((t) => `<tr><td>${esc(t.name)}</td><td class="num">${t.qty}</td><td class="num">${rupiah(t.revenue)}</td><td class="num">${rupiah(t.cost)}</td><td class="num">${rupiah(t.revenue - t.cost)}</td><td class="num">${t.revenue ? num(((t.revenue - t.cost) / t.revenue) * 100, 1) + '%' : '-'}</td></tr>`).join('') || '<tr><td colspan="6" class="muted">Belum ada penjualan</td></tr>'}
    </tbody></table></div>
    ${r.low_stock.length ? `<div class="card pad" style="background:var(--bad-soft)">⚠️ <b>Stok menipis:</b> ${r.low_stock.map((x) => `${esc(x.name)} (${num(x.stock)} ${esc(x.unit)})`).join(', ')}</div>` : ''}
  </div>`;
  $('#main').onclick = async (e) => {
    const p = e.target.closest('[data-period]');
    if (p) {
      rp.period = p.dataset.period;
      rp.value = { day: today(), month: today().slice(0, 7), year: today().slice(0, 4) }[rp.period] || rp.value;
      return render();
    }
    if (e.target.closest('[data-print]')) return window.print();
    if (e.target.closest('[data-export]')) {
      const res = await api('/reports/export.csv?' + periodQuery(), { raw: true });
      if (!res.ok) return toast('Gagal mengunduh', 'bad');
      const blob = await res.blob();
      const a = document.createElement('a');
      a.href = URL.createObjectURL(blob);
      a.download = `laporan-five5star-${r.label.replaceAll(' ', '_').replaceAll('/', '-')}.csv`;
      a.click();
      URL.revokeObjectURL(a.href);
    }
  };
  $('#main').onchange = (e) => {
    const i = e.target.closest('[data-rp]');
    if (i && i.value) {
      rp[i.dataset.rp] = i.value;
      render();
    }
  };
}

// ===================== MENU & RESEP =====================
let menuCache;
async function renderMenu() {
  menuCache = await api('/admin/menu');
  const { categories, products } = menuCache;
  const noHpp = products.filter((p) => !p.hpp).length;
  $('#main').innerHTML = `<div class="stack" style="gap:14px">
    <div class="section-head"><h2>Menu (${products.length} produk)</h2><button class="btn" data-cats>🗂️ Kategori</button><button class="btn gold" data-new>➕ Produk Baru</button></div>
    ${noHpp ? `<div class="card pad small" style="background:var(--warn-soft)">ℹ️ ${noHpp} produk belum punya HPP. Isi <b>Resep</b> (stok otomatis berkurang & HPP dihitung dari bahan) atau <b>HPP manual</b> agar laporan laba rugi akurat.</div>` : ''}
    ${categories
      .map((c) => {
        const list = products.filter((p) => p.category_id === c.id);
        return `<div class="card table-wrap"><table class="tbl"><thead><tr><th colspan="2">${esc(c.icon)} ${esc(c.name)}</th><th class="num">Harga</th><th class="num">HPP</th><th class="num">Margin</th><th>Opsi</th><th>Tersedia</th><th></th></tr></thead><tbody>
          ${list
            .map(
              (p) => `<tr><td style="width:56px">${p.image ? `<img class="thumb-sm" src="${esc(p.image)}" alt="">` : `<div class="thumb-sm">${esc(c.icon)}</div>`}</td>
              <td><b>${esc(p.name)}</b><div class="small muted">${esc(p.description || '')}</div></td>
              <td class="num">${rupiah(p.price)}</td>
              <td class="num">${p.hpp ? rupiah(p.hpp) + (p.has_recipe ? '<div class="small muted">resep</div>' : '<div class="small muted">manual</div>') : '<span class="badge pending">belum</span>'}</td>
              <td class="num">${p.hpp && p.price ? num(((p.price - p.hpp) / p.price) * 100, 0) + '%' : '-'}</td>
              <td class="small">${p.options.map((g) => esc(g.name)).join(', ') || '-'}</td>
              <td><label class="check"><input type="checkbox" data-avail="${p.id}" ${p.available ? 'checked' : ''}></label></td>
              <td class="right" style="white-space:nowrap"><button class="btn sm" data-recipe="${p.id}">🧪 Resep</button> <button class="btn sm" data-edit="${p.id}">✏️</button></td></tr>`
            )
            .join('') || '<tr><td colspan="8" class="muted">Belum ada produk</td></tr>'}</tbody></table></div>`;
      })
      .join('')}
  </div>`;
  $('#main').onclick = (e) => {
    if (e.target.closest('[data-new]')) return productEditor(null);
    if (e.target.closest('[data-cats]')) return categoryEditor();
    const ed = e.target.closest('[data-edit]');
    if (ed) return productEditor(products.find((p) => p.id === Number(ed.dataset.edit)));
    const rc = e.target.closest('[data-recipe]');
    if (rc) return recipeEditor(products.find((p) => p.id === Number(rc.dataset.recipe)));
  };
  $('#main').onchange = async (e) => {
    const a = e.target.closest('[data-avail]');
    if (!a) return;
    try {
      await api(`/products/${a.dataset.avail}/availability`, { method: 'PATCH', body: { available: a.checked } });
      toast(a.checked ? 'Tersedia' : 'Ditandai habis', 'ok', 1200);
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
}

function optionsEditorHtml(options) {
  return `<div class="opt-editor stack" data-opts>${options.map(grpHtml).join('')}</div><button class="btn sm" data-addgrp style="align-self:flex-start">+ Grup opsi</button>`;
}
function grpHtml(g) {
  return `<div class="grp" data-grp>
      <div class="row wrap"><input class="input grow" data-gname placeholder="Nama grup (mis. Ukuran)" value="${esc(g.name)}" style="min-width:140px">
        <label class="check small"><input type="checkbox" data-greq ${g.required ? 'checked' : ''}>Wajib</label>
        <label class="check small"><input type="checkbox" data-gmulti ${g.multi ? 'checked' : ''}>Boleh pilih banyak</label>
        <button class="btn sm outline-bad" data-delgrp>Hapus grup</button></div>
      <div class="stack" data-choices>${g.choices.map((c) => choiceRow(c)).join('')}</div>
      <button class="btn sm" data-addchoice style="align-self:flex-start">+ Pilihan</button></div>`;
}
const choiceRow = (c = { name: '', price: 0 }) =>
  `<div class="row" data-choice><input class="input grow" data-cname placeholder="Pilihan (mis. Large)" value="${esc(c.name)}"><input class="input" data-cprice inputmode="numeric" placeholder="+Harga" value="${c.price || ''}" style="max-width:120px"><button class="btn sm ghost" data-delchoice>✕</button></div>`;
function readOptions(root) {
  return $$('[data-grp]', root).map((g) => ({
    name: $('[data-gname]', g).value.trim(),
    required: $('[data-greq]', g).checked,
    multi: $('[data-gmulti]', g).checked,
    choices: $$('[data-choice]', g).map((c) => ({ name: $('[data-cname]', c).value.trim(), price: Number($('[data-cprice]', c).value.replace(/\D/g, '')) || 0 })),
  }));
}

function productEditor(p) {
  const { categories } = menuCache;
  let image = p?.image || '';
  const m = modal({
    title: p ? `Edit ${esc(p.name)}` : 'Produk baru',
    wide: true,
    body: `<div class="grid-2">
        <label class="field"><span>Nama</span><input class="input" data-f="name" value="${esc(p?.name || '')}"></label>
        <label class="field"><span>Kategori</span><select class="input" data-f="category_id">${categories.map((c) => `<option value="${c.id}" ${p?.category_id === c.id ? 'selected' : ''}>${esc(c.icon)} ${esc(c.name)}</option>`).join('')}</select></label>
        <label class="field"><span>Harga jual (Rp)</span><input class="input" data-f="price" inputmode="numeric" value="${p?.price ?? ''}"></label>
        <label class="field"><span>HPP manual (Rp) — dipakai jika tidak ada resep</span><input class="input" data-f="cost" inputmode="numeric" value="${p?.cost || ''}"></label>
        <label class="field"><span>Urutan</span><input class="input" data-f="sort" inputmode="numeric" value="${p?.sort ?? 0}"></label>
        <label class="check" style="margin-top:24px"><input type="checkbox" data-f="available" ${p?.available === false ? '' : 'checked'}> Tersedia</label>
      </div>
      <label class="field"><span>Deskripsi</span><textarea class="input" data-f="description">${esc(p?.description || '')}</textarea></label>
      <div class="row wrap"><div class="thumb-sm" data-preview style="width:90px;height:90px;overflow:hidden">${image ? `<img src="${esc(image)}" style="width:100%;height:100%;object-fit:cover">` : '📷'}</div>
        <label class="btn">📷 Pilih foto<input type="file" accept="image/*" data-img hidden></label><button class="btn ghost" data-noimg>Hapus foto</button></div>
      <h4 style="margin:6px 0 0">Opsi / varian</h4>
      ${optionsEditorHtml(p?.options || [])}`,
    foot: `${p ? '<button class="btn outline-bad" data-del>Hapus produk</button><span class="grow"></span>' : ''}<button class="btn" data-close>Batal</button><button class="btn gold" data-save>Simpan</button>`,
  });
  m.el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-addgrp]')) {
      m.$('[data-opts]').insertAdjacentHTML('beforeend', grpHtml({ name: '', required: false, multi: false, choices: [{ name: '', price: 0 }] }));
    }
    if (e.target.closest('[data-addchoice]')) e.target.closest('[data-grp]').querySelector('[data-choices]').insertAdjacentHTML('beforeend', choiceRow());
    if (e.target.closest('[data-delchoice]')) e.target.closest('[data-choice]').remove();
    if (e.target.closest('[data-delgrp]')) e.target.closest('[data-grp]').remove();
    if (e.target.closest('[data-noimg]')) (image = ''), (m.$('[data-preview]').innerHTML = '📷');
    if (e.target.closest('[data-del]')) {
      if (!(await confirmBox(`Hapus ${p.name}? Riwayat penjualan tetap tersimpan.`, { ok: 'Hapus', danger: true }))) return;
      await api(`/admin/products/${p.id}`, { method: 'DELETE' });
      m.close();
      toast('Produk dihapus', 'ok');
      render();
    }
    if (e.target.closest('[data-save]')) {
      const f = (k) => m.$(`[data-f="${k}"]`);
      const body = {
        name: f('name').value,
        category_id: Number(f('category_id').value),
        price: Number(f('price').value.replace(/\D/g, '')),
        cost: Number(f('cost').value.replace(/\D/g, '')) || 0,
        sort: Number(f('sort').value) || 0,
        available: f('available').checked,
        description: f('description').value,
        image,
        options: readOptions(m.el),
      };
      try {
        await api(p ? `/admin/products/${p.id}` : '/admin/products', { method: p ? 'PUT' : 'POST', body });
        m.close();
        toast('Tersimpan', 'ok');
        render();
      } catch (err) {
        toast(err.message, 'bad');
      }
    }
  });
  m.$('[data-img]').addEventListener('change', async (e) => {
    const file = e.target.files[0];
    if (!file) return;
    image = await resizeImage(file, 600);
    m.$('[data-preview]').innerHTML = `<img src="${image}" style="width:100%;height:100%;object-fit:cover">`;
  });
}

async function recipeEditor(p) {
  const [rec, ings] = await Promise.all([api(`/products/${p.id}/recipe`), api('/stock/ingredients')]);
  const optNames = p.options.flatMap((g) => g.choices.map((c) => c.name));
  const row = (r = {}) => `<div class="row wrap" data-r>
    <select class="input grow" data-ing style="min-width:180px">${ings.map((i) => `<option value="${i.id}" ${r.ingredient_id === i.id ? 'selected' : ''}>${esc(i.name)} (${esc(i.unit)}) · ${rupiah(i.cost_per_unit)}/${esc(i.unit)}</option>`).join('')}</select>
    <input class="input" data-qty inputmode="decimal" placeholder="Jumlah" value="${r.qty ?? ''}" style="max-width:110px">
    <select class="input" data-opt style="max-width:180px"><option value="">Selalu dipakai</option>${optNames.map((o) => `<option ${r.option_name === o ? 'selected' : ''}>${esc(o)}</option>`).join('')}</select>
    <button class="btn sm ghost" data-delr>✕</button></div>`;
  const m = modal({
    title: `Resep ${esc(p.name)}`,
    wide: true,
    body: `<p class="small muted" style="margin:0">Kebutuhan bahan untuk <b>1 porsi</b>. Bahan dengan pilihan opsi (mis. "Large" atau "Ice") hanya dipakai jika opsi itu dipilih. Stok berkurang otomatis saat pesanan diterima, dan HPP dihitung dari harga rata-rata bahan.</p>
      ${ings.length ? '' : '<div class="card pad">Belum ada bahan. Tambahkan dulu di tab Stok Bahan.</div>'}
      <div class="stack" data-rows>${rec.items.map((r) => row(r)).join('')}</div>
      <button class="btn sm" data-addr style="align-self:flex-start">+ Bahan</button>
      <div class="tot big"><span>Estimasi HPP dasar</span><span data-hpp></span></div>`,
    foot: '<button class="btn" data-close>Batal</button><button class="btn gold" data-save>Simpan Resep</button>',
  });
  const calc = () => {
    let c = 0;
    m.$$('[data-r]').forEach((r) => {
      if ($('[data-opt]', r).value) return;
      const ing = ings.find((i) => i.id === Number($('[data-ing]', r).value));
      c += (Number($('[data-qty]', r).value.replace(',', '.')) || 0) * (ing?.cost_per_unit || 0);
    });
    m.$('[data-hpp]').textContent = rupiah(c) + (p.price ? ` (${num((c / p.price) * 100, 1)}% dari harga)` : '');
  };
  m.el.addEventListener('input', calc);
  m.el.addEventListener('change', calc);
  m.el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-addr]')) m.$('[data-rows]').insertAdjacentHTML('beforeend', row()), calc();
    if (e.target.closest('[data-delr]')) e.target.closest('[data-r]').remove(), calc();
    if (e.target.closest('[data-save]')) {
      const items = m.$$('[data-r]').map((r) => ({ ingredient_id: Number($('[data-ing]', r).value), qty: Number($('[data-qty]', r).value.replace(',', '.')), option_name: $('[data-opt]', r).value }));
      try {
        await api(`/products/${p.id}/recipe`, { method: 'PUT', body: { items } });
        m.close();
        toast('Resep tersimpan', 'ok');
        render();
      } catch (err) {
        toast(err.message, 'bad');
      }
    }
  });
  calc();
}

function categoryEditor() {
  const { categories } = menuCache;
  const row = (c = {}) => `<div class="row" data-cat="${c.id || ''}"><input class="input" data-icon value="${esc(c.icon || '')}" placeholder="🍰" style="max-width:70px"><input class="input grow" data-name value="${esc(c.name || '')}" placeholder="Nama kategori"><input class="input" data-sort value="${c.sort ?? 0}" style="max-width:70px" inputmode="numeric"><button class="btn sm outline-bad" data-delc>Hapus</button></div>`;
  const m = modal({
    title: 'Kategori menu',
    body: `<div class="stack" data-list>${categories.map(row).join('')}</div><button class="btn sm" data-addc style="align-self:flex-start">+ Kategori</button>`,
    foot: '<button class="btn" data-close>Tutup</button><button class="btn gold" data-save>Simpan</button>',
    onClose: render,
  });
  m.el.addEventListener('click', async (e) => {
    if (e.target.closest('[data-addc]')) m.$('[data-list]').insertAdjacentHTML('beforeend', row());
    const del = e.target.closest('[data-delc]');
    if (del) {
      const r = del.closest('[data-cat]');
      if (r.dataset.cat) {
        if (!(await confirmBox('Hapus kategori? Produk di dalamnya menjadi tanpa kategori.', { ok: 'Hapus', danger: true }))) return;
        await api(`/admin/categories/${r.dataset.cat}`, { method: 'DELETE' });
      }
      r.remove();
    }
    if (e.target.closest('[data-save]')) {
      try {
        for (const r of m.$$('[data-cat]')) {
          const body = { name: $('[data-name]', r).value, icon: $('[data-icon]', r).value, sort: Number($('[data-sort]', r).value) || 0 };
          if (!body.name.trim()) continue;
          await api(r.dataset.cat ? `/admin/categories/${r.dataset.cat}` : '/admin/categories', { method: r.dataset.cat ? 'PUT' : 'POST', body });
        }
        toast('Kategori tersimpan', 'ok');
        m.close();
      } catch (err) {
        toast(err.message, 'bad');
      }
    }
  });
}

// ===================== STOK =====================
const MV = { purchase: '📥 Pembelian', sale: '☕ Terjual', adjust: '⚖️ Opname/Penyesuaian', waste: '🗑️ Terbuang', return: '↩️ Batal pesanan' };
const sr = { from: today(), to: today(), type: '' };
async function renderStock() {
  const [ings, moves] = await Promise.all([api('/stock/ingredients'), api(`/stock/movements?from=${sr.from}&to=${sr.to}${sr.type ? '&type=' + sr.type : ''}`)]);
  const value = ings.reduce((a, i) => a + Math.max(0, i.stock) * i.cost_per_unit, 0);
  $('#main').innerHTML = `<div class="stack" style="gap:14px">
    <div class="section-head"><h2>Stok Bahan Baku</h2>
      <button class="btn" data-mv="purchase">📥 Pembelian</button><button class="btn" data-mv="waste">🗑️ Terbuang</button><button class="btn" data-mv="adjust">⚖️ Stok Opname</button><button class="btn gold" data-newing>➕ Bahan Baru</button></div>
    <div class="stats"><div class="card stat"><div class="label">Jumlah bahan</div><div class="value">${ings.length}</div></div><div class="card stat"><div class="label">Nilai persediaan</div><div class="value">${rupiah(value)}</div></div><div class="card stat"><div class="label">Bahan menipis</div><div class="value ${ings.some((i) => i.low) ? 'neg' : ''}">${ings.filter((i) => i.low && i.active).length}</div></div></div>
    <div class="card table-wrap"><table class="tbl"><thead><tr><th>Bahan</th><th class="num">Stok</th><th class="num">Minimum</th><th>Satuan</th><th class="num">Harga rata-rata</th><th class="num">Nilai</th><th></th></tr></thead><tbody>
      ${ings.map((i) => `<tr class="${i.low && i.active ? 'low' : ''}"><td>${esc(i.name)} ${i.active ? '' : '<span class="badge">nonaktif</span>'}</td><td class="num"><b>${num(i.stock)}</b></td><td class="num">${num(i.min_stock)}</td><td>${esc(i.unit)}</td><td class="num">${rupiah(i.cost_per_unit)}</td><td class="num">${rupiah(Math.max(0, i.stock) * i.cost_per_unit)}</td><td class="right"><button class="btn sm" data-editing="${i.id}">✏️</button></td></tr>`).join('') || '<tr><td colspan="7" class="muted">Belum ada bahan</td></tr>'}
    </tbody></table></div>
    <div class="card pad row wrap"><h3 class="grow">Riwayat mutasi stok</h3>
      <input type="date" class="input" data-sr="from" value="${sr.from}" style="max-width:170px"><span>s/d</span><input type="date" class="input" data-sr="to" value="${sr.to}" style="max-width:170px">
      <select class="input" data-sr="type" style="max-width:200px"><option value="">Semua jenis</option>${Object.entries(MV).map(([k, v]) => `<option value="${k}" ${sr.type === k ? 'selected' : ''}>${v}</option>`).join('')}</select></div>
    <div class="card table-wrap"><table class="tbl"><thead><tr><th>Waktu</th><th>Bahan</th><th>Jenis</th><th class="num">Jumlah</th><th class="num">Nilai</th><th>Catatan</th><th>Oleh</th></tr></thead><tbody>
      ${moves.map((m) => `<tr><td class="small">${dateTimeOf(m.created_at)}</td><td>${esc(m.ingredient_name)}</td><td>${MV[m.type]}</td><td class="num">${m.qty > 0 ? '+' : ''}${num(m.qty)} ${esc(m.unit)}</td><td class="num">${rupiah(m.total_cost)}</td><td class="small">${esc(m.note)}</td><td class="small">${esc(m.user_name || '')}</td></tr>`).join('') || '<tr><td colspan="7" class="muted">Tidak ada mutasi</td></tr>'}
    </tbody></table></div></div>`;
  $('#main').onchange = (e) => {
    const i = e.target.closest('[data-sr]');
    if (i) (sr[i.dataset.sr] = i.value), render();
  };
  $('#main').onclick = (e) => {
    if (e.target.closest('[data-newing]')) return ingredientEditor(null);
    const ed = e.target.closest('[data-editing]');
    if (ed) return ingredientEditor(ings.find((i) => i.id === Number(ed.dataset.editing)));
    const mv = e.target.closest('[data-mv]');
    if (mv) return movementDialog(mv.dataset.mv, ings);
  };
}

function ingredientEditor(i) {
  const m = modal({
    title: i ? `Edit ${esc(i.name)}` : 'Bahan baru',
    body: `<div class="grid-2">
      <label class="field"><span>Nama bahan</span><input class="input" data-f="name" value="${esc(i?.name || '')}"></label>
      <label class="field"><span>Satuan</span><input class="input" data-f="unit" list="units" value="${esc(i?.unit || 'gr')}"><datalist id="units"><option>gr</option><option>kg</option><option>ml</option><option>liter</option><option>pcs</option><option>pack</option></datalist></label>
      <label class="field"><span>Stok minimum (peringatan)</span><input class="input" data-f="min_stock" inputmode="decimal" value="${i?.min_stock ?? ''}"></label>
      <label class="field"><span>Harga per satuan (Rp)</span><input class="input" data-f="cost_per_unit" inputmode="decimal" value="${i?.cost_per_unit ?? ''}"></label>
      ${i ? '' : '<label class="field"><span>Stok awal</span><input class="input" data-f="stock" inputmode="decimal"></label>'}
      ${i ? `<label class="check" style="margin-top:24px"><input type="checkbox" data-f="active" ${i.active ? 'checked' : ''}> Aktif</label>` : ''}
    </div>`,
    foot: `${i ? '<button class="btn outline-bad" data-del>Hapus</button><span class="grow"></span>' : ''}<button class="btn" data-close>Batal</button><button class="btn gold" data-save>Simpan</button>`,
  });
  m.el.addEventListener('click', async (e) => {
    const f = (k) => m.$(`[data-f="${k}"]`);
    if (e.target.closest('[data-del]')) {
      if (!(await confirmBox(`Hapus ${i.name}? Resep & riwayat mutasinya ikut terhapus. Sebaiknya nonaktifkan saja.`, { ok: 'Hapus', danger: true }))) return;
      await api(`/stock/ingredients/${i.id}`, { method: 'DELETE' });
      m.close();
      render();
    }
    if (e.target.closest('[data-save]')) {
      const body = { name: f('name').value, unit: f('unit').value, min_stock: Number(f('min_stock').value.replace(',', '.')) || 0, cost_per_unit: Number(f('cost_per_unit').value.replace(',', '.')) || 0, stock: Number(f('stock')?.value.replace(',', '.')) || 0, active: i ? f('active').checked : true };
      try {
        await api(i ? `/stock/ingredients/${i.id}` : '/stock/ingredients', { method: i ? 'PUT' : 'POST', body });
        m.close();
        toast('Tersimpan', 'ok');
        render();
      } catch (err) {
        toast(err.message, 'bad');
      }
    }
  });
}

function movementDialog(type, ings) {
  const title = { purchase: 'Pembelian / stok masuk', waste: 'Bahan terbuang / rusak', adjust: 'Stok opname (hitung fisik)' }[type];
  const m = modal({
    title,
    body: `<label class="field"><span>Bahan</span><select class="input" data-ing>${ings.filter((i) => i.active).map((i) => `<option value="${i.id}">${esc(i.name)} — stok sistem ${num(i.stock)} ${esc(i.unit)}</option>`).join('')}</select></label>
      ${type === 'adjust' ? '<label class="field"><span>Jumlah fisik sebenarnya</span><input class="input" data-counted inputmode="decimal"></label><p class="small muted" style="margin:0">Selisih dengan stok sistem dicatat sebagai penyesuaian (masuk laporan laba rugi sebagai selisih stok).</p>' : '<label class="field"><span>Jumlah</span><input class="input" data-qty inputmode="decimal"></label>'}
      ${type === 'purchase' ? '<label class="field"><span>Total harga beli (Rp)</span><input class="input" data-cost inputmode="numeric"></label>' : ''}
      <label class="field"><span>Catatan</span><input class="input" data-note></label>`,
    foot: '<button class="btn" data-close>Batal</button><button class="btn gold" data-ok>Simpan</button>',
  });
  m.$('[data-ok]').onclick = async () => {
    try {
      await api('/stock/movements', {
        method: 'POST',
        body: {
          type,
          ingredient_id: Number(m.$('[data-ing]').value),
          qty: Number(m.$('[data-qty]')?.value.replace(',', '.')) || 0,
          counted: m.$('[data-counted]')?.value.replace(',', '.'),
          total_cost: Number(m.$('[data-cost]')?.value.replace(/\D/g, '')) || 0,
          note: m.$('[data-note]').value,
        },
      });
      m.close();
      toast('Tersimpan', 'ok');
      render();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
}

// ===================== KEUANGAN =====================
const fr = { from: today().slice(0, 8) + '01', to: today() };
let settingsCache;
async function renderFinance() {
  settingsCache = await api('/admin/settings');
  const entries = await api(`/finance/entries?from=${fr.from}&to=${fr.to}`);
  const sum = (t) => entries.filter((x) => x.type === t).reduce((a, b) => a + b.amount, 0);
  const byCat = {};
  for (const e of entries.filter((x) => x.type === 'expense')) byCat[e.category] = (byCat[e.category] || 0) + e.amount;
  const maxCat = Math.max(1, ...Object.values(byCat));
  $('#main').innerHTML = `<div class="stack" style="gap:14px">
    <div class="section-head"><h2>Keuangan: Pengeluaran & Pemasukan Lain</h2>
      <input type="date" class="input" data-fr="from" value="${fr.from}" style="max-width:170px"><span>s/d</span><input type="date" class="input" data-fr="to" value="${fr.to}" style="max-width:170px">
      <button class="btn gold" data-add="expense">➖ Pengeluaran</button><button class="btn" data-add="income">➕ Pemasukan</button></div>
    <div class="stats"><div class="card stat"><div class="label">Total pengeluaran</div><div class="value neg">${rupiah(sum('expense'))}</div></div><div class="card stat"><div class="label">Pemasukan lain</div><div class="value pos">${rupiah(sum('income'))}</div></div></div>
    ${Object.keys(byCat).length ? `<div class="card pad stack"><h3>Pengeluaran per kategori</h3><div class="bars">${Object.entries(byCat).sort((a, b) => b[1] - a[1]).map(([k, v]) => `<div class="bar-row" style="grid-template-columns:150px 1fr 120px"><span>${esc(k)}</span><div class="bar-track"><div class="bar-fill" style="width:${(v / maxCat) * 100}%;background:var(--bad)"></div></div><span class="right">${rupiah(v)}</span></div>`).join('')}</div></div>` : ''}
    <div class="card table-wrap"><table class="tbl"><thead><tr><th>Tanggal</th><th>Jenis</th><th>Kategori</th><th>Keterangan</th><th>Oleh</th><th class="num">Nominal</th><th></th></tr></thead><tbody>
      ${entries.map((x) => `<tr><td>${esc(x.business_date)} <span class="small muted">${timeOf(x.created_at)}</span></td><td>${x.type === 'expense' ? '<span class="badge unpaid">Keluar</span>' : '<span class="badge paid">Masuk</span>'}</td><td>${esc(x.category)}</td><td>${esc(x.description)}</td><td class="small">${esc(x.user_name || '')}</td><td class="num">${rupiah(x.amount)}</td><td class="right"><button class="btn sm ghost" data-delx="${x.id}">🗑️</button></td></tr>`).join('') || '<tr><td colspan="7" class="muted">Belum ada catatan pada periode ini</td></tr>'}
    </tbody></table></div></div>`;
  $('#main').onchange = (e) => {
    const i = e.target.closest('[data-fr]');
    if (i && i.value) (fr[i.dataset.fr] = i.value), render();
  };
  $('#main').onclick = async (e) => {
    const d = e.target.closest('[data-delx]');
    if (d && (await confirmBox('Hapus catatan ini?', { ok: 'Hapus', danger: true }))) {
      await api(`/finance/entries/${d.dataset.delx}`, { method: 'DELETE' });
      return render();
    }
    const a = e.target.closest('[data-add]');
    if (!a) return;
    const type = a.dataset.add;
    const cats = String(type === 'expense' ? settingsCache.expense_categories : settingsCache.income_categories).split(',').map((x) => x.trim()).filter(Boolean);
    const m = modal({
      title: type === 'expense' ? 'Catat pengeluaran' : 'Catat pemasukan lain',
      body: `<label class="field"><span>Tanggal</span><input type="date" class="input" data-date value="${today()}"></label>
        <label class="field"><span>Kategori</span><input class="input" data-cat list="fcats" value="${esc(cats[0] || '')}"><datalist id="fcats">${cats.map((c) => `<option value="${esc(c)}">`).join('')}</datalist></label>
        <label class="field"><span>Nominal (Rp)</span><input class="input" data-amt inputmode="numeric"></label>
        <label class="field"><span>Keterangan</span><input class="input" data-desc></label>`,
      foot: '<button class="btn" data-close>Batal</button><button class="btn gold" data-ok>Simpan</button>',
    });
    m.$('[data-ok]').onclick = async () => {
      try {
        await api('/finance/entries', { method: 'POST', body: { type, business_date: m.$('[data-date]').value, category: m.$('[data-cat]').value, amount: Number(m.$('[data-amt]').value.replace(/\D/g, '')), description: m.$('[data-desc]').value } });
        m.close();
        render();
      } catch (err) {
        toast(err.message, 'bad');
      }
    };
  };
}

// ===================== MEJA & QR =====================
async function renderTables() {
  const tables = await api('/tables');
  const qrs = await Promise.all(tables.map((t) => api(`/tables/${t.id}/qr`)));
  $('#main').innerHTML = `<div class="stack" style="gap:14px">
    <div class="section-head"><h2>Meja & QR (${tables.length})</h2><button class="btn" data-printqr>🖨️ Cetak semua QR</button><button class="btn gold" data-newt>➕ Meja</button></div>
    <p class="small muted" style="margin:0">Tablet meja: buka <b>/meja.html</b> lalu login staf untuk memilih meja, atau scan QR. Pelanggan juga bisa memindai QR dengan HP sendiri untuk memesan.</p>
    <div class="product-grid" style="grid-template-columns:repeat(auto-fill,minmax(220px,1fr))">${tables
      .map(
        (t, i) => `<div class="card qr-card stack" style="align-items:center"><b>${esc(t.name)}</b> ${t.active ? '' : '<span class="badge cancelled">nonaktif</span>'}${qrs[i].svg}
        <a class="small" href="${esc(qrs[i].url)}" target="_blank" style="word-break:break-all">${esc(qrs[i].url)}</a>
        <div class="row"><button class="btn sm" data-edt="${t.id}">✏️ Ubah</button><button class="btn sm" data-regen="${t.id}" title="Kode lama tidak berlaku">🔄 Kode baru</button></div></div>`
      )
      .join('')}</div></div>`;
  $('#main').onclick = async (e) => {
    if (e.target.closest('[data-printqr]')) {
      let area = $('#print-area');
      if (!area) document.body.insertAdjacentHTML('beforeend', '<div id="print-area"></div>'), (area = $('#print-area'));
      area.className = 'qr-sheet';
      area.innerHTML = `<div class="qr-grid">${tables.filter((t) => t.active).map((t) => `<div class="qr-item"><div style="font-size:18px;font-weight:800">${esc(t.name)}</div>${qrs[tables.indexOf(t)].svg}<div>Scan untuk pesan · Five5Star Coffee</div></div>`).join('')}</div>`;
      return setTimeout(() => print(), 50);
    }
    if (e.target.closest('[data-newt]')) {
      const name = prompt('Nama meja baru', `Meja ${tables.length + 1}`);
      if (name) await api('/admin/tables', { method: 'POST', body: { name } }).catch((err) => toast(err.message, 'bad'));
      return render();
    }
    const rg = e.target.closest('[data-regen]');
    if (rg) {
      const t = tables.find((x) => x.id === Number(rg.dataset.regen));
      if (!(await confirmBox(`Buat kode baru untuk ${t.name}? QR lama & tablet yang memakai kode lama harus diatur ulang.`, { ok: 'Buat kode baru' }))) return;
      await api(`/admin/tables/${t.id}`, { method: 'PUT', body: { name: t.name, active: !!t.active, regenerate: true } });
      return render();
    }
    const ed = e.target.closest('[data-edt]');
    if (ed) {
      const t = tables.find((x) => x.id === Number(ed.dataset.edt));
      const m = modal({
        title: `Ubah ${esc(t.name)}`,
        body: `<label class="field"><span>Nama</span><input class="input" data-name value="${esc(t.name)}"></label><label class="check"><input type="checkbox" data-active ${t.active ? 'checked' : ''}> Aktif</label>`,
        foot: '<button class="btn outline-bad" data-del>Hapus</button><span class="grow"></span><button class="btn" data-close>Batal</button><button class="btn gold" data-ok>Simpan</button>',
      });
      m.$('[data-ok]').onclick = async () => {
        await api(`/admin/tables/${t.id}`, { method: 'PUT', body: { name: m.$('[data-name]').value, active: m.$('[data-active]').checked } }).catch((err) => toast(err.message, 'bad'));
        m.close();
        render();
      };
      m.$('[data-del]').onclick = async () => {
        if (!(await confirmBox(`Hapus ${t.name}?`, { ok: 'Hapus', danger: true }))) return;
        await api(`/admin/tables/${t.id}`, { method: 'DELETE' });
        m.close();
        render();
      };
    }
  };
}

// ===================== PENGGUNA =====================
async function renderUsers() {
  const users = await api('/admin/users');
  $('#main').innerHTML = `<div class="stack" style="gap:14px">
    <div class="section-head"><h2>Pengguna</h2><button class="btn gold" data-newu>➕ Pengguna</button></div>
    <div class="card pad small"><b>Superadmin</b>: akses penuh — laporan laba rugi harian/bulanan/tahunan, menu & resep, stok opname, keuangan, meja, pengguna, pengaturan, plus semua fungsi kasir.<br><b>Kasir</b>: terima & proses pesanan, pembayaran, layar barista, catat pembelian stok/terbuang & pengeluaran hari ini, ringkasan penjualan harian.</div>
    <div class="card table-wrap"><table class="tbl"><thead><tr><th>Nama</th><th>Peran</th><th>Status</th><th>Dibuat</th><th></th></tr></thead><tbody>
      ${users.map((u) => `<tr><td><b>${esc(u.name)}</b></td><td>${u.role === 'superadmin' ? '<span class="badge ready">Superadmin</span>' : '<span class="badge preparing">Kasir</span>'}</td><td>${u.active ? 'Aktif' : '<span class="badge cancelled">Nonaktif</span>'}</td><td class="small">${esc(u.created_at)}</td><td class="right"><button class="btn sm" data-edu="${u.id}">✏️</button></td></tr>`).join('')}
    </tbody></table></div></div>`;
  $('#main').onclick = (e) => {
    if (e.target.closest('[data-newu]')) return userEditor(null);
    const ed = e.target.closest('[data-edu]');
    if (ed) userEditor(users.find((u) => u.id === Number(ed.dataset.edu)));
  };
}
function userEditor(u) {
  const m = modal({
    title: u ? `Ubah ${esc(u.name)}` : 'Pengguna baru',
    body: `<label class="field"><span>Nama</span><input class="input" data-name value="${esc(u?.name || '')}"></label>
      <label class="field"><span>Peran</span><select class="input" data-role><option value="kasir" ${u?.role === 'kasir' ? 'selected' : ''}>Kasir</option><option value="superadmin" ${u?.role === 'superadmin' ? 'selected' : ''}>Superadmin</option></select></label>
      <label class="field"><span>${u ? 'PIN baru (kosongkan jika tidak diganti)' : 'PIN (4–8 digit)'}</span><input class="input" data-pin inputmode="numeric" maxlength="8" autocomplete="off"></label>
      ${u ? `<label class="check"><input type="checkbox" data-active ${u.active ? 'checked' : ''}> Aktif</label>` : ''}`,
    foot: `${u ? '<button class="btn outline-bad" data-del>Hapus</button><span class="grow"></span>' : ''}<button class="btn" data-close>Batal</button><button class="btn gold" data-ok>Simpan</button>`,
  });
  m.$('[data-ok]').onclick = async () => {
    const body = { name: m.$('[data-name]').value, role: m.$('[data-role]').value, pin: m.$('[data-pin]').value || undefined, active: u ? m.$('[data-active]').checked : true };
    try {
      await api(u ? `/admin/users/${u.id}` : '/admin/users', { method: u ? 'PUT' : 'POST', body });
      m.close();
      toast('Tersimpan', 'ok');
      render();
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
  m.$('[data-del]')?.addEventListener('click', async () => {
    if (!(await confirmBox(`Hapus ${u.name}?`, { ok: 'Hapus', danger: true }))) return;
    try {
      await api(`/admin/users/${u.id}`, { method: 'DELETE' });
      m.close();
      render();
    } catch (err) {
      toast(err.message, 'bad');
    }
  });
}

// ===================== PENGATURAN =====================
const feeRow = (f = { name: '', type: 'percent', value: '', applies: 'all' }) => `<div class="row wrap" data-fee>
  <input class="input grow" data-fname placeholder="Nama (mis. Service charge)" value="${esc(f.name)}" style="min-width:160px">
  <select class="input" data-ftype style="max-width:130px"><option value="percent" ${f.type === 'percent' ? 'selected' : ''}>Persen (%)</option><option value="fixed" ${f.type === 'fixed' ? 'selected' : ''}>Nominal (Rp)</option></select>
  <input class="input" data-fvalue inputmode="decimal" placeholder="Nilai" value="${f.value}" style="max-width:110px">
  <select class="input" data-fapplies style="max-width:170px"><option value="all" ${f.applies === 'all' ? 'selected' : ''}>Semua pesanan</option><option value="dine_in" ${f.applies === 'dine_in' ? 'selected' : ''}>Makan di tempat</option><option value="takeaway" ${f.applies === 'takeaway' ? 'selected' : ''}>Bawa pulang</option></select>
  <button class="btn sm ghost" data-delfee>✕</button></div>`;

async function renderSettings() {
  const s = await api('/admin/settings');
  let fees = [];
  try {
    fees = JSON.parse(s.extra_fees || '[]');
  } catch {
    fees = [];
  }
  // Service charge lama dipindahkan ke daftar biaya tambahan
  if (Number(s.service_percent) > 0) fees.unshift({ name: 'Service charge', type: 'percent', value: Number(s.service_percent), applies: 'all' });
  const f = (key, label, extra = '') => `<label class="field"><span>${label}</span><input class="input" data-s="${key}" value="${esc(s[key] ?? '')}" ${extra}></label>`;
  const chk = (key, label) => `<label class="check"><input type="checkbox" data-s="${key}" ${s[key] === '1' ? 'checked' : ''}> ${label}</label>`;
  $('#main').innerHTML = `<div class="stack" style="gap:14px;max-width:860px">
    <h2>Pengaturan</h2>
    <div class="card pad stack"><h3>Toko & struk</h3><div class="grid-2">${f('store_name', 'Nama toko')}${f('store_phone', 'Telepon')}</div>${f('store_address', 'Alamat')}${f('receipt_footer', 'Catatan kaki struk')}</div>
    <div class="card pad stack"><h3>PPN</h3><div class="grid-3">${f('tax_percent', 'PPN (%)', 'inputmode="decimal"')}${f('timezone', 'Zona waktu')}</div>
      ${chk('tax_inclusive', 'Harga menu sudah termasuk PPN (PPN dihitung dari dalam harga, tidak ditambahkan ke tagihan)')}
      ${f('payment_methods', 'Metode pembayaran (pisahkan koma; "Tunai" untuk hitung kembalian)')}</div>
    <div class="card pad stack"><h3>Biaya tambahan otomatis</h3>
      <p class="small muted" style="margin:0">Ditambahkan otomatis ke setiap pesanan sesuai jenisnya, mis. service charge 5% atau biaya kemasan Rp2.000 untuk bawa pulang.</p>
      <div class="stack" id="fees">${fees.map(feeRow).join('')}</div>
      <button class="btn sm" data-addfee style="align-self:flex-start">+ Biaya tambahan</button></div>
    <div class="card pad stack"><h3>Alur pesanan</h3>
      ${chk('auto_accept', 'Pesanan dari meja langsung masuk ke barista (tanpa konfirmasi kasir)')}
      ${chk('require_payment_first', 'Wajib bayar dulu di kasir sebelum pesanan dibuat (pesanan otomatis ke barista setelah lunas)')}
      ${f('queue_prefix', 'Awalan nomor antrean (mis. A → A001)', 'maxlength="3"')}</div>
    <div class="card pad stack"><h3>Panggilan suara</h3>
      ${f('voice_template', 'Kalimat panggilan')}
      <p class="small muted" style="margin:0">Variabel: <code>{nomor}</code> <code>{nama}</code> <code>{meja}</code> <code>{nama_kalimat}</code> (", atas nama Budi") <code>{meja_kalimat}</code> (", Meja 3")</p>
      <div class="grid-2">${f('voice_repeat', 'Diulang berapa kali', 'inputmode="numeric"')}${f('voice_rate', 'Kecepatan bicara (0.5–1.5)', 'inputmode="decimal"')}</div></div>
    <div class="card pad stack"><h3>Kategori keuangan</h3>${f('expense_categories', 'Kategori pengeluaran (pisahkan koma)')}${f('income_categories', 'Kategori pemasukan lain (pisahkan koma)')}</div>
    <div class="row"><span class="grow"></span><button class="btn gold lg" data-save>Simpan Pengaturan</button></div>
  </div>`;
  $('#main').onclick = async (e) => {
    if (e.target.closest('[data-addfee]')) return $('#fees').insertAdjacentHTML('beforeend', feeRow());
    if (e.target.closest('[data-delfee]')) return e.target.closest('[data-fee]').remove();
    if (!e.target.closest('[data-save]')) return;
    const body = {};
    $$('[data-s]').forEach((i) => (body[i.dataset.s] = i.type === 'checkbox' ? (i.checked ? '1' : '0') : i.value));
    body.service_percent = '0';
    body.extra_fees = JSON.stringify(
      $$('[data-fee]').map((r) => ({ name: $('[data-fname]', r).value.trim(), type: $('[data-ftype]', r).value, value: Number($('[data-fvalue]', r).value.replace(',', '.')) || 0, applies: $('[data-fapplies]', r).value })).filter((f) => f.name && f.value > 0)
    );
    try {
      await api('/admin/settings', { method: 'PUT', body });
      toast('Pengaturan tersimpan', 'ok');
    } catch (err) {
      toast(err.message, 'bad');
    }
  };
}

(async () => {
  const user = await requireLogin({ roles: ['superadmin'], title: 'Masuk Superadmin' });
  $('#who').textContent = `${user.name} · Superadmin`;
  const s = await api('/public/settings');
  $('#store').textContent = s.store_name;
  render();
})();
