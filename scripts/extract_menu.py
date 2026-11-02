"""Ekstrak foto menu dari PDF buku menu -> public/img/menu/*.jpg dan src/menu-seed.js.
Pemakaian: python3 scripts/extract_menu.py BUKU_MENU.pdf
"""
import io, json, re, sys, os
import pymupdf as fitz
from PIL import Image
sys.path.insert(0, os.path.dirname(__file__))
from menu_data import CATEGORIES

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(ROOT, 'public', 'img', 'menu')
os.makedirs(OUT, exist_ok=True)
doc = fitz.open(sys.argv[1])
DECOR = {132, 997, 377, 951, 925}
BG = (246, 238, 226)
# Penetapan manual (halaman, xref) untuk label yang sulit dibaca otomatis.
OVERRIDE = {
  'Donut Chocolate': 792, 'Donut Cookies': 798, 'Donut Matcha': 804, 'Donut Tiramisu': 810,
  'Banana Bread': 836, 'Banana Bread Cheese': 842, 'Roti Bakar Coklat Keju': 880, 'Roti Bakar Kaya': 886, 'Roti Bakar Strawberry': 892,
  'French Fries Ori': 622, 'French Fries Pedas': 616, 'Enoki Crispy': 717, 'Singkong Goreng': 628, 'Buncis Crispy': 634, 'Corn Ribs': 640,
  'Tahu Bakso Ori': 646, 'Tahu Bakso Jamur': 652, 'Tahu Bakso Pedas': 658, 'Tahu Bakso Keju': 775, 'Brokoli Crispy': 759, 'Bakso Gulung': 669, 'Mix Platter': 689,
  'Kids Meal A': 933, 'Kids Meal B': 939,
  'OH My Lychee': 2261, 'Peach My Up': 2261, 'Sleep Tight': 2261, 'Es Jeruk Peras': 2264,
}
# Potongan dari render halaman (halaman tanpa objek gambar terpisah): (x0,y0,x1,y1) dalam pt
CROP = {'Filter Coffee': (11, (150, 470, 560, 800)), 'Sate Ayam': (2, (0, 40, 410, 270)), 'Sate Sapi': (2, (130, 290, 595, 520)), 'Sate Taichan': (2, (0, 520, 410, 760))}

def slug(s):
    return re.sub(r'[^a-z0-9]+', '-', s.lower()).strip('-')

def save(img, name):
    img = img.convert('RGBA')
    # Potong ke objek (berdasarkan alpha), beri margin, lalu jadikan kanvas persegi.
    box = img.getchannel('A').point(lambda a: 255 if a > 24 else 0).getbbox()
    if box:
        img = img.crop(box)
    w, h = img.size
    side = int(max(w, h) * 1.12)
    canvas = Image.new('RGBA', (side, side), BG + (255,))
    canvas.alpha_composite(img, ((side - w) // 2, (side - h) // 2))
    im = canvas.convert('RGB')
    im.thumbnail((480, 480), Image.LANCZOS)
    path = os.path.join(OUT, slug(name) + '.jpg')
    im.save(path, 'JPEG', quality=78, optimize=True, progressive=True)
    return '/img/menu/' + slug(name) + '.jpg'

def xref_image(page, xref):
    pix = fitz.Pixmap(doc, xref)
    info = [i for i in doc[page - 1].get_images(full=True) if i[0] == xref]
    smask = info[0][1] if info else 0
    if pix.n - pix.alpha >= 4:
        pix = fitz.Pixmap(fitz.csRGB, pix)
    img = Image.open(io.BytesIO(pix.tobytes('png'))).convert('RGB')
    if smask:
        m = fitz.Pixmap(doc, smask)
        mask = Image.open(io.BytesIO(m.tobytes('png'))).convert('L').resize(img.size)
        img = img.convert('RGBA')
        img.putalpha(mask)
    return img

def lines(page):
    out = []
    for b in page.get_text('dict')['blocks']:
        for l in b.get('lines', []):
            t = ' '.join(s['text'] for s in l['spans']).strip()
            t = re.sub(r'\s+', ' ', t)
            if t:
                out.append((t, fitz.Rect(l['bbox'])))
    return out

def candidates(pno):
    page = doc[pno - 1]
    res = []
    for info in page.get_image_info(xrefs=True):
        r = fitz.Rect(info['bbox'])
        if info['xref'] in DECOR or r.width > page.rect.width * 0.9 or r.width < 60:
            continue
        res.append((info['xref'], r))
    return res

images = {}
by_page = {}
for cat, icon, items in CATEGORIES:
    for (name, price, large, desc, pno, search) in items:
        if pno:
            by_page.setdefault(pno, []).append((name, search or name))

for pno, items in by_page.items():
    page = doc[pno - 1]
    ls = lines(page)
    cands = candidates(pno)
    pairs = []
    for name, search in items:
        if name in OVERRIDE or name in CROP:
            continue
        s = search.lower()
        hits = [r for t, r in ls if t.lower() == s] or [r for t, r in ls if t.lower().startswith(s)] or [r for t, r in ls if s in t.lower()]
        if not hits:
            print('!! nama tidak ditemukan', pno, name)
            continue
        nr = hits[0]
        for xref, r in cands:
            # foto biasanya di atas label nama
            dy = (nr.y0 - r.y1)
            dist = abs((r.x0 + r.x1) / 2 - (nr.x0 + nr.x1) / 2) + abs(dy) * 1.5 + (400 if r.y0 > nr.y1 else 0)
            pairs.append((dist, name, xref))
    pairs.sort()
    used_n, used_x = set(), set()
    for dist, name, xref in pairs:
        if name in used_n or xref in used_x:
            continue
        used_n.add(name); used_x.add(xref)
        images[name] = save(xref_image(pno, xref), name)

for name, xref in OVERRIDE.items():
    pno = next(p for c in CATEGORIES for it in c[2] for p in [it[4]] if it[0] == name)
    if name in ('Peach My Up', 'Sleep Tight'):
        images[name] = images.get('OH My Lychee') or save(xref_image(pno, xref), 'artisan-tea')
        continue
    images[name] = save(xref_image(pno, xref), name)

for name, (pno, rect) in CROP.items():
    pix = doc[pno - 1].get_pixmap(clip=fitz.Rect(*rect), dpi=110)
    images[name] = save(Image.open(io.BytesIO(pix.tobytes('png'))), name)

# Tulis seed JS
seed = []
for sort, (cat, icon, items) in enumerate(CATEGORIES):
    prods = []
    for (name, price, large, desc, pno, search) in items:
        p = {'name': name, 'price': int(round(price * 1000)), 'description': desc, 'image': images.get(name, '')}
        if large:
            p['large'] = int(round(large * 1000))
        prods.append(p)
    seed.append({'name': cat, 'icon': icon, 'products': prods})
missing = [p['name'] for c in seed for p in c['products'] if not p['image'] and c['name'] != 'Add On']
print('Produk:', sum(len(c['products']) for c in seed), 'gambar:', len(set(images.values())), 'tanpa gambar:', missing)
with open(os.path.join(ROOT, 'src', 'menu-seed.js'), 'w') as f:
    f.write('// Dihasilkan otomatis oleh scripts/extract_menu.py dari buku menu PDF. Harga dalam rupiah.\n')
    f.write('export const MENU_SEED = ' + json.dumps(seed, ensure_ascii=False, indent=1) + ';\n')
