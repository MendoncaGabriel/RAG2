// Modo de voz: conversa falada com o notebook aberto, em tela cheia (HUD animado).
// Fluxo: microfone -> detecção de fala (VAD por energia, no navegador) -> /api/voice/transcribe (STT local)
// -> mesma rota do chat (/api/conversations/:id/messages?stream=1, RAG inalterado; a conversa fica salva)
// -> resposta falada frase a frase enquanto o modelo ainda escreve (/api/voice/speak, TTS local) -> volta a ouvir.
// Usa `conversation`, `detailMode`, `loadMessages`, `loadChats`, `renderMarkdown` e `icons` de app.js.
(() => {
  const PREF_KEY = 'bento-voice', GREETINGS = ['Às suas ordens.', 'Estou ouvindo.', 'Pois não?', 'Em que posso ajudar?'];
  const prefs = { voice: 'faber', voiceEn: 'alan', speed: 1, fx: 'jarvis', pause: 1000, bargeIn: false, greet: true, review: false, filter: true };
  try { Object.assign(prefs, JSON.parse(localStorage.getItem(PREF_KEY) || '{}')) } catch {}
  const savePrefs = () => { try { localStorage.setItem(PREF_KEY, JSON.stringify(prefs)) } catch {} };
  const LABEL = { review: 'Confira o texto', boot: 'Iniciando', listening: 'Ouvindo', hearing: 'Ouvindo você', transcribing: 'Entendendo', thinking: 'Pensando', speaking: 'Falando', muted: 'Microfone pausado', error: 'Atenção' };
  const reduced = matchMedia('(prefers-reduced-motion: reduce)').matches;

  let root, canvas, g, ctx, stream, micSrc, lastCapture = null, micAn, outAn, fxIn, fxNodes = [], capture, sink, raf = 0, state = 'off', muted = false, used = false, session = 0;
  let turn = null, progress = 0, levelSm = 0, rot = 0, lastT = 0;
  // VAD: piso de ruído adaptativo, pré-gravação (para não cortar o início da fala) e silêncio final configurável.
  let deafUntil = 0, noise = 0.004, loud = 0, inSpeech = false, frames = [], pre = [], preMs = 0, speechMs = 0, silentMs = 0, bargeMs = 0;

  // ---------- Interface ----------
  const css = `
  #voice{--c-ink:230 234 237;--c-ink-muted:169 179 188;--c-ink-soft:124 135 145;--c-line:42 59 74;--c-canvas:11 22 32;--c-surface:18 32 45;--c-heading:21 190 240;--c-medium:21 190 240;--c-light:21 190 240;
    background:radial-gradient(120% 90% at 50% 38%,#06243d 0%,#031423 45%,#01080f 100%);color:#e6eaed}
  #voice.hidden{display:none}
  #voice .v-grid{background-image:linear-gradient(rgba(21,190,240,.05) 1px,transparent 1px),linear-gradient(90deg,rgba(21,190,240,.05) 1px,transparent 1px);background-size:44px 44px;mask-image:radial-gradient(circle at 50% 40%,#000 0%,transparent 70%)}
  #voice .v-btn{display:inline-flex;align-items:center;justify-content:center;gap:.5rem;height:3rem;min-width:3rem;padding:0 1rem;border-radius:999px;border:1px solid rgba(21,190,240,.35);background:rgba(21,190,240,.08);color:#dff6ff;font-size:.875rem;font-weight:500;transition:background .15s,border-color .15s,transform .1s}
  #voice .v-btn:hover{background:rgba(21,190,240,.18);border-color:rgba(21,190,240,.7)}#voice .v-btn:active{transform:scale(.97)}
  #voice .v-btn[aria-pressed="true"]{background:rgba(220,88,42,.2);border-color:rgba(220,88,42,.7)}
  #voice .v-main{height:3.5rem;padding:0 1.5rem;background:#15BEF0;color:#002B49;border-color:#15BEF0;font-weight:700}#voice .v-main:hover{background:#4fd0f5}
  #voice .v-answer{scrollbar-width:thin;scrollbar-color:rgba(21,190,240,.3) transparent;mask-image:linear-gradient(transparent 0,#000 1.25rem,#000 calc(100% - .5rem),transparent)}
  #voice .v-answer .markdown-body{color:#d7e3ec}#voice .v-answer strong{color:#fff}
  #voice .v-label{font-family:"Roboto Condensed",sans-serif;letter-spacing:.32em;text-transform:uppercase;font-weight:700;color:#15BEF0;text-shadow:0 0 18px rgba(21,190,240,.6)}
  #voice .v-panel{background:#031423;border:1px solid rgba(21,190,240,.4);box-shadow:0 0 0 1px rgba(0,0,0,.4),0 24px 60px rgba(0,0,0,.65);scrollbar-width:thin;scrollbar-color:rgba(21,190,240,.35) transparent}
  @media (max-width:639px){#voice .v-panel{max-height:calc(100dvh - 5rem)}}
  #voice select,#voice input[type=range]{accent-color:#15BEF0}
  #voice .v-field{width:100%;border-radius:.5rem;border:1px solid rgba(21,190,240,.3);background:#06192a;color:#e6eaed;padding:.45rem .6rem;font-size:.875rem}
  #voice .v-sent{color:#fff;text-shadow:0 0 12px rgba(21,190,240,.35)}`;
  const html = `<div id="voice" class="hidden fixed inset-0 z-40 flex flex-col overflow-hidden" role="dialog" aria-modal="true" aria-label="Modo de voz">
    <div class="v-grid pointer-events-none absolute inset-0"></div>
    <header class="relative z-30 flex items-center gap-3 px-4 pt-4 sm:px-8 sm:pt-6">
      <div class="min-w-0"><div class="v-label text-[11px]">Bento · Voz</div><div id="vBook" class="truncate text-sm text-white/60"></div></div>
      <div class="ml-auto flex items-center gap-2">
        <button id="vSettingsBtn" class="v-btn !h-10 !min-w-10 !px-0" title="Voz e efeitos" aria-label="Configurações de voz" aria-expanded="false"><i data-lucide="sliders-horizontal" class="h-4 w-4"></i></button>
        <button id="vClose" class="v-btn !h-10 !min-w-10 !px-0" title="Fechar (Esc)" aria-label="Fechar modo de voz"><i data-lucide="x" class="h-5 w-5"></i></button>
      </div>
      <div id="vSettings" class="v-panel fixed inset-x-3 top-16 hidden max-h-[calc(100dvh-5rem)] space-y-3 overflow-y-auto overscroll-contain rounded-xl p-4 text-sm shadow-2xl sm:inset-x-auto sm:right-8 sm:top-20 sm:w-[340px]" role="group" aria-label="Voz e efeitos">
        <label class="block"><span class="mb-1 block text-white/70">Voz em português</span><select id="vVoice" class="v-field"></select></label>
        <label class="block"><span class="mb-1 block text-white/70">Voz para respostas em inglês</span><select id="vVoiceEn" class="v-field"></select></label>
        <label class="block"><span class="mb-1 flex justify-between text-white/70">Velocidade <b id="vSpeedVal" class="font-medium text-white"></b></span><input id="vSpeed" type="range" min="0.8" max="1.3" step="0.05" class="w-full"></label>
        <label class="block"><span class="mb-1 block text-white/70">Efeito da voz</span><select id="vFx" class="v-field"><option value="jarvis">Jarvis (eco metálico)</option><option value="sutil">Sutil (ambiente)</option><option value="natural">Natural</option></select></label>
        <label class="block"><span class="mb-1 block text-white/70">Enviar após uma pausa de</span><select id="vPause" class="v-field"><option value="600">0,6 s (ágil)</option><option value="800">0,8 s</option><option value="1000">1 s (recomendado)</option><option value="1400">1,4 s (pausado)</option><option value="2000">2 s (para pensar)</option></select></label>
        <label class="flex items-start gap-2 text-white/80"><input id="vReview" type="checkbox" class="mt-0.5 h-4 w-4"> <span>Revisar o texto antes de enviar <span class="block text-xs text-white/50">Corrija o que foi entendido; Enter envia.</span></span></label>
        <label class="flex items-start gap-2 text-white/80"><input id="vFilter" type="checkbox" class="mt-0.5 h-4 w-4"> <span>Filtro de ruído do navegador <span class="block text-xs text-white/50">Desligue se palavras sumirem; ligue em ambiente barulhento.</span></span></label>
        <label class="flex items-center gap-2 text-white/80"><input id="vBarge" type="checkbox" class="h-4 w-4"> Interromper quando eu falar <span class="text-xs text-white/50">(use fone)</span></label>
        <label class="flex items-center gap-2 text-white/80"><input id="vGreet" type="checkbox" class="h-4 w-4"> Saudação ao abrir</label>
        <p class="border-t border-white/10 pt-3 text-xs text-white/50">Tudo roda no servidor do Bento: <span id="vEngine"></span>. Respostas rápidas/detalhadas seguem o botão do chat.</p>
      </div>
    </header>
    <div class="relative min-h-0 flex-1"><canvas id="vCanvas" class="absolute inset-0 h-full w-full"></canvas>
      <button id="vOrb" class="absolute left-1/2 top-1/2 h-40 w-40 -translate-x-1/2 -translate-y-1/2 rounded-full" aria-label="Interromper ou enviar agora"></button></div>
    <section class="relative z-10 mx-auto w-full max-w-3xl px-4 text-center sm:px-8">
      <div id="vState" class="v-label text-sm" aria-live="polite"></div>
      <p id="vHint" class="mt-1 min-h-[1.25rem] text-xs text-white/50"></p>
      <div id="vUserRow" class="mt-3 hidden items-center justify-center gap-2"><p id="vUser" class="text-base italic text-white/70 sm:text-lg"></p><button id="vReplay" class="v-btn !h-8 !min-w-8 shrink-0 !px-0" title="Ouvir o que o microfone captou" aria-label="Ouvir minha fala"><i data-lucide="volume-2" class="h-4 w-4"></i></button></div>
      <div id="vReviewBox" class="mt-3 hidden"><textarea id="vReviewText" rows="2" maxlength="5000" class="v-field resize-none text-base" aria-label="Texto entendido, edite se precisar"></textarea>
        <div class="mt-2 flex justify-center gap-2"><button id="vReviewSend" class="v-btn v-main !h-10"><i data-lucide="send" class="h-4 w-4"></i><span>Enviar</span></button><button id="vReviewRedo" class="v-btn !h-10"><i data-lucide="mic" class="h-4 w-4"></i><span>Falar de novo</span></button><button id="vReplay2" class="v-btn !h-10 !px-3" title="Ouvir o que o microfone captou" aria-label="Ouvir minha fala"><i data-lucide="volume-2" class="h-4 w-4"></i></button></div></div>
      <div id="vAnswer" class="v-answer mt-2 max-h-[30vh] overflow-y-auto py-3 text-left text-[15px] leading-relaxed sm:text-base"></div>
    </section>
    <footer class="relative z-10 flex items-center justify-center gap-3 px-4 pb-6 pt-3 sm:pb-8">
      <button id="vMute" class="v-btn" aria-pressed="false" title="Pausar microfone (M)"><i data-lucide="mic" class="h-5 w-5"></i></button>
      <button id="vMain" class="v-btn v-main"><i data-lucide="square" class="h-4 w-4"></i><span>Interromper</span></button>
    </footer>
  </div>`;
  function build() {
    if (root) return;
    const st = document.createElement('style'); st.textContent = css; document.head.append(st);
    document.body.insertAdjacentHTML('beforeend', html); root = document.getElementById('voice');
    canvas = document.getElementById('vCanvas'); g = canvas.getContext('2d');
    const q = s => root.querySelector(s);
    q('#vClose').onclick = close;
    q('#vMute').onclick = toggleMute;
    q('#vMain').onclick = mainAction; q('#vOrb').onclick = mainAction;
    const setPanel = show => { q('#vSettings').classList.toggle('hidden', !show); q('#vSettingsBtn').setAttribute('aria-expanded', String(show)) };
    q('#vSettingsBtn').onclick = () => setPanel(q('#vSettings').classList.contains('hidden'));
    // Clique fora do painel de configurações o fecha (ele fica por cima do HUD).
    root.addEventListener('pointerdown', e => { if (!q('#vSettings').classList.contains('hidden') && !e.target.closest('#vSettings,#vSettingsBtn')) setPanel(false) });
    const bind = (id, key, parse = v => v, after) => { const e = q(id); e.onchange = e.oninput = () => { prefs[key] = e.type === 'checkbox' ? e.checked : parse(e.value); savePrefs(); after?.() } };
    bind('#vVoice', 'voice', String, warmVoices); bind('#vVoiceEn', 'voiceEn', String, warmVoices); bind('#vSpeed', 'speed', Number, paintPrefs);
    bind('#vFx', 'fx', String, applyFx); bind('#vPause', 'pause', Number); bind('#vBarge', 'bargeIn'); bind('#vGreet', 'greet');
    bind('#vReview', 'review'); bind('#vFilter', 'filter', undefined, restartMic);
    q('#vReplay').onclick = q('#vReplay2').onclick = replay;
    q('#vReviewSend').onclick = sendReview; q('#vReviewRedo').onclick = () => { hideReview(); setState('listening') };
    q('#vReviewText').addEventListener('keydown', e => { if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) { e.preventDefault(); sendReview() } });
    document.addEventListener('keydown', e => {
      if (root.classList.contains('hidden')) return;
      if (e.key === 'Escape' && !q('#vSettings').classList.contains('hidden')) { e.preventDefault(); setPanel(false) }
      else if (e.key === 'Escape' && state === 'review') { e.preventDefault(); hideReview(); setState('listening') }
      else if (e.key === 'Escape') { e.preventDefault(); close() }
      else if (e.target.closest?.('select,input,textarea')) return;
      else if (e.code === 'Space') { if (e.target.closest?.('button')) return; e.preventDefault(); mainAction() } // em botão, o próprio clique nativo age
      else if (e.key === 'm' || e.key === 'M') toggleMute();
    });
    icons();
  }
  const $q = s => root.querySelector(s);
  function paintPrefs() {
    $q('#vVoice').value = prefs.voice; $q('#vVoiceEn').value = prefs.voiceEn; $q('#vSpeed').value = prefs.speed; $q('#vSpeedVal').textContent = `${Number(prefs.speed).toFixed(2).replace('.', ',')}x`;
    $q('#vFx').value = prefs.fx; $q('#vPause').value = String(prefs.pause); $q('#vBarge').checked = !!prefs.bargeIn; $q('#vGreet').checked = !!prefs.greet;
    $q('#vReview').checked = !!prefs.review; $q('#vFilter').checked = !!prefs.filter;
  }
  function setState(s, hint) {
    state = s; $q('#vState').textContent = LABEL[s] || '';
    $q('#vHint').textContent = hint ?? ({ listening: 'Fale quando quiser · Espaço interrompe · Esc fecha', hearing: 'Pause para enviar · Espaço envia agora', thinking: 'Buscando nos documentos…', speaking: 'Espaço interrompe', muted: 'Pressione M ou o botão do microfone para voltar a ouvir' }[s] || '');
    const main = $q('#vMain'), label = { hearing: ['send', 'Enviar agora'], transcribing: ['square', 'Cancelar'], thinking: ['square', 'Interromper'], speaking: ['square', 'Interromper'], muted: ['mic', 'Voltar a ouvir'], error: ['rotate-ccw', 'Tentar de novo'] }[s];
    main.classList.toggle('invisible', !label);
    if (label) { main.innerHTML = `<i data-lucide="${label[0]}" class="h-4 w-4"></i><span>${label[1]}</span>`; icons() }
  }
  const showUser = text => { $q('#vUser').textContent = text ? `“${text}”` : ''; const r = $q('#vUserRow'); r.classList.toggle('hidden', !text); r.classList.toggle('flex', !!text); $q('#vReplay').classList.toggle('hidden', !lastCapture) };
  // Revisão: mostra o texto entendido para corrigir antes de perguntar (opcional).
  function showReview(text) { showUser(''); const box = $q('#vReviewBox'), ta = $q('#vReviewText'); box.classList.remove('hidden'); ta.value = text; setState('review', 'Enter envia · Esc descarta'); ta.focus(); ta.setSelectionRange(text.length, text.length) }
  function hideReview() { $q('#vReviewBox').classList.add('hidden') }
  function sendReview() { const text = $q('#vReviewText').value.trim(); hideReview(); if (!text) return setState('listening'); turn = { ctrl: new AbortController(), queue: [], text: '', cursor: 0, buf: '', final: false, first: true, playing: false, src: null }; ask(text, turn); $q('#vMain').focus() }
  // Toca o áudio exatamente como foi enviado para a transcrição: mostra se o problema é o microfone/corte ou o modelo.
  function replay() { if (!ctx || !lastCapture) return; const b = ctx.createBuffer(1, lastCapture.length, 16000); b.copyToChannel(lastCapture, 0); const s = ctx.createBufferSource(); s.buffer = b; s.connect(ctx.destination); s.start(); deafUntil = performance.now() + b.duration * 1000 + 400; resetVad() }
  let paintQueued = false;
  function paintAnswer() {
    if (paintQueued) return; paintQueued = true;
    requestAnimationFrame(() => { paintQueued = false; const box = $q('#vAnswer'), text = (turn && !turn.quiet ? turn.text : box.dataset.text) || ''; box.innerHTML = text ? `<div class="markdown-body">${renderMarkdown(text)}</div>` : ''; box.scrollTop = box.scrollHeight });
  }

  // ---------- Abrir / fechar ----------
  async function open() {
    if (typeof conversation === 'undefined' || !conversation) return toast('Abra uma conversa primeiro');
    build(); paintPrefs(); used = false; muted = false; turn = null; lastCapture = null; hideReview(); showUser(''); $q('#vAnswer').innerHTML = ''; delete $q('#vAnswer').dataset.text;
    // Documentos focados no chat valem também na voz: o topo avisa em quais a pergunta vai buscar.
    const focused = typeof focus !== 'undefined' ? focus.size : 0;
    $q('#vBook').textContent = (document.getElementById('bookTitle')?.textContent || '') + (focused ? ` · só ${focused} documento${focused === 1 ? '' : 's'} focado${focused === 1 ? '' : 's'}` : '');
    $q('#vMute').setAttribute('aria-pressed', 'false');
    root.classList.remove('hidden'); document.body.style.overflow = 'hidden'; $q('#vMain').focus();
    const my = ++session; progress = 0; setState('boot', 'Preparando microfone e modelos de voz…');
    lastT = performance.now(); cancelAnimationFrame(raf); raf = requestAnimationFrame(draw);
    try {
      if (!window.isSecureContext || !navigator.mediaDevices?.getUserMedia) throw Error('O navegador só libera o microfone em HTTPS ou em http://localhost. Acesse o Bento por um desses endereços.');
      ctx = new AudioContext({ latencyHint: 'interactive' });
      const micReq = getMic().catch(e => { throw Error(e?.name === 'NotAllowedError' ? 'Permissão do microfone negada. Libere o microfone para este site no ícone de cadeado da barra de endereço.' : e?.name === 'NotFoundError' ? 'Nenhum microfone encontrado.' : `Microfone indisponível: ${e?.message || e}`) });
      const [, s] = await Promise.all([ensureModels(my), micReq]);
      if (my !== session) return s.getTracks().forEach(t => t.stop());
      stream = s; await setupAudio();
      if (my !== session) return;
      $q('#vEngine').textContent = ensureModels.engine || 'modelos locais';
      noise = 0.004; resetVad();
      if (prefs.greet) { setState('speaking'); speakLines(GREETINGS[Math.floor(Math.random() * GREETINGS.length)]) }
      else { earcon('ready'); setState('listening') }
    } catch (e) { if (my === session) fail(e) }
  }
  function close() {
    if (!root || root.classList.contains('hidden')) return;
    session++; interrupt(true); cancelAnimationFrame(raf);
    try { stream?.getTracks().forEach(t => t.stop()) } catch {}
    try { capture?.port && (capture.port.onmessage = null) } catch {}
    try { ctx?.close() } catch {}
    hideReview(); stream = ctx = capture = micSrc = micAn = outAn = fxIn = null; fxNodes = []; state = 'off';
    root.classList.add('hidden'); document.body.style.overflow = ''; $q('#vSettings').classList.add('hidden');
    // As perguntas e respostas faladas foram salvas na conversa: atualiza o chat ao sair.
    if (used) { loadMessages().catch(() => {}); loadChats().catch(() => {}) }
    document.getElementById('voiceMode')?.focus();
  }
  function fail(e) { interrupt(true); setState('error', e?.message || String(e)); earcon('error') }

  // Baixa (1ª vez) e carrega os modelos no servidor; mostra o progresso no anel do HUD.
  async function ensureModels(my) {
    for (;;) {
      const r = await fetch('/api/voice/prepare', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ voice: prefs.voice, voiceEn: prefs.voiceEn }) });
      if (r.status === 401) { location.replace('/login.html'); throw Error('Sessão expirada.') }
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw Error(j.error || `Erro ${r.status} ao preparar a voz.`);
      if (my !== session) return;
      if (j.status === 'ready') break;
      if (j.status === 'error') throw Error(`Não foi possível preparar a voz: ${j.error}`);
      progress = j.total ? j.done / j.total : 0;
      if (state === 'boot' || state === 'listening') $q('#vHint').textContent = j.total && j.done < j.total ? `${j.stage} ${Math.round(progress * 100)}% · ${(j.done / 1048576).toFixed(0)} de ${(j.total / 1048576).toFixed(0)} MB (só na primeira vez)` : (j.stage || 'Carregando modelos de voz…');
      await new Promise(res => setTimeout(res, 600));
    }
    progress = 1;
    fetch('/api/voice/status').then(r => r.json()).then(s => {
      ensureModels.engine = `transcrição ${s.stt.label}, voz Piper`;
      const opts = lang => s.voices.filter(v => v.lang === lang).map(v => `<option value="${v.key}">${v.label}${v.ready ? '' : ` (baixa ${v.mb} MB)`}</option>`).join('');
      $q('#vVoice').innerHTML = opts('pt'); $q('#vVoiceEn').innerHTML = opts('en'); paintPrefs();
      if (root && !root.classList.contains('hidden')) $q('#vEngine').textContent = ensureModels.engine;
    }).catch(() => {});
  }
  // Troca de voz: baixa/carrega a nova voz em segundo plano.
  function warmVoices() { if (!ctx) return; ensureModels(session).then(() => { if (state === 'listening') speakLines('Voz alterada.') }).catch(fail) }

  // ---------- Áudio: microfone, efeitos e sons de interface ----------
  const WORKLET = `class C extends AudioWorkletProcessor{constructor(){super();this.b=new Float32Array(1024);this.n=0}process(i){const c=i[0]&&i[0][0];if(c)for(let k=0;k<c.length;k++){this.b[this.n++]=c[k];if(this.n===1024){this.port.postMessage(this.b.slice(0));this.n=0}}return true}}registerProcessor('bento-capture',C)`;
  // Eco cancelado sempre (a resposta sai pelo alto-falante); ganho automático ligado (volume baixo foi o pior caso nos testes);
  // filtro de ruído opcional: limpa o fundo, mas às vezes come finais de palavra.
  const getMic = () => navigator.mediaDevices.getUserMedia({ audio: { echoCancellation: true, noiseSuppression: !!prefs.filter, autoGainControl: true, channelCount: 1 } });
  async function restartMic() {
    if (!ctx || !stream) return;
    try {
      const s = await getMic(); stream.getTracks().forEach(t => t.stop()); stream = s;
      micSrc?.disconnect(); micSrc = ctx.createMediaStreamSource(stream); micSrc.connect(micAn); micSrc.connect(capture);
      if (muted) stream.getAudioTracks().forEach(t => t.enabled = false);
      resetVad(); toast(prefs.filter ? 'Filtro de ruído ligado' : 'Filtro de ruído desligado');
    } catch (e) { fail(e) }
  }
  async function setupAudio() {
    if (ctx.state === 'suspended') await ctx.resume();
    const src = micSrc = ctx.createMediaStreamSource(stream);
    micAn = ctx.createAnalyser(); micAn.fftSize = 256; micAn.smoothingTimeConstant = 0.6; src.connect(micAn);
    const url = URL.createObjectURL(new Blob([WORKLET], { type: 'text/javascript' }));
    try { await ctx.audioWorklet.addModule(url) } finally { URL.revokeObjectURL(url) }
    capture = new AudioWorkletNode(ctx, 'bento-capture'); sink = ctx.createGain(); sink.gain.value = 0;
    src.connect(capture); capture.connect(sink); sink.connect(ctx.destination); // o worklet só processa se estiver ligado ao destino
    capture.port.onmessage = e => onFrame(e.data);
    outAn = ctx.createAnalyser(); outAn.fftSize = 256; outAn.smoothingTimeConstant = 0.55; outAn.connect(ctx.destination);
    fxIn = ctx.createGain(); applyFx();
  }
  // Cadeia "Jarvis": equalização de presença, compressão, leve dobra modulada (brilho metálico) e reverberação curta.
  function applyFx() {
    if (!ctx || !fxIn) return;
    fxIn.disconnect(); fxNodes.forEach(n => { try { n.stop?.(); n.disconnect() } catch {} }); fxNodes = [];
    const node = n => (fxNodes.push(n), n), bq = (type, f, gain = 0, Q = 0.8) => { const b = node(ctx.createBiquadFilter()); b.type = type; b.frequency.value = f; b.gain.value = gain; b.Q.value = Q; return b };
    const fx = prefs.fx, hp = bq('highpass', 85), low = bq('lowshelf', 200, fx === 'natural' ? 1 : 3), pres = bq('peaking', 3200, fx === 'natural' ? 1.5 : 3), air = bq('highshelf', 9000, fx === 'jarvis' ? 3 : 1.5);
    const comp = node(ctx.createDynamicsCompressor()); comp.threshold.value = -22; comp.knee.value = 10; comp.ratio.value = 3.2; comp.attack.value = 0.004; comp.release.value = 0.18;
    const out = node(ctx.createGain()); out.gain.value = 0.95;
    fxIn.connect(hp); hp.connect(low); low.connect(pres); pres.connect(air); air.connect(comp); comp.connect(out); out.connect(outAn);
    if (fx !== 'natural') {
      const sec = fx === 'jarvis' ? 1.1 : 0.6, len = Math.floor(ctx.sampleRate * sec), ir = ctx.createBuffer(2, len, ctx.sampleRate);
      for (let c = 0; c < 2; c++) { const d = ir.getChannelData(c); for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, fx === 'jarvis' ? 3.2 : 4) * (i < ctx.sampleRate * 0.012 ? 0.2 : 1) }
      const conv = node(ctx.createConvolver()), wet = node(ctx.createGain()); conv.buffer = ir; wet.gain.value = fx === 'jarvis' ? 0.2 : 0.12; comp.connect(conv); conv.connect(wet); wet.connect(out);
    }
    if (fx === 'jarvis') {
      // Duas "dobras" com atraso modulado em direções opostas: dá o timbre sintético sem perder inteligibilidade.
      for (const [delay, rate, panTo] of [[0.011, 0.23, -0.6], [0.017, 0.31, 0.6]]) {
        const d = node(ctx.createDelay(0.05)), gn = node(ctx.createGain()), lfo = node(ctx.createOscillator()), depth = node(ctx.createGain()), pan = node(ctx.createStereoPanner());
        d.delayTime.value = delay; lfo.frequency.value = rate; depth.gain.value = 0.0022; gn.gain.value = 0.22; pan.pan.value = panTo;
        lfo.connect(depth); depth.connect(d.delayTime); lfo.start(); comp.connect(d); d.connect(gn); gn.connect(pan); pan.connect(out);
      }
    }
  }
  function earcon(kind) {
    if (!ctx) return;
    const t = ctx.currentTime, notes = { ready: [[660, 0], [990, 0.09]], send: [[880, 0], [1320, 0.05]], error: [[330, 0], [247, 0.12]] }[kind] || [];
    for (const [f, at] of notes) {
      const o = ctx.createOscillator(), gn = ctx.createGain(); o.type = 'sine'; o.frequency.value = f;
      gn.gain.setValueAtTime(0, t + at); gn.gain.linearRampToValueAtTime(0.05, t + at + 0.012); gn.gain.exponentialRampToValueAtTime(0.0001, t + at + 0.16);
      o.connect(gn); gn.connect(ctx.destination); o.start(t + at); o.stop(t + at + 0.2);
    }
  }

  // ---------- Detecção de fala ----------
  function resetVad() { inSpeech = false; loud = 0; frames = []; pre = []; preMs = 0; speechMs = 0; silentMs = 0; bargeMs = 0 }
  function onFrame(f) {
    if (!ctx || muted || performance.now() < deafUntil) return;
    let sum = 0; for (let i = 0; i < f.length; i++) sum += f[i] * f[i];
    const rms = Math.sqrt(sum / f.length), ms = f.length / ctx.sampleRate * 1000;
    // 0,6 s de pré-gravação: cortar o início da fala foi o que mais aumentou erros nos testes (de 17% para 28%).
    pre.push(f); preMs += ms; while (preMs > 600 && pre.length > 1) { preMs -= pre.shift().length / ctx.sampleRate * 1000 }
    if (state === 'listening' || state === 'hearing') vad(f, rms, ms);
    else if (prefs.bargeIn && (state === 'speaking' || state === 'thinking')) {
      // Interromper falando: limiar bem mais alto para não confundir o eco da própria voz com o usuário.
      if (rms > Math.max(noise * 8, 0.06)) { bargeMs += ms; if (bargeMs > 220) { interrupt(); startSpeech(bargeMs) } } else bargeMs = Math.max(0, bargeMs - ms);
    }
  }
  function startSpeech(already) { inSpeech = true; frames = pre.slice(); speechMs = already; silentMs = 0; setState('hearing') }
  function vad(f, rms, ms) {
    if (!inSpeech) {
      if (rms < Math.max(noise * 2, 0.006)) noise = Math.min(0.03, Math.max(0.0015, noise * 0.96 + rms * 0.04));
      if (rms > Math.max(noise * 3.5, 0.014)) { loud += ms; if (loud >= 90) startSpeech(loud) } else loud = Math.max(0, loud - ms * 0.5);
      return;
    }
    frames.push(f);
    if (rms < Math.max(noise * 2.2, 0.01)) silentMs += ms; else { silentMs = 0; speechMs += ms }
    if (silentMs >= prefs.pause || speechMs + silentMs > 30000) finishSpeech();
  }
  async function finishSpeech() {
    if (!inSpeech) return;
    const sr = ctx.sampleRate, keep = Math.max(0, silentMs - 250), fr = frames, spoke = speechMs; resetVad();
    // Descarta o silêncio final (menos áudio para transcrever) e ruídos curtos (tosse, clique).
    let drop = Math.floor(keep / (1024 / sr * 1000)); const pcmFrames = drop > 0 ? fr.slice(0, Math.max(1, fr.length - drop)) : fr;
    if (spoke < 300) return setState('listening');
    earcon('send'); setState('transcribing', 'Transcrevendo sua fala…');
    const my = session, ctrl = new AbortController(); turn = { ctrl, queue: [], text: '', cursor: 0, buf: '', final: false, first: true, playing: false, src: null, transcribing: true };
    try {
      const nb = typeof notebook !== 'undefined' && notebook ? `?notebook=${encodeURIComponent(notebook)}` : '';
      const r = await fetch(`/api/voice/transcribe${nb}`, { method: 'POST', headers: { 'content-type': 'application/octet-stream' }, body: toPcm16(pcmFrames, sr), signal: ctrl.signal });
      if (r.status === 401) return location.replace('/login.html');
      const j = await r.json().catch(() => ({}));
      if (!r.ok) throw Error(j.error || `Erro ${r.status} na transcrição.`);
      if (my !== session || turn?.ctrl !== ctrl) return;
      const text = String(j.text || '').trim();
      if (!/[\p{L}\p{N}]{2,}/u.test(text)) { turn = null; return setState('listening', 'Não entendi. Pode repetir?') }
      if (prefs.review) { turn = null; return showReview(text) }
      turn.transcribing = false; ask(text, turn);
    } catch (e) { if (!ctrl.signal.aborted && my === session) { turn = null; setState('listening', e.message || String(e)); earcon('error') } }
  }
  // Junta os quadros, reamostra para 16 kHz (média por janela: nos testes, mesma precisão do reamostrador do sherpa),
  // normaliza o volume (fala baixa dobrava os erros) e converte para PCM 16 bits. Guarda o áudio para "ouvir minha fala".
  function toPcm16(fr, rate) {
    const total = fr.reduce((n, f) => n + f.length, 0), all = new Float32Array(total); let o = 0; for (const f of fr) { all.set(f, o); o += f.length }
    const ratio = rate / 16000, n = Math.floor(total / ratio), mono = new Float32Array(n);
    for (let i = 0; i < n; i++) { const a = Math.floor(i * ratio), b = Math.max(a + 1, Math.floor((i + 1) * ratio)); let s = 0; for (let k = a; k < b; k++) s += all[k]; mono[i] = s / (b - a) }
    // Pico robusto (ignora estalos isolados): 99,9º percentil do módulo; ganho até 10x, sem saturar.
    const abs = Float32Array.from(mono, Math.abs).sort(), peak = abs[Math.floor(abs.length * 0.999)] || 0, gain = peak > 1e-4 ? Math.min(10, Math.max(1, 0.5 / peak)) : 1;
    const out = new Int16Array(n);
    for (let i = 0; i < n; i++) { const v = Math.max(-1, Math.min(1, mono[i] * gain)); mono[i] = v; out[i] = Math.round(v * 32767) }
    lastCapture = mono;
    return out.buffer;
  }

  // ---------- Pergunta e resposta falada ----------
  // Trechos achados pela busca e quantos foram usados depois do ranqueamento.
  const retrievalHint = ev => { const s = ev.stats, pl = n => n === 1 ? '' : 's'; return s ? `${s.found} trecho${pl(s.found)} encontrado${pl(s.found)} · ${s.used} usado${pl(s.used)} após o ranqueamento…` : `Lendo ${ev.sources.length} trecho${pl(ev.sources.length)}…` };
  async function ask(content, t) {
    setState('thinking'); showUser(content); $q('#vAnswer').innerHTML = '';
    try {
      const res = await fetch(`/api/conversations/${conversation}/messages?stream=1`, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ content, detailed: typeof detailMode !== 'undefined' && detailMode, creative: typeof creativeMode !== 'undefined' && creativeMode, conversational: typeof chatMode !== 'undefined' && chatMode, documentIds: typeof focus !== 'undefined' && focus.size ? [...focus] : undefined }), signal: t.ctrl.signal });
      if (res.status === 401) return location.replace('/login.html');
      if (!res.ok) { const d = await res.json().catch(() => ({})); throw Error(d.error || `Erro ${res.status}`) }
      used = true;
      const reader = res.body.getReader(), dec = new TextDecoder(); let buf = '';
      const handle = line => {
        if (!line.trim()) return; const ev = JSON.parse(line);
        if (ev.type === 'token') { t.text += ev.token; paintAnswer(); feed(t) }
        else if (ev.type === 'sources' && !t.text && state === 'thinking') $q('#vHint').textContent = retrievalHint(ev);
        else if (ev.type === 'done') { if (!t.text) t.text = ev.assistant?.content || ''; t.done = true }
        else if (ev.type === 'error') throw Error(ev.error);
      };
      for (;;) { const { done, value } = await reader.read(); if (done) break; buf += dec.decode(value, { stream: true }); const parts = buf.split('\n'); buf = parts.pop(); parts.forEach(handle) }
      handle(buf);
      if (!t.done) throw Error('A resposta foi interrompida.');
      t.final = true; paintAnswer(); feed(t);
      if (!t.playing && !t.queue.length) endTurn(t);
    } catch (e) {
      if (t.ctrl.signal.aborted || turn !== t) return;
      turn = null; $q('#vAnswer').dataset.text = `**Não foi possível obter uma resposta:** ${e.message || e}`; paintAnswer(); setState('listening', 'Tente novamente.'); earcon('error');
    }
  }
  // Fala uma frase fixa (saudação, avisos) pelo mesmo caminho das respostas.
  function speakLines(text) { const t = turn = { ctrl: new AbortController(), queue: [], text, cursor: 0, buf: '', final: true, first: true, playing: false, src: null, quiet: true }; feed(t); if (!t.queue.length) endTurn(t) }
  // Corta o texto que chega em frases completas e as envia para síntese assim que ficam prontas.
  const ABBR = /(?:^|[\s(])(?:sr|sra|srta|dr|dra|prof|profa|ex|av|art|aprox|obs|pág|p|vs|n|nº|etc|cia|ltda|[a-z])$/i;
  function feed(t) {
    const s = t.text.slice(t.cursor), segs = []; let start = 0;
    const cut = (end, next) => { const seg = s.slice(start, end).trim(); if (seg) segs.push(seg); start = next };
    for (let i = 0; i < s.length; i++) {
      const c = s[i];
      if (c === '\n') { cut(i, i + 1); continue }
      const ws = i + 1 < s.length && /\s/.test(s[i + 1]);
      if ('.!?…;:'.includes(c) && ws) { const before = s.slice(start, i); if (c === '.' && (ABBR.test(before) || /^\s*\d{1,2}$/.test(before))) continue; cut(i + 1, i + 1) }
      else if (ws && i - start > 170 && c === ',') cut(i + 1, i + 1); // frase longa sem ponto: corta na vírgula para não atrasar a voz
    }
    if (t.final) cut(s.length, s.length);
    t.cursor += start;
    for (const seg of segs) {
      t.buf += (t.buf ? ' ' : '') + seg;
      // A 1ª frase sai sozinha (voz começa logo); as seguintes são agrupadas para uma entonação mais natural.
      if (t.first || t.buf.length >= 60) { enqueue(t, t.buf); t.buf = ''; t.first = false }
    }
    if (t.final && t.buf) { enqueue(t, t.buf); t.buf = '' }
  }
  function enqueue(t, text) {
    const audio = fetch('/api/voice/speak', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: t.ctrl.signal,
      body: JSON.stringify({ text, voice: prefs.voice, voiceEn: prefs.voiceEn, speed: prefs.speed, context: t.text.slice(0, 400) }) })
      .then(r => r.status === 204 ? null : r.ok ? r.arrayBuffer().then(b => ctx.decodeAudioData(b)) : r.json().then(j => { throw Error(j.error || `Erro ${r.status}`) }))
      .catch(e => { if (!t.ctrl.signal.aborted) { console.warn('Voz:', e); if (!t.warned) { t.warned = true; $q('#vHint').textContent = `Falha na síntese de voz: ${e.message || e}` } } return null });
    t.queue.push({ text, audio });
    if (!t.playing) playNext(t);
  }
  async function playNext(t) {
    if (turn !== t) return;
    const item = t.queue.shift();
    if (!item) { t.playing = false; if (t.final) endTurn(t); else if (state === 'speaking') setState('thinking', 'Continuando…'); return }
    t.playing = true;
    const buf = await item.audio;
    if (turn !== t || !ctx) return;
    if (!buf) return playNext(t);
    if (state !== 'speaking') setState('speaking');
    const src = ctx.createBufferSource(); src.buffer = buf; src.connect(fxIn); t.src = src;
    src.onended = () => { if (t.src === src) t.src = null; playNext(t) };
    src.start();
  }
  function endTurn(t) {
    if (turn !== t) return; turn = null;
    if (!t.quiet) $q('#vAnswer').dataset.text = t.text;
    // Pequena espera antes de ouvir de novo: evita captar o fim da própria voz (eco/reverberação).
    setTimeout(() => { if (turn || !ctx || state === 'off' || state === 'error') return; resetVad(); if (muted) setState('muted'); else { setState('listening'); earcon('ready') } }, 350);
  }
  function interrupt(silent) {
    const t = turn; turn = null;
    if (t) { if (!t.quiet) $q('#vAnswer').dataset.text = t.text; try { t.ctrl.abort() } catch {} try { t.src?.stop() } catch {} }
    resetVad();
    if (!silent && ctx) setState(muted ? 'muted' : 'listening', t && !t.final && !t.quiet && !t.transcribing ? 'Interrompido. A pergunta ficou na conversa, sem resposta salva.' : undefined);
  }
  function mainAction() {
    if (state === 'review') sendReview();
    else if (state === 'hearing') finishSpeech();
    else if (state === 'transcribing' || state === 'thinking' || state === 'speaking') interrupt();
    else if (state === 'muted') toggleMute();
    else if (state === 'error') { close(); open() }
  }
  function toggleMute() {
    if (!ctx || state === 'boot' || state === 'error') return;
    muted = !muted; resetVad();
    const b = $q('#vMute'); b.setAttribute('aria-pressed', String(muted)); b.innerHTML = `<i data-lucide="${muted ? 'mic-off' : 'mic'}" class="h-5 w-5"></i>`; icons();
    try { stream?.getAudioTracks().forEach(tr => tr.enabled = !muted) } catch {}
    if (state === 'listening' || state === 'hearing' || state === 'muted') setState(muted ? 'muted' : 'listening');
  }

  // ---------- HUD (reator) ----------
  const bins = new Uint8Array(128), bars = new Float32Array(72);
  function draw(now) {
    raf = requestAnimationFrame(draw);
    const dt = Math.min(0.05, (now - lastT) / 1000); lastT = now;
    const dpr = Math.min(2, devicePixelRatio || 1), w = canvas.clientWidth, h = canvas.clientHeight;
    if (!w || !h) return;
    if (canvas.width !== Math.round(w * dpr) || canvas.height !== Math.round(h * dpr)) { canvas.width = Math.round(w * dpr); canvas.height = Math.round(h * dpr) }
    g.setTransform(dpr, 0, 0, dpr, 0, 0); g.clearRect(0, 0, w, h);
    const cx = w / 2, cy = h / 2, R = Math.max(48, Math.min(Math.min(w, h) * 0.3, 200));
    const an = state === 'speaking' ? outAn : (state === 'listening' || state === 'hearing') ? micAn : null;
    let lvl = 0;
    if (an) { an.getByteFrequencyData(bins); for (let i = 2; i < 40; i++) lvl += bins[i]; lvl = Math.min(1, lvl / 38 / 150) }
    levelSm += (lvl - levelSm) * (lvl > levelSm ? 0.35 : 0.08);
    const busy = state === 'thinking' || state === 'transcribing' || state === 'boot';
    rot += dt * (reduced ? 0.05 : busy ? 1.5 : 0.22);
    const rgb = state === 'error' ? '220,88,42' : state === 'muted' ? '147,149,152' : busy ? '120,215,255' : '21,190,240', col = a => `rgba(${rgb},${a})`;
    g.lineCap = 'round';
    // anel externo graduado
    g.save(); g.translate(cx, cy); g.rotate(-rot * 0.3);
    for (let i = 0; i < 90; i++) { const a = i / 90 * Math.PI * 2, long = i % 6 === 0, r1 = R * 1.3, r2 = r1 + (long ? 10 : 4); g.strokeStyle = col(long ? 0.5 : 0.22); g.lineWidth = long ? 1.6 : 1; g.beginPath(); g.moveTo(Math.cos(a) * r1, Math.sin(a) * r1); g.lineTo(Math.cos(a) * r2, Math.sin(a) * r2); g.stroke() }
    g.restore();
    // arcos segmentados (giram mais rápido enquanto pensa) e progresso do download
    g.save(); g.translate(cx, cy); g.shadowBlur = 16; g.shadowColor = col(0.8);
    g.rotate(rot); g.strokeStyle = col(0.85); g.lineWidth = 3;
    for (const [a, b] of [[0, 1.05], [1.6, 2.5], [3.3, 4.9], [5.3, 5.8]]) { g.beginPath(); g.arc(0, 0, R * 1.12, a, b); g.stroke() }
    g.rotate(-rot * 2.3); g.strokeStyle = col(0.45); g.lineWidth = 1.5; g.setLineDash([2, 7]); g.beginPath(); g.arc(0, 0, R * 1.0, 0, Math.PI * 2); g.stroke(); g.setLineDash([]);
    g.restore();
    if (state === 'boot' && progress > 0 && progress < 1) { g.save(); g.strokeStyle = '#fff'; g.lineWidth = 3; g.shadowBlur = 12; g.shadowColor = col(1); g.beginPath(); g.arc(cx, cy, R * 1.22, -Math.PI / 2, -Math.PI / 2 + progress * Math.PI * 2); g.stroke(); g.restore() }
    // barras de áudio ao redor do núcleo (voz do usuário ou da IA)
    for (let i = 0; i < bars.length; i++) {
      const k = i < bars.length / 2 ? i : bars.length - 1 - i, v = an ? bins[2 + Math.floor(k * 1.1)] / 255 : busy ? 0.18 + 0.15 * Math.sin(now / 160 + i * 0.5) : 0.05;
      bars[i] += (v - bars[i]) * 0.3;
    }
    g.save(); g.translate(cx, cy); g.rotate(rot * 0.15);
    for (let i = 0; i < bars.length; i++) { const a = i / bars.length * Math.PI * 2, r1 = R * 0.66, r2 = r1 + 3 + bars[i] * R * 0.3; g.strokeStyle = col(0.35 + bars[i] * 0.65); g.lineWidth = 2.2; g.beginPath(); g.moveTo(Math.cos(a) * r1, Math.sin(a) * r1); g.lineTo(Math.cos(a) * r2, Math.sin(a) * r2); g.stroke() }
    g.restore();
    // núcleo pulsante
    const pulse = state === 'off' ? 0 : busy ? 0.06 * Math.sin(now / 260) : levelSm * 0.32, cr = R * 0.44 * (1 + pulse);
    const grd = g.createRadialGradient(cx, cy, 0, cx, cy, cr * 1.6);
    grd.addColorStop(0, `rgba(255,255,255,${0.85 + levelSm * 0.15})`); grd.addColorStop(0.28, col(0.9)); grd.addColorStop(0.62, col(0.25)); grd.addColorStop(1, col(0));
    g.fillStyle = grd; g.beginPath(); g.arc(cx, cy, cr * 1.6, 0, Math.PI * 2); g.fill();
    g.strokeStyle = col(0.9); g.lineWidth = 2; g.beginPath(); g.arc(cx, cy, cr, 0, Math.PI * 2); g.stroke();
    // triângulo interno girando (detalhe do reator)
    g.save(); g.translate(cx, cy); g.rotate(-rot * 0.8); g.strokeStyle = 'rgba(255,255,255,.55)'; g.lineWidth = 1.5; g.beginPath();
    for (let i = 0; i < 3; i++) { const a = i / 3 * Math.PI * 2 - Math.PI / 2; g.lineTo(Math.cos(a) * cr * 0.55, Math.sin(a) * cr * 0.55) } g.closePath(); g.stroke(); g.restore();
  }

  // Botão no campo do chat; também abre com Ctrl+Shift+Espaço.
  document.getElementById('voiceMode')?.addEventListener('click', open);
  document.addEventListener('keydown', e => { if (e.code === 'Space' && e.ctrlKey && e.shiftKey && !document.getElementById('workspace')?.classList.contains('hidden')) { e.preventDefault(); open() } });
  window.addEventListener('beforeunload', () => { if (state !== 'off') close() });
})();
