// 교재 검사기: 저장소 맨 위에서 node tools/check.js  (오류 있으면 종료코드 1)
// 단어 난이도 기준: tools/cefr/ 의 CEFR-J Wordlist 1.5 + Octanove C1/C2 Profile 1.0 (출처는 tools/cefr/README.md)
const fs = require('fs'), path = require('path');
const file = (...p) => path.join(__dirname, ...p);  // 어디서 실행해도 같은 파일을 찾음
const C = JSON.parse(fs.readFileSync(file('..', 'data', 'course.json'), 'utf8'));
const T = JSON.parse(fs.readFileSync(file('..', 'data', 'leveltest.json'), 'utf8'));

// 규격: 레벨 → CEFR 목표, 표현 수, 단어 수
// 앱 목표 범위 A1~B2: L1 A1, L2 A2, L3 B1, L4 B1+~B2, L5 B2 (상급은 C1 단어까지 허용)
const LV = { 1: { cefr: 1, max: 1, ex: 5, w: 6 }, 2: { cefr: 2, max: 2, ex: 6, w: 8 }, 3: { cefr: 3, max: 3, ex: 6, w: 8 }, 4: { cefr: 4, max: 4, ex: 6, w: 8 }, 5: { cefr: 4, max: 5, ex: 6, w: 8 } };
const CEFR = ['', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const GOALS = ['일상 대화', '여행', '직장', '시험 준비', '병원', '학교', '교회'];
const POS = { n: 'noun', v: 'verb', a: 'adjective' };
const ROLE_MAX = 500;  // 역할극 지시문은 매 대화마다 전송 → 토큰 상한

// 앱과 같은 정규화 (index.html norm과 동일해야 함)
const norm = t => t.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\s+/g, ' ').trim();

// CEFR 사전
const dict = {};
function loadCsv(f) {
  fs.readFileSync(f, 'utf8').split(/\r?\n/).slice(1).forEach(l => {
    const [h, p, lv] = l.split(','), n = CEFR.indexOf(lv);
    if (!h || n < 1) return;
    h.split('/').forEach(w => {
      const k = w.trim().toLowerCase(); if (!k) return;
      (dict[k] = dict[k] || {})[p] = Math.min(dict[k][p] || 9, n);
    });
  });
}
loadCsv(file('cefr', 'cefrj-vocabulary-profile-1.5.csv')); loadCsv(file('cefr', 'octanove-vocabulary-profile-c1c2-1.0.csv'));
const lvOf = (w, pos) => {
  const d = dict[w.toLowerCase()]; if (!d) return 0;
  return Math.min(...Object.values(d));  // 품사별 등급은 편차가 커서(far 형용사 B2 등) 가장 쉬운 쓰임 기준
};

const out = { err: [], warn: [], info: [] };
const add = (k, where, msg) => out[k].push(`${where}: ${msg}`);

// 표현 변형 (축약 ↔ 풀어쓰기): 맞게 말했는데 오답 처리되는지
const PAIRS = [["i'm", 'i am'], ["don't", 'do not'], ["can't", 'cannot'], ["it's", 'it is'], ["i'd", 'i would'], ["i'll", 'i will'],
  ["that's", 'that is'], ["what's", 'what is'], ["there's", 'there is'], ["isn't", 'is not'], ["won't", 'will not'], ["i've", 'i have'],
  ["you're", 'you are'], ["we're", 'we are'], ["doesn't", 'does not'], ["didn't", 'did not'], ["wouldn't", 'would not'], ["couldn't", 'could not']];
const variants = s => {
  const n = norm(s), v = [];
  PAIRS.forEach(([a, b]) => {
    const ra = new RegExp(`\\b${a}\\b`), rb = new RegExp(`\\b${b}\\b`);
    if (ra.test(n)) v.push(n.replace(ra, b));
    if (rb.test(n)) v.push(n.replace(rb, a));
  });
  return v;
};
// 엉뚱한 답: 이런 말에 통과하면 너무 느슨함
const JUNK = ['yes', 'no', 'okay', 'thank you', 'hello', "i'm a dog", 'i like it', "i don't know", 'good', 'what', 'i want'];

const ids = new Set(), wordSeen = {}, lenByLv = {}, wordLvStat = {};
const allEx = Object.entries(C).flatMap(([lv, us]) => us.flatMap(u => u.ex.map((e, i) => ({ lv, id: u.id, i, en: e[0] }))));

for (const [lv, us] of Object.entries(C)) {
  const spec = LV[lv];
  if (!spec) { add('err', `레벨 ${lv}`, '규격에 없는 레벨'); continue; }
  us.forEach(u => {
    const at = `L${lv} ${u.id}`;
    // 1) 규격
    ['id', 'title', 'scene', 'grammar', 'role'].forEach(k => { if (typeof u[k] !== 'string' || !u[k].trim()) add('err', at, `${k} 없음`); });
    if (ids.has(u.id)) add('err', at, 'id 중복'); ids.add(u.id);
    if (!Array.isArray(u.goals) || !u.goals.length) add('err', at, 'goals 없음');
    else u.goals.forEach(g => { if (!GOALS.includes(g)) add('err', at, `없는 목표 "${g}"`); });
    if (u.ex.length !== spec.ex) add('warn', at, `표현 ${u.ex.length}개 (규격 ${spec.ex})`);
    if (u.words.length !== spec.w) add('warn', at, `단어 ${u.words.length}개 (규격 ${spec.w})`);
    if (u.role.length > ROLE_MAX) add('warn', at, `역할극 지시문 ${u.role.length}자 (상한 ${ROLE_MAX})`);

    // 2) 채점 기준
    u.ex.forEach((e, i) => {
      const w = `${at} 표현${i + 1} "${e[0]}"`;
      if (e.length !== 3 || e.some(x => typeof x !== 'string' || !x.trim())) return add('err', w, '[영어, 뜻, 정규식] 형식 아님');
      let re; try { re = new RegExp(e[2], 'i'); } catch (x) { return add('err', w, `정규식 오류 ${x.message}`); }
      if (!re.test(norm(e[0]))) add('err', w, '교재 문장이 자기 채점 기준을 통과 못 함');
      variants(e[0]).forEach(v => { if (!re.test(v)) add('warn', w, `빡빡함: "${v}" 오답 처리`); });
      const junk = JUNK.filter(j => re.test(norm(j)));
      if (junk.length) add('warn', w, `느슨함: "${junk.join('", "')}"도 통과`);
      u.ex.forEach((o, j) => { if (j !== i && re.test(norm(o[0]))) add('warn', w, `겹침: 같은 유닛 표현${j + 1} "${o[0]}"도 이 표현으로 인정`); });
      (lenByLv[lv] = lenByLv[lv] || []).push(norm(e[0]).split(' ').length);
    });

    // 3) 단어
    u.words.forEach(([w, ko, pos]) => {
      const at2 = `${at} 단어 "${w}"`;
      if (!w || !ko || !POS[pos]) add('err', at2, '[영어, 뜻, 품사 n/v/a] 형식 아님');
      if (wordSeen[w]) add('warn', at2, `중복 (${wordSeen[w]})`); else wordSeen[w] = at;
      const c = lvOf(w, pos);
      (wordLvStat[lv] = wordLvStat[lv] || []).push(c);
      if (!c) add('info', at2, 'CEFR 목록에 없음 (합성어, 구문 등 → 직접 판단)');
      else if (c > spec.max) add('warn', at2, `너무 어려움: ${CEFR[c]} (레벨 목표 ${CEFR[spec.cefr]})`);
      else if (spec.cefr - c >= 2) add('info', at2, `쉬움: ${CEFR[c]} (레벨 목표 ${CEFR[spec.cefr]})`);
    });
  });
}

// 4) 레벨 테스트
T.words.forEach((band, b) => band && band.forEach(([w, ko, pos]) => {
  const c = lvOf(w, pos);
  if (c && Math.abs(c - b) >= 2) add('warn', `테스트 단어 ${b}단계 "${w}"`, `CEFR ${CEFR[c]} (단계 기준 ${CEFR[b]})`);
}));
T.sent.forEach(([b, en, ok, wrong], i) => {
  const opts = [ok, ...wrong], at = `테스트 문장 ${i + 1} "${en}"`;
  if (new Set(opts).size !== 4) add('err', at, '보기 중복');
  opts.forEach(o => { if (o.length > 17) add('warn', at, `보기 17자 초과 "${o}"`); });
});

// 출력
const avg = a => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1);
console.log('== 레벨별 지표 ==');
Object.keys(lenByLv).forEach(lv => {
  const ws = wordLvStat[lv].filter(Boolean);
  console.log(`L${lv} (목표 ${CEFR[LV[lv].cefr]}): 표현 평균 ${avg(lenByLv[lv])}단어, 단어 평균 CEFR ${avg(ws)} (A1=1 … C1=5), 목록 없음 ${wordLvStat[lv].length - ws.length}개`);
});
for (const k of ['err', 'warn', 'info']) {
  console.log(`\n== ${{ err: '오류', warn: '경고', info: '참고' }[k]} ${out[k].length}건 ==`);
  out[k].forEach(m => console.log('- ' + m));
}
process.exit(out.err.length ? 1 : 0);
