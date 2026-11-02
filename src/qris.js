// Utilitas QRIS (standar EMVCo Merchant Presented Mode).
// QRIS statis dari bank/e-wallet diubah menjadi QRIS dinamis berisi nominal tepat,
// sehingga pelanggan tidak perlu mengetik jumlah. Dana tetap masuk ke merchant QRIS yang sama.

export function crc16(str) {
  let crc = 0xffff;
  for (let i = 0; i < str.length; i++) {
    crc ^= str.charCodeAt(i) << 8;
    for (let j = 0; j < 8; j++) crc = crc & 0x8000 ? ((crc << 1) ^ 0x1021) & 0xffff : (crc << 1) & 0xffff;
  }
  return crc.toString(16).toUpperCase().padStart(4, '0');
}

export function parseTLV(payload) {
  const out = [];
  let i = 0;
  while (i < payload.length) {
    const id = payload.slice(i, i + 2);
    const len = Number(payload.slice(i + 2, i + 4));
    if (!/^\d{2}$/.test(id) || !Number.isInteger(len) || i + 4 + len > payload.length) throw new Error('Format QRIS tidak valid');
    out.push({ id, value: payload.slice(i + 4, i + 4 + len) });
    i += 4 + len;
  }
  return out;
}

const tlv = (id, value) => `${id}${String(value.length).padStart(2, '0')}${value}`;

// Validasi payload QRIS & ambil info merchant.
export function inspectQris(payload) {
  const p = String(payload || '').trim();
  if (!p.startsWith('000201')) throw new Error('Ini bukan kode QRIS (harus diawali 000201)');
  const crcIdx = p.lastIndexOf('6304');
  if (crcIdx < 0 || crcIdx !== p.length - 8) throw new Error('Kode QRIS tidak lengkap (CRC tidak ditemukan)');
  if (crc16(p.slice(0, crcIdx + 4)) !== p.slice(crcIdx + 4).toUpperCase()) throw new Error('Kode QRIS rusak (CRC tidak cocok)');
  const tags = parseTLV(p);
  const get = (id) => tags.find((t) => t.id === id)?.value || '';
  const isQris = tags.some((t) => Number(t.id) >= 26 && Number(t.id) <= 51 && /ID\.CO\.QRIS|ID\.CO\./i.test(t.value)) || /QRIS/i.test(p);
  if (!isQris) throw new Error('Kode QR ini bukan QRIS Indonesia');
  return {
    payload: p,
    merchant_name: get('59'),
    merchant_city: get('60'),
    dynamic: get('01') === '12',
    amount: get('54') ? Number(get('54')) : null,
  };
}

// Buat QRIS dinamis dengan nominal tertentu dari QRIS statis.
export function qrisWithAmount(payload, amount) {
  const amt = Math.round(Number(amount));
  if (!(amt > 0)) throw new Error('Nominal tidak valid');
  const info = inspectQris(payload);
  const tags = parseTLV(info.payload).filter((t) => !['54', '55', '56', '57', '63'].includes(t.id));
  const t01 = tags.find((t) => t.id === '01');
  if (t01) t01.value = '12';
  else tags.push({ id: '01', value: '12' });
  tags.push({ id: '54', value: String(amt) });
  tags.sort((a, b) => Number(a.id) - Number(b.id));
  const body = tags.map((t) => tlv(t.id, t.value)).join('') + '6304';
  return body + crc16(body);
}
