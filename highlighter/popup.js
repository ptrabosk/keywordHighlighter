const { createOperationalLogger, loadSyncSettings } = globalThis.AMH_EXTENSION_UTILS;
const { parseKeywordCsv, serializeKeywordCsv } = globalThis.AMH_KEYWORD_CSV;

function createCustomKeywordUi({ surface = 'popup' } = {}) {
const els = {
  form: document.querySelector('#keywordForm'),
  input: document.querySelector('#keywordInput'),
  addKeyword: document.querySelector('#addKeyword'),
  keywords: document.querySelector('#keywords'),
  exportKeywords: document.querySelector('#exportKeywords'),
  importKeywords: document.querySelector('#importKeywords'),
  importFile: document.querySelector('#importFile'),
  status: document.querySelector('#status')
};

const core = globalThis.AMH_HIGHLIGHT_CORE;
const { mergeSettings, normalizeKeyword } = core;
const MIN_KEYWORD_LENGTH = core.MIN_CUSTOM_KEYWORD_LENGTH;
const MAX_KEYWORDS = core.MAX_CUSTOM_KEYWORDS;
// Chrome sync storage rejects a single item larger than this (key + JSON value).
const SYNC_ITEM_BYTE_LIMIT = globalThis.chrome?.storage?.sync?.QUOTA_BYTES_PER_ITEM || 8192;

let settings = structuredClone(DEFAULT_SETTINGS);
let featuresStarted = false;
let editingKeyword = null;

const { logOperationalEvent, logOperationalFailure } = createOperationalLogger({ surface });

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

function loadSettings() {
  return loadSyncSettings(SETTINGS_KEY, logOperationalFailure);
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
    return true;
  } catch (_error) {
    logOperationalFailure('settings_save_failed', 'SETTINGS_SAVE_FAILED', 'Settings could not be saved', {
      operation: 'customKeywordsSave'
    });
    return false;
  }
}

// Shows the change immediately; if saving fails, restores the previous list.
async function commitSettings(nextSettings) {
  const previous = settings;
  settings = nextSettings;
  renderKeywords();
  if (await saveSettings()) return true;
  settings = previous;
  renderKeywords();
  setStatus('Keywords could not be saved. Try again.');
  return false;
}

async function addKeyword(event) {
  event.preventDefault();
  const wasEditing = Boolean(editingKeyword);
  if (!els.input.value.trim()) {
    setStatus('Enter a keyword first.');
    return;
  }
  const keyword = normalizeKeyword(els.input.value);
  if (!keyword) {
    setStatus(`Keywords need at least ${MIN_KEYWORD_LENGTH} characters.`);
    return;
  }
  if (settings.customKeywords.some((item) => item.toLowerCase() === keyword.toLowerCase() && item.toLowerCase() !== String(editingKeyword || '').toLowerCase())) {
    setStatus('That keyword is already in the list.');
    return;
  }
  if (!wasEditing && settings.customKeywords.length >= MAX_KEYWORDS) {
    setStatus(`You can save up to ${MAX_KEYWORDS} keywords. Remove one first.`);
    return;
  }
  const nextSettings = {
    ...settings,
    customKeywords: settings.customKeywords
      .filter((item) => item !== editingKeyword)
      .concat(keyword)
      .sort((a, b) => a.localeCompare(b))
  };
  if (exceedsSyncItemLimit(nextSettings)) {
    setStatus('Not enough sync storage for this keyword. Remove a keyword first.');
    return;
  }
  if (!(await commitSettings(nextSettings))) return;
  if (wasEditing) {
    editingKeyword = null;
    els.addKeyword.textContent = 'ADD KEYWORD';
  }
  els.input.value = '';
  setStatus(wasEditing ? 'Keyword updated.' : 'Keyword added.');
}

function editKeyword(keyword) {
  editingKeyword = keyword;
  els.input.value = keyword;
  els.addKeyword.textContent = 'SAVE KEYWORD';
  els.input.focus();
}

async function removeKeyword(keyword) {
  const nextSettings = { ...settings, customKeywords: settings.customKeywords.filter((item) => item !== keyword) };
  if (!(await commitSettings(nextSettings))) return;
  setStatus('Keyword removed.');
  if (editingKeyword === keyword) {
    editingKeyword = null;
    els.input.value = '';
    els.addKeyword.textContent = 'ADD KEYWORD';
  }
}

function exportKeywords() {
  const csv = serializeKeywordCsv((settings.customKeywords || []).map((keyword) => ({ keyword })));
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
    const nextSettings = mergeSettings(DEFAULT_SETTINGS, {
      ...settings,
      customKeywords: imported.customKeywords
    });
    if (exceedsSyncItemLimit(nextSettings)) {
      setStatus('Import is too large for sync storage. Remove some keywords from the CSV.');
      return;
    }
    if (!(await commitSettings(nextSettings))) return;
    const count = settings.customKeywords.length;
    const skipped = imported.skippedShort + Math.max(0, imported.customKeywords.length - count);
    const skippedNote = skipped
      ? ` Skipped ${skipped}: keywords need ${MIN_KEYWORD_LENGTH}+ characters and the list holds up to ${MAX_KEYWORDS}.`
      : '';
    setStatus(`Imported ${count} keyword${count === 1 ? '' : 's'}.${skippedNote}`);
  } catch (error) {
    logOperationalFailure('settings_save_failed', 'KEYWORD_IMPORT_FAILED', 'Keyword backup could not be imported', {
      operation: 'customKeywordsImport'
    });
    setStatus('Import failed. Choose a CSV file whose first row is the keyword header.');
  }
}

function parseKeywordImport(csvText) {
  const importedByKeyword = new Map();
  let skippedShort = 0;
  for (const row of parseKeywordCsv(csvText)) {
    const keyword = normalizeKeyword(row.keyword);
    if (!keyword) {
      if (String(row.keyword || '').trim()) skippedShort += 1;
      continue;
    }
    const key = keyword.toLocaleLowerCase();
    if (!importedByKeyword.has(key)) importedByKeyword.set(key, keyword);
  }
  const customKeywords = Array.from(importedByKeyword.values()).sort((a, b) => a.localeCompare(b));
  return { customKeywords, skippedShort };
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

function exceedsSyncItemLimit(nextSettings) {
  return new TextEncoder().encode(SETTINGS_KEY + JSON.stringify(nextSettings)).length > SYNC_ITEM_BYTE_LIMIT;
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
