// 실시간 통화: Gemini Live API (gemini-3.8-live) 웹소켓 직접 연결. 통화 버튼을 누를 때만 불러옴
// 소리: 마이크 16kHz PCM16 보냄, 답 24kHz PCM16 받음. 자막은 서버 받아쓰기 사용
window.LiveCall = (() => {
  const MODEL = 'models/gemini-3.8-live';
  const URL_WS = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=';
  const IDLE_SEC = 15, IDLE_MAX = 2, IDLE_END = 90;  // 침묵 안부: 몇 초 뒤, 연속 몇 번까지 / 이만큼 말이 없으면 통화 자동 종료 (비용 절약)
  const IN_RATE = 16000, OUT_RATE = 24000, LONG_SEC = 15 * 60;  // 음성 세션은 약 15분이 한계라 그 전에 안내
  const JITTER = 0.15, REBUF = 0.15;  // 말 시작 때 / 조각이 늦게 왔을 때 모아 두는 시간 (인터넷이 출렁여도 말이 뚝뚝 끊기지 않게)
  const FADE = 0.03;     // 끊을 때 소리를 줄이는 시간 (뚝 소리 방지)
  // 튜터가 말하는 동안 스피커 소리가 마이크로 다시 들어가면, 서버가 내가 말한 줄 알고 튜터 말을 끊음.
  // 그래서 튜터가 말하는 중엔 '울림 크기'를 계속 재고, 그보다 확실히 큰 소리가 잠깐 이어질 때만 내 말로 보고 보냄
  const GATE_MIN = 0.06, GATE_X = 3, SUSTAIN = 3, HOLD = 700, PRE = 6;  // 최소 크기, 울림의 몇 배, 연속 조각 수(40ms씩), 유지 ms, 앞부분 보존 조각 수
  // 마이크 처리기: 오디오 전용 스레드에서 16kHz로 줄이고 40ms씩 묶어 보냄
  const WORKLET = `class Cap extends AudioWorkletProcessor {
    constructor() { super(); this.r = sampleRate / ${IN_RATE}; this.acc = 0; this.sum = 0; this.n = 0; this.e = 0; this.m = 0; this.out = new Int16Array(640); this.k = 0; }
    process(inp) {
      const x = inp[0] && inp[0][0];
      if (!x) return true;
      for (let i = 0; i < x.length; i++) {
        const v = x[i]; this.sum += v; this.n++; this.e += v * v; this.m++;
        if (++this.acc >= this.r) {
          this.acc -= this.r;
          const a = Math.max(-1, Math.min(1, this.sum / this.n)); this.sum = 0; this.n = 0;
          this.out[this.k++] = a < 0 ? a * 32768 : a * 32767;
          if (this.k === this.out.length) {
            this.port.postMessage({ pcm: this.out.buffer, lv: Math.sqrt(this.e / this.m) }, [this.out.buffer]);
            this.out = new Int16Array(640); this.k = 0; this.e = 0; this.m = 0;
          }
        }
      }
      return true;
    }
  }
  registerProcessor('cap', Cap);`;
  const LIVE_RULE = ['',
    'Level 1: speak slowly in very short sentences (max 6 words) with basic words. Ask yes/no or either/or questions. If the learner is stuck, give one short sentence to repeat.',
    'Level 2: short everyday sentences (max 10 words). If the learner is stuck, offer a model sentence.',
    'Level 3: natural everyday English at a relaxed pace.',
    'Level 4: natural speed; common idioms are fine.',
    'Level 5: native speed with idioms and nuance; do not simplify.'];

  let spoke = 0, ws, ctx, stream, src, node, sink, out, ana, raf, timer, wake = null, attempt = 0, rest = null, lastChunk = null, gated = 0, lastAct = 0, nudges = 0, gateT = 0, echo = 0, loud = 0, pre = [], under = 0, cuts = 0, meT = 0, wantLat = false, lat = [];
  let ready = false, ended = true, muted = false, t0 = 0, playAt = 0, playing = [], lines = [], tokens = 0;
  const $c = id => document.getElementById(id);
  const DEBUG = /[?&]debug/.test(location.search);  // 주소 끝에 ?debug 를 붙이면 통화 진단 숫자 표시

  // ===== 화면 =====
  const CSS = `
  #call { position: fixed; inset: 0; z-index: 900; display: none; flex-direction: column; align-items: center; box-sizing: border-box;
          padding: calc(env(safe-area-inset-top, 0px) + 18px) 20px calc(env(safe-area-inset-bottom, 0px) + 24px); background: var(--bg); color: var(--text); }
  #call.on { display: flex; }
  #call .cl-top { display: flex; flex-direction: column; align-items: center; gap: 4px; margin-top: 12px; }
  #call .cl-top b { font-size: 19px; font-weight: 800; }
  #call .cl-top span { font-size: 14px; color: var(--sub); font-variant-numeric: tabular-nums; }
  #call .cl-orb { cursor: pointer; position: relative; width: 156px; height: 156px; margin: 44px 0 38px; }
  #call .cl-orb::before { content: ''; position: absolute; inset: -14px; border-radius: 50%; background: var(--accent);
                          opacity: calc(.18 + var(--lv, 0) * .5); transform: scale(calc(1 + var(--lv, 0) * .1)); transition: transform .08s, opacity .08s; }  /* 목소리에 반응하는 테두리 */
  #call .cl-orb .face { position: absolute; inset: 0; border-radius: 50%; overflow: hidden; background: var(--today-bg, var(--accent-soft)); }
  #call .cl-orb img { position: absolute; left: 50%; bottom: -10px; width: 112px; transform: translateX(-50%); }
  #call.speak .cl-orb img { animation: clbob .5s ease-in-out infinite alternate; }  /* 말할 때 살짝 들썩 */
  #call.wait .cl-orb::before { animation: clpulse 1.4s ease-in-out infinite; }
  @keyframes clbob { to { transform: translateX(-50%) translateY(-4px); } }
  @keyframes clpulse { 50% { transform: scale(.92); opacity: .08; } }
  #call .cl-top small { font-size: 12px; color: var(--sub); }
  #call .cl-state { margin: 0 0 18px; font-size: 15px; font-weight: 700; color: var(--sub); }
  #call .cl-cap { flex: 1; width: 100%; max-width: 520px; overflow-y: auto; display: flex; flex-direction: column; justify-content: flex-end; gap: 10px; }
  #call .cl-cap p { margin: 0; font-size: 16px; line-height: 1.5; text-wrap: pretty; }
  #call .cl-cap p.me { align-self: flex-end; max-width: 85%; padding: 8px 12px; border-radius: 16px 16px 4px 16px; background: var(--surface2); }
  #call .cl-cap p.ai { color: var(--text); }
  #call .cl-cap p.old { opacity: .45; }
  #call .cl-note { min-height: 20px; margin: 10px 0; font-size: 13px; line-height: 1.5; color: var(--sub); text-align: center; text-wrap: pretty; }
  #call .cl-btns { display: flex; gap: 22px; }
  #call .cl-btns button { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 0; border: 0; background: none; color: var(--sub); font-size: 13px; font-weight: 600; }
  #call .cl-btns span { display: flex; align-items: center; justify-content: center; width: 64px; height: 64px; border-radius: 50%; background: var(--surface2); color: var(--text); }
  #call #cl-end span { background: var(--danger); color: #fff; }
  #call #cl-mute.on span, #call #cl-slow.on span { background: var(--text); color: var(--bg); }
  #call.fail #cl-mute, #call.wait #cl-mute, #call.fail #cl-slow, #call.wait #cl-slow { visibility: hidden; }  /* 연결 전, 끊긴 뒤엔 음소거 의미 없음 */
  #call .cl-first { display: none; width: 100%; max-width: 420px; margin-top: 24px; text-align: center; }
  #call.first .cl-first { display: block; }
  #call.first .cl-orb, #call.first .cl-state, #call.first .cl-cap, #call.first .cl-btns { display: none; }
  #call .cl-first p { margin: 0 0 14px; font-size: 15px; line-height: 1.6; color: var(--sub); text-wrap: pretty; }
  #call .cl-first button { width: 100%; height: 52px; margin-top: 8px; border: 0; border-radius: 16px; background: var(--accent); color: var(--on-accent); font-size: 16px; font-weight: 800; }
  #call .cl-first button.ghost { background: var(--surface2); color: var(--text); }
  #call .cl-fail { display: none; gap: 10px; width: 100%; max-width: 420px; margin-bottom: 14px; }
  #call.fail .cl-fail { display: flex; }
  #call .cl-fail button { flex: 1; height: 48px; border: 0; border-radius: 14px; background: var(--surface2); color: var(--text); font-size: 15px; font-weight: 700; }
  /* 통화 후 교정 리포트 */
  #call .cl-rep { display: none; width: 100%; max-width: 520px; flex: 1; min-height: 0; flex-direction: column; margin-top: 18px; }
  #call.report .cl-rep { display: flex; }
  #call.report .cl-orb, #call.report .cl-state, #call.report .cl-cap, #call.report .cl-btns, #call.report .cl-note, #call.report .cl-fail { display: none; }
  #call .rp-scroll { flex: 1; min-height: 0; overflow-y: auto; padding-bottom: 8px; }
  #call .rp-sum { margin: 0 0 18px; font-size: 15px; line-height: 1.55; color: var(--sub); text-wrap: pretty; }
  #call .rp-stats { display: flex; gap: 8px; margin: 0 0 18px; }
  #call .rp-stats div { flex: 1; padding: 12px 8px; border-radius: 16px; background: var(--surface2); text-align: center; }
  #call .rp-stats b { display: block; font-size: 20px; font-weight: 800; }
  #call .rp-stats small { font-size: 12px; color: var(--sub); }
  #call .rp-h { margin: 18px 0 8px; font-size: 13px; font-weight: 700; color: var(--sub); }
  #call .rp-fix { margin: 0 0 10px; padding: 14px 16px; border-radius: 18px; background: var(--surface); box-shadow: var(--shadow); }
  #call .rp-fix s { display: block; margin-bottom: 6px; font-size: 14px; color: var(--sub); }
  #call .rp-fix .bt { display: flex; align-items: flex-start; justify-content: space-between; gap: 8px; font-size: 16px; font-weight: 700; line-height: 1.4; }
  #call .rp-fix small { display: block; margin-top: 6px; font-size: 13px; color: var(--sub); line-height: 1.5; }
  #call .rp-good { display: flex; flex-wrap: wrap; gap: 6px; }
  #call .rp-good span { padding: 6px 12px; border-radius: 999px; background: var(--accent-soft); font-size: 14px; font-weight: 600; }
  #call .rp-ph { display: flex; align-items: center; gap: 10px; padding: 12px 0; border-bottom: 1px solid var(--line); }
  #call .rp-ph div { flex: 1; }
  #call .rp-ph b { display: block; font-size: 15px; }
  #call .rp-ph small { font-size: 13px; color: var(--sub); }
  #call .rp-ph button { flex: none; height: 34px; padding: 0 14px; border: 0; border-radius: 999px; background: var(--surface2); color: var(--text); font-size: 13px; font-weight: 700; }
  #call .rp-ph button.done { background: var(--accent-soft); color: var(--accent-text); }
  #call .rp-wait { margin: 40px 0; font-size: 15px; color: var(--sub); text-align: center; }
  #call .rp-btns { display: flex; gap: 8px; padding-top: 12px; }
  #call .rp-btns button { flex: 1; height: 50px; border: 0; border-radius: 16px; background: var(--surface2); color: var(--text); font-size: 15px; font-weight: 800; }
  #call .rp-btns button.go { background: var(--accent); color: #111111; }
  #call .cl-fail button.go { background: var(--accent); color: var(--on-accent); }`;
  const I_MIC = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/></svg>';
  const I_MUTE = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18M9 9v2a3 3 0 0 0 5 2.2M15 9.3V5a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 11.5 5.3M19 11a7 7 0 0 1-.6 2.8M12 18v4"/></svg>';
  const I_SLOW = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="13" r="8"/><path d="M12 9v4l2.5 2.5M9 2h6"/></svg>';  // 시계
  const I_END = '<svg viewBox="0 0 24 24" width="28" height="28" fill="currentColor"><path d="M12 9c-3.3 0-6.3.9-8.7 2.4-.6.4-.9 1.1-.7 1.8l.6 2c.2.7 1 1.1 1.7.9l2.9-.9c.6-.2 1-.8.9-1.4l-.2-1.6c1.1-.4 2.3-.6 3.5-.6s2.4.2 3.5.6l-.2 1.6c-.1.6.3 1.2.9 1.4l2.9.9c.7.2 1.5-.2 1.7-.9l.6-2c.2-.7-.1-1.4-.7-1.8C18.3 9.9 15.3 9 12 9z"/></svg>';

  function mount() {
    if ($c('call')) return;
    const st = document.createElement('style');
    st.textContent = CSS;
    document.head.appendChild(st);
    const d = document.createElement('div');
    d.id = 'call';
    d.setAttribute('role', 'dialog');
    d.setAttribute('aria-label', 'AI 튜터와 통화');
    d.innerHTML = `<div class="cl-top"><b>AI 튜터</b><span id="cl-time">통화 준비</span><small id="cl-lat"></small></div>
      <div class="cl-first">
        <p>AI 튜터와 전화하듯 영어로 대화해요.<br>틀려도 괜찮아요. 교정은 통화가 끝난 뒤에 따로 해 드려요.</p>
        <p>이어폰을 쓰면 더 잘 들리고 울림도 줄어요. 무료 API 키로 통화하면 음성이 구글 모델 개선에 쓰일 수 있어요.</p>
        <button type="button" id="cl-go">통화 시작</button><button type="button" id="cl-back" class="ghost">닫기</button>
      </div>
      <div class="cl-orb"><div class="face"><img src="img/art.webp" alt=""></div></div>
      <p class="cl-state" id="cl-state"></p>
      <div class="cl-cap" id="cl-cap" aria-live="polite"></div>
      <p class="cl-note" id="cl-note"></p>
      <div class="cl-rep">
        <div class="rp-scroll" id="rp-body"></div>
        <div class="rp-btns"><button type="button" id="rp-close">닫기</button><button type="button" id="rp-review" class="go">틀린 문장 복습하기</button></div>
      </div>
      <div class="cl-fail"><button type="button" id="cl-text">글로 대화하기</button><button type="button" id="cl-again" class="go">다시 걸기</button></div>
      <div class="cl-btns">
        <button type="button" id="cl-slow"><span>${I_SLOW}</span>천천히</button>
        <button type="button" id="cl-mute"><span>${I_MIC}</span>음소거</button>
        <button type="button" id="cl-end"><span>${I_END}</span>끊기</button>
      </div>`;
    document.body.appendChild(d);
    $c('cl-go').onclick = () => { localStorage.setItem('livenote', '1'); $c('call').classList.remove('first'); begin(); };
    $c('cl-back').onclick = close;
    $c('cl-end').onclick = endCall;
    $c('rp-close').onclick = close;
    $c('rp-review').onclick = () => { close(); if (typeof startReview === 'function') startReview(); };
    $c('cl-again').onclick = () => { logTime(); stop(); begin(); };
    $c('cl-text').onclick = () => { close(); if (typeof navTo === 'function') navTo('main'); };
    $c('cl-mute').onclick = () => setMute(!muted);
    $c('cl-slow').onclick = () => setSlow(!slow);
    d.querySelector('.cl-orb').onclick = () => {  // 튜터가 말할 때 누르면 바로 멈추고 내 말을 들음 (시끄러운 곳에서 끼어들기)
      if (!playing.length) return;
      flush();
      gateT = performance.now() + 4000;
      setState('listen');
    };
  }
  let mutedAt = 0;
  function setMute(on) {
    muted = on;
    mutedAt = performance.now();
    $c('cl-mute').classList.toggle('on', on);
    $c('cl-mute').innerHTML = `<span>${on ? I_MUTE : I_MIC}</span>${on ? '음소거 중' : '음소거'}`;
  }
  const setState = s => {
    const box = $c('call');
    ['wait', 'listen', 'speak', 'fail'].forEach(k => box.classList.toggle(k, k === s));
    $c('cl-state').textContent = { wait: '연결하는 중이에요', listen: '듣고 있어요', speak: '튜터가 말하는 중 · 눌러서 끼어들기', fail: '통화가 끊겼어요' }[s];
    if (DEBUG) $c('cl-lat').textContent = `${lat.length ? '반응 ' + lat[lat.length - 1] + '초 · ' : ''}끊김 ${under} · 끼어듦 ${cuts} · 잡음 ${gated} · 울림 ${echo.toFixed(3)}`;
  };
  const note = t => { $c('cl-note').textContent = t || ''; };

  // ===== 자막 =====
  function cap(who, text) {
    const last = lines[lines.length - 1];
    if (last && last.who === who && last.open) last.text += text;
    else {
      if (last) last.open = false;
      lines.push({ who, text, open: true });
    }
    drawCap();
  }
  const closeLine = () => { const l = lines[lines.length - 1]; if (l) l.open = false; };
  function drawCap() {
    const box = $c('cl-cap'), show = lines.slice(-6);
    box.innerHTML = '';
    show.forEach((l, i) => {
      const p = document.createElement('p');
      p.className = l.who + (i < show.length - 2 ? ' old' : '');
      p.textContent = l.text.trim();
      box.appendChild(p);
    });
    box.scrollTop = box.scrollHeight;
  }

  // ===== 소리 변환 =====
  function down(x, sr) {  // 폰 마이크(보통 48kHz)를 16kHz로. 구간 평균이라 잡음도 덜함
    if (sr === IN_RATE) return x;
    const r = sr / IN_RATE, n = Math.floor(x.length / r), o = new Float32Array(n);
    for (let i = 0; i < n; i++) {
      const a = Math.floor(i * r), b = Math.min(x.length, Math.floor((i + 1) * r));
      let s = 0;
      for (let j = a; j < b; j++) s += x[j];
      o[i] = s / (b - a || 1);
    }
    return o;
  }
  function toB64(f) {
    const pcm = new Int16Array(f.length);
    for (let i = 0; i < f.length; i++) { const s = Math.max(-1, Math.min(1, f[i])); pcm[i] = s < 0 ? s * 0x8000 : s * 0x7fff; }
    const u = new Uint8Array(pcm.buffer);
    let s = '';
    for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000));
    return btoa(s);
  }
  const level = x => {  // 원 크기용 음량
    let s = 0;
    for (let i = 0; i < x.length; i += 16) s += x[i] * x[i];
    return Math.min(1, Math.sqrt(s / (x.length / 16)) * 6);
  };

  // ===== 재생: 받은 조각을 빈틈없이 이어 붙임 =====
  // 3.8 세대 음성은 문장, 턴 경계에 50~150ms 잡음(삐익, 지직)이 섞여 올 수 있음 (구글 포럼 보고, AI Studio는 재생 쪽에서 걸러 냄).
  // 그래서 받은 소리를 10ms 단위로 보고, 조용한 구간 사이에 고립된 짧고 거친 덩어리는 지움
  const FR = 240, QUIET = 0.004, LOUD = 0.012, MAXB = 15, GAPF = 4;  // 10ms 한 칸, 조용함/소리 기준, 덩어리 최대 15칸(150ms), 앞뒤 조용함 4칸(40ms)
  function frames(ch) {
    const out = [];
    for (let k = 0; k + FR <= ch.length; k += FR) {
      let e = 0, z = 0;
      for (let i = k; i < k + FR; i++) { e += ch[i] * ch[i]; if (i > k && (ch[i] >= 0) !== (ch[i - 1] >= 0)) z++; }
      out.push({ rms: Math.sqrt(e / FR), zcr: z / FR });
    }
    return out;
  }
  const noisy = seg => { let r = 0, z = 0; seg.forEach(f => { r = Math.max(r, f.rms); z += f.zcr; }); return z / seg.length > 0.2 || r > 0.15; };  // 말소리(모음)는 부드럽고, 잡음은 거칠거나 갑자기 큼
  function gate(ch, atEnd, fresh) {  // 고립된 잡음 덩어리를 0으로. atEnd: 조각 끝에 붙은 덩어리 위치를 돌려줌 (턴이 끝나면 지움). fresh: 말 시작 조각 (앞이 조용함)
    const fs = frames(ch); let cut = 0, tail = null;
    for (let i = 0; i < fs.length; i++) {
      if (fs[i].rms < LOUD) continue;
      let j = i; while (j < fs.length && fs[j].rms >= QUIET) j++;  // 덩어리 [i, j)
      let before = i === 0 && fresh ? GAPF : 0; for (let k = i - 1; k >= 0 && fs[k].rms < QUIET; k--) before++;
      let after = 0; for (let k = j; k < fs.length && fs[k].rms < QUIET; k++) after++;
      if (j - i <= MAXB && before >= GAPF && noisy(fs.slice(i, j))) {
        if (after >= GAPF) { ch.fill(0, i * FR, Math.min(ch.length, j * FR)); cut++; }  // 앞뒤가 조용한 고립 덩어리: 바로 지움
        else if (j === fs.length && atEnd) tail = [i * FR, ch.length];
      }
      i = j;
    }
    return { cut, tail };
  }
  function play(b64) {
    let bin = atob(b64);
    if (rest !== null) { bin = rest + bin; rest = null; }  // 조각이 샘플 중간에서 잘려 오면 다음 조각과 이어 붙임 (지직 방지)
    if (bin.length & 1) { rest = bin[bin.length - 1]; bin = bin.slice(0, -1); }
    const n = bin.length >> 1;
    if (!n) return;
    const buf = ctx.createBuffer(1, n, OUT_RATE), ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v >= 0x8000) v -= 0x10000; ch[i] = v / 32768; }
    const g = gate(ch, true, !playing.length && playAt < ctx.currentTime + 0.01);  // 말 시작 조각이면 맨 앞 잡음도 지움
    gated += g.cut;
    const now = ctx.currentTime, gap = playAt < now + 0.01;
    if (gap) {  // 새 말 시작이거나 조각이 늦게 옴: 잠깐 모았다가 재생, 첫 3ms는 부드럽게 시작 (틱 방지)
      if (playing.length) { under++; playAt = now + REBUF; } else playAt = now + JITTER;  // under: 진단용 끊김 횟수
      const f = Math.min(n, Math.round(OUT_RATE * 0.003));
      for (let i = 0; i < f; i++) ch[i] *= i / f;
    }
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.connect(out);
    s.start(playAt);
    lastChunk = g.tail ? { at: playAt + g.tail[0] / OUT_RATE, end: playAt + buf.duration } : null;  // 턴이 끝나면 끝 덩어리를 소리 줄여 지움
    playAt += buf.duration;
    playing.push(s);
    s.onended = () => { playing = playing.filter(x => x !== s); if (!playing.length && !ended && ready) { setState('listen'); lastAct = performance.now(); } };
    if (wantLat && meT) { wantLat = false; const d = (performance.now() - meT) / 1000; lat.push(+d.toFixed(2)); $c('cl-lat').textContent = `반응 약 ${d.toFixed(1)}초`; }
    setState('speak');
  }
  function muteTail() {  // 턴 마지막 조각 끝의 잡음 덩어리: 아직 재생 전이면 그 구간만 볼륨 0
    const t = lastChunk; lastChunk = null;
    if (!t || !ctx || !out || t.at < ctx.currentTime + 0.01) return;
    out.gain.setValueAtTime(1, t.at - 0.004);
    out.gain.linearRampToValueAtTime(0, t.at);
    out.gain.setValueAtTime(0, t.end);
    out.gain.linearRampToValueAtTime(1, t.end + 0.01);
    gated++;
  }
  function flush(soft) {  // 끼어들거나 끊으면 튜터 말을 멈춤. 0.03초 동안 줄인 뒤 멈춰서 뚝 소리가 안 남
    const list = playing;
    playing = [];
    playAt = 0;
    rest = null;
    if (!ctx || !out) return;
    const t = ctx.currentTime;
    out.gain.cancelScheduledValues(t);
    out.gain.setValueAtTime(out.gain.value, t);
    out.gain.linearRampToValueAtTime(0, t + FADE);
    list.forEach(s => { s.onended = null; try { s.stop(t + FADE + 0.01); } catch (e) {} });
    out.gain.setValueAtTime(1, t + FADE + 0.02);
  }

  // ===== 말하기 속도: Live 음성은 배속 값이 없어 지시문으로 조절 (재생 속도를 바꾸면 목소리 높이가 변함) =====
  let slow = false;
  function pace() {
    const r = typeof ttsRate === 'number' ? ttsRate : 1;
    if (r >= 1) return '';  // 기본은 자연스러운 속도
    return `Speaking pace: about ${Math.max(50, Math.round(100 * r))}% of a native speaker's normal speed. Articulate every word and pause briefly between sentences. Keep this pace for the whole call.`;
  }
  function setSlow(on) {  // 통화 중 '더 천천히' 버튼
    slow = on;
    $c('cl-slow').classList.toggle('on', on);
    if (!ready || !ws || ws.readyState !== 1) return;
    const t = on ? '(Note for your next replies: speak more slowly and clearly, with short pauses. Do not reply to this note.)' : '(Note for your next replies: go back to your normal pace. Do not reply to this note.)';
    ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: t }] }], turnComplete: false } }));  // 다음 대답부터 적용, 지금 말은 그대로
    toastIn(on ? '다음 대답부터 천천히 말해요' : '다음 대답부터 원래 속도로 말해요');
  }
  function idleCheck() {  // 튜터 말이 끝난 뒤 조용하면 먼저 안부 (음소거 중이면 일부러 조용한 거라 안 함). 오래 조용하면 자동 종료
    if (lastAct && !playing.length && !ended && performance.now() - lastAct >= IDLE_END * 1000) {
      endCall();
      if (typeof toast === 'function') toast('대화가 없어서 통화를 마쳤어요', 3000);
      return;
    }
    if (!lastAct || playing.length || muted || nudges >= IDLE_MAX || !ws || ws.readyState !== 1) return;
    if (performance.now() - lastAct < IDLE_SEC * 1000) return;
    nudges++;
    lastAct = performance.now();
    const t = nudges === 1
      ? '(The learner has been silent for a while. Gently check in with one short, warm line, like "Are you still there?" or "Everything okay? Take your time." Then offer an easier way to answer.)'
      : '(The learner is still silent. Check in once more, light and playful, like "Hello? Did you fall asleep?" Keep it to one short line.)';
    ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: t }] }], turnComplete: true } }));
  }
  const heardMe = () => { lastAct = performance.now(); nudges = 0; };  // 내가 말하면 침묵 시계와 안부 횟수 초기화
  function toastIn(t) { note(t); clearTimeout(toastIn.t); toastIn.t = setTimeout(() => note(''), 2400); }
  // ===== 통화 후 교정 리포트: 통화 중엔 흐름, 끝난 뒤 저렴한 텍스트 모델 1번으로 정리 =====
  const REPORT_SYS = `You review a voice call between an English tutor and a Korean adult learner. The transcript comes from speech recognition, so ignore capitalization, punctuation, filler words and obvious recognition glitches.
Output only JSON: {"summary":"","fixes":[{"said":"","better":"","tip":""}],"good":[""],"phrases":[{"en":"","ko":""}]}
Rules:
- fixes: up to 5 learner sentences with real grammar or word-choice mistakes, most useful first. "said" is what the learner said (shortened if long), "better" is a natural sentence at the learner's level that keeps their meaning, "tip" is one short Korean explanation under 40 Korean characters. Skip sentences that are already fine.
- good: up to 2 English expressions the learner used well, quoted exactly.
- phrases: up to 3 useful English phrases from the tutor's lines at the learner's level, with short Korean meanings.
- summary: one warm, specific Korean sentence about how the call went.
- Never invent anything the learner did not say. If there are no mistakes, return an empty fixes array.`;
  const clean = (x, n) => String(x || '').replace(/[<>\n\r]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, n);
  const same = (a, b) => a.toLowerCase().replace(/[^a-z]/g, '') === b.toLowerCase().replace(/[^a-z]/g, '');
  function endCall() {  // 끊기: 충분히 말했으면 리포트, 아니면 바로 닫기
    logTime();
    save();
    stop();
    const mine = lines.filter(l => l.who === 'me' && l.text.trim().split(/\s+/).length >= 2);
    if (spoke < 30 || mine.length < 2 || typeof lite !== 'function') return close();
    report();
  }
  async function report() {
    const box = $c('call'), body = $c('rp-body');
    box.classList.add('report');
    $c('cl-time').textContent = '통화 정리';
    $c('rp-review').style.display = 'none';
    body.innerHTML = '<p class="rp-wait">통화 내용을 정리하고 있어요<br>잠시만 기다려 주세요</p>';
    const lv = (typeof ob !== 'undefined' && ob && ob.lvl) || 0;
    const tr = lines.map(l => `${l.who === 'me' ? 'Learner' : 'Tutor'}: ${l.text.trim()}`).join('\n').slice(-6000);  // 긴 통화는 최근 부분만
    let j;
    try {
      const raw = await lite({ system_instruction: { parts: [{ text: REPORT_SYS }] }, contents: [{ role: 'user', parts: [{ text: `Learner level: ${lv || 'unknown'} of 5\nTranscript:\n${tr}` }] }],
        generationConfig: { temperature: 0.2, maxOutputTokens: 900 } });
      j = JSON.parse(raw.replace(/```json|```/g, '').trim());
    } catch (e) {
      if (!box.classList.contains('report')) return;
      body.innerHTML = '<p class="rp-wait">리포트를 만들지 못했어요<br>인터넷이나 사용 한도를 확인해 주세요</p>';
      return;
    }
    if (!box.classList.contains('report')) return;  // 기다리는 동안 닫음
    const fixes = (Array.isArray(j.fixes) ? j.fixes : []).map(f => ({ said: clean(f.said, 140), better: clean(f.better, 160), tip: clean(f.tip, 60) }))
      .filter(f => f.said && f.better && !same(f.said, f.better)).slice(0, 5);
    const good = (Array.isArray(j.good) ? j.good : []).map(g => clean(g, 80)).filter(Boolean).slice(0, 2);
    const phrases = (Array.isArray(j.phrases) ? j.phrases : []).map(p => ({ en: clean(p.en, 60), ko: clean(p.ko, 40) })).filter(p => p.en && p.ko).slice(0, 3);
    keepFixes(fixes);
    try { localStorage.setItem('lastreport', JSON.stringify({ at: Date.now(), sec: spoke, summary: clean(j.summary, 120), fixes, good, phrases })); } catch (e) {}
    paintReport(clean(j.summary, 120), fixes, good, phrases);
  }
  function keepFixes(fixes) {  // 복습, 튜터 메모가 쓰도록 날짜와 함께 보관 (최근 60개)
    if (!fixes.length) return;
    const d = new Date(), day = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    try {
      const all = JSON.parse(localStorage.getItem('callfix') || '[]');
      fixes.forEach(f => all.push({ day, said: f.said, better: f.better, tip: f.tip }));
      localStorage.setItem('callfix', JSON.stringify(all.slice(-60)));
    } catch (e) {}
  }
  function paintReport(summary, fixes, good, phrases) {
    const body = $c('rp-body'), esc = t => String(t).replace(/[&<>"]/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]));
    const said = lines.filter(l => l.who === 'me').length, min = Math.max(1, Math.round(spoke / 60));
    let h = `<p class="rp-sum">${esc(summary || '수고했어요! 오늘도 영어로 말했어요.')}</p>
      <div class="rp-stats"><div><b>${min}분</b><small>통화</small></div><div><b>${said}</b><small>내가 한 말</small></div><div><b>${fixes.length}</b><small>고칠 문장</small></div></div>`;
    if (fixes.length) h += '<p class="rp-h">이렇게 말하면 더 자연스러워요</p>' + fixes.map((f, i) => `<div class="rp-fix"><s>${esc(f.said)}</s><div class="bt"><span>${esc(f.better)}</span><span data-sp="${i}"></span></div>${f.tip ? `<small>${esc(f.tip)}</small>` : ''}</div>`).join('');
    else h += '<p class="rp-h">고칠 문장이 없었어요. 아주 좋아요!</p>';
    if (good.length) h += '<p class="rp-h">잘 쓴 표현</p><div class="rp-good">' + good.map(g => `<span>${esc(g)}</span>`).join('') + '</div>';
    if (phrases.length) h += '<p class="rp-h">튜터가 쓴 표현, 써먹어 보세요</p>' + phrases.map((p, i) => {
      const has = typeof findWord === 'function' && findWord(p.en);
      return `<div class="rp-ph"><div><b>${esc(p.en)}</b><small>${esc(p.ko)}</small></div><button type="button" data-ph="${i}" class="${has ? 'done' : ''}">${has ? '저장됨' : '단어장에 저장'}</button></div>`;
    }).join('');
    body.innerHTML = h;
    body.scrollTop = 0;
    if (typeof spkBtn === 'function') body.querySelectorAll('[data-sp]').forEach(e => e.append(spkBtn(fixes[+e.dataset.sp].better)));
    body.querySelectorAll('[data-ph]').forEach(b => b.onclick = () => {
      const p = phrases[+b.dataset.ph];
      if (b.classList.contains('done') || typeof vocab === 'undefined') return;
      if (!findWord(p.en)) { vocab.push({ w: p.en, base: '', meaning: `ⓟ ${p.ko}`, exs: [], box: 1, due: addDays(dayKey, 1), src: 'call' }); saveVocab(); }
      b.classList.add('done');
      b.textContent = '저장됨';
    });
    $c('rp-review').style.display = fixes.length ? '' : 'none';  // 고칠 문장이 있을 때만 복습 버튼
  }
  // ===== 시스템 지시문 =====
  function sys() {
    const p = (typeof profile !== 'undefined' && profile) || {}, o = (typeof ob !== 'undefined' && ob) || {};
    const goals = p.field || (o.goals && o.goals.join(', ')) || 'daily conversation';
    return [
      'You are a warm, encouraging English conversation tutor on a voice call with a Korean adult learner.',
      'Speak only English. Keep each turn short (1 to 3 sentences) and usually end with a question, so the learner talks more than you.',
      'Do not stop the conversation for small mistakes. If a mistake hides the meaning, naturally recast the correct form in your reply. A correction report is given after the call.',
      'When the learner struggles to find a word, pauses, uses a vague word or mixes in Korean, offer what they probably meant as a short check, like "Did you mean a refund?" or "Oh, you mean you were late?", then let them go on.',
      'When the learner asks how to say something, in Korean or English (for example "이거 영어로 뭐라고 해?"), give one natural way to say it, then invite them to try: "You can say, I\'d like a refund. Want to try saying it?" In that turn ask nothing else. Wait for their try, react warmly in a few words (recast gently if needed), and only then continue the conversation.',
      o.lvl ? `Learner level ${o.lvl} of 5. ${LIVE_RULE[o.lvl]}` : 'Learner level unknown: start simple and adjust to the learner.',
      `Learner goals: ${goals}.`,
      pace(),
      typeof memoNotes === 'function' ? memoNotes() : ''
    ].filter(Boolean).join('\n');
  }

  // ===== 연결 =====
  function connect() {
    ready = false;
    setState('wait');
    const sock = ws = new WebSocket(URL_WS + encodeURIComponent(apiKey));
    ws.onopen = () => {
      const setup = { model: MODEL, generationConfig: { responseModalities: ['AUDIO'] }, systemInstruction: { parts: [{ text: sys() }] },
        inputAudioTranscription: {}, outputAudioTranscription: {} };
      if (attempt === 0) {  // 선택 옵션: 서버가 거부하면 빼고 한 번 더 연결
        setup.contextWindowCompression = { slidingWindow: {} };  // 긴 통화에서 앞부분을 정리해 용량 확보
      }
      ws.send(JSON.stringify({ setup }));
    };
    ws.onmessage = async e => {
      let m;
      try { m = JSON.parse(typeof e.data === 'string' ? e.data : await e.data.text()); } catch (x) { return; }  // 서버는 글자도 이진 프레임으로 보냄
      if (ws !== sock || ended) return;  // 끊긴 뒤 늦게 도착한 조각은 버림 (끊김 안내가 '듣고 있어요'로 덮이지 않게)
      if (m.setupComplete) {
        ready = true;
        t0 = Date.now();
        $c('cl-time').textContent = '00:00';
        setState('listen');
        ws.send(JSON.stringify({ clientContent: { turns: [{ role: 'user', parts: [{ text: 'Start the call: greet me briefly and ask one easy question.' }] }], turnComplete: true } }));
        return;
      }
      if (m.usageMetadata) tokens = Math.max(tokens, m.usageMetadata.totalTokenCount || 0);  // 실측용
      const c = m.serverContent;
      if (c) {
        if (c.interrupted) { cuts++; flush(); closeLine(); setState('listen'); }
        ((c.modelTurn && c.modelTurn.parts) || []).forEach(p => { if (p.inlineData && /audio/.test(p.inlineData.mimeType || '')) play(p.inlineData.data); });
        if (c.inputTranscription && c.inputTranscription.text) { heardMe(); cap('me', c.inputTranscription.text); meT = performance.now(); wantLat = true; }  // 내 말 마지막 시각 → 튜터 첫 소리까지 = 반응 시간
        if (c.outputTranscription && c.outputTranscription.text) cap('ai', c.outputTranscription.text);
        if (c.turnComplete) { closeLine(); muteTail(); }
      }
      if (m.goAway) note('통화 시간이 거의 끝났어요. 끊고 다시 걸면 이어서 할 수 있어요.');
    };
    ws.onclose = e => {
      if (ended) return;
      if (!ready && attempt === 0 && e.code === 1007) { attempt = 1; return connect(); }  // 설정 거부: 선택 옵션 빼고 한 번 더
      const why = /api key|permission|unauth/i.test(e.reason) ? 'API 키를 확인해 주세요.' : /quota|exhaust|rate/i.test(e.reason) ? '사용 한도에 걸렸어요. 잠시 뒤 다시 걸어 주세요.'
        : ready ? '연결이 끊겼어요. 인터넷을 확인하고 다시 걸어 주세요.' : '통화를 연결하지 못했어요.';
      logTime();
      ws = null;
      stopAudio();
      setState('fail');
      note(why + (e.reason ? ` (${e.reason.slice(0, 80)})` : ''));
    };
  }

  // ===== 마이크 =====
  let micLv = 0;
  function sendPcm(b64, lv) {  // 튜터가 말하는 중엔 큰 소리(내 목소리)만 보냄: 스피커 소리가 다시 들어가는 에코 줄이기
    micLv = muted ? 0 : lv;
    if (!ready || muted || !ws || ws.readyState !== 1) return;
    const now = performance.now(), send = d => ws.send(JSON.stringify({ realtimeInput: { audio: { data: d, mimeType: 'audio/pcm;rate=16000' } } }));
    if (playing.length && now > gateT) {
      const th = Math.max(GATE_MIN, echo * GATE_X);
      loud = lv > th ? loud + 1 : 0;
      if (loud < SUSTAIN) {  // 아직 울림으로 봄: 보내지 않고 울림 크기만 학습, 앞부분은 잠깐 보관
        if (lv <= th) echo = echo * .9 + lv * .1;
        pre.push(b64);
        if (pre.length > PRE) pre.shift();
        return;
      }
      gateT = now + HOLD;  // 내 목소리로 판단: 보관해 둔 앞부분부터 보냄 (첫 음절이 잘리지 않게)
      pre.push(b64);
      pre.forEach(send);
      pre = [];
      return;
    }
    if (playing.length && lv > Math.max(GATE_MIN, echo * GATE_X)) gateT = now + HOLD;  // 말하는 동안 계속 열어 둠
    if (!playing.length) { echo *= .98; loud = 0; pre = []; if (lv > GATE_MIN) lastAct = performance.now(); }  // 말소리가 나면 침묵 아님
    send(b64);
  }
  async function startMic() {
    if (typeof setAudioSession === 'function') setAudioSession('play-and-record');  // 통화 채널: 볼륨 버튼이 통화 소리에 적용
    stream = await navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: true, autoGainControl: true } });
    await ctx.resume();
    src = ctx.createMediaStreamSource(stream);
    sink = ctx.createGain();  // 처리기가 돌게 출력에 연결하되 소리는 0
    sink.gain.value = 0;
    sink.connect(ctx.destination);
    try {
      if (!ctx.audioWorklet) throw 0;
      const url = URL.createObjectURL(new Blob([WORKLET], { type: 'application/javascript' }));
      await ctx.audioWorklet.addModule(url);
      URL.revokeObjectURL(url);
      node = new AudioWorkletNode(ctx, 'cap');
      node.port.onmessage = e => { const u = new Uint8Array(e.data.pcm); let s = ''; for (let i = 0; i < u.length; i += 0x8000) s += String.fromCharCode.apply(null, u.subarray(i, i + 0x8000)); sendPcm(btoa(s), e.data.lv); };
    } catch (e) {  // 오래된 브라우저: 예전 방식 (작은 묶음으로 지연 줄임)
      node = ctx.createScriptProcessor(2048, 1, 1);
      node.onaudioprocess = ev => { const x = ev.inputBuffer.getChannelData(0); sendPcm(toB64(down(x, ctx.sampleRate)), level(x) / 6); };
    }
    src.connect(node);
    node.connect(sink);
  }
  function meter() {  // 테두리 크기: 튜터가 말하면 튜터 소리, 아니면 내 마이크
    if (ended || !ctx) return;
    let v = micLv * 6;
    if (playing.length && ana) {
      const a = new Uint8Array(ana.fftSize);
      ana.getByteTimeDomainData(a);
      let s = 0;
      for (let i = 0; i < a.length; i += 4) { const d = (a[i] - 128) / 128; s += d * d; }
      v = Math.sqrt(s / (a.length / 4)) * 5;
    }
    $c('call').style.setProperty('--lv', Math.min(1, v).toFixed(2));
    raf = requestAnimationFrame(meter);
  }
  function stopAudio() {
    flush();
    if (node) { node.onaudioprocess = null; if (node.port) node.port.onmessage = null; try { node.disconnect(); } catch (e) {} }
    if (src) try { src.disconnect(); } catch (e) {}
    if (sink) try { sink.disconnect(); } catch (e) {}
    cancelAnimationFrame(raf);
    micLv = 0;
    sink = null;
    if (stream) stream.getTracks().forEach(t => t.stop());  // 마이크를 꺼야 아이폰 소리가 스피커로 돌아옴
    node = src = stream = null;
  }
  function stop() {
    ended = true;
    if (ws) { try { ws.close(); } catch (e) {} ws = null; }
    stopAudio();
    clearInterval(timer);
    if (wake) { wake.release().catch(() => {}); wake = null; }
  }

  async function begin() {
    ended = false; attempt = 0; spoke = 0; lastAct = 0; nudges = 0; gated = 0; lastChunk = null; echo = 0; loud = 0; pre = []; under = 0; cuts = 0; lines = []; tokens = 0; playAt = 0; lat = []; meT = 0; wantLat = false;
    setMute(false);
    slow = false;
    $c('cl-slow').classList.remove('on');
    $c('cl-lat').textContent = '';
    if (!out) {  // 튜터 소리 → 볼륨(페이드용) → 분석기(테두리용) → 스피커
      out = ctx.createGain();
      const lim = ctx.createDynamicsCompressor();  // 리미터: 남은 큰 잡음이 귀 아프지 않게 눌러 줌
      lim.threshold.value = -6; lim.knee.value = 0; lim.ratio.value = 20; lim.attack.value = 0.002; lim.release.value = 0.1;
      ana = ctx.createAnalyser();
      ana.fftSize = 512;
      out.connect(lim);
      lim.connect(ana);
      ana.connect(ctx.destination);
    }
    drawCap();
    note('');
    setState('wait');
    if (navigator.wakeLock) navigator.wakeLock.request('screen').then(w => { wake = w; }).catch(() => {});  // 통화 중 화면 꺼짐 방지
    timer = setInterval(() => {
      if (!ready || !t0) return;
      const sec = spoke + Math.round((Date.now() - t0) / 1000);
      $c('cl-time').textContent = `${String(Math.floor(sec / 60)).padStart(2, '0')}:${String(sec % 60).padStart(2, '0')}`;
      if (sec === LONG_SEC) note('15분이 지났어요. 한 번 끊고 다시 걸면 더 안정적이에요.');
      idleCheck();
      if (muted && !ended && performance.now() - mutedAt > IDLE_END * 1000) { endCall(); if (typeof toast === 'function') toast('음소거가 오래 이어져서 통화를 마쳤어요', 3000); }  // 음소거로 방치해도 통화가 계속 열려 있지 않게
    }, 1000);
    try { await startMic(); meter(); }
    catch (e) {
      stop();
      setState('fail');
      return note(e && e.name === 'NotAllowedError' ? '마이크 권한이 필요해요. 브라우저 설정에서 마이크를 허용해 주세요.' : '마이크를 켜지 못했어요.');
    }
    connect();
  }

  function save() {  // 통화 후 교정 리포트(다음 단계)를 위해 마지막 통화 기록 저장
    const sec = spoke;
    if (!lines.length) return;
    try { localStorage.setItem('lastcall', JSON.stringify({ at: Date.now(), sec, tokens, lat, under, cuts, gated, lines: lines.map(l => ({ who: l.who, text: l.text.trim() })) })); } catch (e) {}
  }
  function logTime() {  // 날짜별 통화 시간 (홈의 오늘 목표, 연속 학습에 씀). 최근 60일만 보관
    if (!t0 || !ready) return;
    const sec = Math.round((Date.now() - t0) / 1000), d = new Date();
    t0 = 0;
    spoke += sec;
    const key = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
    try {
      const m = JSON.parse(localStorage.getItem('talksec') || '{}');
      m[key] = (m[key] || 0) + sec;
      Object.keys(m).sort().slice(0, -60).forEach(k => delete m[k]);
      localStorage.setItem('talksec', JSON.stringify(m));
    } catch (e) {}
  }
  function close() {
    logTime();
    save();
    stop();
    if (ctx) { ctx.close().catch(() => {}); ctx = null; }
    if (typeof setAudioSession === 'function') setAudioSession('playback');  // 통화가 끝나면 다시 미디어 채널
    out = ana = null;
    $c('call').classList.remove('on', 'first', 'wait', 'listen', 'speak', 'fail', 'report');
    $c('cl-time').textContent = '통화 준비';
    if (typeof paintMenu === 'function') paintMenu();  // 홈의 오늘 목표 바로 반영
  }

  // c: 버튼을 누른 순간 만든 AudioContext (아이폰은 누른 순간에 만들어야 소리가 남)
  function open(c) {
    if (!ended) return;
    mount();
    ctx = c;
    if (typeof stopSpeak === 'function') stopSpeak();
    $c('call').classList.add('on');
    if (!localStorage.getItem('livenote')) { $c('call').classList.add('first'); return; }
    begin();
  }
  return { open, close, active: () => !ended, _test: { gate, idleEnd: () => IDLE_END, endState: () => ended, setMuted: (on, ago) => { setMute(on); mutedAt = performance.now() - ago; }, endCall, report, keepFixes, setLines: v => { lines = v; }, setSpoke: v => { spoke = v; }, idle: () => [lastAct, nudges], idleCheck, setAct: v => { lastAct = v; }, down, toB64, sys, pace, sendPcm, fake: on => { playing = on ? [{}] : []; gateT = 0; loud = 0; pre = []; }, echo: () => echo, ready: () => ready } };  // 검사용
})();
