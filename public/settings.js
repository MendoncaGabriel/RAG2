// Tela de Configurações de IA: cadastro de servidores Ollama para chat e embeddings, e escolha da IA em uso. Depende de $, api, esc, showError e confirmModal (app.js).
const PRESETS = [
  { label: 'Ollama (local)', name: 'Ollama', kind: 'ollama', baseUrl: 'http://localhost:11434', chatModel: 'qwen2.5:3b', embeddingModel: 'bge-m3' },
];
const SLOTS = {
  chat: { field: 'chatModel', list: '#listChat', select: '#activeChat', saved: '#savedChat', noun: 'IA de chat', badge: 'bg-jabil text-white' },
  embedding: { field: 'embeddingModel', list: '#listEmbedding', select: '#activeEmbedding', saved: '#savedEmbedding', noun: 'embeddings', badge: 'bg-ok text-white' },
};
let kinds = {}, state = { providers: [], active: { chat: null, embedding: null } }, editingId = null, editingSlot = 'chat', wasWorkspace = false;
const testResults = {};

const status = (slot, text) => { const el = $(SLOTS[slot].saved); el.textContent = text; if (text) setTimeout(() => { if (el.textContent === text) el.textContent = ''; }, 2500); };

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
      const presets = PRESETS.map((p, i) => [p, i]).filter(([p]) => p[c.field]);
      host.innerHTML = `<div class="rounded-xl border-2 border-dashed border-line bg-canvas p-5 text-center"><p class="font-medium text-heading">Nenhuma ${slot === 'chat' ? 'IA de chat' : 'IA de embeddings'} cadastrada</p><p class="mt-1 text-sm text-ink-muted">Escolha uma para começar:</p><div class="mt-4 flex flex-wrap justify-center gap-2">${presets.map(([p, i]) => `<button data-quick="${i}" data-slot="${slot}" class="btn btn-secondary rounded-full">${esc(p.label)}</button>`).join('')}</div></div>`;
      continue;
    }
    host.innerHTML = items.map(p => {
      const inUse = state.active[slot] === p.id, t = testResults[p.id], r = t && t !== 'loading' ? t[slot] : null;
      return `<article class="rounded-xl border ${inUse ? 'border-jabil-light ring-1 ring-jabil-light' : 'border-line'} bg-surface p-4">
      <div class="flex flex-wrap items-start justify-between gap-3">
        <div class="min-w-0"><div class="flex flex-wrap items-center gap-2"><h4 class="break-words font-semibold text-heading">${esc(p.name)}</h4><span class="badge">${esc(p.kindLabel)}</span>${inUse ? `<span class="rounded-full ${c.badge} px-2 py-0.5 text-xs">Em uso</span>` : ''}</div>
        <p class="mt-1 break-all text-sm">Modelo: <span class="font-medium">${esc(p[c.field])}</span></p>
        <p class="mt-1 break-all font-mono text-xs text-ink-muted">${esc(p.baseUrl)} · ${p.hasKey ? 'chave ' + esc(p.keyHint) : 'sem chave'}</p></div>
        <div class="flex shrink-0 flex-wrap gap-1">${inUse ? '' : `<button data-use="${p.id}" data-slot="${slot}" class="btn btn-primary btn-sm">Usar</button>`}<button data-test="${p.id}" class="btn btn-ghost btn-sm">Testar</button><button data-edit="${p.id}" data-slot="${slot}" class="btn btn-ghost btn-sm">Editar</button><button data-delete="${p.id}" class="btn btn-ghost btn-sm hover:text-danger-ink">Excluir</button></div>
      </div>
      ${t === 'loading' ? '<p class="mt-3 text-xs text-ink-muted">Testando…</p>' : r ? `<p class="mt-3 break-words text-xs ${r.ok ? 'text-ok-ink' : 'text-danger-ink'}">${r.ok ? '✓' : '✗'} ${esc(r.detail)}</p>` : ''}
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
// Só existe um tipo de servidor (Ollama): o campo "kind" é fixo no formulário.
const form = { name: $('#pfName'), kind: $('#pfKind'), baseUrl: $('#pfBaseUrl'), key: $('#pfKey'), clear: $('#pfClear'), chat: $('#pfChat'), emb: $('#pfEmb') };
const setError = msg => { const el = $('#pfError'); el.textContent = msg || ''; el.classList.toggle('hidden', !msg); };
function applyKindUi() { form.baseUrl.placeholder = kinds.ollama?.baseUrl || 'http://localhost:11434'; }
function fillForm(v) {
  form.name.value = v.name || ''; form.kind.value = 'ollama'; form.baseUrl.value = v.baseUrl || ''; form.chat.value = v.chatModel || ''; form.emb.value = v.embeddingModel || '';
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
  $('#pfPreset').innerHTML = '<option value="">Preencher manualmente</option>' + PRESETS.map((p, i) => (p[field] ? `<option value="${i}">${esc(p.label)}</option>` : '')).join('');
  fillForm(provider || { kind: 'ollama' });
  form.key.type = 'password'; $('#pfKeyToggle').textContent = 'Ver';
  form.key.placeholder = provider?.hasKey ? `Mantida (${provider.keyHint}) — deixe vazio para não alterar` : 'Cole a chave de API aqui, se o Ollama exigir';
  $('#pfClearRow').classList.toggle('hidden', !provider?.hasKey); $('#pfClearRow').classList.toggle('flex', !!provider?.hasKey);
  $('#providerDialog').showModal();
  if (!provider) $('#pfPreset').focus(); else form.name.focus();
}
$('#pfCancel').onclick = () => $('#providerDialog').close();
$('#providerDialog').addEventListener('click', e => { if (e.target === $('#providerDialog')) $('#providerDialog').close(); });
// Cadastro novo guarda só o modelo da seção em que foi aberto; o outro campo fica vazio.
$('#pfPreset').onchange = e => { const p = PRESETS[e.target.value]; if (p) { fillForm(editingSlot === 'chat' ? { ...p, embeddingModel: '' } : { ...p, chatModel: '' }); form.key.focus(); } };
$('#pfKeyToggle').onclick = () => { const show = form.key.type === 'password'; form.key.type = show ? 'text' : 'password'; $('#pfKeyToggle').textContent = show ? 'Ocultar' : 'Ver'; };

$('#pfFetch').onclick = async () => {
  const msg = $('#pfFetchMsg'), btn = $('#pfFetch');
  btn.disabled = true; msg.textContent = 'Buscando modelos…'; msg.className = 'mt-2 text-xs text-ink-muted';
  try {
    const { models } = await api('/api/ai/models', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ providerId: editingId, kind: 'ollama', baseUrl: form.baseUrl.value.trim(), apiKey: form.key.value.trim() }) });
    $('#pfModels').innerHTML = models.map(m => `<option value="${esc(m)}"></option>`).join('');
    msg.textContent = models.length ? `${models.length} modelo(s) encontrados. Clique no campo do modelo e escolha na lista.` : 'Nenhum modelo retornado; digite o nome manualmente.';
  } catch (e) { msg.textContent = `Não foi possível listar: ${e.message}`; msg.className = 'mt-2 text-xs font-medium text-danger-ink'; }
  finally { btn.disabled = false; }
};

$('#providerForm').onsubmit = async e => {
  e.preventDefault(); setError('');
  const save = $('#pfSave'); save.disabled = true;
  try {
    const body = { name: form.name.value, kind: 'ollama', baseUrl: form.baseUrl.value, apiKey: form.key.value, clearKey: form.clear.checked, chatModel: form.chat.value, embeddingModel: form.emb.value };
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
