(function installContentDiagnostics(globalScope) {
  'use strict';

  function installDiagnostics(state) {
    window.addEventListener('error', function logPageError(event) {
      const error = event.error;
      console.warn('[Offsight Highlighter] Page error observed', {
        message: event.message || error?.message || 'unknown error',
        stack: error?.stack || '(no stack)',
        source: event.filename || '(unknown)',
        line: event.lineno || 0,
        column: event.colno || 0,
        highlighter: { ...state.debug }
      });
    }, true);
    window.addEventListener('unhandledrejection', function logUnhandledRejection(event) {
      const reason = event.reason;
      console.warn('[Offsight Highlighter] Unhandled rejection observed', {
        message: reason?.message || String(reason || 'unknown rejection'),
        stack: reason?.stack || '(no stack)',
        highlighter: { ...state.debug }
      });
    }, true);
  }

  function persistStats(state) {
    document.documentElement.dataset.amhStats = JSON.stringify(state.stats);
    chrome.storage.local.set({ amhLastStats: state.stats }).catch(() => {});
  }

  globalScope.AMH_CONTENT_DIAGNOSTICS = Object.freeze({ installDiagnostics, persistStats });
})(typeof globalThis !== 'undefined' ? globalThis : this);
