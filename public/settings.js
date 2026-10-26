// Tela de Configurações de IA: cadastro separado de IA de chat e de embeddings, e escolha da IA em uso. Depende de $, api, esc, showError e confirmModal (app.js).
const PRESETS = [
  { label: 'Ollama (local)', name: 'Ollama', kind: 'ollama', baseUrl: 'http://localhost:11434', chatModel: 'qwen2.5:1.5b-instruct', embeddingModel: 'bge-m3' },
  { label: 'OpenAI', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', chatModel: 'gpt-4o-mini', embeddingModel: 'text-embedding-3-small' },
  { label: 'Google Gemini', name: 'Gemini', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', chatModel: 'gemini-2.5-flash', embeddingModel: 'gemini-embedding-001' },
  { label: 'Anthropic (Claude)', name: 'Claude', kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', chatModel: 'claude-haiku-5-5', embeddingModel: '' },
  { label: 'Groq', name: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', chatModel: 'llama-3.3-70b-versatile', embeddingModel: '' },
  { label: 'OpenRouter', name: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', chatModel: 'openai/gpt-4o-mini', embeddingModel: '' },
  { label: 'LM Studio (local)', name: 'LM Studio', kind: 'openai', baseUrl: 'http://localhost:1234/v1', chatModel: '', embeddingModel: '', any: true },
  { label: 'Outro (API compatível com OpenAI)', name: '', kind: 'openai', baseUrl: '', chatModel: '', embeddingModel: '', any: true },
];
const KIND_HINTS = {
  ollama: 'IA rodando na sua máquina ou servidor. Normalmente não precisa de chave.',
  openai: 'Serve para OpenAI e qualquer API com /chat/completions: Groq, OpenRouter, Together, LM Studio, vLLM…',
  gemini: 'API do Google AI Studio. Crie a chave em aistudio.google.com.',
  anthropic: 'API da Anthropic (Claude). Oferece só chat, não embeddings.',
};
const SLOTS = {
  chat: { field: 'chatModel', list: '#listChat', select: '#activeChat', saved: '#savedChat', noun: 'IA de chat', badge: 'bg-indigo-600/30 text-indigo-200' },
  embedding: { field: 'embeddingModel', list: '#listEmbedding', select: '#activeEmbedding', saved: '#savedEmbedding', noun: 'embeddings', badge: 'bg-emerald-600/25 text-emerald-200' },
};
let kinds = {}, state = { providers: [], active: { chat: null, embedding: null } }, editingId = null, editingSlot = 'chat', wasWorkspace = false;
const testResults = {};

const status = (slot, text) => { const el = $(SLOTS[slot].saved); el.textContent = text; if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 2500); };

async function refreshAiStatus() {
  const el = $('#aiStatus'), text = $('#aiStatusText');
  try {
    const s = await api('/api/ai/status');
    if (s.chat && s.embedding) { text.textContent = `IA: ${s.chat.name} · ${s.chat.model}`; el.className = 'flex items-center gap-2 text-xs text-emerald-400 sm:text-sm'; el.title = `Chat: ${s.chat.name} (${s.chat.model})\nEmbeddings: ${s.embedding.name} (${s.embedding.model})`; }
    else { text.textContent = s.chat || s.embedding ? `Falta escolher ${s.chat ? 'embeddings' : 'chat'}` : 'Configurar IA'; el.className = 'flex items-center gap-2 text-xs text-amber-300 sm:text-sm'; el.title = 'Abrir configurações de IA'; }
  } catch (e) { text.textContent = 'IA indisponível'; el.className = 'flex items-center gap-2 text-xs text-red-400 sm:text-sm'; el.title = e.message; }
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
      const presets = PRESETS.map((p, i) => [p, i]).filter(([p]) => (p[c.field] || p.any) && (slot === 'chat' || kinds[p.kind]?.embeddings !== false));
      host.innerHTML = `<div class="rounded-xl border border-dashed border-slate-700 p-5 text-center"><p class="font-medium">Nenhuma ${slot === 'chat' ? 'IA de chat' : 'IA de embeddings'} cadastrada</p><p class="mt-1 text-sm text-slate-400">Escolha uma para começar:</p><div class="mt-4 flex flex-wrap justify-center gap-2">${presets.slice(0, 6).map(([p, i]) => `<button data-quick="${i}" data-slot="${slot}" class="rounded-full border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800">${esc(p.label)}</button>`).join('')}</div></div>`;
      continue;
    }
    host.innerHTML = items.map(p => {
      const inUse = state.active[slot] === p.id, t = testResults[p.id], r = t && t !== 'loading' ? t[slot] : null;
      return `<article class="rounded-xl border ${inUse ? 'border-indigo-500/60' : 'border-slate-800'} bg-slate-950/50 p-4">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0"><div class="flex flex-wrap items-center gap-2"><h4 class="break-words font-semibold">${esc(p.name)}</h4><span class="rounded-full border border-slate-700 px-2 py-0.5 text-xs text-slate-400">${esc(p.kindLabel)}</span>${inUse ? `<span class="rounded-full ${c.badge} px-2 py-0.5 text-xs">Em uso</span>` : ''}</div>
        <p class="mt-1 break-all text-sm">Modelo: <span class="font-medium">${esc(p[c.field])}</span></p>
        <p class="mt-1 break-all font-mono text-xs text-slate-400">${esc(p.baseUrl)} · ${p.hasKey ? 'chave ' + esc(p.keyHint) : 'sem chave'}</p></div>
        <div class="flex shrink-0 flex-wrap gap-1">${inUse ? '' : `<button data-use="${p.id}" data-slot="${slot}" class="rounded-lg px-3 py-1.5 text-sm text-indigo-300 hover:bg-slate-800">Usar</button>`}<button data-test="${p.id}" class="rounded-lg px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800">Testar</button><button data-edit="${p.id}" data-slot="${slot}" class="rounded-lg px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800">Editar</button><button data-delete="${p.id}" class="rounded-lg px-3 py-1.5 text-sm text-red-400 hover:bg-slate-800">Excluir</button></div>
      </div>
      ${t === 'loading' ? '<p class="mt-3 text-xs text-slate-400">Testando…</p>' : r ? `<p class="mt-3 break-words text-xs ${r.ok ? 'text-emerald-400' : 'text-red-400'}">${r.ok ? '✓' : '✗'} ${esc(r.detail)}</p>` : ''}
    </article>`;
    }).join('');
  }
}

async function loadSettings() {
  [kinds, state] = await Promise.all([api('/api/ai/kinds'), api('/api/ai/providers')]);
  renderActive(); renderProviders();
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
    renderActive(); renderProviders(); status(slot, 'Salvo ✓'); refreshAiStatus();
  } catch (e) { renderActive(); showError(e); }
}
$('#activeChat').onchange = () => saveActive('chat');
$('#activeEmbedding').onchange = () => saveActive('embedding');

// ---------- Diálogo de cadastro/edição ----------
const form = { name: $('#pfName'), kind: $('#pfKind'), baseUrl: $('#pfBaseUrl'), key: $('#pfKey'), clear: $('#pfClear'), chat: $('#pfChat'), emb: $('#pfEmb') };
const setError = msg => { const el = $('#pfError'); el.textContent = msg || ''; el.classList.toggle('hidden', !msg); };
function applyKindUi() {
  const kind = form.kind.value;
  $('#pfKindHint').textContent = KIND_HINTS[kind] || '';
  form.baseUrl.placeholder = kinds[kind]?.baseUrl || '';
}
function fillForm(v) {
  form.name.value = v.name || ''; form.kind.value = v.kind; form.baseUrl.value = v.baseUrl || ''; form.chat.value = v.chatModel || ''; form.emb.value = v.embeddingModel || '';
  form.key.value = ''; form.clear.checked = false; applyKindUi();
}
function openProviderDialog(provider, slot) {
  editingId = provider?.id || null; editingSlot = slot;
  const isChat = slot === 'chat', field = SLOTS[slot].field;
  setError(''); $('#pfModels').innerHTML = ''; $('#pfFetchMsg').textContent = 'Digite o nome do modelo ou use “Buscar modelos”.';
  $('#pfChatRow').classList.toggle('hidden', !isChat); $('#pfEmbRow').classList.toggle('hidden', isChat);
  form.chat.required = isChat; form.emb.required = !isChat;
  $('#providerKicker').textContent = isChat ? 'IA de chat' : 'Embeddings';
  $('#providerTitle').textContent = (provider ? 'Editar ' : 'Nova ') + SLOTS[slot].noun;
  $('#presetRow').classList.toggle('hidden', !!provider);
  const allowed = Object.entries(kinds).filter(([, v]) => isChat || v.embeddings);
  $('#pfKind').innerHTML = allowed.map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
  $('#pfPreset').innerHTML = '<option value="">Preencher manualmente</option>' + PRESETS.map((p, i) => (p[field] || p.any) && (isChat || kinds[p.kind]?.embeddings) ? `<option value="${i}">${esc(p.label)}</option>` : '').join('');
  fillForm(provider || { kind: allowed[0]?.[0] });
  form.key.type = 'password'; $('#pfKeyToggle').textContent = 'Ver';
  form.key.placeholder = provider?.hasKey ? `Mantida (${provider.keyHint}) — deixe vazio para não alterar` : 'Cole a chave de API aqui';
  $('#pfClearRow').classList.toggle('hidden', !provider?.hasKey); $('#pfClearRow').classList.toggle('flex', !!provider?.hasKey);
  $('#providerDialog').showModal();
  if (!provider) $('#pfPreset').focus(); else form.name.focus();
}
$('#pfCancel').onclick = () => $('#providerDialog').close();
$('#providerDialog').addEventListener('click', e => { if (e.target === $('#providerDialog')) $('#providerDialog').close(); });
form.kind.onchange = () => { form.baseUrl.value = ''; applyKindUi(); };
// Cadastro novo guarda só o modelo da seção em que foi aberto; o outro campo fica vazio.
$('#pfPreset').onchange = e => { const p = PRESETS[e.target.value]; if (p) { fillForm(editingSlot === 'chat' ? { ...p, embeddingModel: '' } : { ...p, chatModel: '' }); form.key.focus(); } };
$('#pfKeyToggle').onclick = () => { const show = form.key.type === 'password'; form.key.type = show ? 'text' : 'password'; $('#pfKeyToggle').textContent = show ? 'Ocultar' : 'Ver'; };

$('#pfFetch').onclick = async () => {
  const msg = $('#pfFetchMsg'), btn = $('#pfFetch');
  btn.disabled = true; msg.textContent = 'Buscando modelos…'; msg.className = 'mt-2 text-xs text-slate-400';
  try {
    const { models } = await api('/api/ai/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providerId: editingId, kind: form.kind.value, baseUrl: form.baseUrl.value.trim(), apiKey: form.key.value.trim() }) });
    $('#pfModels').innerHTML = models.map(m => `<option value="${esc(m)}"></option>`).join('');
    msg.textContent = models.length ? `${models.length} modelo(s) encontrados. Clique no campo do modelo e escolha na lista.` : 'Nenhum modelo retornado; digite o nome manualmente.';
  } catch (e) { msg.textContent = `Não foi possível listar: ${e.message}`; msg.className = 'mt-2 text-xs text-amber-300'; }
  finally { btn.disabled = false; }
};

$('#providerForm').onsubmit = async e => {
  e.preventDefault(); setError('');
  const save = $('#pfSave'); save.disabled = true;
  try {
    const body = { name: form.name.value, kind: form.kind.value, baseUrl: form.baseUrl.value, apiKey: form.key.value, clearKey: form.clear.checked, chatModel: form.chat.value, embeddingModel: form.emb.value };
    const saved = await api(editingId ? `/api/ai/providers/${editingId}` : '/api/ai/providers', { method: editingId ? 'PUT' : 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) });
    delete testResults[saved.id];
    $('#providerDialog').close();
    await loadSettings(); refreshAiStatus();
    // O primeiro cadastro de cada seção já fica em uso, para o sistema funcionar sem passos extras.
    const slot = editingSlot;
    if (!state.active[slot] && saved[SLOTS[slot].field]) {
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
    else if (d.quick !== undefined) { openProviderDialog(null, d.slot); $('#pfPreset').value = d.quick; $('#pfPreset').onchange({ target: $('#pfPreset') }); }
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

lucide.createIcons();
refreshAiStatus();
