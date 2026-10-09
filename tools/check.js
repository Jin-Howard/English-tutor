// 교재 검사기: 저장소 맨 위에서 node tools/check.js  (오류 있으면 종료코드 1)
// 단어 등급: tools/cefr/ 의 CEFR-J 1.5 + Octanove C1/C2 1.0 (출처 tools/cefr/README.md), 보정은 tools/cefr-overrides.json
const fs = require('fs'), path = require('path');
const file = (...p) => path.join(__dirname, ...p);  // 어디서 실행해도 같은 파일을 찾음
const json = (...p) => JSON.parse(fs.readFileSync(file(...p), 'utf8'));
const C = json('..', 'data', 'course.json'), T = json('..', 'data', 'leveltest.json');

// ===== 규격 =====
// 앱 목표 범위 A1~B2: L1 A1, L2 A2, L3 B1, L4 B1+~B2, L5 B2 (상급은 C1 단어까지 허용)
const LV = { 1: { cefr: 1, max: 1, ex: 5, w: 6 }, 2: { cefr: 2, max: 2, ex: 6, w: 8 }, 3: { cefr: 3, max: 3, ex: 6, w: 8 }, 4: { cefr: 4, max: 4, ex: 6, w: 8 }, 5: { cefr: 4, max: 5, ex: 6, w: 8 } };
const BAND_MAX = [0, 1, 2, 3, 4, 5];  // 레벨 테스트 단계 → 허용 등급
const CEFR = ['', 'A1', 'A2', 'B1', 'B2', 'C1', 'C2'];
const GOALS = ['일상 대화', '여행', '직장', '시험 준비', '병원', '학교', '교회'];
const POS = { n: 1, v: 1, a: 1 };
const ROLE_MAX = 500, CANDO_MAX = 40;
const SENT_PLUS = 1;  // 문장 속 단어는 목표보다 한 단계 위까지 허용 (i+1: 조금 어려운 입력이 실력을 올림)  // 역할극 지시문은 매 대화마다 전송 → 토큰 상한

// 앱과 같은 정규화. index.html의 norm과 다르면 아래에서 경고
const NORM_SRC = `t => t.toLowerCase().replace(/[’‘]/g, "'").replace(/[^a-z0-9' ]+/g, ' ').replace(/\\s+/g, ' ').trim()`;
const norm = eval(NORM_SRC);

// ===== 단어 등급 사전 =====
const dict = {};
function loadCsv(f) {
  fs.readFileSync(file('cefr', f), 'utf8').split(/\r?\n/).slice(1).forEach(l => {
    const [h, , lv] = l.split(','), n = CEFR.indexOf(lv);
    if (!h || n < 1) return;
    h.split('/').forEach(w => { const k = w.trim().toLowerCase(); if (k) dict[k] = Math.min(dict[k] || 9, n); });  // 가장 쉬운 쓰임 기준
  });
}
loadCsv('cefrj-vocabulary-profile-1.5.csv'); loadCsv('octanove-vocabulary-profile-c1c2-1.0.csv');
const OV = json('cefr-overrides.json');
Object.entries(OV).forEach(([w, o]) => { if (o.level) dict[w] = CEFR.indexOf(o.level); });

// 원형 찾기: 규칙 변화 + 자주 쓰는 불규칙
const IRR = { went: 'go', gone: 'go', bought: 'buy', felt: 'feel', got: 'get', gotten: 'get', had: 'have', has: 'have', made: 'make', saw: 'see', seen: 'see',
  took: 'take', taken: 'take', told: 'tell', said: 'say', thought: 'think', came: 'come', left: 'leave', met: 'meet', was: 'be', were: 'be', is: 'be', are: 'be', am: 'be',
  been: 'be', did: 'do', does: 'do', done: 'do', ate: 'eat', eaten: 'eat', gave: 'give', given: 'give', knew: 'know', known: 'know', found: 'find', kept: 'keep',
  lost: 'lose', paid: 'pay', ran: 'run', sat: 'sit', slept: 'sleep', spent: 'spend', stood: 'stand', taught: 'teach', understood: 'understand', wore: 'wear',
  worn: 'wear', wrote: 'write', written: 'write', broke: 'break', broken: 'break', chose: 'choose', fell: 'fall', forgot: 'forget', heard: 'hear', meant: 'mean',
  better: 'good', best: 'good', worse: 'bad', worst: 'bad', children: 'child', people: 'person', men: 'man', women: 'woman', feet: 'foot', teeth: 'tooth' };
const CONTR = { "n't": '', "'m": '', "'re": '', "'s": '', "'ve": '', "'ll": '', "'d": '' };
function lemmas(t) {
  t = t.replace(/(n't|'m|'re|'s|'ve|'ll|'d)$/, x => CONTR[x]);
  const c = [t];
  if (IRR[t]) c.push(IRR[t]);
  const rules = [[/ies$/, 'y'], [/ied$/, 'y'], [/es$/, ''], [/s$/, ''], [/ed$/, ''], [/ed$/, 'e'], [/d$/, ''], [/ing$/, ''], [/ing$/, 'e'], [/er$/, ''], [/est$/, ''], [/ly$/, '']];
  rules.forEach(([re, s]) => { if (re.test(t)) { const b = t.replace(re, s); c.push(b); if (/(.)\1$/.test(b)) c.push(b.slice(0, -1)); } });
  return c;
}
const lvOf = w => Math.min(...lemmas(w.toLowerCase()).map(x => dict[x] || 9)) % 9;  // 원형 후보 중 가장 쉬운 등급, 없으면 0
// 문장 속 단어 중 허용 등급을 넘는 것 (고유명사, 숫자, 이미 가르치는 단어 제외)
function hardWords(sentence, max, allowed) {
  const out = [];
  sentence.replace(/[’‘]/g, "'").split(/[^A-Za-z']+/).forEach((raw, i) => {
    if (!raw || /^[A-Z]/.test(raw) && i > 0 && raw !== 'I') return;  // 문장 중간 대문자 = 고유명사
    const w = raw.toLowerCase().replace(/^'+|'+$/g, '');
    if (!w || lemmas(w).some(x => allowed.has(x))) return;
    const c = lvOf(w);
    if (c > max) out.push(`${w}(${CEFR[c]})`);
  });
  return out;
}

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

// ===== 0) 앱과 검사기의 정규화가 같은지 =====
const html = fs.readFileSync(file('..', 'index.html'), 'utf8');
const m = html.match(/const norm = (t => .*?);\n/);
if (!m) add('err', 'index.html', 'norm 함수를 못 찾음 (검사기 기준과 맞는지 확인 필요)');
else if (m[1] !== NORM_SRC) add('err', 'index.html', 'norm 함수가 검사기와 다름 → tools/check.js의 NORM_SRC도 같이 고칠 것');

// ===== 1) 커리큘럼 =====
const testWords = new Set(T.words.flat().filter(Boolean).map(w => w[0]));
const ids = new Set(), wordSeen = {}, lenByLv = {}, wordLvStat = {};
for (const [lv, us] of Object.entries(C)) {
  const spec = LV[lv];
  if (!spec) { add('err', `레벨 ${lv}`, '규격에 없는 레벨'); continue; }
  us.forEach(u => {
    const at = `L${lv} ${u.id}`;
    // 규격
    ['id', 'title', 'scene', 'cando', 'grammar', 'role'].forEach(k => { if (typeof u[k] !== 'string' || !u[k].trim()) add('err', at, `${k} 없음`); });
    if (ids.has(u.id)) add('err', at, 'id 중복'); ids.add(u.id);
    if (!Array.isArray(u.goals) || !u.goals.length) add('err', at, 'goals 없음');
    else u.goals.forEach(g => { if (!GOALS.includes(g)) add('err', at, `없는 목표 "${g}"`); });
    if (u.ex.length !== spec.ex) add('warn', at, `표현 ${u.ex.length}개 (규격 ${spec.ex})`);
    if (u.words.length !== spec.w) add('warn', at, `단어 ${u.words.length}개 (규격 ${spec.w})`);
    if ((u.role || '').length > ROLE_MAX) add('warn', at, `역할극 지시문 ${u.role.length}자 (상한 ${ROLE_MAX})`);
    if ((u.cando || '').length > CANDO_MAX) add('warn', at, `할 수 있어요 ${u.cando.length}자 (상한 ${CANDO_MAX})`);
    if (u.cando && !/수 있어요$/.test(u.cando)) add('warn', at, 'cando는 "~할 수 있어요"로 끝내기');
    const situ = new Set(u.situational || []);
    (u.situational || []).forEach(w => { if (!u.words.some(x => x[0] === w)) add('err', at, `situational "${w}"가 단어 목록에 없음`); });
    const taught = new Set([...u.words.flatMap(w => lemmas(w[0].toLowerCase())), ...situ]);

    // 표현과 채점 기준
    u.ex.forEach((e, i) => {
      const w = `${at} 표현${i + 1} "${e[0]}"`;
      if (e.length !== 3 || e.some(x => typeof x !== 'string' || !x.trim())) return add('err', w, '[영어, 뜻, 정규식] 형식 아님');
      let re; try { re = new RegExp(e[2], 'i'); } catch (x) { return add('err', w, `정규식 오류 ${x.message}`); }
      if (!re.test(norm(e[0]))) add('err', w, '교재 문장이 자기 채점 기준을 통과 못 함');
      variants(e[0]).forEach(v => { if (!re.test(v)) add('warn', w, `빡빡함: "${v}" 오답 처리`); });
      const junk = JUNK.filter(j => re.test(norm(j)));
      if (junk.length) add('info', w, `넓게 인정: "${junk.join('", "')}"도 통과`);
      u.ex.forEach((o, j) => { if (j !== i && re.test(norm(o[0]))) add('info', w, `겹침: 표현${j + 1} "${o[0]}"도 이 표현으로 인정`); });
      const hard = hardWords(e[0], spec.max + SENT_PLUS, taught);
      if (hard.length) add('warn', w, `문장 속 어려운 단어 ${hard.join(', ')} → 쉬운 말로 바꾸거나 단어 목록에 넣기`);
      (lenByLv[lv] = lenByLv[lv] || []).push(norm(e[0]).split(' ').length);
    });

    // 단어
    u.words.forEach(([w, ko, pos]) => {
      const at2 = `${at} 단어 "${w}"`;
      if (!w || !ko || !POS[pos]) add('err', at2, '[영어, 뜻, 품사 n/v/a] 형식 아님');
      if (wordSeen[w]) add('warn', at2, `중복 (${wordSeen[w]})`); else wordSeen[w] = at;
      if (testWords.has(w)) add('info', at2, '레벨 테스트 단어와 겹침 (재시험 때 점수가 부풀 수 있음)');
      const c = w.includes(' ') ? 0 : lvOf(w);
      (wordLvStat[lv] = wordLvStat[lv] || []).push(c);
      if (!c) add('info', at2, 'CEFR 목록에 없음 → 직접 판단');
      else if (c > spec.max && !situ.has(w)) add('warn', at2, `어려움: ${CEFR[c]} (레벨 목표 ${CEFR[spec.cefr]}) → 상황 필수면 situational에 추가`);
      else if (spec.cefr - c >= 2) add('info', at2, `쉬움: ${CEFR[c]} (레벨 목표 ${CEFR[spec.cefr]})`);
    });
  });
}

// ===== 2) 레벨 테스트 =====
T.words.forEach((band, b) => band && band.forEach(([w, ko, pos]) => {
  const c = lvOf(w);
  if (c && Math.abs(c - b) >= 2) add('warn', `테스트 단어 ${b}단계 "${w}"`, `CEFR ${CEFR[c]} (단계 기준 ${CEFR[b]})`);
}));
T.sent.forEach(([b, en, ok, wrong], i) => {
  const opts = [ok, ...wrong], at = `테스트 문장 ${i + 1} "${en}"`;
  if (new Set(opts).size !== 4) add('err', at, '보기 중복');
  opts.forEach(o => { if (o.length > 17) add('warn', at, `보기 17자 초과 "${o}"`); });
  const hard = hardWords(en, BAND_MAX[b] + SENT_PLUS, new Set());
  if (hard.length) add('warn', at, `${b}단계 문장에 어려운 단어 ${hard.join(', ')}`);
});
T.speak.forEach((qs, b) => qs && qs.forEach(([ko, en]) => {
  const hard = hardWords(en, BAND_MAX[b] + SENT_PLUS, new Set());
  if (hard.length) add('warn', `테스트 말하기 ${b}단계 "${en}"`, `모범 답에 어려운 단어 ${hard.join(', ')}`);
}));

// ===== 출력 =====
const avg = a => (a.reduce((x, y) => x + y, 0) / a.length).toFixed(1);
console.log('== 레벨별 지표 ==');
Object.keys(lenByLv).forEach(lv => {
  const ws = wordLvStat[lv].filter(Boolean);
  console.log(`L${lv} (목표 ${CEFR[LV[lv].cefr]}): 표현 평균 ${avg(lenByLv[lv])}단어, 단어 평균 CEFR ${avg(ws)} (A1=1 … C1=5), 목록 없음 ${wordLvStat[lv].length - ws.length}개`);
});
for (const k of ['err', 'warn', 'info']) {
  console.log(`\n== ${{ err: '오류', warn: '경고', info: '참고' }[k]} ${out[k].length}건 ==`);
  out[k].forEach(x => console.log('- ' + x));
}
process.exit(out.err.length ? 1 : 0);
