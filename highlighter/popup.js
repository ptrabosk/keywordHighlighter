const els = {
  form: document.querySelector('#keywordForm'),
  input: document.querySelector('#keywordInput'),
  text: document.querySelector('#keywordText'),
  keywords: document.querySelector('#keywords'),
  exportKeywords: document.querySelector('#exportKeywords'),
  importKeywords: document.querySelector('#importKeywords'),
  importFile: document.querySelector('#importFile'),
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
  els.exportKeywords.addEventListener('click', exportKeywords);
  els.importKeywords.addEventListener('click', () => els.importFile.click());
  els.importFile.addEventListener('change', importKeywords);
  logOperationalEvent({
    eventType: 'popup_opened',
    severity: 'info',
    result: 'success',
    durationMs: performance.now() - startedAt
  });
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
  settings.customKeywordTextByPattern = {
    ...(settings.customKeywordTextByPattern || {}),
    [keyword]: normalizeHoverText(els.text.value)
  };
  els.input.value = '';
  els.text.value = '';
  renderKeywords();
  await saveSettings();
}

async function removeKeyword(keyword) {
  settings.customKeywords = settings.customKeywords.filter((item) => item !== keyword);
  if (settings.customKeywordTextByPattern) {
    delete settings.customKeywordTextByPattern[keyword];
  }
  renderKeywords();
  await saveSettings();
}

function exportKeywords() {
  const payload = {
    schemaVersion: 1,
    exportedAt: new Date().toISOString(),
    extensionName: 'Attentive Rule Highlighter',
    customKeywords: settings.customKeywords || [],
    customKeywordTextByPattern: settings.customKeywordTextByPattern || {}
  };
  const blob = new Blob([JSON.stringify(payload, null, 2)], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `attentive-highlighter-keywords-${formatDateForFilename(new Date())}.json`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  window.setTimeout(() => URL.revokeObjectURL(url), 1000);
  setStatus('Keyword backup exported.');
}

async function importKeywords(event) {
  const file = event.target.files?.[0];
  event.target.value = '';
  if (!file) return;

  try {
    const payload = JSON.parse(await file.text());
    const imported = parseKeywordImport(payload);
    settings = mergeSettings(DEFAULT_SETTINGS, {
      ...settings,
      customKeywords: imported.customKeywords,
      customKeywordTextByPattern: imported.customKeywordTextByPattern
    });
    renderKeywords();
    await saveSettings();
    setStatus(`Imported ${settings.customKeywords.length} keyword${settings.customKeywords.length === 1 ? '' : 's'}.`);
  } catch (error) {
    logOperationalFailure('settings_save_failed', 'KEYWORD_IMPORT_FAILED', 'Keyword backup could not be imported', {
      operation: 'customKeywordsImport'
    });
    setStatus('Import failed. Choose a valid keyword backup JSON file.');
  }
}

function parseKeywordImport(payload) {
  const source = payload && typeof payload === 'object' && payload.amhSettings ? payload.amhSettings : payload;
  if (!source || typeof source !== 'object' || !Array.isArray(source.customKeywords)) {
    throw new Error('Missing customKeywords array');
  }
  const customKeywords = Array.from(new Set(source.customKeywords.map(normalizeKeyword).filter(Boolean)))
    .sort((a, b) => a.localeCompare(b));
  return {
    customKeywords,
    customKeywordTextByPattern: normalizeCustomKeywordTextMap(customKeywords, source.customKeywordTextByPattern || {})
  };
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
    customKeywords: Array.isArray(override?.customKeywords) ? override.customKeywords.map(normalizeKeyword).filter(Boolean) : base.customKeywords,
    customKeywordTextByPattern: normalizeCustomKeywordTextMap(override?.customKeywords, override?.customKeywordTextByPattern || base.customKeywordTextByPattern || {})
  };
  return merged;
}

function normalizeKeyword(value) {
  if (value && typeof value === 'object') return String(value.pattern || value.name || '').trim().replace(/\s+/g, ' ');
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeHoverText(value) {
  return String(value || '').trim().replace(/\s+/g, ' ');
}

function normalizeCustomKeywordTextMap(customKeywords, existingTextByPattern = {}) {
  const textByPattern = {};
  for (const item of customKeywords || []) {
    if (item && typeof item === 'object') {
      const pattern = normalizeKeyword(item);
      if (pattern) textByPattern[pattern] = normalizeHoverText(item.text || existingTextByPattern[pattern] || '');
    }
  }
  for (const [pattern, text] of Object.entries(existingTextByPattern || {})) {
    const normalized = normalizeKeyword(pattern);
    if (normalized && !(normalized in textByPattern)) textByPattern[normalized] = normalizeHoverText(text);
  }
  return textByPattern;
}

function setStatus(text) {
  els.status.textContent = text;
  window.clearTimeout(setStatus.timer);
  setStatus.timer = window.setTimeout(() => {
    els.status.textContent = '';
  }, 3200);
}

function formatDateForFilename(date) {
  return date.toISOString().slice(0, 10);
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}
