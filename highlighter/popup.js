const els = {
  form: document.querySelector('#keywordForm'),
  input: document.querySelector('#keywordInput'),
  keywords: document.querySelector('#keywords'),
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
