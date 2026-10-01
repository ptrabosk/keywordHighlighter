(() => {
  'use strict';

  const { createOperationalLogger, loadSyncSettings } = globalThis.AMH_EXTENSION_UTILS;
  const { installDiagnostics, persistStats } = globalThis.AMH_CONTENT_DIAGNOSTICS;

  if (document.documentElement.dataset.amhRuntimeLoaded === 'true') return;
  document.documentElement.dataset.amhRuntimeLoaded = 'true';

  if (typeof DEFAULT_SETTINGS === 'undefined' || typeof SETTINGS_KEY === 'undefined') {
    const message = 'settings.js did not load before content.js. Reload the unpacked extension and refresh the page.';
    document.documentElement.dataset.amhInitError = message;
    console.error('[Offsight Highlighter] Failed to initialize:', new Error(message));
    return;
  }

  if (!globalThis.AMH_HIGHLIGHT_CORE) {
    const message = 'highlight core did not load before content.js. Reload the unpacked extension and refresh the page.';
    document.documentElement.dataset.amhInitError = message;
    console.error('[Offsight Highlighter] Failed to initialize:', new Error(message));
    return;
  }

  if (!globalThis.AMH_SHORTCUT_TELEMETRY) {
    const message = 'shortcut telemetry did not load before content.js. Reload the extension and refresh the page.';
    document.documentElement.dataset.amhInitError = message;
    console.error('[Offsight Highlighter] Failed to initialize:', new Error(message));
    return;
  }

  const core = globalThis.AMH_HIGHLIGHT_CORE;
  const shortcutTelemetry = globalThis.AMH_SHORTCUT_TELEMETRY;
  const messageContext = globalThis.AMH_MESSAGE_CONTEXT;
  const RENDER_LOG_INTERVAL_MS = 5 * 60 * 1000;
  const DEBUG_LOG_INTERVAL_MS = 10 * 1000;
  const DEBUG_MUTATION_THRESHOLD = 50;
  const ESCALATION_HIGHLIGHT_COLOR = '#2E6F68';
  const HOT_TOPIC_BRAND_LOOKBACK_LIMIT = 3;
  const TOOLTIP_TARGET_SELECTOR = '.amh-escalation-highlight, .amh-message-highlight';

  const state = {
    rules: [],
    settings: DEFAULT_SETTINGS,
    observer: null,
    renderTimer: null,
    tooltip: null,
    targetSnapshots: new WeakMap(),
    escalationTargetSnapshots: new WeakMap(),
    loggedHighlightBlocks: new WeakSet(),
    loggedHighlightMessageIds: new Set(),
    stats: {
      loadedRules: 0,
      activeRules: 0,
      invalidRules: 0,
      highlightedElements: 0,
      highlights: 0,
      lastRunAt: null
    },
    lastRenderLogAt: 0,
    debug: {
      mutations: 0,
      renders: 0,
      lastMutationLogAt: 0,
      lastRenderStartedAt: 0,
      lastRenderDurationMs: 0,
      lastTrigger: 'startup'
    }
  };

  const { logOperationalEvent, logOperationalFailure } = createOperationalLogger({
    surface: 'content',
    decorate(loggedEvent) {
      if (loggedEvent.severity === 'error' || loggedEvent.eventType === 'highlight_detected' || loggedEvent.eventType === 'highlight_shortcut_pressed') {
        loggedEvent.pageUrl = window.location.href;
      }
    }
  });

  init().catch((error) => {
    document.documentElement.dataset.amhInitError = error && error.message ? error.message : String(error);
    logOperationalFailure('unexpected_exception', 'UNEXPECTED_ERROR', 'Content script startup failed', {
      operation: 'init'
    });
    console.error('[Offsight Highlighter] Failed to initialize:', error);
  });

  async function init() {
    state.settings = core.mergeSettings(DEFAULT_SETTINGS, await loadSettings());
    state.rules = await loadRules();
    state.stats.loadedRules = state.rules.length;
    installTooltipHandlers();
    installShortcutTelemetry();
    installMutationObserver();
    installMessageHandlers();
    installDiagnostics(state);
    scheduleRender(true);
  }

  async function loadSettings() {
    try {
      return await loadSyncSettings(SETTINGS_KEY, logOperationalFailure);
    } catch (error) {
      console.warn('[Offsight Highlighter] Could not load settings:', error);
      return {};
    }
  }

  async function loadRules() {
    const url = chrome.runtime.getURL('data/rules/opt_out_rules.json');
    try {
      const payload = await loadJsonResource(url, 'Rules');
      const rules = core.buildRules(payload);
      logOperationalEvent({
        eventType: 'rules_loaded',
        severity: 'info',
        result: 'success',
        ruleSource: 'opt_out_rules',
        metadata: { operation: 'rulesLoaded', ruleCount: rules.length }
      });
      return rules;
    } catch (error) {
      logOperationalFailure('rules_load_failed', 'RULES_LOAD_FAILED', 'Rules could not be fetched', {
        operation: 'rulesFetch'
      });
      throw new Error(`Rules load failed for ${url}. Select the highlighter folder in Load unpacked, then reload the extension. ${error.message || error}`);
    }
  }

  function installShortcutTelemetry() {
    document.addEventListener('keydown', (event) => {
      const shortcut = shortcutTelemetry.normalizeShortcutEvent(event);
      if (!shortcut) return;

      const highlightCount = shortcutTelemetry.countRenderedHighlightGroups(document);
      if (highlightCount < 1) return;

      logOperationalEvent({
        eventType: 'highlight_shortcut_pressed',
        severity: 'info',
        result: 'success',
        metadata: {
          shortcut,
          highlightCount
        }
      });
    }, true);
  }

  async function loadJsonResource(url, label) {
    let response;
    try {
      response = await fetch(url);
    } catch (error) {
      throw new Error(`${label} fetch failed. ${error.message || error}`);
    }
    if (!response.ok) {
      throw new Error(`${label} fetch returned HTTP ${response.status}.`);
    }
    const text = await response.text();
    try {
      return JSON.parse(text);
    } catch (error) {
      const preview = text.slice(0, 80).replace(/\s+/g, ' ');
      throw new Error(`${label} resource was not valid JSON. First bytes: ${JSON.stringify(preview)}. ${error.message || error}`);
    }
  }

  function installMutationObserver() {
    state.observer?.disconnect();
    state.observer = new MutationObserver((mutations) => {
      const relevantMutations = mutations.filter(isRelevantMutation);
      if (relevantMutations.length) {
        state.debug.mutations += relevantMutations.length;
        const now = Date.now();
        if (state.debug.mutations >= DEBUG_MUTATION_THRESHOLD && now - state.debug.lastMutationLogAt >= DEBUG_LOG_INTERVAL_MS) {
          state.debug.lastMutationLogAt = now;
          console.warn('[Offsight Highlighter] High mutation activity', {
            batchSize: relevantMutations.length,
            ignoredBatchSize: mutations.length - relevantMutations.length,
            relevantSinceLastWarning: state.debug.mutations,
            lastTrigger: state.debug.lastTrigger,
            pendingRender: Boolean(state.renderTimer)
          });
          state.debug.mutations = 0;
        }
        scheduleRender();
      }
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
  }

  function isRelevantMutation(mutation) {
    const extensionSelector = '.amh-extension-root, .amh-escalation-highlight, .amh-tooltip, .amh-highlight-count';
    const contentSelector = 'div[class*="type-INBOUND"], [class*="brand-message"], [data-speaker="Brand"], p[class*="variant-caption"]';
    const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
    if (!target || target.closest(extensionSelector)) return false;
    const insideContent = Boolean(target.closest(contentSelector));
    if (mutation.type === 'characterData') return insideContent;

    const nodes = [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])];
    // Our own span insertions/removals swap text nodes in and out; skip them.
    if (nodes.some((node) => node instanceof Element && node.matches(extensionSelector))) return false;
    for (const node of nodes) {
      if (node.nodeType === Node.TEXT_NODE) {
        if (insideContent && node.nodeValue?.trim()) return true;
        continue;
      }
      if (!(node instanceof Element)) continue;
      // Removed nodes are detached, so only the old parent tells us where they were.
      if (insideContent || node.matches(contentSelector) || node.querySelector(contentSelector)) return true;
    }
    return false;
  }

  function installMessageHandlers() {
    chrome.runtime.onMessage.addListener((message, _sender, sendResponse) => {
      if (!message || !message.type) return false;
      if (message.type === 'AMH_GET_STATS') {
        sendResponse({ stats: state.stats, settings: state.settings });
        return false;
      }
      if (message.type === 'AMH_REFRESH') {
        state.settings = core.mergeSettings(DEFAULT_SETTINGS, message.settings || state.settings);
        state.targetSnapshots = new WeakMap();
        state.escalationTargetSnapshots = new WeakMap();
        renderNow(true);
        sendResponse({ stats: state.stats });
        return false;
      }
      return false;
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'sync' || !changes[SETTINGS_KEY]) return;
      state.settings = core.mergeSettings(DEFAULT_SETTINGS, changes[SETTINGS_KEY].newValue || {});
      state.targetSnapshots = new WeakMap();
      state.escalationTargetSnapshots = new WeakMap();
      logOperationalEvent({
        eventType: 'settings_saved',
        severity: 'info',
        result: 'success',
        metadata: {
          operation: 'settingsApply',
          areaName,
          changeSource: 'storageChanged'
        }
      });
      renderNow(true);
    });
  }

  function scheduleRender(forceAll = false) {
    state.debug.lastTrigger = forceAll ? 'force' : 'mutation';
    window.clearTimeout(state.renderTimer);
    state.renderTimer = window.setTimeout(() => renderNow(forceAll), 120);
  }

  function renderNow(forceAll = false) {
    const startedAt = performance.now();
    state.debug.renders += 1;
    state.debug.lastRenderStartedAt = Date.now();
    state.debug.lastTrigger = forceAll ? 'force' : state.debug.lastTrigger;
    window.clearTimeout(state.renderTimer);
    state.renderTimer = null;

    try {
      const activeRules = core.getActiveRules(state.rules, state.settings);
      state.stats.activeRules = activeRules.length;
      state.stats.invalidRules = state.rules.filter((rule) => !rule.executable).length;
      state.stats.highlightedElements = 0;
      state.stats.highlights = 0;
      state.stats.lastRunAt = new Date().toISOString();

      if (!state.settings.enabled) {
        state.stats.highlightedElements = clearAllHighlights();
        state.targetSnapshots = new WeakMap();
        state.escalationTargetSnapshots = new WeakMap();
      } else {
        if (!activeRules.length) {
          state.stats.highlightedElements += clearAllRuleHighlights();
          state.targetSnapshots = new WeakMap();
        } else {
          for (const [block, paragraphs] of getMessageBlocks()) {
            const texts = paragraphs.map((paragraph) => paragraph.textContent || '');
            const snapshot = texts.join('\n');
            if (!forceAll && state.targetSnapshots.get(block) === snapshot) continue;
            clearMessageBlockHighlight(block);
            highlightMessageBlock(block, texts, activeRules);
            state.targetSnapshots.set(block, snapshot);
            state.stats.highlightedElements += 1;
          }
        }

        for (const target of getEscalationBulletElements()) {
          const snapshot = target.textContent || '';
          const cached = state.escalationTargetSnapshots.get(target);
          if (!forceAll && cached === snapshot) continue;
          clearHighlightElements(target.querySelectorAll('.amh-escalation-highlight'));
          highlightEscalationTarget(target);
          state.escalationTargetSnapshots.set(target, target.textContent || '');
          state.stats.highlightedElements += 1;
        }
      }

      persistStats(state);
      refreshHighlightCountBadge();
      maybeLogRenderCompleted({
        durationMs: performance.now() - startedAt,
        forceAll,
        changedElements: state.stats.highlightedElements,
        highlights: state.stats.highlights
      });
      state.debug.lastRenderDurationMs = performance.now() - startedAt;
    } catch (error) {
      state.targetSnapshots = new WeakMap();
      persistStats(state);
      logOperationalFailure('render_failed', 'RENDER_FAILED', error?.message || 'Render failed', {
        operation: 'render',
        trigger: forceAll ? 'force' : 'scheduled',
        ruleCount: state.rules.length,
        matchedCount: state.stats.highlights
      });
      console.warn('[Offsight Highlighter] Render failed and will retry on the next DOM update:', error);
    }
  }

  function refreshHighlightCountBadge() {
    const existingBadges = document.querySelectorAll('.amh-highlight-count');
    const isSupportedPage = window.location.hostname === 'ui.attentivemobile.com' &&
      window.location.pathname.startsWith('/concierge/');
    if (!isSupportedPage) {
      existingBadges.forEach((badge) => badge.remove());
      return;
    }

    const heading = Array.from(document.querySelectorAll('h1')).find((node) => {
      const text = Array.from(node.childNodes)
        .filter((child) => !(child instanceof Element && child.classList.contains('amh-highlight-count')))
        .map((child) => child.textContent || '')
        .join('')
        .trim();
      return text === 'CUSTOMER';
    });
    if (!heading) {
      existingBadges.forEach((badge) => badge.remove());
      return;
    }

    const section = heading.parentElement;
    let badge = section.querySelector(':scope > .amh-highlight-count');

    const count = state.settings.enabled ? countVisibleHighlightsForBadge() : 0;
    existingBadges.forEach((badge) => {
      if (badge.parentElement !== section) badge.remove();
    });

    badge ||= document.createElement('span');
    if (!count) {
      badge.remove();
      return;
    }

    if (!badge.parentElement) {
      badge.className = 'amh-highlight-count';
      badge.setAttribute('aria-live', 'polite');
      heading.insertAdjacentElement('afterend', badge);
    }
    if (badge.textContent !== String(count)) badge.textContent = String(count);
    badge.setAttribute('aria-label', `${count} highlight${count === 1 ? '' : 's'}`);
  }

  function countVisibleHighlightsForBadge() {
    return shortcutTelemetry.countRenderedHighlightGroups(document);
  }

  // Groups the configured inbound paragraphs by their message block so a
  // message with several <p> elements is classified once, as a whole.
  function getMessageBlocks() {
    const selector = state.settings.selector || DEFAULT_SETTINGS.selector;
    let nodes;
    try {
      nodes = document.querySelectorAll(selector);
    } catch (error) {
      console.warn('[Offsight Highlighter] Invalid selector, using default:', selector, error);
      nodes = document.querySelectorAll(DEFAULT_SETTINGS.selector);
    }
    const blocks = new Map();
    for (const node of nodes) {
      if (!(node instanceof HTMLElement)) continue;
      const block = node.closest('div[class*="type-INBOUND"]');
      if (!block) continue;
      const paragraphs = blocks.get(block) || [];
      paragraphs.push(node);
      blocks.set(block, paragraphs);
    }
    return blocks;
  }

  function getEscalationBulletElements() {
    const selector = 'div[class*="type-INBOUND"] p[class*="variant-caption"], [class*="brand-message"] p[class*="variant-caption"], [data-speaker="Brand"] p[class*="variant-caption"]';
    return Array.from(document.querySelectorAll(selector)).filter((node) => {
      return node instanceof HTMLElement && /\u2022/.test(node.textContent || '');
    });
  }

  function highlightMessageBlock(block, texts, activeRules) {
    const winningRule = core.classifyMessage(texts, activeRules, state.settings, {
      rules: state.rules,
      getRecentBrandTexts: () => messageContext.getRecentBrandMessageTexts(block, HOT_TOPIC_BRAND_LOOKBACK_LIMIT)
    });
    if (!winningRule) return;
    block.classList.add('amh-message-highlight');
    applyInsetHighlightStyle(block, winningRule);
    applyTooltipData(block, winningRule);
    state.stats.highlights += 1;
    logHighlightOnce(block);
  }

  function logHighlightOnce(block) {
    const messageId = block.closest('[data-message-id]')?.dataset.messageId;
    if (messageId) {
      if (state.loggedHighlightMessageIds.has(messageId)) return;
      state.loggedHighlightMessageIds.add(messageId);
    } else {
      if (state.loggedHighlightBlocks.has(block)) return;
      state.loggedHighlightBlocks.add(block);
    }
    logOperationalEvent({ eventType: 'highlight_detected', severity: 'info', result: 'success', metadata: {
      operation: 'message_highlight',
      ruleCount: state.rules.length
    } });
  }

  function clearAllHighlights() {
    return clearAllRuleHighlights() + clearHighlightElements(document.querySelectorAll('.amh-escalation-highlight'));
  }

  function clearAllRuleHighlights() {
    const blocks = document.querySelectorAll('.amh-message-highlight');
    for (const element of blocks) clearMessageBlockHighlight(element);
    return blocks.length;
  }

  function clearMessageBlockHighlight(element) {
    element.classList.remove('amh-message-highlight', 'amh-highlight--hover');
    element.style.removeProperty('--amh-highlight-background');
    element.style.removeProperty('--amh-highlight-border');
    for (const key of ['amhRuleTag', 'amhTooltipTitle']) {
      delete element.dataset[key];
    }
  }

  function clearHighlightElements(highlights) {
    let count = 0;
    for (const highlight of highlights) {
      const textNode = document.createTextNode(highlight.textContent || '');
      highlight.replaceWith(textNode);
      textNode.parentNode?.normalize();
      count += 1;
    }
    return count;
  }

  function highlightEscalationTarget(element) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest('.amh-escalation-highlight, .amh-tooltip, script, style, textarea, input, [contenteditable="true"]')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    let count = 0;
    for (const node of textNodes) count += highlightEscalationTextNode(node);
    state.stats.highlights += count;
  }

  function highlightEscalationTextNode(node) {
    const text = node.nodeValue;
    const matches = core.collectEscalationBulletMatches(text);
    if (!matches.length) return 0;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const match of matches) {
      if (match.start > cursor) fragment.appendChild(document.createTextNode(text.slice(cursor, match.start)));
      const span = document.createElement('span');
      span.className = 'amh-escalation-highlight';
      span.textContent = text.slice(match.start, match.end);
      applyEscalationHighlightStyle(span);
      span.dataset.amhRuleTag = match.rule.tag;
      span.dataset.amhTooltipTitle = match.rule.label;
      fragment.appendChild(span);
      cursor = match.end;
    }
    if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)));
    node.parentNode.replaceChild(fragment, node);
    return matches.length;
  }

  function applyInsetHighlightStyle(element, rule) {
    const category = state.settings.categories[rule.tag] || {};
    const color = category.color || '#a855f7';
    const opacity = clamp(Number(state.settings.opacity), 0.08, 0.85);
    element.style.setProperty('--amh-highlight-background', hexToRgba(color, opacity));
    element.style.setProperty('--amh-highlight-border', hexToRgba(color, Math.min(opacity + 0.18, 0.9)));
  }

  function applyEscalationHighlightStyle(span) {
    span.style.backgroundColor = hexToRgba(ESCALATION_HIGHLIGHT_COLOR, 0.78);
    span.style.boxShadow = `0 0 0 1px ${hexToRgba(ESCALATION_HIGHLIGHT_COLOR, 0.95)}`;
    span.style.color = '#FFFFFF';
    span.style.textShadow = '0 1px 1px rgba(0, 0, 0, 0.35)';
  }

  // Tooltips show only the category label of the winning rule.
  function applyTooltipData(element, rule) {
    const category = state.settings.categories[rule.tag] || {};
    element.dataset.amhRuleTag = rule.tag;
    element.dataset.amhTooltipTitle = category.label || rule.tag;
    element.removeAttribute('title');
  }

  function installTooltipHandlers() {
    document.addEventListener('mouseover', (event) => {
      const target = getTooltipTarget(event.target);
      if (!target || !state.settings.showTooltip) return;
      target.classList.add('amh-highlight--hover');
      showTooltip(target, event);
    }, true);
    document.addEventListener('mousemove', (event) => {
      if (!state.tooltip || state.tooltip.dataset.visible !== 'true') return;
      positionTooltip(event);
    }, true);
    document.addEventListener('mouseout', (event) => {
      const target = getTooltipTarget(event.target);
      if (!target || getTooltipTarget(event.relatedTarget) === target) return;
      target.classList.remove('amh-highlight--hover');
      hideTooltip();
    }, true);
  }

  // The innermost highlight wins, so an escalation note inside a highlighted
  // message shows its own label.
  function getTooltipTarget(node) {
    return node instanceof Element ? node.closest(TOOLTIP_TARGET_SELECTOR) : null;
  }

  function ensureTooltip() {
    if (state.tooltip && document.body.contains(state.tooltip)) return state.tooltip;
    const tooltip = document.createElement('div');
    tooltip.className = 'amh-tooltip';
    tooltip.setAttribute('role', 'tooltip');
    document.body.appendChild(tooltip);
    state.tooltip = tooltip;
    return tooltip;
  }

  function showTooltip(target, event) {
    const title = target.dataset.amhTooltipTitle || target.dataset.amhRuleTag || '';
    if (!title) return;
    const tooltip = ensureTooltip();
    tooltip.textContent = title;
    tooltip.dataset.visible = 'true';
    positionTooltip(event);
  }

  function hideTooltip() {
    if (!state.tooltip) return;
    state.tooltip.dataset.visible = 'false';
  }

  function positionTooltip(event) {
    const tooltip = ensureTooltip();
    const padding = 12;
    const offset = 16;
    const rect = tooltip.getBoundingClientRect();
    let left = event.clientX + offset;
    let top = event.clientY + offset;
    if (left + rect.width + padding > window.innerWidth) left = Math.max(padding, event.clientX - rect.width - offset);
    if (top + rect.height + padding > window.innerHeight) top = Math.max(padding, event.clientY - rect.height - offset);
    tooltip.style.left = `${left}px`;
    tooltip.style.top = `${top}px`;
  }

  function maybeLogRenderCompleted({ durationMs, forceAll, changedElements, highlights }) {
    const now = Date.now();
    const shouldLog = forceAll || changedElements > 0 || highlights > 0 || now - state.lastRenderLogAt >= RENDER_LOG_INTERVAL_MS;
    if (!shouldLog) return;
    state.lastRenderLogAt = now;
    logOperationalEvent({
      eventType: 'render_completed',
      severity: 'info',
      result: 'success',
      durationMs,
      ruleSource: 'opt_out_rules',
      metadata: {
        operation: 'render',
        trigger: forceAll ? 'force' : 'scheduled'
      }
    });
  }

  function hexToRgba(hex, alpha) {
    const normalized = String(hex || '').trim();
    const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(normalized);
    if (!match) return `rgba(168, 85, 247, ${alpha})`;
    return `rgba(${parseInt(match[1], 16)}, ${parseInt(match[2], 16)}, ${parseInt(match[3], 16)}, ${alpha})`;
  }

  function clamp(value, min, max) {
    if (Number.isNaN(value)) return min;
    return Math.min(max, Math.max(min, value));
  }
})();
