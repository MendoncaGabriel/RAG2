// Tela de Configurações de IA: configuração automática, cadastro de servidores Ollama para chat e embeddings, escolha da IA em uso e ajustes de contexto/desempenho (automático ou manual). Depende de $, api, esc, showError e confirmModal (app.js).
// O sistema só usa Ollama: não há escolha de tipo de provedor.
const SLOTS = {
  chat: { field: 'chatModel', other: 'embeddingModel', list: '#listChat', select: '#activeChat', saved: '#savedChat', noun: 'IA de chat', badge: 'bg-jabil text-white', lead: 'É a IA que lê os trechos encontrados e escreve as respostas.', models: 'chat', pull: 'qwen3:1.7b' },
  embedding: { field: 'embeddingModel', other: 'chatModel', list: '#listEmbedding', select: '#activeEmbedding', saved: '#savedEmbedding', noun: 'embeddings', badge: 'bg-ok text-white', lead: 'É o modelo que transforma textos em vetores para achar os trechos certos nos documentos. Não conversa.', models: 'embedding', pull: 'bge-m3' },
};
let state = { providers: [], active: { chat: null, embedding: null } }, editingId = null, editingSlot = 'chat', wasWorkspace = false;
const testResults = {};

const status = (slot, text) => { const el = $(slot === 'tune' ? '#savedTuning' : SLOTS[slot].saved); el.textContent = text; if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 2500); };

async function refreshAiStatus() {
  const el = $('#aiStatus'), text = $('#aiStatusText');
  try {
    const s = await api('/api/ai/status');
    if (s.chat && s.embedding) { text.textContent = `IA: ${s.chat.model}`; el.dataset.state = 'ok'; el.title = `Chat: ${s.chat.name} (${s.chat.model})\nEmbeddings: ${s.embedding.name} (${s.embedding.model})`; }
    else { text.textContent = s.chat || s.embedding ? `Falta escolher ${s.chat ? 'embeddings' : 'chat'}` : 'Configurar IA'; el.dataset.state = 'warn'; el.title = 'Abrir configurações de IA'; }
  } catch (e) { text.textContent = 'IA indisponível'; el.dataset.state = 'error'; el.title = e.message; }
  // No celular o texto fica oculto: o rótulo acessível carrega o estado (a cor do ponto indica ok/atenção/erro).
  el.setAttribute('aria-label', `Configurações de IA: ${text.textContent}`);
}

function renderActive() {
  for (const [slot, c] of Object.entries(SLOTS)) {
    const select = $(c.select);
    select.innerHTML = '<option value="">— nenhum selecionado —</option>' + state.providers.filter(p => p[c.field]).map(p => `<option value="${p.id}">${esc(p.name)} · ${esc(p[c.field])}</option>`).join('');
    select.value = state.active[slot] || '';
  }
}

function renderProviders() {
  for (const [slot, c] of Object.entries(SLOTS)) {
    const host = $(c.list), items = state.providers.filter(p => p[c.field]);
    if (!items.length) {
      host.innerHTML = `<div class="rounded-xl border-2 border-dashed border-line bg-canvas p-5 text-center"><p class="font-medium text-heading">Nenhuma ${slot === 'chat' ? 'IA de chat' : 'IA de embeddings'} cadastrada</p><p class="mt-1 text-sm text-ink-muted">O jeito mais rápido é a configuração automática; ou adicione à mão.</p><div class="mt-4 flex flex-wrap justify-center gap-2"><button data-autoconfig="1" class="btn btn-primary rounded-full">Configurar automaticamente</button><button data-add="${slot}" class="btn btn-secondary rounded-full">Adicionar manualmente</button></div></div>`;
      continue;
    }
    host.innerHTML = items.map(p => {
      const inUse = state.active[slot] === p.id, t = testResults[p.id], r = t && t !== 'loading' ? t[slot] : null;
      return `<article class="rounded-xl border ${inUse ? 'border-jabil-light ring-1 ring-jabil-light' : 'border-line'} bg-surface p-4">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0"><div class="flex flex-wrap items-center gap-2"><h4 class="break-words font-semibold text-heading">${esc(p[c.field])}</h4>${inUse ? `<span class="rounded-full ${c.badge} px-2 py-0.5 text-xs">Em uso</span>` : ''}</div>
        <p class="mt-1 break-all font-mono text-xs text-ink-muted">${esc(p.name)} · ${esc(p.baseUrl)}${p.hasKey ? ' · chave ' + esc(p.keyHint) : ''}</p></div>
        <div class="flex shrink-0 flex-wrap gap-1">${inUse ? '' : `<button data-use="${p.id}" data-slot="${slot}" class="btn btn-primary btn-sm">Usar</button>`}<button data-test="${p.id}" class="btn btn-ghost btn-sm">Testar</button><button data-edit="${p.id}" data-slot="${slot}" class="btn btn-ghost btn-sm">Editar</button><button data-delete="${p.id}" class="btn btn-ghost btn-sm hover:text-danger-ink">Excluir</button></div>
      </div>
      ${t === 'loading' ? '<p class="mt-3 text-xs text-ink-muted">Testando…</p>' : r ? `<p class="mt-3 break-words text-xs ${r.ok ? 'text-ok-ink' : 'text-danger-ink'}">${r.ok ? '✓' : '✗'} ${esc(r.detail)}</p>` : ''}
    </article>`;
    }).join('');
  }
}

async function loadSettings() {
  state = await api('/api/ai/providers');
  renderActive(); renderProviders();
  loadTuning();
}

async function openSettings() {
  wasWorkspace = !$('#workspace').classList.contains('hidden');
  $('#home').classList.add('hidden'); $('#workspace').classList.add('hidden'); $('#settings').classList.remove('hidden');
  window.scrollTo(0, 0);
  try { await loadSettings(); } catch (e) { showError(e); }
}
function closeSettings() {
  $('#settings').classList.add('hidden');
  $(wasWorkspace ? '#workspace' : '#home').classList.remove('hidden');
  refreshAiStatus();
}
$('#aiStatus').onclick = openSettings;
$('#settingsBack').onclick = closeSettings;

async function saveActive(slot) {
  try {
    state.active = await api('/api/ai/active', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [slot]: $(SLOTS[slot].select).value || null }) });
    renderActive(); renderProviders(); status(slot, 'Salvo ✓'); refreshAiStatus(); if (slot === 'chat') loadTuning();
  } catch (e) { renderActive(); showError(e); }
}
$('#activeChat').onchange = () => saveActive('chat');
$('#activeEmbedding').onchange = () => saveActive('embedding');

// ---------- Diálogo de cadastro/edição ----------
// Passo 1: servidor (detectado sozinho ao abrir; "Atualizar" procura de novo ou lê os modelos do endereço digitado).
// Passo 2: modelo, escolhido entre os instalados no servidor (ou digitado). Nome e chave ficam em "Opções avançadas".
const form = { name: $('#pfName'), baseUrl: $('#pfBaseUrl'), key: $('#pfKey'), clear: $('#pfClear'), model: $('#pfModel') };
let modelNames = [], fetchSeq = 0;
const setError = msg => { const el = $('#pfError'); el.textContent = msg || ''; el.classList.toggle('hidden', !msg); };
const fetchMsg = (text, tone) => { const el = $('#pfFetchMsg'); el.textContent = text; el.className = `mt-2 text-xs ${tone === 'error' ? 'font-medium text-danger-ink' : tone === 'ok' ? 'text-ok-ink' : 'text-ink-muted'}`; };

function renderChips() {
  const current = form.model.value.trim();
  $('#pfChips').innerHTML = modelNames.map(m => `<button type="button" data-model="${esc(m)}" aria-pressed="${m === current}" class="btn btn-sm rounded-full font-mono ${m === current ? 'btn-primary' : 'btn-secondary'}">${esc(m)}</button>`).join('');
}
async function refreshModels() {
  const slot = SLOTS[editingSlot], seq = ++fetchSeq, btn = $('#pfFetch'), typed = form.baseUrl.value.trim();
  btn.disabled = true; fetchMsg(typed ? 'Buscando os modelos instalados…' : 'Procurando o Ollama neste computador…');
  try {
    const info = await api('/api/ai/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providerId: editingId, baseUrl: typed, apiKey: form.key.value.trim() }) });
    if (seq !== fetchSeq) return;
    form.baseUrl.value = info.baseUrl;
    modelNames = info[slot.models];
    if (!form.model.value.trim() && info.suggested[slot.models]) form.model.value = info.suggested[slot.models];
    renderChips();
    if (modelNames.length) fetchMsg(`✓ Ollama encontrado · ${modelNames.length} modelo(s) ${editingSlot === 'chat' ? 'de chat' : 'de embeddings'} instalado(s). Escolha um abaixo.`, 'ok');
    else fetchMsg(`Ollama encontrado, mas sem modelo ${editingSlot === 'chat' ? 'de chat' : 'de embeddings'} instalado. No Windows, execute "ollama pull ${slot.pull}" e clique em Atualizar.`, 'error');
  } catch (e) {
    if (seq !== fetchSeq) return;
    modelNames = []; renderChips();
    fetchMsg(`${e.message} Você ainda pode digitar o endereço (ex.: http://172.29.48.1:11434) e o nome do modelo.`, 'error');
  } finally { if (seq === fetchSeq) btn.disabled = false; }
}
function openProviderDialog(provider, slot) {
  editingId = provider?.id || null; editingSlot = slot; modelNames = [];
  const c = SLOTS[slot];
  setError(''); renderChips();
  $('#providerKicker').textContent = c.noun[0].toUpperCase() + c.noun.slice(1);
  $('#providerTitle').textContent = (provider ? 'Editar ' : 'Adicionar ') + c.noun;
  $('#providerLead').textContent = c.lead;
  $('#pfModelTitle').textContent = slot === 'chat' ? 'Modelo de chat' : 'Modelo de embeddings';
  form.name.value = provider?.name || ''; form.baseUrl.value = provider?.baseUrl || ''; form.model.value = provider?.[c.field] || '';
  form.key.value = ''; form.clear.checked = false; form.key.type = 'password'; $('#pfKeyToggle').textContent = 'Ver';
  form.key.placeholder = provider?.hasKey ? `Mantida (${provider.keyHint}) — deixe vazio para não alterar` : '';
  $('#pfClearRow').classList.toggle('hidden', !provider?.hasKey); $('#pfClearRow').classList.toggle('flex', !!provider?.hasKey);
  document.querySelector('#providerDialog details').open = !!provider?.hasKey;
  $('#providerDialog').showModal();
  form.model.focus();
  refreshModels();
}
$('#pfCancel').onclick = () => $('#providerDialog').close();
$('#providerDialog').addEventListener('click', e => { if (e.target === $('#providerDialog')) $('#providerDialog').close(); });
$('#pfKeyToggle').onclick = () => { const show = form.key.type === 'password'; form.key.type = show ? 'text' : 'password'; $('#pfKeyToggle').textContent = show ? 'Ocultar' : 'Ver'; };
$('#pfFetch').onclick = refreshModels;
form.baseUrl.addEventListener('change', () => { if (form.baseUrl.value.trim()) refreshModels(); });
form.model.addEventListener('input', renderChips);
$('#pfChips').addEventListener('click', e => { const b = e.target.closest('button[data-model]'); if (b) { form.model.value = b.dataset.model; renderChips(); } });

$('#providerForm').onsubmit = async e => {
  e.preventDefault(); setError('');
  const save = $('#pfSave'); save.disabled = true;
  try {
    const c = SLOTS[editingSlot], current = state.providers.find(p => p.id === editingId);
    // O outro modelo do mesmo cadastro (chat x embeddings) é mantido como está.
    const body = { name: form.name.value, baseUrl: form.baseUrl.value, apiKey: form.key.value, clearKey: form.clear.checked, [c.field]: form.model.value, [c.other]: current?.[c.other] || '' };
    const saved = await api(editingId ? `/api/ai/providers/${editingId}` : '/api/ai/providers', { method: editingId ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    delete testResults[saved.id];
    $('#providerDialog').close();
    await loadSettings(); refreshAiStatus();
    // O primeiro cadastro de cada seção já fica em uso, para o sistema funcionar sem passos extras.
    const slot = editingSlot;
    if (!state.active[slot] && saved[c.field]) {
      state.active = await api('/api/ai/active', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ [slot]: saved.id }) });
      renderActive(); renderProviders(); refreshAiStatus(); status(slot, 'Selecionado automaticamente ✓');
    }
  } catch (x) { setError(x.message || String(x)); }
  finally { save.disabled = false; }
};

$('#settings').onclick = async e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  const d = btn.dataset;
  try {
    if (d.add) openProviderDialog(null, d.add);
    else if (d.autoconfig !== undefined) $('#autoConfig').click();
    else if (d.use) { $(SLOTS[d.slot].select).value = d.use; await saveActive(d.slot); }
    else if (d.edit) openProviderDialog(state.providers.find(p => p.id === d.edit), d.slot);
    else if (d.delete) {
      const p = state.providers.find(x => x.id === d.delete);
      const inUse = state.active.chat === p.id || state.active.embedding === p.id;
      const both = p.chatModel && p.embeddingModel;
      const note = (inUse ? 'Está em uso; depois de excluir, escolha outra. ' : '') + (both ? 'Este cadastro tem chat e embeddings: os dois serão removidos. ' : '') + 'A chave de API e a configuração serão removidas.';
      if (await confirmModal(`Excluir "${p.name}"?`, note)) {
        await api(`/api/ai/providers/${p.id}`, { method: 'DELETE' }); delete testResults[p.id];
        await loadSettings(); refreshAiStatus();
      }
    } else if (d.test) {
      const id = d.test; testResults[id] = 'loading'; renderProviders();
      testResults[id] = await api(`/api/ai/providers/${id}/test`, { method: 'POST' }); renderProviders();
    }
  } catch (x) { showError(x); }
};

// ---------- Configuração automática ----------
$('#autoConfig').onclick = async () => {
  const btn = $('#autoConfig'), msg = $('#autoMsg');
  btn.disabled = true; msg.className = 'alert mt-4 text-sm'; msg.textContent = 'Procurando o Ollama…';
  try {
    const r = await api('/api/ai/autoconfigure', { method: 'POST' });
    const used = r.activated.length ? ` Em uso agora: ${r.activated.map(s => SLOTS[s].noun).join(' e ')}.` : ' As IAs que você já usava foram mantidas.';
    msg.className = 'alert alert-ok mt-4 text-sm';
    msg.textContent = `Ollama encontrado em ${r.baseUrl} (${r.models} modelo(s) instalados). Chat: ${r.chatModel || '— nenhum modelo de chat instalado'} · Embeddings: ${r.embeddingModel || '— nenhum modelo de embeddings instalado'}.${used}`;
    await loadSettings(); refreshAiStatus();
  } catch (e) { msg.className = 'alert alert-error mt-4 text-sm'; msg.textContent = e.message; }
  finally { btn.disabled = false; }
};

// ---------- Contexto e desempenho (automático ou manual) ----------
// Número 0 = automático (valor derivado do modelo ativo); > 0 = manual. As threads têm um modo à parte (auto / manual / Ollama decide).
const TUNE = [
  { key: 'contextTokens', label: 'Contexto do modelo', unit: 'tokens', help: 'Janela de memória do modelo (num_ctx): quanto texto cabe em cada pergunta. Maior permite mais trechos e conversas longas, mas usa mais memória no Ollama. Nunca passa do contexto que o modelo suporta.' },
  { key: 'maxTokens', label: 'Tamanho máximo da resposta', unit: 'tokens', help: 'Teto base de tokens da resposta. O modo Rápido usa metade e o Detalhado o dobro.' },
  { key: 'contextChars', label: 'Texto dos documentos no prompt', unit: 'caracteres', help: 'Quanto do texto recuperado entra no prompt (sempre limitado pelo contexto acima).' },
  { key: 'topK', label: 'Trechos por pergunta', unit: 'trechos', help: 'Quantos trechos a busca entrega ao modelo (o reranking ainda pode usar menos).' },
];
let tune = null, tuneDraft = null;
const nf = n => (n == null ? '—' : Number(n).toLocaleString('pt-BR'));
const tuneModeOf = k => (tuneDraft.manual[k] ? 'manual' : 'auto');

function renderTuning() {
  const t = tune, host = $('#tuneRows');
  $('#tuneModel').textContent = t.model ? `Modelo de chat em uso: ${t.model} · perfil ${t.tier} (${t.family}, ${nf(t.sizeB)}B)${t.nativeContext ? ` · contexto nativo ${nf(t.nativeContext)} tokens` : ''}` : 'Nenhuma IA de chat em uso: os valores automáticos aparecem quando você escolher uma.';
  const row = (title, help, mode, options, value, min, max, unit, note) => `<div class="grid gap-3 py-4 sm:grid-cols-[1fr_auto] sm:items-start">
    <div class="min-w-0"><p class="font-medium text-heading">${esc(title)}</p><p class="mt-0.5 text-xs text-ink-muted">${esc(help)}</p><p class="mt-1 text-xs text-ink-muted">${note}</p></div>
    <div class="flex flex-wrap items-center gap-2 sm:justify-end">
      <select data-mode="${mode.key}" class="field w-auto" aria-label="${esc(title)}: modo">${options.map(([v, l]) => `<option value="${v}"${v === mode.value ? ' selected' : ''}>${esc(l)}</option>`).join('')}</select>
      ${mode.value === 'manual' ? `<input data-val="${mode.key}" type="number" inputmode="numeric" min="${min}" max="${max}" step="1" value="${value ?? ''}" class="field w-32" aria-label="${esc(title)}: valor manual"><span class="text-xs text-ink-muted">${esc(unit)}</span>` : ''}
    </div></div>`;
  const lim = t.limits;
  host.innerHTML = TUNE.map(f => row(f.label, f.help, { key: f.key, value: tuneModeOf(f.key) }, [['auto', `Automático (${nf(t.auto[f.key])})`], ['manual', 'Manual']], tuneDraft.values[f.key], lim[f.key][0], lim[f.key][1], f.unit,
    `Automático escolheria <b>${nf(t.auto[f.key])}</b> · em uso agora <b>${nf(t.effective[f.key])}</b> · aceita de ${nf(lim[f.key][0])} a ${nf(lim[f.key][1])}`)).join('')
    + row('Threads de CPU do Ollama', 'Quantos núcleos o Ollama usa para ler o prompt e gerar. O automático mede o seu PC na primeira vez com cada modelo (leva de 20 s a 2 min).', { key: 'threads', value: tuneDraft.threadMode },
      [['auto', 'Automático (medido neste PC)'], ['manual', 'Manual'], ['ollama', 'Deixar o Ollama decidir']], tuneDraft.threads, lim.threads[0], lim.threads[1], 'threads',
      t.threads.measured ? `Medido neste PC: <b>${t.threads.measured.value ? nf(t.threads.measured.value) + ' threads' : 'o Ollama decide (modelo na GPU)'}</b> (${esc(t.threads.measured.device)}) · em uso agora <b>${t.threads.effective ? nf(t.threads.effective) : 'padrão do Ollama'}</b>` : 'Ainda não medido para o modelo atual · em uso agora: padrão do Ollama');
}

async function loadTuning() {
  try {
    tune = await api('/api/ai/tuning');
    const s = tune.settings;
    tuneDraft = { manual: {}, values: {}, threadMode: s.threadMode, threads: s.threads || 0 };
    for (const f of TUNE) { tuneDraft.manual[f.key] = s[f.key] > 0; tuneDraft.values[f.key] = s[f.key] > 0 ? s[f.key] : tune.auto[f.key]; }
    if (!tuneDraft.threads) tuneDraft.threads = tune.threads.measured?.value || tune.threads.effective || 4;
    renderTuning(); $('#tuneError').classList.add('hidden');
  } catch (e) { $('#tuneRows').innerHTML = `<p class="py-3 text-sm text-danger-ink">${esc(e.message)}</p>`; }
}
$('#tuneRows').addEventListener('change', e => {
  const key = e.target.dataset.mode;
  if (!key || !tune) return;
  if (key === 'threads') tuneDraft.threadMode = e.target.value;
  else tuneDraft.manual[key] = e.target.value === 'manual';
  renderTuning();
});
$('#tuneRows').addEventListener('input', e => {
  const key = e.target.dataset.val;
  if (!key) return;
  if (key === 'threads') tuneDraft.threads = Number(e.target.value); else tuneDraft.values[key] = Number(e.target.value);
});
async function saveTuning(body) {
  const err = $('#tuneError'), btn = $('#tuneSave');
  err.classList.add('hidden'); btn.disabled = true;
  try {
    await api('/api/ai/tuning', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    await loadTuning(); status('tune', 'Salvo ✓');
  } catch (x) { err.textContent = x.message || String(x); err.classList.remove('hidden'); }
  finally { btn.disabled = false; }
}
$('#tuneSave').onclick = () => {
  if (!tuneDraft) return;
  const body = { threadMode: tuneDraft.threadMode, threads: tuneDraft.threadMode === 'manual' ? tuneDraft.threads : 0 };
  for (const f of TUNE) body[f.key] = tuneDraft.manual[f.key] ? tuneDraft.values[f.key] : 0;
  saveTuning(body);
};
$('#tuneReset').onclick = () => saveTuning({ contextTokens: 0, maxTokens: 0, contextChars: 0, topK: 0, threads: 0, threadMode: 'auto' });

lucide.createIcons();
refreshAiStatus();
