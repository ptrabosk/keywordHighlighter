const els = {
  form: document.querySelector('#keywordForm'),
  input: document.querySelector('#keywordInput'),
  keywords: document.querySelector('#keywords'),
  diagnosticsList: document.querySelector('#diagnosticsList'),
  refreshDiagnostics: document.querySelector('#refreshDiagnostics'),
  uploadDiagnostics: document.querySelector('#uploadDiagnostics'),
  status: document.querySelector('#status')
};

let settings = structuredClone(DEFAULT_SETTINGS);

function logOperationalEvent(event) {
  try {
    chrome.runtime.sendMessage({
      type: 'highlighter:logEvent',
      event: {
        surface: 'popup',
        ...event
      }
    }).catch(() => {});
  } catch (_error) {
    // Logging must never affect popup behavior.
  }
}

function logOperationalFailure(eventType, errorCode, errorMessage, metadata = {}) {
  logOperationalEvent({
    eventType,
    severity: 'error',
    result: 'failure',
    errorCode,
    errorMessage,
    metadata
  });
}

init().catch((error) => {
  logOperationalFailure('unexpected_exception', 'UNEXPECTED_ERROR', 'Popup startup failed', {
    operation: 'init'
  });
  console.error('[Attentive Rule Highlighter] Popup failed to initialize:', error);
});

async function init() {
  const startedAt = performance.now();
  settings = mergeSettings(DEFAULT_SETTINGS, await loadSettings());
  renderKeywords();
  els.form.addEventListener('submit', addKeyword);
  els.refreshDiagnostics.addEventListener('click', refreshDiagnostics);
  els.uploadDiagnostics.addEventListener('click', uploadDiagnostics);
  await refreshDiagnostics();
  logOperationalEvent({
    eventType: 'popup_opened',
    severity: 'info',
    result: 'success',
    durationMs: performance.now() - startedAt
  });
}

async function refreshDiagnostics() {
  try {
    const response = await chrome.runtime.sendMessage({ type: 'highlighter:getDiagnostics' });
    if (!response?.ok) throw new Error('Diagnostics unavailable');
    renderDiagnostics(response.diagnostics);
  } catch (error) {
    renderDiagnostics(null);
    logOperationalFailure('unexpected_exception', 'UNEXPECTED_ERROR', 'Diagnostics could not be loaded', {
      operation: 'diagnostics'
    });
  }
}

async function uploadDiagnostics() {
  setStatus('Uploading queued diagnostics...');
  try {
    const response = await chrome.runtime.sendMessage({ type: 'highlighter:runDiagnosticsUpload' });
    if (!response?.ok) throw new Error('Diagnostics upload unavailable');
    renderDiagnostics(response.diagnostics);
    setStatus('Diagnostics upload requested.');
  } catch (error) {
    setStatus('Diagnostics upload failed.');
    logOperationalFailure('upload_failed', 'UPLOAD_NETWORK_FAILED', 'Diagnostics upload could not be requested', {
      operation: 'diagnostics'
    });
  }
}

function renderDiagnostics(diagnostics) {
  if (!diagnostics) {
    els.diagnosticsList.innerHTML = '<dt>Status</dt><dd>Unavailable</dd>';
    return;
  }
  const queue = diagnostics.queueStats || {};
  const upload = diagnostics.uploadStatus || {};
  const config = diagnostics.loggingConfig || {};
  const stats = diagnostics.lastStats || {};
  els.diagnosticsList.innerHTML = [
    ['Logging', config.configured ? 'Configured' : 'Not configured'],
    ['Queue', `${queue.pendingCount || 0} pending`],
    ['Last upload', formatTime(upload.lastUploadAt || upload.lastSuccessfulUploadAt)],
    ['Last error', upload.lastErrorCode || 'None'],
    ['Highlights', Number.isFinite(stats.highlights) ? String(stats.highlights) : 'n/a']
  ].map(([label, value]) => `<dt>${escapeHtml(label)}</dt><dd>${escapeHtml(value)}</dd>`).join('');
}

function formatTime(value) {
  if (!value) return 'Never';
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return 'Unknown';
  return date.toLocaleString([], { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });
}

async function loadSettings() {
  try {
    const result = await chrome.storage.sync.get(SETTINGS_KEY);
    return result[SETTINGS_KEY] || {};
  } catch (error) {
    logOperationalFailure('settings_load_failed', 'SETTINGS_LOAD_FAILED', 'Settings could not be loaded', {
      operation: 'settingsRead'
    });
    throw error;
  }
}

async function saveSettings() {
  try {
    await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
    logOperationalEvent({
      eventType: 'settings_saved',
      severity: 'info',
      result: 'success',
      metadata: {
        operation: 'customKeywordsSave',
        changeSource: 'popup'
      }
    });
    setStatus('Saved. Refresh the page if highlights do not update immediately.');
  } catch (error) {
    logOperationalFailure('settings_save_failed', 'SETTINGS_SAVE_FAILED', 'Settings could not be saved', {
      operation: 'customKeywordsSave'
    });
    throw error;
  }
}

async function addKeyword(event) {
  event.preventDefault();
  const keyword = normalizeKeyword(els.input.value);
  if (!keyword) {
    setStatus('Enter a keyword first.');
    return;
  }
  if (settings.customKeywords.some((item) => item.toLowerCase() === keyword.toLowerCase())) {
    setStatus('That keyword is already in the list.');
    return;
  }
  settings.customKeywords = [...settings.customKeywords, keyword].sort((a, b) => a.localeCompare(b));
  els.input.value = '';
  renderKeywords();
  await saveSettings();
}

async function removeKeyword(keyword) {
  settings.customKeywords = settings.customKeywords.filter((item) => item !== keyword);
  renderKeywords();
  await saveSettings();
}

function renderKeywords() {
  els.keywords.innerHTML = '';
  if (!settings.customKeywords.length) {
    const empty = document.createElement('p');
    empty.className = 'empty';
    empty.textContent = 'No custom keywords yet.';
    els.keywords.appendChild(empty);
    return;
  }
  for (const keyword of settings.customKeywords) {
    const row = document.createElement('div');
    row.className = 'keyword';
    const label = document.createElement('span');
    label.textContent = keyword;
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'secondary';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => removeKeyword(keyword));
    row.append(label, remove);
    els.keywords.appendChild(row);
  }
}

function mergeSettings(base, override) {
  const merged = {
    ...base,
    ...override,
    customKeywords: Array.isArray(override?.customKeywords) ? override.customKeywords.map(normalizeKeyword).filter(Boolean) : base.customKeywords
  };
  return merged;
}

function normalizeKeyword(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function setStatus(text) {
  els.status.textContent = text;
  window.clearTimeout(setStatus.timer);
  setStatus.timer = window.setTimeout(() => {
    els.status.textContent = '';
  }, 3200);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
