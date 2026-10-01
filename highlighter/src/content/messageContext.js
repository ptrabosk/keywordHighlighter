(function installMessageContext(globalScope) {
  'use strict';

  // Numeric DOM constants so this module also runs against lightweight fakes.
  const ELEMENT_NODE = 1;
  const TEXT_NODE = 3;
  const DOCUMENT_POSITION_FOLLOWING = 4;
  const MAX_ANCESTOR_DEPTH = 6;
  const BRAND_MESSAGE_SELECTOR = '.brand-message__text, [class*="brand-message"] p[class*="variant-caption"], [data-speaker="Brand"] p[class*="variant-caption"]';
  const EXTENSION_SELECTOR = '.amh-extension-root, .amh-escalation-highlight, .amh-tooltip, .amh-highlight-count';
  const CONTENT_SELECTOR = 'div[class*="type-INBOUND"], [class*="brand-message"], [data-speaker="Brand"], p[class*="variant-caption"]';

  // Decides whether a DOM mutation can change what is highlighted: text edits
  // or added/removed nodes inside message content. Changes made by the
  // extension itself are ignored so highlighting does not trigger a re-render.
  function isRelevantMutation(mutation) {
    const target = toElement(mutation.target);
    if (!target || target.closest(EXTENSION_SELECTOR)) return false;
    const insideContent = Boolean(target.closest(CONTENT_SELECTOR));
    if (mutation.type === 'characterData') return insideContent;

    const nodes = [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])];
    if (nodes.some(isExtensionElement)) return false;
    return nodes.some((node) => isRelevantChangedNode(node, insideContent));
  }

  function toElement(node) {
    if (!node) return null;
    return node.nodeType === ELEMENT_NODE ? node : node.parentElement || null;
  }

  function isExtensionElement(node) {
    return node?.nodeType === ELEMENT_NODE && node.matches(EXTENSION_SELECTOR);
  }

  // Removed nodes are detached, so only the old parent says where they were.
  function isRelevantChangedNode(node, insideContent) {
    if (node.nodeType === TEXT_NODE) return insideContent && Boolean(node.nodeValue?.trim());
    if (node.nodeType !== ELEMENT_NODE) return false;
    return insideContent || node.matches(CONTENT_SELECTOR) || Boolean(node.querySelector(CONTENT_SELECTOR));
  }

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
      .filter(function isEarlierBrandMessage(node) {
        if (!node || node.nodeType !== ELEMENT_NODE || node === element || !node.textContent) return false;
        return Boolean(node.compareDocumentPosition(element) & DOCUMENT_POSITION_FOLLOWING);
      });
  }

  function toTexts(nodes, limit) {
    return nodes.slice(-limit).map((node) => node.textContent || '');
  }

  const api = Object.freeze({ BRAND_MESSAGE_SELECTOR, getRecentBrandMessageTexts, isRelevantMutation });
  globalScope.AMH_MESSAGE_CONTEXT = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
