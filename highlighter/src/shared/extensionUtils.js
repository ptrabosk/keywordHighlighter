(function installExtensionUtils(globalScope) {
  'use strict';

  function safeClassName(value) {
    return String(value || 'unknown').replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  }

  function escapeHtml(value) {
    return String(value)
      .replaceAll('&', '&amp;')
      .replaceAll('<', '&lt;')
      .replaceAll('>', '&gt;')
      .replaceAll('"', '&quot;')
      .replaceAll("'", '&#039;');
  }

  // Sends sanitized-at-the-background operational events. `decorate` may add
  // surface-specific fields (for example the page URL) to the outgoing event.
  function createOperationalLogger({ surface, decorate } = {}) {
    function logOperationalEvent(event) {
      try {
        const loggedEvent = { surface, ...event };
        if (decorate) decorate(loggedEvent);
        chrome.runtime.sendMessage({ type: 'highlighter:logEvent', event: loggedEvent }).catch(() => {});
      } catch (_error) {
        // Logging must never affect extension behavior.
      }
    }

    function logOperationalFailure(eventType, errorCode, errorMessage, metadata = {}) {
      logOperationalEvent({ eventType, severity: 'error', result: 'failure', errorCode, errorMessage, metadata });
    }

    return { logOperationalEvent, logOperationalFailure };
  }

  async function loadSyncSettings(settingsKey, logOperationalFailure) {
    try {
      const result = await chrome.storage.sync.get(settingsKey);
      return result[settingsKey] || {};
    } catch (error) {
      logOperationalFailure('settings_load_failed', 'SETTINGS_LOAD_FAILED', 'Settings could not be loaded', {
        operation: 'settingsRead'
      });
      throw error;
    }
  }

  globalScope.AMH_EXTENSION_UTILS = Object.freeze({ safeClassName, escapeHtml, createOperationalLogger, loadSyncSettings });
})(typeof globalThis !== 'undefined' ? globalThis : this);
