(() => {
  'use strict';

  const { escapeHtml, safeClassName } = globalThis.AMH_EXTENSION_UTILS;
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

  if (!globalThis.AMH_ACCESS_POLICY) {
    const message = 'access policy did not load before content.js. Reload the extension and refresh the page.';
    document.documentElement.dataset.amhInitError = message;
    console.error('[Offsight Highlighter] Failed to initialize:', new Error(message));
    return;
  }

  const core = globalThis.AMH_HIGHLIGHT_CORE;
  const shortcutTelemetry = globalThis.AMH_SHORTCUT_TELEMETRY;
  const RENDER_LOG_INTERVAL_MS = 5 * 60 * 1000;
  const DEBUG_LOG_INTERVAL_MS = 10 * 1000;
  const DEBUG_MUTATION_THRESHOLD = 50;
  const ESCALATION_HIGHLIGHT_COLOR = '#2E6F68';
  const HOT_TOPIC_BRAND_LOOKBACK_LIMIT = 3;

  const state = {
    rules: [],
    hoverText: {},
    settings: DEFAULT_SETTINGS,
    observer: null,
    renderTimer: null,
    tooltip: null,
    targetSnapshots: new WeakMap(),
    escalationTargetSnapshots: new WeakMap(),
    accessAllowed: false,
    accessRecheckTimer: null,
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
    },
    nextMatchGroupId: 1
  };

  function logOperationalEvent(event) {
    try {
      chrome.runtime.sendMessage({
        type: 'highlighter:logEvent',
        event: {
          surface: 'content',
          ...event
        }
      }).catch(() => {});
    } catch (_error) {
      // Logging must never affect highlighting.
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
    document.documentElement.dataset.amhInitError = error && error.message ? error.message : String(error);
    logOperationalFailure('unexpected_exception', 'UNEXPECTED_ERROR', 'Content script startup failed', {
      operation: 'init'
    });
    console.error('[Offsight Highlighter] Failed to initialize:', error);
  });

  async function init() {
    const access = await AMH_ACCESS_POLICY.requestAccessStatus();
    if (!access.allowed) {
      document.documentElement.dataset.amhAccessDenied = 'true';
      document.documentElement.dataset.amhAccessReason = access.reason;
      return;
    }
    state.accessAllowed = true;
    state.settings = core.mergeSettings(DEFAULT_SETTINGS, await loadSettings());
    const [rules, hoverText] = await Promise.all([loadRules(), loadHoverText()]);
    state.rules = rules;
    state.hoverText = hoverText;
    state.stats.loadedRules = state.rules.length;
    installTooltipHandlers();
    installShortcutTelemetry();
    installMutationObserver();
    installMessageHandlers();
    installDiagnostics(state);
    scheduleAccessRecheck();
    scheduleRender(true);
  }

  function scheduleAccessRecheck() {
    window.clearInterval(state.accessRecheckTimer);
    state.accessRecheckTimer = window.setInterval(async () => {
      const access = await AMH_ACCESS_POLICY.requestAccessStatus();
      if (access.allowed || !state.accessAllowed) return;

      state.accessAllowed = false;
      window.clearInterval(state.accessRecheckTimer);
      state.accessRecheckTimer = null;
      state.observer?.disconnect();
      state.observer = null;
      window.clearTimeout(state.renderTimer);
      state.renderTimer = null;
      clearAllHighlights();
      refreshHighlightCountBadge();
      document.documentElement.dataset.amhAccessDenied = 'true';
      document.documentElement.dataset.amhAccessReason = access.reason;
    }, 5 * 60 * 1000);
  }

  async function loadSettings() {
    try {
      const result = await chrome.storage.sync.get(SETTINGS_KEY);
      return result[SETTINGS_KEY] || {};
    } catch (error) {
      logOperationalFailure('settings_load_failed', 'SETTINGS_LOAD_FAILED', 'Settings could not be loaded', {
        operation: 'settingsRead'
      });
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

  async function loadHoverText() {
    const url = chrome.runtime.getURL('data/rules/rule_hover_text.json');
    try {
      return await loadJsonResource(url, 'Hover text');
    } catch (error) {
      logOperationalFailure('hover_text_load_failed', 'HOVER_TEXT_LOAD_FAILED', 'Hover text could not be loaded', {
        operation: 'hoverTextFetch'
      });
      console.warn('[Offsight Highlighter] Could not load hover text:', error);
      return {};
    }
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
    const extensionSelector = '.amh-extension-root, .amh-highlight, .amh-escalation-highlight, .amh-tooltip, .amh-highlight-count';
    const contentSelector = 'div[class*="type-INBOUND"], [class*="brand-message"], [data-speaker="Brand"], p[class*="variant-caption"]';
    const target = mutation.target instanceof Element ? mutation.target : mutation.target.parentElement;
    if (target?.closest(extensionSelector)) return false;
    if (mutation.type === 'characterData') return Boolean(target?.closest(contentSelector));

    const nodes = [...(mutation.addedNodes || []), ...(mutation.removedNodes || [])];
    return nodes.some((node) => {
      if (node.nodeType === Node.TEXT_NODE) return Boolean(node.nodeValue?.trim() && target?.closest(contentSelector));
      if (!(node instanceof Element) || node.closest(extensionSelector)) return false;
      if (!node.textContent?.trim()) return false;
      return Boolean(
        target?.closest(contentSelector) ||
        node.closest(contentSelector) ||
        node.matches(contentSelector) ||
        node.querySelector(contentSelector)
      );
    });
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
      if (!state.accessAllowed) {
        clearAllHighlights();
        refreshHighlightCountBadge();
        return;
      }
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
          const targets = getTargetElements();
          for (const target of targets) {
            const snapshot = target.textContent || '';
            const cached = state.targetSnapshots.get(target);
            if (!forceAll && cached === snapshot) continue;
            clearHighlightsWithin(target);
            highlightTarget(target, activeRules);
            state.targetSnapshots.set(target, target.textContent || '');
            state.stats.highlightedElements += 1;
          }
        }

        const escalationTargets = getEscalationBulletElements();
        for (const target of escalationTargets) {
          const snapshot = target.textContent || '';
          const cached = state.escalationTargetSnapshots.get(target);
          if (!forceAll && cached === snapshot) continue;
          clearHighlightsWithin(target);
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
    const count = shortcutTelemetry.countRenderedHighlightGroups(document);
    const messageHighlights = Array.from(document.querySelectorAll('.amh-message-highlight'))
      .filter((element) => !element.querySelector('.amh-highlight'))
      .filter((element) => shortcutTelemetry.isRenderedHighlight(element));
    return Math.min(1000, count + messageHighlights.length);
  }

  function getTargetElements() {
    let selector = state.settings.selector || DEFAULT_SETTINGS.selector;
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(selector));
    } catch (error) {
      console.warn('[Offsight Highlighter] Invalid selector, using default:', selector, error);
      nodes = Array.from(document.querySelectorAll(DEFAULT_SETTINGS.selector));
    }
    const brandNodes = Array.from(document.querySelectorAll(getBrandMessageSelector()))
      .filter((node) => node instanceof HTMLElement && isHotTopicBrandPrompt(node.textContent || ''));
    return uniqueElements([...nodes, ...brandNodes]).filter((node) => {
      if (!(node instanceof HTMLElement) || node.closest('.amh-tooltip') || !isVisible(node)) return false;
      return node.closest('div[class*="type-INBOUND"]') || isHotTopicBrandElement(node);
    });
  }

  function uniqueElements(nodes) {
    return Array.from(new Set(nodes));
  }

  function getEscalationBulletElements() {
    const selector = 'div[class*="type-INBOUND"] p[class*="variant-caption"], [class*="brand-message"] p[class*="variant-caption"], [data-speaker="Brand"] p[class*="variant-caption"]';
    return Array.from(document.querySelectorAll(selector)).filter((node) => {
      return node instanceof HTMLElement && isVisible(node) && /\u2022/.test(node.textContent || '');
    });
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function highlightTarget(element, activeRules) {
    const segments = collectTextNodeSegments(element);
    const text = segments.map((segment) => segment.text).join('');
    if (!text.trim()) return;

    const matches = mergeContextualMatches([
      ...collectContextualMessageMatches(element, text),
      ...core.collectMatches(text, activeRules, state.settings)
    ]);
    if (!matches.length) return;

    const winningMatch = matches[0];
    applyMessageBlockHighlight(element, winningMatch.rule, text);
    const matchesByNode = mapMatchesToTextNodeSegments(segments, matches, text);
    for (const [node, nodeMatches] of matchesByNode) {
      wrapTextNodeMatches(node, nodeMatches);
    }
    state.stats.highlights += 1;
    logOperationalEvent({ eventType: 'highlight_detected', severity: 'info', result: 'success', metadata: {
      operation: 'message_highlight',
      highlightCount: 1,
      ruleCount: state.rules.length,
      matchedCount: state.stats.highlights
    } });
  }

  function applyMessageBlockHighlight(element, rule, messageText) {
    const messageBlock = element.closest('div[class*="type-INBOUND"]') || element;
    messageBlock.classList.add('amh-message-highlight');
    applyInsetHighlightStyle(messageBlock, rule);
    applyTooltipData(messageBlock, rule, messageText);
  }

  function collectContextualMessageMatches(element, text) {
    const hotTopicPromptRule = getHotTopicPromptRule(element);
    if (hotTopicPromptRule) {
      return [{
        start: 0,
        end: text.length,
        length: text.length,
        rule: hotTopicPromptRule
      }];
    }

    const hotTopicRule = getHotTopicContextualRule(element, text);
    if (!hotTopicRule) return [];
    return [{
      start: 0,
      end: text.length,
      length: text.length,
      rule: hotTopicRule
    }];
  }

  function getHotTopicContextualRule(element, text) {
    if (!element.closest('div[class*="type-INBOUND"]')) return null;
    const brandTexts = getRecentBrandMessageTexts(element, HOT_TOPIC_BRAND_LOOKBACK_LIMIT);
    if (!brandTexts.some(isHotTopicBrandPrompt)) return null;

    const normalizedReply = core.normalizeMessageBody(text);
    const isOptOut = /\b(?:4|four|never)\b/i.test(normalizedReply);
    const isPositiveChoice = /\b(?:1|one|same|2|two|weekly|3|three|monthly)\b/i.test(normalizedReply);
    if (!isOptOut && !isPositiveChoice) return null;
    const detector = isOptOut ? 'hot_topic_opt_out' : 'hot_topic_not_opt_out';
    const rule = state.rules.find((item) => item.detector === detector) || createHotTopicFallbackRule(isOptOut);
    if (!rule || !isRuleCategoryEnabled(rule)) return null;
    return rule;
  }

  function getHotTopicPromptRule(element) {
    if (!isHotTopicBrandElement(element)) return null;
    const rule = state.rules.find((item) => item.detector === 'hot_topic_not_opt_out') || createHotTopicFallbackRule(false);
    if (!rule || !isRuleCategoryEnabled(rule)) return null;
    return rule;
  }

  function isHotTopicBrandElement(element) {
    return element instanceof HTMLElement && Boolean(element.closest('[class*="brand-message"], [data-speaker="Brand"]')) && isHotTopicBrandPrompt(element.textContent || '');
  }

  function getBrandMessageSelector() {
    return '.brand-message__text, [class*="brand-message"] p[class*="variant-caption"], [data-speaker="Brand"] p[class*="variant-caption"]';
  }

  function getRecentBrandMessageTexts(element, limit) {
    const brandSelector = getBrandMessageSelector();
    const scopedContainers = [
      element.closest('article, [class*="message-card"]'),
      element.closest('[data-message-id]')?.parentElement,
      element.closest('[class*="messages"]')
    ].filter(Boolean);

    for (const container of scopedContainers) {
      const candidates = getBrandMessagesBefore(container, brandSelector, element);
      if (candidates.length) return candidates.slice(-limit).map((brand) => brand.textContent || '');
    }

    let ancestor = element.parentElement;
    for (let depth = 0; ancestor && depth < 6; depth += 1, ancestor = ancestor.parentElement) {
      const candidates = getBrandMessagesBefore(ancestor, brandSelector, element);
      if (candidates.length) return candidates.slice(-limit).map((brand) => brand.textContent || '');
    }

    return [];
  }

  function getBrandMessagesBefore(container, selector, element) {
    return Array.from(container.querySelectorAll?.(selector) || [])
      .filter((node) => {
        if (!(node instanceof HTMLElement) || node === element || !node.textContent) return false;
        return Boolean(node.compareDocumentPosition(element) & Node.DOCUMENT_POSITION_FOLLOWING);
      });
  }

  function isHotTopicBrandPrompt(text) {
    const normalized = core.normalizeMessageBody(text);
    return normalized.startsWith('hot topic') &&
      /\b1\s+same\b/.test(normalized) &&
      /\b2\s+weekly\b/.test(normalized) &&
      /\b3\s+monthly\b/.test(normalized) &&
      /\b4\s+never\b/.test(normalized);
  }

  function createHotTopicFallbackRule(isOptOut) {
    const action = isOptOut ? 'opt_out' : 'close';
    return {
      id: isOptOut ? 'contextual_hot_topic_opt_out' : 'contextual_hot_topic_not_opt_out',
      name: isOptOut ? 'opt_outs_ml.hot_topic_opt_out' : 'opt_outs_ml.hot_topic_not_opt_out',
      tag: action,
      action,
      pattern: isOptOut ? 'Hot Topic customer reply contains 4, four, or never.' : 'Hot Topic customer reply does not contain 4, four, or never.',
      conditionSummary: isOptOut
        ? 'Brand message is a Hot Topic frequency prompt and the customer reply contains 4, four, or never.'
        : 'Brand message is a Hot Topic frequency prompt and the customer reply does not contain 4, four, or never.'
    };
  }

  function isRuleCategoryEnabled(rule) {
    const category = state.settings.categories[rule.tag];
    return category && category.enabled !== false;
  }

  function mergeContextualMatches(matches) {
    const candidates = matches
      .filter((match) => match && match.start < match.end)
      .sort((a, b) => {
        if (a.start !== b.start) return a.start - b.start;
        if (b.length !== a.length) return b.length - a.length;
        return (state.settings.categories[a.rule.tag]?.priority ?? 999) - (state.settings.categories[b.rule.tag]?.priority ?? 999);
      });
    const accepted = [];
    for (const candidate of candidates) {
      if (!accepted.some((existing) => candidate.start < existing.end && candidate.end > existing.start)) {
        accepted.push(candidate);
      }
    }
    return accepted.sort((a, b) => a.start - b.start);
  }

  function collectTextNodeSegments(element) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest('.amh-highlight, .amh-escalation-highlight, .amh-tooltip, script, style, textarea, input, [contenteditable="true"]')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const segments = [];
    let offset = 0;
    while (walker.nextNode()) {
      const node = walker.currentNode;
      const text = node.nodeValue || '';
      segments.push({
        node,
        text,
        start: offset,
        end: offset + text.length
      });
      offset += text.length;
    }
    return segments;
  }

  function mapMatchesToTextNodeSegments(segments, matches, fullText) {
    const byNode = new Map();
    matches.forEach((match, matchIndex) => {
      const intersectingSegments = segments.filter((segment) => !(match.start >= segment.end || match.end <= segment.start));
      const matchGroupId = String(state.nextMatchGroupId++);
      intersectingSegments.forEach((segment, partIndex) => {
        const nodeStart = Math.max(match.start, segment.start) - segment.start;
        const nodeEnd = Math.min(match.end, segment.end) - segment.start;
        const nodeMatches = byNode.get(segment.node) || [];
        nodeMatches.push({
          start: nodeStart,
          end: nodeEnd,
          rule: match.rule,
          matchedText: fullText.slice(match.start, match.end),
          matchId: matchIndex,
          matchGroupId,
          isMultiPart: intersectingSegments.length > 1,
          isFirstPart: partIndex === 0,
          isLastPart: partIndex === intersectingSegments.length - 1
        });
        byNode.set(segment.node, nodeMatches);
      });
    });
    return byNode;
  }

  function wrapTextNodeMatches(node, matches) {
    const text = node.nodeValue || '';
    const orderedMatches = matches
      .filter((match) => match.start < match.end)
      .sort((a, b) => a.start - b.start || b.end - a.end);
    if (!orderedMatches.length) return;

    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const match of orderedMatches) {
      if (match.start < cursor) continue;
      if (match.start > cursor) fragment.appendChild(document.createTextNode(text.slice(cursor, match.start)));
      const span = document.createElement('span');
      span.className = getHighlightClassName(match);
      span.textContent = text.slice(match.start, match.end);
      applyHighlightStyle(span, match.rule);
      applyTooltipData(span, match.rule, match.matchedText);
      applyHighlightPartData(span, match);
      fragment.appendChild(span);
      cursor = match.end;
    }
    if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)));
    node.parentNode.replaceChild(fragment, node);
  }

  function getHighlightClassName(match) {
    const classes = ['amh-highlight', `amh-highlight--${safeClassName(match.rule.tag)}`];
    if (match.isMultiPart) {
      classes.push('amh-highlight--multipart');
      if (match.isFirstPart) classes.push('amh-highlight--match-start');
      if (!match.isFirstPart && !match.isLastPart) classes.push('amh-highlight--match-middle');
      if (match.isLastPart) classes.push('amh-highlight--match-end');
    }
    return classes.join(' ');
  }

  function applyHighlightPartData(span, match) {
    span.dataset.amhMatchGroupId = match.matchGroupId;
    if (!match.isMultiPart) return;
    span.dataset.amhMatchId = String(match.matchId);
    span.dataset.amhMatchPart = match.isFirstPart ? 'start' : match.isLastPart ? 'end' : 'middle';
  }

  function clearHighlightsWithin(root) {
    clearMessageBlockHighlights(root);
    return clearHighlightElements(root.querySelectorAll('.amh-highlight, .amh-escalation-highlight'));
  }

  function clearAllHighlights() {
    clearMessageBlockHighlights(document);
    return clearHighlightElements(document.querySelectorAll('.amh-highlight, .amh-escalation-highlight'));
  }

  function clearAllRuleHighlights() {
    clearMessageBlockHighlights(document);
    return clearHighlightElements(document.querySelectorAll('.amh-highlight'));
  }

  function clearMessageBlockHighlights(root) {
    for (const element of root.querySelectorAll('.amh-message-highlight')) {
      element.classList.remove('amh-message-highlight', 'amh-highlight--hover');
      element.style.removeProperty('--amh-highlight-background');
      element.style.removeProperty('--amh-highlight-border');
      for (const attribute of ['amhRuleName', 'amhRuleTag', 'amhRuleLabel', 'amhTooltipTitle', 'amhTooltipText', 'amhTooltipName', 'amhMatchedText']) {
        element.removeAttribute(`data-${attribute}`);
      }
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
        if (parent.closest('.amh-highlight, .amh-escalation-highlight, .amh-tooltip, script, style, textarea, input, [contenteditable="true"]')) {
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
    span.dataset.amhRuleName = match.rule.name;
    span.dataset.amhRuleTag = match.rule.tag;
    span.dataset.amhRuleLabel = match.rule.label;
    span.dataset.amhTooltipTitle = match.rule.label;
    span.dataset.amhTooltipText = match.rule.label;
    fragment.appendChild(span);
      cursor = match.end;
    }
    if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)));
    node.parentNode.replaceChild(fragment, node);
    return matches.length;
  }

  function applyHighlightStyle(span, rule) {
    const category = state.settings.categories[rule.tag] || {};
    const color = category.color || '#a855f7';
    const opacity = clamp(Number(state.settings.opacity), 0.08, 0.85);
    span.style.backgroundColor = hexToRgba(color, opacity);
    span.style.boxShadow = `0 0 0 1px ${hexToRgba(color, Math.min(opacity + 0.18, 0.9))}`;
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

  function applyTooltipData(span, rule, matchedText) {
    const category = state.settings.categories[rule.tag] || {};
    const label = category.label || rule.tag;
    const hoverText = getRuleHoverText(rule);
    span.dataset.amhRuleName = rule.name;
    span.dataset.amhRuleTag = rule.tag;
    span.dataset.amhRuleLabel = label;
    span.dataset.amhTooltipTitle = hoverText.title || label;
    span.dataset.amhTooltipText = hoverText.text || 'Review the highlighted message and choose the appropriate response.';
    span.dataset.amhTooltipName = hoverText.name || rule.name || rule.pattern;
    span.dataset.amhMatchedText = matchedText;
    span.removeAttribute('title');
  }

  function getRuleHoverText(rule) {
    if (rule.tag === 'user_added') {
      return {
        title: 'user_added',
        text: rule.conditionSummary || state.hoverText.defaults?.user_added?.text || 'Review this user-added highlighted pattern.',
        name: rule.pattern || rule.name || 'user_added'
      };
    }

    const configured = state.hoverText.by_rule_id?.[rule.id] || state.hoverText.by_rule_name?.[rule.name];
    if (configured) return configured;

    return {
      title: rule.action || rule.tag,
      text: rule.conditionSummary || rule.pattern || 'Review the highlighted message and choose the appropriate response.',
      name: rule.name || rule.pattern || rule.id
    };
  }

  function installTooltipHandlers() {
    document.addEventListener('mouseover', (event) => {
      const target = event.target instanceof Element ? event.target.closest('.amh-highlight, .amh-message-highlight') : null;
      if (!target || !state.settings.showTooltip) return;
      setHighlightGroupHover(target, true);
      showTooltip(target, event);
    }, true);
    document.addEventListener('mousemove', (event) => {
      if (!state.tooltip || state.tooltip.dataset.visible !== 'true') return;
      positionTooltip(event);
    }, true);
    document.addEventListener('mouseout', (event) => {
      const target = event.target instanceof Element ? event.target.closest('.amh-highlight, .amh-message-highlight') : null;
      if (!target) return;
      const related = event.relatedTarget instanceof Element ? event.relatedTarget.closest('.amh-highlight, .amh-message-highlight') : null;
      if (related && getHighlightGroupId(related) === getHighlightGroupId(target)) return;
      setHighlightGroupHover(target, false);
      hideTooltip();
    }, true);
  }

  function getHighlightGroupId(target) {
    return target?.dataset?.amhMatchGroupId || '';
  }

  function getHighlightGroupParts(target) {
    const groupId = getHighlightGroupId(target);
    if (!groupId) return [target];
    const escapedGroupId = typeof CSS !== 'undefined' && CSS.escape ? CSS.escape(groupId) : groupId.replace(/"/g, '\\"');
    return Array.from(document.querySelectorAll(`.amh-highlight[data-amh-match-group-id="${escapedGroupId}"]`));
  }

  function setHighlightGroupHover(target, isHovered) {
    for (const part of getHighlightGroupParts(target)) {
      part.classList.toggle('amh-highlight--hover', isHovered);
    }
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
    const html = renderTooltipHtml(target);
    if (!html) return;
    const tooltip = ensureTooltip();
    tooltip.innerHTML = html;
    tooltip.dataset.visible = 'true';
    positionTooltip(event);
  }

  function hideTooltip() {
    if (!state.tooltip) return;
    state.tooltip.dataset.visible = 'false';
  }

  function renderTooltipHtml(target) {
    const title = target.dataset.amhTooltipTitle || target.dataset.amhRuleLabel || target.dataset.amhRuleTag || '';
    const text = target.dataset.amhTooltipText || '';
    const name = target.dataset.amhTooltipName || target.dataset.amhRuleName || '';
    if (!title && !text) return '';

    return [
      '<div class="amh-tooltip__top">',
      `<span class="amh-tooltip__rule">${escapeHtml(name || title)}</span>`,
      `<span class="amh-tooltip__tag">${escapeHtml(title)}</span>`,
      '</div>',
      text
        ? '<div class="amh-tooltip__row amh-tooltip__row--stacked">' +
          '<span class="amh-tooltip__label">Guidance</span>' +
          `<span class="amh-tooltip__value">${escapeHtml(text)}</span>` +
          '</div>'
        : ''
    ].join('');
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
