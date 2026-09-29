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

  globalScope.AMH_EXTENSION_UTILS = Object.freeze({ safeClassName, escapeHtml });
})(typeof globalThis !== 'undefined' ? globalThis : this);
