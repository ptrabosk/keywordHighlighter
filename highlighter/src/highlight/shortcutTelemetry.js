(function initShortcutTelemetry(globalScope) {
  'use strict';

  const SHORTCUT_KEYS = new Set(['D', 'N', 'B', 'C', 'E']);

  function isEditableTarget(target) {
    if (!target) return false;
    if (target.isContentEditable === true) return true;
    const tagName = String(target.tagName || '').toUpperCase();
    if (tagName === 'INPUT' || tagName === 'TEXTAREA') return true;
    return typeof target.closest === 'function' && Boolean(target.closest('input, textarea, [contenteditable="true"]'));
  }

  function normalizeShortcutEvent(event) {
    if (!event || event.isTrusted !== true || event.shiftKey !== true || event.repeat === true ||
        event.ctrlKey === true || event.altKey === true || event.metaKey === true || isEditableTarget(event.target)) return null;
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
    // Highlighted messages plus highlighted escalation notes.
    const elements = [
      ...root.querySelectorAll('.amh-message-highlight'),
      ...root.querySelectorAll('.amh-escalation-highlight')
    ];
    const count = elements.filter((element) => rendered(element)).length;
    return Math.min(1000, count);
  }

  const api = Object.freeze({
    normalizeShortcutEvent,
    isRenderedHighlight,
    countRenderedHighlightGroups
  });

  globalScope.AMH_SHORTCUT_TELEMETRY = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
