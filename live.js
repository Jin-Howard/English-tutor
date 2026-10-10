// 실시간 통화: Gemini Live API (gemini-3.8-live) 웹소켓 직접 연결. 통화 버튼을 누를 때만 불러옴
// 소리: 마이크 16kHz PCM16 보냄, 답 24kHz PCM16 받음. 자막은 서버 받아쓰기 사용
window.LiveCall = (() => {
  const MODEL = 'models/gemini-3.8-live';
  const URL_WS = 'wss://generativelanguage.googleapis.com/ws/google.ai.generativelanguage.v1beta.GenerativeService.BidiGenerateContent?key=';
  const IN_RATE = 16000, OUT_RATE = 24000, LONG_SEC = 15 * 60;  // 음성 세션은 약 15분이 한계라 그 전에 안내
  const JITTER = 0.15;   // 말 시작 때 모아 두는 시간 (인터넷 지연에도 끊김 없이)
  const FADE = 0.03;     // 끊을 때 소리를 줄이는 시간 (뚝 소리 방지)
  const GATE = 0.035, HOLD = 500;  // 튜터가 말하는 동안은 이 크기 이상만 보냄 (에코 줄이기), 넘으면 0.5초 유지
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

  let spoke = 0, ws, ctx, stream, src, node, sink, out, ana, raf, timer, wake = null, attempt = 0, rest = null, gateT = 0, meT = 0, wantLat = false, lat = [];
  let ready = false, ended = true, muted = false, t0 = 0, playAt = 0, playing = [], lines = [], tokens = 0;
  const $c = id => document.getElementById(id);

  // ===== 화면 =====
  const CSS = `
  #call { position: fixed; inset: 0; z-index: 900; display: none; flex-direction: column; align-items: center; box-sizing: border-box;
          padding: calc(env(safe-area-inset-top, 0px) + 18px) 20px calc(env(safe-area-inset-bottom, 0px) + 24px); background: var(--bg); color: var(--text); }
  #call.on { display: flex; }
  #call .cl-top { display: flex; flex-direction: column; align-items: center; gap: 4px; margin-top: 12px; }
  #call .cl-top b { font-size: 19px; font-weight: 800; }
  #call .cl-top span { font-size: 14px; color: var(--sub); font-variant-numeric: tabular-nums; }
  #call .cl-orb { position: relative; width: 156px; height: 156px; margin: 44px 0 38px; }
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
  #call .cl-btns { display: flex; gap: 28px; }
  #call .cl-btns button { display: flex; flex-direction: column; align-items: center; gap: 6px; padding: 0; border: 0; background: none; color: var(--sub); font-size: 13px; font-weight: 600; }
  #call .cl-btns span { display: flex; align-items: center; justify-content: center; width: 64px; height: 64px; border-radius: 50%; background: var(--surface2); color: var(--text); }
  #call #cl-end span { background: var(--danger); color: #fff; }
  #call #cl-mute.on span { background: var(--text); color: var(--bg); }
  #call.fail #cl-mute, #call.wait #cl-mute { visibility: hidden; }  /* 연결 전, 끊긴 뒤엔 음소거 의미 없음 */
  #call .cl-first { display: none; width: 100%; max-width: 420px; margin-top: 24px; text-align: center; }
  #call.first .cl-first { display: block; }
  #call.first .cl-orb, #call.first .cl-state, #call.first .cl-cap, #call.first .cl-btns { display: none; }
  #call .cl-first p { margin: 0 0 14px; font-size: 15px; line-height: 1.6; color: var(--sub); text-wrap: pretty; }
  #call .cl-first button { width: 100%; height: 52px; margin-top: 8px; border: 0; border-radius: 16px; background: var(--accent); color: var(--on-accent); font-size: 16px; font-weight: 800; }
  #call .cl-first button.ghost { background: var(--surface2); color: var(--text); }
  #call .cl-fail { display: none; gap: 10px; width: 100%; max-width: 420px; margin-bottom: 14px; }
  #call.fail .cl-fail { display: flex; }
  #call .cl-fail button { flex: 1; height: 48px; border: 0; border-radius: 14px; background: var(--surface2); color: var(--text); font-size: 15px; font-weight: 700; }
  #call .cl-fail button.go { background: var(--accent); color: var(--on-accent); }`;
  const I_MIC = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="2" width="6" height="12" rx="3"/><path d="M5 11a7 7 0 0 0 14 0M12 18v4"/></svg>';
  const I_MUTE = '<svg viewBox="0 0 24 24" width="26" height="26" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3l18 18M9 9v2a3 3 0 0 0 5 2.2M15 9.3V5a3 3 0 0 0-5.7-1.3M5 11a7 7 0 0 0 11.5 5.3M19 11a7 7 0 0 1-.6 2.8M12 18v4"/></svg>';
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
      <div class="cl-fail"><button type="button" id="cl-text">글로 대화하기</button><button type="button" id="cl-again" class="go">다시 걸기</button></div>
      <div class="cl-btns">
        <button type="button" id="cl-mute"><span>${I_MIC}</span>음소거</button>
        <button type="button" id="cl-end"><span>${I_END}</span>끊기</button>
      </div>`;
    document.body.appendChild(d);
    $c('cl-go').onclick = () => { localStorage.setItem('livenote', '1'); $c('call').classList.remove('first'); begin(); };
    $c('cl-back').onclick = close;
    $c('cl-end').onclick = close;
    $c('cl-again').onclick = () => { logTime(); stop(); begin(); };
    $c('cl-text').onclick = () => { close(); if (typeof navTo === 'function') navTo('main'); };
    $c('cl-mute').onclick = () => setMute(!muted);
  }
  function setMute(on) {
    muted = on;
    $c('cl-mute').classList.toggle('on', on);
    $c('cl-mute').innerHTML = `<span>${on ? I_MUTE : I_MIC}</span>${on ? '음소거 중' : '음소거'}`;
  }
  const setState = s => {
    const box = $c('call');
    ['wait', 'listen', 'speak', 'fail'].forEach(k => box.classList.toggle(k, k === s));
    $c('cl-state').textContent = { wait: '연결하는 중이에요', listen: '듣고 있어요', speak: '튜터가 말하는 중', fail: '통화가 끊겼어요' }[s];
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
  function play(b64) {
    let bin = atob(b64);
    if (rest !== null) { bin = rest + bin; rest = null; }  // 조각이 샘플 중간에서 잘려 오면 다음 조각과 이어 붙임 (지직 방지)
    if (bin.length & 1) { rest = bin[bin.length - 1]; bin = bin.slice(0, -1); }
    const n = bin.length >> 1;
    if (!n) return;
    const buf = ctx.createBuffer(1, n, OUT_RATE), ch = buf.getChannelData(0);
    for (let i = 0; i < n; i++) { let v = bin.charCodeAt(2 * i) | (bin.charCodeAt(2 * i + 1) << 8); if (v >= 0x8000) v -= 0x10000; ch[i] = v / 32768; }
    const now = ctx.currentTime, gap = playAt < now + 0.01;
    if (gap) {  // 새 말 시작이거나 조각이 늦게 옴: 잠깐 모았다가 재생, 첫 3ms는 부드럽게 시작 (틱 방지)
      playAt = now + (playing.length ? 0.06 : JITTER);
      const f = Math.min(n, Math.round(OUT_RATE * 0.003));
      for (let i = 0; i < f; i++) ch[i] *= i / f;
    }
    const s = ctx.createBufferSource();
    s.buffer = buf;
    s.connect(out);
    s.start(playAt);
    playAt += buf.duration;
    playing.push(s);
    s.onended = () => { playing = playing.filter(x => x !== s); if (!playing.length && !ended && ready) setState('listen'); };
    if (wantLat && meT) { wantLat = false; const d = (performance.now() - meT) / 1000; lat.push(+d.toFixed(2)); $c('cl-lat').textContent = `반응 약 ${d.toFixed(1)}초`; }
    setState('speak');
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

  // ===== 시스템 지시문 =====
  function sys() {
    const p = (typeof profile !== 'undefined' && profile) || {}, o = (typeof ob !== 'undefined' && ob) || {};
    const goals = p.field || (o.goals && o.goals.join(', ')) || 'daily conversation';
    return [
      'You are a warm, encouraging English conversation tutor on a voice call with a Korean adult learner.',
      'Speak only English. Keep each turn short (1 to 3 sentences) and usually end with a question, so the learner talks more than you.',
      'Do not stop the conversation to correct mistakes. If a mistake hides the meaning, naturally recast the correct form in your reply. A correction report is given after the call.',
      'If the learner speaks Korean, reply in simple English and help them say it in English.',
      o.lvl ? `Learner level ${o.lvl} of 5. ${LIVE_RULE[o.lvl]}` : 'Learner level unknown: start simple and adjust to the learner.',
      `Learner goals: ${goals}.`,
      typeof memoNotes === 'function' ? memoNotes() : ''
    ].filter(Boolean).join('\n');
  }

  // ===== 연결 =====
  function connect() {
    ready = false;
    setState('wait');
    ws = new WebSocket(URL_WS + encodeURIComponent(apiKey));
    ws.onopen = () => {
      const setup = { model: MODEL, generationConfig: { responseModalities: ['AUDIO'] }, systemInstruction: { parts: [{ text: sys() }] },
        inputAudioTranscription: {}, outputAudioTranscription: {} };
      if (attempt === 0) setup.contextWindowCompression = { slidingWindow: {} };  // 긴 통화에서 앞부분을 정리해 용량 확보 (거부되면 빼고 재시도)
      ws.send(JSON.stringify({ setup }));
    };
    ws.onmessage = async e => {
      let m;
      try { m = JSON.parse(typeof e.data === 'string' ? e.data : await e.data.text()); } catch (x) { return; }  // 서버는 글자도 이진 프레임으로 보냄
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
        if (c.interrupted) { flush(); closeLine(); setState('listen'); }
        ((c.modelTurn && c.modelTurn.parts) || []).forEach(p => { if (p.inlineData && /audio/.test(p.inlineData.mimeType || '')) play(p.inlineData.data); });
        if (c.inputTranscription && c.inputTranscription.text) { cap('me', c.inputTranscription.text); meT = performance.now(); wantLat = true; }  // 내 말 마지막 시각 → 튜터 첫 소리까지 = 반응 시간
        if (c.outputTranscription && c.outputTranscription.text) cap('ai', c.outputTranscription.text);
        if (c.turnComplete) closeLine();
      }
      if (m.goAway) note('통화 시간이 거의 끝났어요. 끊고 다시 걸면 이어서 할 수 있어요.');
    };
    ws.onclose = e => {
      if (ended) return;
      if (!ready && attempt === 0 && e.code === 1007) { attempt = 1; return connect(); }  // 설정 거부: 선택 옵션 빼고 한 번 더
      const why = /api key|permission|unauth/i.test(e.reason) ? 'API 키를 확인해 주세요.' : /quota|exhaust|rate/i.test(e.reason) ? '사용 한도에 걸렸어요. 잠시 뒤 다시 걸어 주세요.'
        : ready ? '연결이 끊겼어요. 인터넷을 확인하고 다시 걸어 주세요.' : '통화를 연결하지 못했어요.';
      logTime();
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
    const now = performance.now();
    if (playing.length) {
      if (lv > GATE) gateT = now + HOLD;
      else if (now > gateT) return;
    }
    ws.send(JSON.stringify({ realtimeInput: { audio: { data: b64, mimeType: 'audio/pcm;rate=16000' } } }));
  }
  async function startMic() {
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
    ended = false; attempt = 0; spoke = 0; lines = []; tokens = 0; playAt = 0; lat = []; meT = 0; wantLat = false;
    setMute(false);
    $c('cl-lat').textContent = '';
    if (!out) {  // 튜터 소리 → 볼륨(페이드용) → 분석기(테두리용) → 스피커
      out = ctx.createGain();
      ana = ctx.createAnalyser();
      ana.fftSize = 512;
      out.connect(ana);
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
    try { localStorage.setItem('lastcall', JSON.stringify({ at: Date.now(), sec, tokens, lat, lines: lines.map(l => ({ who: l.who, text: l.text.trim() })) })); } catch (e) {}
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
    out = ana = null;
    $c('call').classList.remove('on', 'first', 'wait', 'listen', 'speak', 'fail');
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
  return { open, close, _test: { down, toB64, sys, sendPcm, fake: on => { playing = on ? [{}] : []; gateT = 0; }, ready: () => ready } };  // 검사용
})();
