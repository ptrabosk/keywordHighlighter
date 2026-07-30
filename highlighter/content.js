(() => {
  'use strict';

  if (document.documentElement.dataset.amhRuntimeLoaded === 'true') return;
  document.documentElement.dataset.amhRuntimeLoaded = 'true';

  if (typeof DEFAULT_SETTINGS === 'undefined' || typeof SETTINGS_KEY === 'undefined') {
    const message = 'settings.js did not load before content.js. Reload the unpacked extension and refresh the page.';
    document.documentElement.dataset.amhInitError = message;
    console.error('[Attentive Rule Highlighter] Failed to initialize:', new Error(message));
    return;
  }

  if (!globalThis.AMH_HIGHLIGHT_CORE) {
    const message = 'highlight core did not load before content.js. Reload the unpacked extension and refresh the page.';
    document.documentElement.dataset.amhInitError = message;
    console.error('[Attentive Rule Highlighter] Failed to initialize:', new Error(message));
    return;
  }

  const core = globalThis.AMH_HIGHLIGHT_CORE;
  const RENDER_LOG_INTERVAL_MS = 5 * 60 * 1000;
  const ESCALATION_HIGHLIGHT_COLOR = '#B9C7FA';
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
    stats: {
      loadedRules: 0,
      activeRules: 0,
      invalidRules: 0,
      highlightedElements: 0,
      highlights: 0,
      lastRunAt: null
    },
    lastRenderLogAt: 0,
    nextMatchGroupId: 1
  };

  function pageHost() {
    return String(window.location.hostname || 'unknown').slice(0, 120);
  }

  function logOperationalEvent(event) {
    try {
      chrome.runtime.sendMessage({
        type: 'highlighter:logEvent',
        event: {
          surface: 'content',
          pageHost: pageHost(),
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
    console.error('[Attentive Rule Highlighter] Failed to initialize:', error);
  });

  async function init() {
    const startedAt = performance.now();
    state.settings = core.mergeSettings(DEFAULT_SETTINGS, await loadSettings());
    const [rules, hoverText] = await Promise.all([loadRules(), loadHoverText()]);
    state.rules = rules;
    state.hoverText = hoverText;
    state.stats.loadedRules = state.rules.length;
    installTooltipHandlers();
    installMutationObserver();
    installMessageHandlers();
    scheduleRender(true);
    logOperationalEvent({
      eventType: 'content_initialized',
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
      console.warn('[Attentive Rule Highlighter] Could not load settings:', error);
      return {};
    }
  }

  async function loadRules() {
    const url = chrome.runtime.getURL('data/rules/opt_out_deterministic_rules.json');
    try {
      const payload = await loadJsonResource(url, 'Rules');
      if (!payload || typeof payload !== 'object' || !payload.rules) {
        throw new Error(`Rules JSON did not contain a rules property: ${url}`);
      }
      const rules = core.buildRules(payload.rules);
      for (const rule of rules.filter((item) => !item.regex)) {
        console.warn('[Attentive Rule Highlighter] Invalid regex skipped:', rule);
      }
      logOperationalEvent({
        eventType: 'rules_loaded',
        severity: 'info',
        result: 'success',
        ruleSource: 'opt_out_deterministic_rules'
      });
      return rules;
    } catch (error) {
      logOperationalFailure('rules_load_failed', 'RULES_LOAD_FAILED', 'Rules could not be fetched', {
        operation: 'rulesFetch'
      });
      throw new Error(`Rules load failed for ${url}. Select the highlighter folder in Load unpacked, then reload the extension. ${error.message || error}`);
    }
  }

  async function loadHoverText() {
    const url = chrome.runtime.getURL('data/rules/rule_hover_text.json');
    try {
      return await loadJsonResource(url, 'Hover text');
    } catch (error) {
      logOperationalFailure('hover_text_load_failed', 'HOVER_TEXT_LOAD_FAILED', 'Hover text could not be loaded', {
        operation: 'hoverTextFetch'
      });
      console.warn('[Attentive Rule Highlighter] Could not load hover text:', error);
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
      if (mutations.some((mutation) => mutation.type === 'characterData' || mutation.addedNodes?.length || mutation.removedNodes?.length)) {
        scheduleRender();
      }
    });
    state.observer.observe(document.documentElement, { childList: true, subtree: true, characterData: true });
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
    window.clearTimeout(state.renderTimer);
    state.renderTimer = window.setTimeout(() => renderNow(forceAll), 120);
  }

  function renderNow(forceAll = false) {
    const startedAt = performance.now();
    window.clearTimeout(state.renderTimer);
    state.renderTimer = null;

    try {
      const activeRules = core.getActiveRules(state.rules, state.settings);
      state.stats.activeRules = activeRules.length;
      state.stats.invalidRules = state.rules.filter((rule) => !rule.regex).length;
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

      persistStats();
      maybeLogRenderCompleted({
        durationMs: performance.now() - startedAt,
        forceAll,
        changedElements: state.stats.highlightedElements,
        highlights: state.stats.highlights
      });
    } catch (error) {
      state.targetSnapshots = new WeakMap();
      persistStats();
      logOperationalFailure('render_failed', 'RENDER_FAILED', error?.message || 'Render failed', {
        operation: 'render',
        trigger: forceAll ? 'force' : 'scheduled'
      });
      console.warn('[Attentive Rule Highlighter] Render failed and will retry on the next DOM update:', error);
    }
  }

  function getTargetElements() {
    let selector = state.settings.selector || DEFAULT_SETTINGS.selector;
    let nodes = [];
    try {
      nodes = Array.from(document.querySelectorAll(selector));
    } catch (error) {
      console.warn('[Attentive Rule Highlighter] Invalid selector, using default:', selector, error);
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
    const headings = Array.from(document.querySelectorAll('p[class*="variant-caption"]')).filter((node) => {
      return node instanceof HTMLElement && isEscalationHeading(node.textContent || '');
    });
    const targets = new Set();
    for (const heading of headings) {
      const section = heading.parentElement?.parentElement;
      if (!section) continue;
      for (const child of Array.from(section.children)) {
        if (child instanceof HTMLElement && child !== heading && child.matches('p[class*="variant-caption"]') && isVisible(child)) {
          targets.add(child);
        }
      }
    }
    return Array.from(targets);
  }

  function isEscalationHeading(text) {
    return /\bESCALATE\b/i.test(String(text || ''));
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

    const segmentsByNode = mapMatchesToTextNodeSegments(segments, matches, text);
    for (const [node, nodeMatches] of segmentsByNode) {
      wrapTextNodeMatches(node, nodeMatches);
    }
    state.stats.highlights += matches.length;
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

    const isOptOut = /\b(?:4|four|never)\b/i.test(core.normalizeMessageBody(text));
    const ruleName = isOptOut ? 'opt_outs_ml.hot_topic_opt_out' : 'opt_outs_ml.hot_topic_not_opt_out';
    const rule = state.rules.find((item) => item.name === ruleName) || createHotTopicFallbackRule(isOptOut);
    if (!rule || !isRuleCategoryEnabled(rule)) return null;
    return rule;
  }

  function getHotTopicPromptRule(element) {
    if (!isHotTopicBrandElement(element)) return null;
    const rule = state.rules.find((item) => item.name === 'opt_outs_ml.hot_topic_not_opt_out') || createHotTopicFallbackRule(false);
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
    return clearHighlightElements(root.querySelectorAll('.amh-highlight, .amh-escalation-highlight'));
  }

  function clearAllHighlights() {
    return clearHighlightElements(document.querySelectorAll('.amh-highlight, .amh-escalation-highlight'));
  }

  function clearAllRuleHighlights() {
    return clearHighlightElements(document.querySelectorAll('.amh-highlight'));
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

  function applyEscalationHighlightStyle(span) {
    span.style.backgroundColor = hexToRgba(ESCALATION_HIGHLIGHT_COLOR, 0.78);
    span.style.boxShadow = `0 0 0 1px ${hexToRgba(ESCALATION_HIGHLIGHT_COLOR, 0.95)}`;
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
      const target = event.target instanceof Element ? event.target.closest('.amh-highlight') : null;
      if (!target || !state.settings.showTooltip) return;
      setHighlightGroupHover(target, true);
      showTooltip(target, event);
    }, true);
    document.addEventListener('mousemove', (event) => {
      if (!state.tooltip || state.tooltip.dataset.visible !== 'true') return;
      positionTooltip(event);
    }, true);
    document.addEventListener('mouseout', (event) => {
      const target = event.target instanceof Element ? event.target.closest('.amh-highlight') : null;
      if (!target) return;
      const related = event.relatedTarget instanceof Element ? event.relatedTarget.closest('.amh-highlight') : null;
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
    const tag = target.dataset.amhRuleTag || '';
    if (tag === 'opt_out') return 'OPT OUT';
    if (tag === 'fuzzy_opt_out') return 'FUZZY OPT OUT';
    if (tag === 'tmt') return 'TMT';
    if (tag === 'txt') return 'TXT';
    if (tag === 'reply') return 'REPLY';
    if (tag === 'close') return 'CLOSE';
    return '';
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

  function persistStats() {
    document.documentElement.dataset.amhStats = JSON.stringify(state.stats);
    chrome.storage.local.set({ amhLastStats: state.stats }).catch(() => {});
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
      ruleSource: 'opt_out_deterministic_rules',
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

  function safeClassName(value) {
    return String(value || 'unknown').replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  }

  function escapeHtml(value) {
    return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }

  function clamp(value, min, max) {
    if (Number.isNaN(value)) return min;
    return Math.min(max, Math.max(min, value));
  }
})();
