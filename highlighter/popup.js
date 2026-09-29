const { escapeHtml } = globalThis.AMH_EXTENSION_UTILS;
const { parseKeywordCsv, serializeKeywordCsv } = globalThis.AMH_KEYWORD_CSV;

function createCustomKeywordUi({ surface = 'popup' } = {}) {
const els = {
  form: document.querySelector('#keywordForm'),
  input: document.querySelector('#keywordInput'),
  text: document.querySelector('#keywordText'),
  addKeyword: document.querySelector('#addKeyword'),
  keywords: document.querySelector('#keywords'),
  exportKeywords: document.querySelector('#exportKeywords'),
  importKeywords: document.querySelector('#importKeywords'),
  importFile: document.querySelector('#importFile'),
  status: document.querySelector('#status')
};

const MAX_KEYWORD_LENGTH = 128;
const MAX_HOVER_TEXT_LENGTH = 256;

let settings = structuredClone(DEFAULT_SETTINGS);
let featuresStarted = false;
let editingKeyword = null;

function logOperationalEvent(event) {
  try {
    chrome.runtime.sendMessage({
      type: 'highlighter:logEvent',
      event: {
        surface,
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

async function init() {
  await startFeatures();
}

async function startFeatures() {
  if (featuresStarted) return;
  featuresStarted = true;
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
  const wasEditing = Boolean(editingKeyword);
  const keyword = normalizeKeyword(els.input.value);
  if (!keyword) {
    setStatus('Enter a keyword first.');
    return;
  }
  if (settings.customKeywords.some((item) => item.toLowerCase() === keyword.toLowerCase() && item.toLowerCase() !== String(editingKeyword || '').toLowerCase())) {
    setStatus('That keyword is already in the list.');
    return;
  }
  const nextText = normalizeHoverText(els.text.value);
  if (editingKeyword) {
    settings.customKeywords = settings.customKeywords
      .filter((item) => item !== editingKeyword)
      .concat(keyword)
      .sort((a, b) => a.localeCompare(b));
    const nextTextByPattern = { ...(settings.customKeywordTextByPattern || {}) };
    delete nextTextByPattern[editingKeyword];
    nextTextByPattern[keyword] = nextText;
    settings.customKeywordTextByPattern = nextTextByPattern;
    editingKeyword = null;
    els.addKeyword.textContent = 'ADD KEYWORD';
  } else {
    settings.customKeywords = [...settings.customKeywords, keyword].sort((a, b) => a.localeCompare(b));
    settings.customKeywordTextByPattern = {
      ...(settings.customKeywordTextByPattern || {}),
      [keyword]: nextText
    };
  }
  els.input.value = '';
  els.text.value = '';
  renderKeywords();
  await saveSettings();
  setStatus(wasEditing ? 'Keyword updated.' : 'Keyword added.');
}

function editKeyword(keyword) {
  editingKeyword = keyword;
  els.input.value = keyword;
  els.text.value = settings.customKeywordTextByPattern?.[keyword] || '';
  els.addKeyword.textContent = 'SAVE KEYWORD';
  els.input.focus();
}

async function removeKeyword(keyword) {
  settings.customKeywords = settings.customKeywords.filter((item) => item !== keyword);
  if (settings.customKeywordTextByPattern) {
    delete settings.customKeywordTextByPattern[keyword];
  }
  if (editingKeyword === keyword) {
    editingKeyword = null;
    els.input.value = '';
    els.text.value = '';
    els.addKeyword.textContent = 'ADD KEYWORD';
  }
  renderKeywords();
  await saveSettings();
}

function exportKeywords() {
  const csv = serializeKeywordCsv((settings.customKeywords || []).map((keyword) => ({
    keyword,
    hoverText: settings.customKeywordTextByPattern?.[keyword] || ''
  })));
  const blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = `offsight-highlighter-keywords-${formatDateForFilename(new Date())}.csv`;
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
    const imported = parseKeywordImport(await file.text());
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
    setStatus('Import failed. Choose a CSV file with keyword and hover text headers.');
  }
}

function parseKeywordImport(csvText) {
  const importedByKeyword = new Map();
  for (const row of parseKeywordCsv(csvText)) {
    const keyword = normalizeKeyword(row.keyword);
    if (!keyword) continue;
    const key = keyword.toLocaleLowerCase();
    const existing = importedByKeyword.get(key);
    importedByKeyword.set(key, {
      keyword: existing?.keyword || keyword,
      hoverText: normalizeHoverText(row.hoverText)
    });
  }
  const customKeywords = Array.from(importedByKeyword.values(), (entry) => entry.keyword)
    .sort((a, b) => a.localeCompare(b));
  return {
    customKeywords,
    customKeywordTextByPattern: Object.fromEntries(
      Array.from(importedByKeyword.values(), (entry) => [entry.keyword, entry.hoverText])
    )
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
    const actions = document.createElement('div');
    actions.className = 'keyword__actions';
    const edit = document.createElement('button');
    edit.type = 'button';
    edit.className = 'secondary';
    edit.textContent = 'Edit';
    edit.addEventListener('click', () => editKeyword(keyword));
    const remove = document.createElement('button');
    remove.type = 'button';
    remove.className = 'secondary';
    remove.textContent = 'Remove';
    remove.addEventListener('click', () => removeKeyword(keyword));
    actions.append(edit, remove);
    row.append(label, actions);
    els.keywords.appendChild(row);
  }
}

function mergeSettings(base, override) {
  const merged = {
    ...base,
    ...override,
    categories: {},
    customKeywords: Array.isArray(override?.customKeywords) ? override.customKeywords.map(normalizeKeyword).filter(Boolean) : base.customKeywords,
    customKeywordTextByPattern: normalizeCustomKeywordTextMap(override?.customKeywords, override?.customKeywordTextByPattern || base.customKeywordTextByPattern || {})
  };
  for (const key of Object.keys(base.categories || {})) {
    const categoryOverride = override?.categories?.[key] || {};
    merged.categories[key] = {
      ...base.categories[key],
      ...categoryOverride,
      label: base.categories[key].label
    };
    if (key === 'txt' && String(categoryOverride.color || '').toUpperCase() === '#F6DA71') {
      merged.categories[key].color = base.categories[key].color;
    }
  }
  if (base.categories?.user_added && merged.categories.user_added) {
    merged.categories.user_added.color = base.categories.user_added.color;
  }
  return merged;
}

function normalizeKeyword(value) {
  if (value && typeof value === 'object') return limitText(String(value.pattern || value.name || '').trim().replace(/\s+/g, ' '), MAX_KEYWORD_LENGTH);
  return limitText(String(value || '').trim().replace(/\s+/g, ' '), MAX_KEYWORD_LENGTH);
}

function normalizeHoverText(value) {
  return limitText(String(value || '').trim().replace(/\s+/g, ' '), MAX_HOVER_TEXT_LENGTH);
}

function limitText(value, maxLength) {
  return String(value || '').slice(0, maxLength).trim();
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

  return { init };
}

globalThis.AMH_CUSTOM_KEYWORDS_UI = Object.freeze({
  create: createCustomKeywordUi
});
