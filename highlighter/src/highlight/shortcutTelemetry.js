(function initShortcutTelemetry(globalScope) {
  'use strict';

  const SHORTCUT_KEYS = new Set(['D', 'N', 'B', 'C']);

  function normalizeShortcutEvent(event) {
    if (!event || event.isTrusted !== true || event.shiftKey !== true || event.repeat === true) return null;
    const key = String(event.key || '').toUpperCase();
    return SHORTCUT_KEYS.has(key) ? `Shift+${key}` : null;
  }

  function isRenderedHighlight(element, view = globalScope) {
    if (!element || typeof element.getClientRects !== 'function' || element.getClientRects().length === 0) return false;
    const style = typeof view.getComputedStyle === 'function' ? view.getComputedStyle(element) : null;
    if (!style) return true;
    return style.display !== 'none' &&
      style.visibility !== 'hidden' &&
      style.visibility !== 'collapse' &&
      style.opacity !== '0';
  }

  function countRenderedHighlightGroups(root, options = {}) {
    if (!root || typeof root.querySelectorAll !== 'function') return 0;
    const view = options.view || globalScope;
    const rendered = options.isRendered || ((element) => isRenderedHighlight(element, view));
    const groupIds = new Set();
    let ungroupedCount = 0;

    for (const element of root.querySelectorAll('.amh-highlight')) {
      if (!rendered(element)) continue;
      const groupId = element.dataset?.amhMatchGroupId;
      if (groupId) groupIds.add(groupId);
      else ungroupedCount += 1;
    }

    return Math.min(1000, groupIds.size + ungroupedCount);
  }

  const api = Object.freeze({
    normalizeShortcutEvent,
    isRenderedHighlight,
    countRenderedHighlightGroups
  });

  globalScope.AMH_SHORTCUT_TELEMETRY = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
