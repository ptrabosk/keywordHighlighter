(function installMessageContext(globalScope) {
  'use strict';

  // Numeric DOM constants so this module also runs against lightweight fakes.
  const ELEMENT_NODE = 1;
  const DOCUMENT_POSITION_FOLLOWING = 4;
  const MAX_ANCESTOR_DEPTH = 6;
  const BRAND_MESSAGE_SELECTOR = '.brand-message__text, [class*="brand-message"] p[class*="variant-caption"], [data-speaker="Brand"] p[class*="variant-caption"]';

  // Returns the text of up to `limit` brand messages that precede `element`,
  // searching the nearest conversation container first, then up to six
  // ancestors.
  function getRecentBrandMessageTexts(element, limit) {
    const scopedContainers = [
      element.closest('article, [class*="message-card"]'),
      element.closest('[data-message-id]')?.parentElement,
      element.closest('[class*="messages"]')
    ].filter(Boolean);

    for (const container of scopedContainers) {
      const candidates = getBrandMessagesBefore(container, element);
      if (candidates.length) return toTexts(candidates, limit);
    }

    let ancestor = element.parentElement;
    for (let depth = 0; ancestor && depth < MAX_ANCESTOR_DEPTH; depth += 1, ancestor = ancestor.parentElement) {
      const candidates = getBrandMessagesBefore(ancestor, element);
      if (candidates.length) return toTexts(candidates, limit);
    }

    return [];
  }

  function getBrandMessagesBefore(container, element) {
    return Array.from(container.querySelectorAll?.(BRAND_MESSAGE_SELECTOR) || [])
      .filter((node) => {
        if (!node || node.nodeType !== ELEMENT_NODE || node === element || !node.textContent) return false;
        return Boolean(node.compareDocumentPosition(element) & DOCUMENT_POSITION_FOLLOWING);
      });
  }

  function toTexts(nodes, limit) {
    return nodes.slice(-limit).map((node) => node.textContent || '');
  }

  const api = Object.freeze({ BRAND_MESSAGE_SELECTOR, getRecentBrandMessageTexts });
  globalScope.AMH_MESSAGE_CONTEXT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
