// Tela de Configurações de IA: cadastro de provedores e escolha da IA em uso. Depende de $, api, esc, showError e confirmModal (app.js).
const PRESETS = [
  { label: 'Ollama (local)', name: 'Ollama', kind: 'ollama', baseUrl: 'http://localhost:11434', chatModel: 'qwen2.5:1.5b-instruct', embeddingModel: 'bge-m3' },
  { label: 'OpenAI', name: 'OpenAI', kind: 'openai', baseUrl: 'https://api.openai.com/v1', chatModel: 'gpt-4o-mini', embeddingModel: 'text-embedding-3-small' },
  { label: 'Google Gemini', name: 'Gemini', kind: 'gemini', baseUrl: 'https://generativelanguage.googleapis.com/v1beta', chatModel: 'gemini-2.5-flash', embeddingModel: 'gemini-embedding-001' },
  { label: 'Anthropic (Claude)', name: 'Claude', kind: 'anthropic', baseUrl: 'https://api.anthropic.com/v1', chatModel: 'claude-haiku-5-5', embeddingModel: '' },
  { label: 'Groq', name: 'Groq', kind: 'openai', baseUrl: 'https://api.groq.com/openai/v1', chatModel: 'llama-3.3-70b-versatile', embeddingModel: '' },
  { label: 'OpenRouter', name: 'OpenRouter', kind: 'openai', baseUrl: 'https://openrouter.ai/api/v1', chatModel: 'openai/gpt-4o-mini', embeddingModel: '' },
  { label: 'LM Studio (local)', name: 'LM Studio', kind: 'openai', baseUrl: 'http://localhost:1234/v1', chatModel: '', embeddingModel: '' },
  { label: 'Outro (API compatível com OpenAI)', name: '', kind: 'openai', baseUrl: '', chatModel: '', embeddingModel: '' },
];
const KIND_HINTS = {
  ollama: 'IA rodando na sua máquina ou servidor. Normalmente não precisa de chave.',
  openai: 'Serve para OpenAI e qualquer API com /chat/completions: Groq, OpenRouter, Together, LM Studio, vLLM…',
  gemini: 'API do Google AI Studio. Crie a chave em aistudio.google.com.',
  anthropic: 'API da Anthropic (Claude). Oferece só chat, não embeddings.',
};
let kinds = {}, state = { providers: [], active: { chat: null, embedding: null } }, editingId = null, wasWorkspace = false;
const testResults = {};

const status = text => { const el = $('#activeSaved'); el.textContent = text; if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 2500); };

async function refreshAiStatus() {
  const el = $('#aiStatus'), text = $('#aiStatusText');
  try {
    const s = await api('/api/ai/status');
    if (s.chat && s.embedding) { text.textContent = `IA: ${s.chat.name} · ${s.chat.model}`; el.className = 'flex items-center gap-2 text-xs text-emerald-400 sm:text-sm'; el.title = `Chat: ${s.chat.name} (${s.chat.model})\nEmbeddings: ${s.embedding.name} (${s.embedding.model})`; }
    else { text.textContent = s.chat || s.embedding ? `Falta escolher ${s.chat ? 'embeddings' : 'chat'}` : 'Configurar IA'; el.className = 'flex items-center gap-2 text-xs text-amber-300 sm:text-sm'; el.title = 'Abrir configurações de IA'; }
  } catch (e) { text.textContent = 'IA indisponível'; el.className = 'flex items-center gap-2 text-xs text-red-400 sm:text-sm'; el.title = e.message; }
}

function renderActive() {
  const fill = (select, slot, field, emptyLabel) => {
    const options = state.providers.filter(p => p[field]);
    select.innerHTML = `<option value="">${emptyLabel}</option>` + options.map(p => `<option value="${p.id}">${esc(p.name)} · ${esc(p[field])}</option>`).join('');
    select.value = state.active[slot] || '';
  };
  fill($('#activeChat'), 'chat', 'chatModel', '— nenhum selecionado —');
  fill($('#activeEmbedding'), 'embedding', 'embeddingModel', '— nenhum selecionado —');
}

function renderProviders() {
  const host = $('#providers');
  if (!state.providers.length) {
    host.innerHTML = `<div class="rounded-xl border border-dashed border-slate-700 p-6 text-center"><p class="font-medium">Nenhum provedor cadastrado</p><p class="mt-1 text-sm text-slate-400">Escolha um para começar:</p><div class="mt-4 flex flex-wrap justify-center gap-2">${PRESETS.slice(0, 7).map((p, i) => `<button data-quick="${i}" class="rounded-full border border-slate-700 px-3 py-1.5 text-sm hover:bg-slate-800">${esc(p.label)}</button>`).join('')}</div></div>`;
    return;
  }
  host.innerHTML = state.providers.map(p => {
    const inChat = state.active.chat === p.id, inEmb = state.active.embedding === p.id, t = testResults[p.id];
    const line = r => r ? `<p class="${r.ok ? 'text-emerald-400' : 'text-red-400'} break-words">${r.ok ? '✓' : '✗'} ${esc(r.detail)}</p>` : '';
    return `<article class="rounded-xl border border-slate-800 bg-slate-950/50 p-4">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0"><div class="flex flex-wrap items-center gap-2"><h3 class="break-words font-semibold">${esc(p.name)}</h3><span class="rounded-full border border-slate-700 px-2 py-0.5 text-xs text-slate-400">${esc(p.kindLabel)}</span>${inChat ? '<span class="rounded-full bg-indigo-600/30 px-2 py-0.5 text-xs text-indigo-200">Em uso: chat</span>' : ''}${inEmb ? '<span class="rounded-full bg-emerald-600/25 px-2 py-0.5 text-xs text-emerald-200">Em uso: embeddings</span>' : ''}</div>
        <p class="mt-1 break-all font-mono text-xs text-slate-400">${esc(p.baseUrl)}</p></div>
        <div class="flex shrink-0 gap-1"><button data-test="${p.id}" class="rounded-lg px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800">Testar</button><button data-edit="${p.id}" class="rounded-lg px-3 py-1.5 text-sm text-slate-300 hover:bg-slate-800">Editar</button><button data-delete="${p.id}" class="rounded-lg px-3 py-1.5 text-sm text-red-400 hover:bg-slate-800">Excluir</button></div>
      </div>
      <dl class="mt-3 grid gap-x-6 gap-y-1 text-sm sm:grid-cols-3"><div><dt class="text-xs text-slate-400">Chat</dt><dd class="break-all">${p.chatModel ? esc(p.chatModel) : '<span class="text-slate-500">—</span>'}</dd></div><div><dt class="text-xs text-slate-400">Embeddings</dt><dd class="break-all">${p.embeddingModel ? esc(p.embeddingModel) : '<span class="text-slate-500">—</span>'}</dd></div><div><dt class="text-xs text-slate-400">Chave de API</dt><dd class="font-mono text-xs">${p.hasKey ? esc(p.keyHint) : '<span class="font-sans text-slate-500">não definida</span>'}</dd></div></dl>
      ${t === 'loading' ? '<p class="mt-3 text-xs text-slate-400">Testando…</p>' : t ? `<div class="mt-3 space-y-1 text-xs">${line(t.chat)}${line(t.embedding)}</div>` : ''}
    </article>`;
  }).join('');
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

async function saveActive() {
  try {
    state.active = await api('/api/ai/active', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ chat: $('#activeChat').value || null, embedding: $('#activeEmbedding').value || null }) });
    renderActive(); renderProviders(); status('Salvo ✓'); refreshAiStatus();
  } catch (e) { renderActive(); showError(e); }
}
$('#activeChat').onchange = saveActive;
$('#activeEmbedding').onchange = saveActive;

// ---------- Diálogo de cadastro/edição ----------
const form = { name: $('#pfName'), kind: $('#pfKind'), baseUrl: $('#pfBaseUrl'), key: $('#pfKey'), clear: $('#pfClear'), chat: $('#pfChat'), emb: $('#pfEmb') };
const setError = msg => { const el = $('#pfError'); el.textContent = msg || ''; el.classList.toggle('hidden', !msg); };
function applyKindUi() {
  const kind = form.kind.value;
  $('#pfKindHint').textContent = KIND_HINTS[kind] || '';
  form.baseUrl.placeholder = kinds[kind]?.baseUrl || '';
  const noEmb = kinds[kind] && !kinds[kind].embeddings;
  form.emb.disabled = !!noEmb;
  form.emb.placeholder = noEmb ? 'Não disponível neste tipo' : 'ex.: text-embedding-3-small';
  if (noEmb) form.emb.value = '';
}
function fillForm(v) {
  form.name.value = v.name || ''; form.kind.value = v.kind; form.baseUrl.value = v.baseUrl || ''; form.chat.value = v.chatModel || ''; form.emb.value = v.embeddingModel || '';
  form.key.value = ''; form.clear.checked = false; applyKindUi();
}
function openProviderDialog(provider) {
  editingId = provider?.id || null;
  setError(''); $('#pfModels').innerHTML = ''; $('#pfFetchMsg').textContent = 'Preencha ao menos um. Deixe em branco o que o provedor não oferece.';
  $('#providerTitle').textContent = provider ? 'Editar provedor' : 'Novo provedor';
  $('#presetRow').classList.toggle('hidden', !!provider);
  $('#pfKind').innerHTML = Object.entries(kinds).map(([k, v]) => `<option value="${k}">${esc(v.label)}</option>`).join('');
  $('#pfPreset').innerHTML = '<option value="">Preencher manualmente</option>' + PRESETS.map((p, i) => `<option value="${i}">${esc(p.label)}</option>`).join('');
  fillForm(provider || { kind: 'ollama' });
  form.key.type = 'password'; $('#pfKeyToggle').textContent = 'Ver';
  form.key.placeholder = provider?.hasKey ? `Mantida (${provider.keyHint}) — deixe vazio para não alterar` : 'Cole a chave de API aqui';
  $('#pfClearRow').classList.toggle('hidden', !provider?.hasKey); $('#pfClearRow').classList.toggle('flex', !!provider?.hasKey);
  $('#providerDialog').showModal();
  if (!provider) $('#pfPreset').focus(); else form.name.focus();
}
$('#addProvider').onclick = () => openProviderDialog(null);
$('#pfCancel').onclick = () => $('#providerDialog').close();
$('#providerDialog').addEventListener('click', e => { if (e.target === $('#providerDialog')) $('#providerDialog').close(); });
form.kind.onchange = () => { form.baseUrl.value = ''; applyKindUi(); };
$('#pfPreset').onchange = e => { const p = PRESETS[e.target.value]; if (p) { fillForm(p); form.key.focus(); } };
$('#pfKeyToggle').onclick = () => { const show = form.key.type === 'password'; form.key.type = show ? 'text' : 'password'; $('#pfKeyToggle').textContent = show ? 'Ocultar' : 'Ver'; };

$('#pfFetch').onclick = async () => {
  const msg = $('#pfFetchMsg'), btn = $('#pfFetch');
  btn.disabled = true; msg.textContent = 'Buscando modelos…'; msg.className = 'mt-2 text-xs text-slate-400';
  try {
    const { models } = await api('/api/ai/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providerId: editingId, kind: form.kind.value, baseUrl: form.baseUrl.value.trim(), apiKey: form.key.value.trim() }) });
    $('#pfModels').innerHTML = models.map(m => `<option value="${esc(m)}"></option>`).join('');
    msg.textContent = models.length ? `${models.length} modelo(s) encontrados. Clique em um campo de modelo e escolha na lista.` : 'Nenhum modelo retornado; digite o nome manualmente.';
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
    // Primeiro provedor cadastrado já fica em uso, para o sistema funcionar sem passos extras.
    const patch = {};
    if (!state.active.chat && saved.chatModel) patch.chat = saved.id;
    if (!state.active.embedding && saved.embeddingModel) patch.embedding = saved.id;
    if (Object.keys(patch).length) {
      state.active = await api('/api/ai/active', { method: 'PUT', headers: { 'content-type': 'application/json' }, body: JSON.stringify(patch) });
      renderActive(); renderProviders(); refreshAiStatus(); status('Selecionado automaticamente ✓');
    }
  } catch (x) { setError(x.message || String(x)); }
  finally { save.disabled = false; }
};

$('#providers').onclick = async e => {
  const btn = e.target.closest('button');
  if (!btn) return;
  try {
    if (btn.dataset.quick !== undefined) { openProviderDialog(null); $('#pfPreset').value = btn.dataset.quick; $('#pfPreset').onchange({ target: $('#pfPreset') }); }
    else if (btn.dataset.edit) openProviderDialog(state.providers.find(p => p.id === btn.dataset.edit));
    else if (btn.dataset.delete) {
      const p = state.providers.find(x => x.id === btn.dataset.delete);
      const inUse = state.active.chat === p.id || state.active.embedding === p.id;
      if (await confirmModal(`Excluir "${p.name}"?`, inUse ? 'Este provedor está em uso; depois de excluir, escolha outro para o chat/embeddings.' : 'A chave de API e a configuração serão removidas.')) {
        await api(`/api/ai/providers/${p.id}`, { method: 'DELETE' }); delete testResults[p.id];
        await loadSettings(); refreshAiStatus();
      }
    } else if (btn.dataset.test) {
      const id = btn.dataset.test; testResults[id] = 'loading'; renderProviders();
      testResults[id] = await api(`/api/ai/providers/${id}/test`, { method: 'POST' }); renderProviders();
    }
  } catch (x) { showError(x); }
};

lucide.createIcons();
refreshAiStatus();
