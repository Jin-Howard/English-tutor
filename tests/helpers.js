// 테스트 공통 도구: 저장 데이터 심기, 가짜 AI 응답, 가짜 통화 서버, 오류 감시
const { test: base, expect } = require('@playwright/test');

// 레벨 2, 병원, 키 저장된 사용자 (처음 안내는 이미 봄)
const USER = { profile: { age: '30', gender: '', field: '병원' }, gkey: 'TESTKEY', ob: { lvl: 2, goals: ['병원'], mins: 10, days: 5 } };

function seed(page, { user = USER, extra = {} } = {}) {
  return page.addInitScript(([u, x]) => {
    if (localStorage.getItem('__seeded')) return;  // 새로고침해도 처음 값으로 덮지 않음
    localStorage.setItem('__seeded', '1');
    localStorage.setItem('pass', 'x');
    localStorage.setItem('permsdone', '1');
    localStorage.setItem('coachseen', '9');
    localStorage.setItem('livenote', '1');
    if (u) {
      localStorage.setItem('profile', JSON.stringify(u.profile));
      localStorage.setItem('gkey', u.gkey);
      localStorage.setItem('ob', JSON.stringify(u.ob));
    }
    Object.entries(x).forEach(([k, v]) => localStorage.setItem(k, typeof v === 'string' ? v : JSON.stringify(v)));
  }, [user, extra]);
}

// 제미나이 REST 응답 흉내 (스트리밍과 일반 둘 다)
function mockAI(page, reply) {
  return page.route('**/generativelanguage.googleapis.com/v1beta/models/**', async route => {
    const body = route.request().postData() || '';
    const text = typeof reply === 'function' ? reply(body) : reply;
    if (text === null) return route.fulfill({ status: 500, contentType: 'application/json', body: '{"error":{"code":500,"message":"test"}}' });
    const json = JSON.stringify({ candidates: [{ content: { parts: [{ text }] }, finishReason: 'STOP' }] });
    if (route.request().url().includes('alt=sse')) return route.fulfill({ status: 200, contentType: 'text/event-stream', body: `data: ${json}\n\n` });
    return route.fulfill({ status: 200, contentType: 'application/json', body: json });
  });
}

// Live API 웹소켓 흉내: 연결, 인사(홀수 바이트로 쪼갠 2초 음성 + 자막), 보낸 조각 기록
function fakeLive(page, { reject1007 = false } = {}) {
  return page.addInitScript(rej => {
    window.__ws = [];
    window.__cc = [];
    class FakeWS {
      constructor(url) { this.url = url; this.readyState = 0; this.sent = []; this.chunks = 0; this.bytes = []; window.__ws.push(this); setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 20); }
      reply(o, bin) { const t = JSON.stringify(o); this.onmessage && this.onmessage({ data: bin ? new Blob([t]) : t }); }
      send(d) {
        const m = JSON.parse(d);
        this.sent.push(Object.keys(m)[0]);
        if (m.setup) {
          this.setup = m.setup;
          if (rej && m.setup.contextWindowCompression) { setTimeout(() => { this.readyState = 3; this.onclose && this.onclose({ code: 1007, reason: 'Invalid argument' }); }, 10); return; }
          setTimeout(() => this.reply({ setupComplete: {} }, true), 10);
        }
        if (m.clientContent) {
          window.__cc.push(m.clientContent);
          if (m.clientContent.turnComplete === false) return;
          const n = 48000, b = new Uint8Array(n * 2);
          for (let i = 0; i < n; i++) { const v = Math.round(Math.sin(i / 10) * 8000) & 0xffff; b[2 * i] = v & 255; b[2 * i + 1] = v >> 8; }
          let s = ''; for (const x of b) s += String.fromCharCode(x);
          const cut = [0, 33331, 66667, s.length];  // 홀수 자리에서 자름
          setTimeout(() => {
            this.reply({ serverContent: { outputTranscription: { text: 'Hi! How are you today?' } } });
            for (let k = 0; k < 3; k++) this.reply({ serverContent: { modelTurn: { parts: [{ inlineData: { mimeType: 'audio/pcm;rate=24000', data: btoa(s.slice(cut[k], cut[k + 1])) } }] } } }, true);
            this.reply({ serverContent: { turnComplete: true }, usageMetadata: { totalTokenCount: 321 } });
          }, 20);
        }
        if (m.realtimeInput) { this.chunks++; this.bytes.push(atob(m.realtimeInput.audio.data).length); this.mime = m.realtimeInput.audio.mimeType; }
      }
      close() { this.readyState = 3; }
    }
    window.WebSocket = FakeWS;
  }, reject1007);
}

// 앱 열기: 시작 완료까지 기다리고, 혹시 뜬 코치마크는 닫음
async function open(page, path = '/?nosplash') {
  await page.goto(path);
  await page.waitForFunction(() => window.__ready === true);
  await page.evaluate(() => { const c = document.getElementById('coach'); if (c) c.classList.remove('open'); });
}

// 모든 테스트: 페이지 오류가 하나라도 나면 실패
const test = base.extend({
  page: async ({ page }, use) => {
    const errors = [];
    page.on('pageerror', e => errors.push(String(e)));
    await use(page);
    expect(errors, '페이지 오류').toEqual([]);
  },
});

module.exports = { test, expect, seed, mockAI, fakeLive, open, USER };
