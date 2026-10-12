# 교육부 2022 개정 영어과 교육과정 [별표 3] 기본 어휘 추출 (한 번만 실행, 결과는 kice-basic-3000.csv)
# 원본: KICE Word Lister 안내서 PDF (경기도교육청 공개) 인쇄 쪽 5~34, 3단 배열. PDF는 저장소에 넣지 않음
import pdfplumber, re, json, collections
import sys
P = sys.argv[1] if len(sys.argv) > 1 else 'BBS_202307111028067791.pdf'  # python3 extract.py <PDF 경로>
def kmeans1d(xs, k=3, it=30):
    xs = sorted(xs); c = [xs[int(len(xs) * (i + .5) / k)] for i in range(k)]
    for _ in range(it):
        g = [[] for _ in range(k)]
        for x in xs: g[min(range(k), key=lambda i: abs(x - c[i]))].append(x)
        c = [sum(v) / len(v) if v else c[i] for i, v in enumerate(g)]
    return sorted(c)
cols_all = []
with pdfplumber.open(P) as pdf:
    for pi in range(6, 36):
        pg = pdf.pages[pi]
        ws = [w for w in pg.extract_words(x_tolerance=1.5, y_tolerance=2) if w['top'] < pg.height - 60 and w['text'] not in ('기본', '어휘', '목록')]
        rows = collections.defaultdict(list)
        for w in ws: rows[round(w['top'] / 3)].append(w)
        segs = []  # (y, x0, text) 한 줄 안에서 간격이 크면 다른 단
        for y in sorted(rows):
            r = sorted(rows[y], key=lambda w: w['x0']); cur = [r[0]]
            for w in r[1:]:
                if w['x0'] - cur[-1]['x1'] > 18: segs.append((y, cur[0]['x0'], ' '.join(t['text'] for t in cur))); cur = [w]
                else: cur.append(w)
            segs.append((y, cur[0]['x0'], ' '.join(t['text'] for t in cur)))
        c = kmeans1d([s[1] for s in segs])
        col = collections.defaultdict(list)
        for y, x, t in segs: col[min(range(3), key=lambda i: abs(x - c[i]))].append((y, t))
        for k in range(3): cols_all.append([t for y, t in sorted(col[k])])
raw = []
for frags in cols_all:
    for t in frags:
        if re.fullmatch(r'[A-Z]', t): continue  # 알파벳 머리글자
        open_ = raw and (raw[-1].count('(') > raw[-1].count(')') or raw[-1].rstrip().endswith('/'))  # 괄호나 / 가 다음 줄로 이어짐
        if raw and (t.startswith('(') or open_): raw[-1] += ' ' + t; continue  # 괄호가 다음 줄로 넘어감
        raw.append(t)
assert len(raw) == 3000, len(raw)  # 지침: 3,000개
import csv
rows = []
for r in raw:
    fam = re.findall(r'\(([^)]*)\)', r)
    alts = [p.strip() for p in re.sub(r'\([^)]*\)', '', r).strip().split('/')]
    tier = 2 if alts[0].endswith('**') else 1 if alts[0].endswith('*') else 3
    words = [a.strip('*').strip() for a in alts]
    family = [f.strip() for x in fam for f in re.split(r'[,/]', x) if f.strip()]
    rows.append({'word': words[0], 'tier': tier, 'alts': '|'.join(words[1:]), 'family': '|'.join(family), 'raw': r})
n = collections.Counter(r['tier'] for r in rows)
assert (n[1], n[2], n[3]) == (800, 1200, 1000), n  # 지침: * 800, ** 1,200, 나머지 1,000
with open('kice-basic-3000.csv', 'w', newline='') as f:
    w = csv.DictWriter(f, fieldnames=['word', 'tier', 'alts', 'family', 'raw'], lineterminator='\n'); w.writeheader(); w.writerows(rows)
print('ok', len(rows), dict(n))
