// 통화: 연결 설정, 자막, 소리 복원, 음소거, 울림 차단, 천천히, 침묵 안부, 재연결, 오류 안내
const { test, expect, seed, fakeLive, open } = require('./helpers');

async function startCall(page, opts) {
  await seed(page);
  await fakeLive(page, opts);
  await page.addInitScript(() => {  // 재생 버퍼 기록 (소리 복원 검사용)
    const cb = BaseAudioContext.prototype.createBuffer;
    window.__bufs = [];
    BaseAudioContext.prototype.createBuffer = function (c, n, r) { const b = cb.call(this, c, n, r); if (r === 24000) window.__bufs.push(b); return b; };
  });
  await open(page);
  await page.click('#m-call');
  await expect(page.locator('#call')).toHaveClass(/\bon\b/);
}

test('연결 설정과 인사, 자막', async ({ page }) => {
  await startCall(page);
  const setup = await page.waitForFunction(() => window.__ws[0] && window.__ws[0].setup).then(() => page.evaluate(() => window.__ws[0].setup));
  expect(setup.model).toBe('models/gemini-3.8-live');
  expect(setup.generationConfig.responseModalities).toEqual(['AUDIO']);
  expect(setup.inputAudioTranscription).toBeTruthy();
  expect(setup.outputAudioTranscription).toBeTruthy();
  expect(setup.realtimeInputConfig).toBeUndefined();  // 반응 속도는 서버 기본값
  expect(await page.evaluate(() => window.__ws[0].url.endsWith('TESTKEY'))).toBe(true);
  await expect(page.locator('#cl-cap')).toContainText('How are you today?');
});

test('쪼개져 온 소리를 오차 없이 이어 붙임', async ({ page }) => {
  await startCall(page);
  await expect.poll(() => page.evaluate(() => window.__bufs.length)).toBe(3);
  const bad = await page.evaluate(() => {
    const all = []; window.__bufs.forEach(b => all.push(...b.getChannelData(0)));
    let n = 0;
    for (let i = 200; i < all.length; i++) { const v = Math.round(Math.sin(i / 10) * 8000) & 0xffff; if (Math.abs(all[i] - (v >= 0x8000 ? v - 0x10000 : v) / 32768) > 1e-4) n++; }
    return [all.length, n];
  });
  expect(bad).toEqual([48000, 0]);
});

test('마이크는 16kHz로 보내고, 음소거하면 멈춤', async ({ page }) => {
  await startCall(page);
  await page.waitForFunction(() => window.__ws[0] && window.__ws[0].chunks > 5);
  expect(await page.evaluate(() => window.__ws[0].mime)).toBe('audio/pcm;rate=16000');
  await page.click('#cl-mute');
  const a = await page.evaluate(() => window.__ws[0].chunks);
  await page.waitForTimeout(700);
  expect(await page.evaluate(() => window.__ws[0].chunks)).toBe(a);
});

test('튜터가 말하는 중엔 울림을 보내지 않고 내 목소리만 보냄', async ({ page }) => {
  await startCall(page);
  await page.click('#cl-mute'); await page.click('#cl-mute');  // 상태 초기화
  const r = await page.evaluate(() => {
    const T = LiveCall._test, w = window.__ws[0], A = 'AAAA', out = {};
    // 실제 마이크 조각이 섞이지 않게 동기 실행
    T.fake(true); let n = w.chunks;
    for (let i = 0; i < 30; i++) T.sendPcm(A, 0.05); out.echo = w.chunks - n;
    n = w.chunks; T.sendPcm(A, 0.3); for (let i = 0; i < 5; i++) T.sendPcm(A, 0.05); out.spike = w.chunks - n;
    n = w.chunks; for (let i = 0; i < 3; i++) T.sendPcm(A, 0.35); out.voice = w.chunks - n;
    T.fake(false); n = w.chunks; T.sendPcm(A, 0); out.idle = w.chunks - n;
    return out;
  });
  expect(r.echo).toBe(0);
  expect(r.spike).toBe(0);
  expect(r.voice).toBeGreaterThanOrEqual(3);  // 앞부분까지 같이
  expect(r.idle).toBe(1);
});

test('천천히: 지금 말을 끊지 않고 다음 대답부터', async ({ page }) => {
  await startCall(page);
  await page.click('#cl-slow');
  const last = await page.evaluate(() => window.__cc[window.__cc.length - 1]);
  expect(last.turnComplete).toBe(false);
  await expect(page.locator('#cl-note')).toContainText('다음 대답부터');
});

test('침묵 안부: 15초 조용하면 최대 2번', async ({ page }) => {
  await startCall(page);
  await page.waitForFunction(() => LiveCall._test.ready());
  const sent = await page.evaluate(() => {
    const T = LiveCall._test, n0 = window.__cc.length, out = [];
    T.fake(false);
    T.setAct(performance.now() - 16000); T.idleCheck(); out.push(window.__cc.length - n0);
    T.idleCheck(); out.push(window.__cc.length - n0);
    T.setAct(performance.now() - 16000); T.idleCheck(); out.push(window.__cc.length - n0);
    T.setAct(performance.now() - 16000); T.idleCheck(); out.push(window.__cc.length - n0);
    return out;
  });
  expect(sent).toEqual([1, 1, 2, 2]);
});

test('설정을 거부하면 선택 옵션 빼고 다시 연결', async ({ page }) => {
  await startCall(page, { reject1007: true });
  await expect.poll(() => page.evaluate(() => window.__ws.length)).toBe(2);
  expect(await page.evaluate(() => [!!window.__ws[0].setup.contextWindowCompression, !!window.__ws[1].setup.contextWindowCompression])).toEqual([true, false]);
});

test('키 오류면 알아듣기 쉬운 안내', async ({ page }) => {
  await startCall(page);
  await page.waitForFunction(() => LiveCall._test.ready());  // 연결 끝난 뒤
  await page.evaluate(() => { const w = window.__ws[window.__ws.length - 1]; w.readyState = 3; w.onclose({ code: 1008, reason: 'API key not valid' }); });
  await expect(page.locator('#cl-state')).toHaveText('통화가 끊겼어요');
  await expect(page.locator('#cl-note')).toContainText('API 키를 확인해 주세요');
});

test('채팅 화면에서 통화를 열어도 받아쓰기 녹음은 꺼짐', async ({ page }) => {
  await seed(page);
  await fakeLive(page);
  await open(page);
  await page.click('#m-chat');
  await page.click('#act');
  await expect(page.locator('#bar')).toHaveClass(/listening/);
  await page.evaluate(() => document.getElementById('barcall').click());  // 녹음 중엔 버튼이 숨지만, 어느 경로로 통화가 열려도 녹음은 꺼져야 함
  await expect(page.locator('#call')).toHaveClass(/\bon\b/);
  expect(await page.evaluate(() => [listening, !!recCtx])).toEqual([false, false]);
});

test('소리 채널: 평소 미디어, 통화와 받아쓰기 중엔 녹음용', async ({ page }) => {
  await page.addInitScript(() => { window.__as = []; Object.defineProperty(navigator, 'audioSession', { value: { set type(t) { window.__as.push(t); this._t = t; }, get type() { return this._t; } } }); });
  await seed(page);
  await fakeLive(page);
  await open(page);
  expect(await page.evaluate(() => navigator.audioSession.type)).toBe('playback');
  await page.click('#m-call');
  await expect.poll(() => page.evaluate(() => navigator.audioSession.type)).toBe('play-and-record');
  await page.click('#cl-end');
  await expect.poll(() => page.evaluate(() => navigator.audioSession.type)).toBe('playback');
  await page.click('#m-chat');
  await page.click('#act');
  await expect.poll(() => page.evaluate(() => navigator.audioSession.type)).toBe('play-and-record');
  await page.click('#act');
  await expect.poll(() => page.evaluate(() => navigator.audioSession.type)).toBe('playback');
});

test('잡음 차단: 고립된 짧은 잡음은 지우고 말소리는 남김', async ({ page }) => {
  await startCall(page);
  const r = await page.evaluate(() => {
    const R = 24000, gate = LiveCall._test.gate;
    const mk = parts => { const o = []; for (const [t, ms, amp, f] of parts) { const n = Math.round(ms * R / 1000); for (let i = 0; i < n; i++) o.push(t === 'noise' ? amp * (Math.sin(i * 12.9898) * 43758.5453 % 1) : t === 'vowel' ? amp * Math.sin(2 * Math.PI * f * i / R) * Math.sin(Math.PI * i / n) : t === 'tone' ? amp * Math.sin(2 * Math.PI * f * i / R) : 0); } return Float32Array.from(o); };
    const kept = (parts, fresh) => { const ch = mk(parts), e0 = ch.reduce((s, v) => s + v * v, 0); gate(ch, true, fresh); return Math.round(ch.reduce((s, v) => s + v * v, 0) / e0 * 100); };
    return {
      noiseAfterSpeech: kept([['vowel', 400, 0.3, 180], ['q', 120], ['noise', 80, 0.4], ['q', 100]]),
      beepAfterSpeech: kept([['vowel', 400, 0.3, 180], ['q', 100], ['tone', 100, 0.3, 3000], ['q', 100]]),
      shortWord: kept([['q', 100], ['vowel', 120, 0.2, 200], ['q', 100], ['vowel', 300, 0.3, 180]]),
      longSpeech: kept([['vowel', 800, 0.3, 150]]),
    };
  });
  expect(r.noiseAfterSpeech).toBeLessThan(80);
  expect(r.beepAfterSpeech).toBeLessThan(80);
  expect(r.shortWord).toBe(100);
  expect(r.longSpeech).toBe(100);
});

test('튜터 지시문: 막힐 때 "이 말 하고 싶었어?", 물어보면 "한번 해 볼래?"', async ({ page }) => {
  await startCall(page);
  const sys = await page.waitForFunction(() => window.__ws[0] && window.__ws[0].setup).then(() => page.evaluate(() => window.__ws[0].setup.systemInstruction.parts[0].text));
  expect(sys).toContain('Did you mean');
  expect(sys).toContain('Want to try saying it?');
  expect(sys).toContain('ask nothing else');
});

test('90초 동안 말이 없으면 통화 자동 종료', async ({ page }) => {
  await startCall(page);
  await page.waitForFunction(() => LiveCall._test.ready());
  await page.evaluate(() => { LiveCall._test.fake(false); LiveCall._test.setAct(performance.now() - LiveCall._test.idleEnd() * 1000 - 1000); LiveCall._test.idleCheck(); });
  await expect(page.locator('#call')).not.toHaveClass(/\bon\b/);  // 짧은 통화라 리포트 없이 닫힘
  await expect(page.locator('#toast, .toast').first()).toContainText('대화가 없어서');
});

test('음소거로 오래 두면 통화 자동 종료', async ({ page }) => {
  await startCall(page);
  await page.waitForFunction(() => LiveCall._test.ready());
  await page.evaluate(() => LiveCall._test.setMuted(true, LiveCall._test.idleEnd() * 1000 + 1000));
  await expect(page.locator('#call')).not.toHaveClass(/\bon\b/, { timeout: 3000 });
});
