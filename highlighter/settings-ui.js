function createSettingsUi({ statusSaved = 'Saved.', statusReset = 'Defaults restored.' } = {}) {
  const MAX_KEYWORD_LENGTH = 128;
  const MAX_HOVER_TEXT_LENGTH = 256;

  const els = {
    enabled: document.querySelector('#enabled'),
    showTooltip: document.querySelector('#showTooltip'),
    opacity: document.querySelector('#opacity'),
    opacityValue: document.querySelector('#opacityValue'),
    selector: document.querySelector('#selector'),
    categories: document.querySelector('#categories'),
    save: document.querySelector('#save'),
    reset: document.querySelector('#reset'),
    status: document.querySelector('#status')
  };

  let settings = structuredClone(DEFAULT_SETTINGS);

  function logOperationalEvent(event) {
    try {
      chrome.runtime.sendMessage({
        type: 'highlighter:logEvent',
        event: {
          surface: 'options',
          ...event
        }
      }).catch(() => {});
    } catch (_error) {
      // Logging must never affect settings behavior.
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
    logOperationalFailure('unexpected_exception', 'UNEXPECTED_ERROR', 'Options startup failed', {
      operation: 'init'
    });
    console.error('[Offisght Operations Rule Highlighter] Settings UI failed to initialize:', error);
  });

  async function init() {
    const startedAt = performance.now();
    settings = mergeSettings(DEFAULT_SETTINGS, await loadSettings());
    render();
    els.save.addEventListener('click', save);
    els.reset.addEventListener('click', reset);
    els.opacity.addEventListener('input', updateOpacityLabel);
    logOperationalEvent({
      eventType: 'options_opened',
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

  function render() {
    els.enabled.checked = settings.enabled !== false;
    els.showTooltip.checked = settings.showTooltip !== false;
    els.opacity.value = settings.opacity;
    updateOpacityLabel();
    els.selector.value = settings.selector;
    els.categories.innerHTML = '';

    for (const [key, category] of Object.entries(settings.categories)) {
      const isFixedColor = key === 'user_added';
      const row = document.createElement('div');
      row.className = 'category';
      row.innerHTML = `
        <input data-key="${escapeHtml(key)}" data-field="enabled" type="checkbox" ${category.enabled !== false ? 'checked' : ''}>
        <div class="category__label">
          <strong>${escapeHtml(category.label || key)}</strong>
          <span>${escapeHtml(key)}</span>
        </div>
        ${isFixedColor
          ? `<span class="color-swatch" style="background:${escapeHtml(category.color || '#a855f7')}" aria-label="Fixed project color"></span>`
          : `<input data-key="${escapeHtml(key)}" data-field="color" type="color" value="${escapeHtml(category.color || '#a855f7')}">`
        }
      `;
      els.categories.appendChild(row);
    }
  }

  async function save() {
    const next = collectSettings();
    if (!isValidSelector(next.selector)) {
      setStatus('Selector is invalid. Fix it before saving.');
      return;
    }

    try {
      await chrome.storage.sync.set({ [SETTINGS_KEY]: next });
      settings = next;
      logOperationalEvent({
        eventType: 'settings_saved',
        severity: 'info',
        result: 'success',
        metadata: {
          operation: 'settingsSave',
          changeSource: 'options'
        }
      });
      setStatus(statusSaved);
    } catch (error) {
      logOperationalFailure('settings_save_failed', 'SETTINGS_SAVE_FAILED', 'Settings could not be saved', {
        operation: 'settingsSave'
      });
      throw error;
    }
  }

  async function reset() {
    settings = structuredClone(DEFAULT_SETTINGS);
    render();
    try {
      await chrome.storage.sync.set({ [SETTINGS_KEY]: settings });
      logOperationalEvent({
        eventType: 'settings_reset',
        severity: 'info',
        result: 'success',
        metadata: {
          operation: 'settingsReset',
          changeSource: 'options'
        }
      });
      setStatus(statusReset);
    } catch (error) {
      logOperationalFailure('settings_save_failed', 'SETTINGS_SAVE_FAILED', 'Default settings could not be saved', {
        operation: 'settingsReset'
      });
      throw error;
    }
  }

  function collectSettings() {
    const next = mergeSettings(DEFAULT_SETTINGS, settings);
    next.enabled = els.enabled.checked;
    next.showTooltip = els.showTooltip.checked;
    next.opacity = Number(els.opacity.value);
    next.selector = els.selector.value.trim() || DEFAULT_SETTINGS.selector;

    for (const input of els.categories.querySelectorAll('[data-key]')) {
      const key = input.dataset.key;
      const field = input.dataset.field;
      next.categories[key] = next.categories[key] || {};
      if (field === 'enabled') next.categories[key].enabled = input.checked;
      if (field === 'color') next.categories[key].color = input.value;
    }

    return next;
  }

  function updateOpacityLabel() {
    els.opacityValue.value = `${Math.round(Number(els.opacity.value) * 100)}%`;
  }

  function isValidSelector(selector) {
    try {
      document.querySelector(selector);
      return true;
    } catch (_error) {
      return false;
    }
  }

  function mergeSettings(base, override) {
    const merged = {
      ...base,
      ...override,
      categories: {}
    };

    const keys = new Set([
      ...Object.keys(base.categories || {}),
      ...Object.keys((override && override.categories) || {})
    ]);

    for (const key of keys) {
      merged.categories[key] = {
        ...(base.categories[key] || {}),
        ...((override.categories && override.categories[key]) || {})
      };
    }
    if (base.categories.user_added && merged.categories.user_added) {
      merged.categories.user_added.color = base.categories.user_added.color;
    }

    merged.opacity = clamp(Number(merged.opacity ?? base.opacity), 0.08, 0.85);
    merged.selector = String(merged.selector || base.selector);
    merged.customKeywords = Array.isArray(override?.customKeywords)
      ? Array.from(new Set(override.customKeywords.map(normalizeKeyword).filter(Boolean)))
      : [...(base.customKeywords || [])];
    merged.customKeywordTextByPattern = normalizeCustomKeywordTextMap(
      override?.customKeywords,
      override?.customKeywordTextByPattern || base.customKeywordTextByPattern || {}
    );
    return merged;
  }

  function normalizeKeyword(value) {
    if (value && typeof value === 'object') return limitText(String(value.pattern || value.name || '').trim().replace(/\s+/g, ' '), MAX_KEYWORD_LENGTH);
    return limitText(String(value || '').trim().replace(/\s+/g, ' '), MAX_KEYWORD_LENGTH);
  }

  function normalizeCustomKeywordTextMap(customKeywords, existingTextByPattern = {}) {
    const textByPattern = {};
    for (const item of customKeywords || []) {
      if (item && typeof item === 'object') {
        const pattern = normalizeKeyword(item);
        if (pattern) textByPattern[pattern] = limitText(String(item.text || existingTextByPattern[pattern] || '').trim().replace(/\s+/g, ' '), MAX_HOVER_TEXT_LENGTH);
      }
    }
    for (const [pattern, text] of Object.entries(existingTextByPattern || {})) {
      const normalized = normalizeKeyword(pattern);
      if (normalized && !(normalized in textByPattern)) textByPattern[normalized] = limitText(String(text || '').trim().replace(/\s+/g, ' '), MAX_HOVER_TEXT_LENGTH);
    }
    return textByPattern;
  }

  function limitText(value, maxLength) {
    return String(value || '').slice(0, maxLength).trim();
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

  function clamp(value, min, max) {
    if (Number.isNaN(value)) return min;
    return Math.min(max, Math.max(min, value));
  }
}
