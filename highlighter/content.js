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

  const state = {
    rules: [],
    settings: DEFAULT_SETTINGS,
    observer: null,
    renderTimer: null,
    tooltip: null,
    targetSnapshots: new WeakMap(),
    stats: {
      loadedRules: 0,
      activeRules: 0,
      invalidRules: 0,
      highlightedElements: 0,
      highlights: 0,
      lastRunAt: null
    }
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
    state.settings = mergeSettings(DEFAULT_SETTINGS, await loadSettings());
    state.rules = await loadRules();
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
    const url = chrome.runtime.getURL('data/rules/consolidated_rules.json');
    let response;
    try {
      response = await fetch(url);
    } catch (error) {
      logOperationalFailure('rules_load_failed', 'RULES_LOAD_FAILED', 'Rules could not be fetched', {
        operation: 'rulesFetch'
      });
      throw new Error(`Rules fetch failed for ${url}. Reload the unpacked extension after manifest changes. ${error.message || error}`);
    }
    if (!response.ok) {
      logOperationalFailure('rules_load_failed', 'RULES_LOAD_FAILED', 'Rules response was not successful', {
        operation: 'rulesFetch',
        httpStatus: response.status
      });
      throw new Error(`Rules fetch failed for ${url}: ${response.status}. Reload the unpacked extension after manifest changes.`);
    }
    const payload = await response.json();
    const flattened = [];
    flattenRules(payload.rules, [], flattened);
    const rules = flattened.map((rule, index) => ({
      ...rule,
      id: `${rule.tag}:${rule.name || 'rule'}:${index}`,
      regex: compileRegex(rule)
    }));
    logOperationalEvent({
      eventType: 'rules_loaded',
      severity: 'info',
      result: 'success',
      ruleSource: 'consolidated_rules'
    });
    return rules;
  }

  function flattenRules(value, path, output) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => flattenRules(item, path.concat(index), output));
      return;
    }
    if (!value || typeof value !== 'object') return;
    if (typeof value.pattern === 'string' && typeof value.tag === 'string') {
      output.push({
        name: value.name || 'unnamed_rule',
        tag: value.tag,
        pattern: value.pattern,
        flags: value.flags || '',
        source: value.source || '',
        groupPath: path.filter((part) => typeof part === 'string').join('.')
      });
      return;
    }
    for (const [key, nested] of Object.entries(value)) {
      flattenRules(nested, path.concat(key), output);
    }
  }

  function compileRegex(rule) {
    try {
      const suppliedFlags = rule.flags || 'i';
      const flags = uniqueRegexFlags(`${suppliedFlags}g`);
      return new RegExp(rule.pattern, flags);
    } catch (error) {
      console.warn('[Attentive Rule Highlighter] Invalid regex skipped:', rule, error);
      return null;
    }
  }

  function uniqueRegexFlags(flags) {
    return Array.from(new Set(flags.split(''))).filter((flag) => 'dgimsuvy'.includes(flag)).join('');
  }

  function mergeSettings(base, override) {
    const merged = { ...base, ...override, categories: {} };
    const categoryKeys = new Set([
      ...Object.keys(base.categories || {}),
      ...Object.keys((override && override.categories) || {})
    ]);
    for (const key of categoryKeys) {
      merged.categories[key] = {
        ...(base.categories && base.categories[key] ? base.categories[key] : {}),
        ...(override && override.categories && override.categories[key] ? override.categories[key] : {})
      };
    }
    if (base.categories?.custom_keywords && merged.categories.custom_keywords) {
      merged.categories.custom_keywords.color = base.categories.custom_keywords.color;
    }
    merged.opacity = clamp(Number(merged.opacity ?? base.opacity), 0.08, 0.85);
    merged.selector = String(merged.selector || base.selector);
    merged.customKeywords = Array.isArray(override?.customKeywords)
      ? Array.from(new Set(override.customKeywords.map(normalizeKeyword).filter(Boolean)))
      : [...(base.customKeywords || [])];
    return merged;
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
        state.settings = mergeSettings(DEFAULT_SETTINGS, message.settings || state.settings);
        state.targetSnapshots = new WeakMap();
        renderNow(true);
        sendResponse({ stats: state.stats });
        return false;
      }
      return false;
    });

    chrome.storage.onChanged.addListener((changes, areaName) => {
      if (areaName !== 'sync' || !changes[SETTINGS_KEY]) return;
      state.settings = mergeSettings(DEFAULT_SETTINGS, changes[SETTINGS_KEY].newValue || {});
      state.targetSnapshots = new WeakMap();
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

    const activeRules = getActiveRules();
    state.stats.activeRules = activeRules.length;
    state.stats.invalidRules = state.rules.filter((rule) => !rule.regex).length;
    state.stats.highlightedElements = 0;
    state.stats.highlights = 0;
    state.stats.lastRunAt = new Date().toISOString();

    if (!state.settings.enabled || !activeRules.length) {
      persistStats();
      logOperationalEvent({
        eventType: 'render_completed',
        severity: 'info',
        result: 'success',
        durationMs: performance.now() - startedAt,
        ruleSource: 'consolidated_rules',
        metadata: {
          operation: 'render',
          trigger: forceAll ? 'force' : 'scheduled'
        }
      });
      return;
    }

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

    persistStats();
    logOperationalEvent({
      eventType: 'render_completed',
      severity: 'info',
      result: 'success',
      durationMs: performance.now() - startedAt,
      ruleSource: 'consolidated_rules',
      metadata: {
        operation: 'render',
        trigger: forceAll ? 'force' : 'scheduled'
      }
    });
  }

  function getActiveRules() {
    const configuredRules = state.rules
      .filter((rule) => {
        const category = state.settings.categories[rule.tag];
        return rule.regex && category && category.enabled !== false;
      })
      .sort((a, b) => (state.settings.categories[a.tag]?.priority ?? 999) - (state.settings.categories[b.tag]?.priority ?? 999));
    return [...getCustomKeywordRules(), ...configuredRules];
  }

  function getCustomKeywordRules() {
    const category = state.settings.categories.custom_keywords;
    if (!category || category.enabled === false) return [];
    return (state.settings.customKeywords || []).map((keyword, index) => ({
      id: `custom_keywords:${index}`,
      name: 'custom_keyword',
      tag: 'custom_keywords',
      pattern: escapeRegex(keyword),
      source: 'popup custom keyword',
      groupPath: 'customKeywords',
      regex: new RegExp(escapeRegex(keyword), 'gi')
    }));
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
    return nodes.filter((node) => node instanceof HTMLElement && node.closest('div[class*="type-INBOUND"]') && !node.closest('.amh-tooltip') && isVisible(node));
  }

  function isVisible(element) {
    const rect = element.getBoundingClientRect();
    const style = window.getComputedStyle(element);
    return rect.width > 0 && rect.height > 0 && style.visibility !== 'hidden' && style.display !== 'none';
  }

  function highlightTarget(element, activeRules) {
    const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT, {
      acceptNode(node) {
        if (!node.nodeValue || !node.nodeValue.trim()) return NodeFilter.FILTER_REJECT;
        const parent = node.parentElement;
        if (!parent) return NodeFilter.FILTER_REJECT;
        if (parent.closest('.amh-highlight, .amh-tooltip, script, style, textarea, input, [contenteditable="true"]')) {
          return NodeFilter.FILTER_REJECT;
        }
        return NodeFilter.FILTER_ACCEPT;
      }
    });
    const textNodes = [];
    while (walker.nextNode()) textNodes.push(walker.currentNode);
    let count = 0;
    for (const node of textNodes) count += highlightTextNode(node, activeRules);
    state.stats.highlights += count;
  }

  function clearHighlightsWithin(root) {
    const highlights = Array.from(root.querySelectorAll('.amh-highlight'));
    for (const highlight of highlights) {
      const textNode = document.createTextNode(highlight.textContent || '');
      highlight.replaceWith(textNode);
      textNode.parentNode?.normalize();
    }
  }

  function highlightTextNode(node, activeRules) {
    const text = node.nodeValue;
    const matches = collectMatches(text, activeRules);
    if (!matches.length) return 0;
    const fragment = document.createDocumentFragment();
    let cursor = 0;
    for (const match of matches) {
      if (match.start > cursor) fragment.appendChild(document.createTextNode(text.slice(cursor, match.start)));
      const span = document.createElement('span');
      span.className = `amh-highlight amh-highlight--${safeClassName(match.rule.tag)}`;
      span.textContent = text.slice(match.start, match.end);
      applyHighlightStyle(span, match.rule);
      applyTooltipData(span, match.rule, span.textContent);
      fragment.appendChild(span);
      cursor = match.end;
    }
    if (cursor < text.length) fragment.appendChild(document.createTextNode(text.slice(cursor)));
    node.parentNode.replaceChild(fragment, node);
    return matches.length;
  }

  function collectMatches(text, activeRules) {
    const candidates = [];
    for (const rule of activeRules) {
      rule.regex.lastIndex = 0;
      let match;
      while ((match = rule.regex.exec(text)) !== null) {
        const value = match[0];
        if (!value) {
          rule.regex.lastIndex += 1;
          continue;
        }
        if (rule.tag === 'not_opt_out' && !isOnlyMessageBodyMatch(text, value)) {
          continue;
        }
        candidates.push({ start: match.index, end: match.index + value.length, length: value.length, rule });
      }
    }
    candidates.sort((a, b) => {
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

  function applyHighlightStyle(span, rule) {
    const category = state.settings.categories[rule.tag] || {};
    const color = category.color || '#a855f7';
    const opacity = clamp(Number(state.settings.opacity), 0.08, 0.85);
    span.style.backgroundColor = hexToRgba(color, opacity);
    span.style.boxShadow = `0 0 0 1px ${hexToRgba(color, Math.min(opacity + 0.18, 0.9))}`;
    span.style.textDecoration = `underline ${hexToRgba(color, 0.9)} 2px`;
    span.style.textUnderlineOffset = '0.16em';
  }

  function applyTooltipData(span, rule, matchedText) {
    const category = state.settings.categories[rule.tag] || {};
    const label = category.label || rule.tag;
    const guidance = getTooltipGuidance(rule.tag);
    span.dataset.amhRuleName = rule.name;
    span.dataset.amhRuleTag = rule.tag;
    span.dataset.amhRuleLabel = label;
    span.dataset.amhGuidance = guidance;
    span.dataset.amhMatchedText = matchedText;
    span.removeAttribute('title');
  }

  function installTooltipHandlers() {
    document.addEventListener('mouseover', (event) => {
      const target = event.target instanceof Element ? event.target.closest('.amh-highlight') : null;
      if (!target || !state.settings.showTooltip) return;
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
      if (related === target) return;
      hideTooltip();
    }, true);
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
    const tooltip = ensureTooltip();
    tooltip.innerHTML = renderTooltipHtml(target);
    tooltip.dataset.visible = 'true';
    positionTooltip(event);
  }

  function hideTooltip() {
    if (!state.tooltip) return;
    state.tooltip.dataset.visible = 'false';
  }

  function renderTooltipHtml(target) {
    const tag = target.dataset.amhRuleTag || '';
    const label = target.dataset.amhRuleLabel || tag;
    const guidance = target.dataset.amhGuidance || getTooltipGuidance(tag);
    const matched = target.dataset.amhMatchedText || target.textContent || '';
    return `
      <div class="amh-tooltip__top">
        <div class="amh-tooltip__rule">${escapeHtml(label)}</div>
        <div class="amh-tooltip__tag">${escapeHtml(label)}</div>
      </div>
      <div class="amh-tooltip__row amh-tooltip__row--stacked"><div class="amh-tooltip__value">${escapeHtml(guidance)}</div></div>
      <div class="amh-tooltip__row"><div class="amh-tooltip__label">Matched</div><div class="amh-tooltip__value">${escapeHtml(matched)}</div></div>
    `;
  }

  function getTooltipGuidance(tag) {
    const guidanceByTag = {
      opt_out: "This pattern could be an opt out request, please examine the message for the customer's intent.",
      fuzzy_opt_out: 'This pattern is likely to require the FZZ template being sent, double-check the intent and send the fuzzy template.',
      txt: "It's possible this requires you to send the TXT template to ensure the subscriber knows who we are and why we are texting them.",
      tmt: 'If the customer is talking about frequency of texts, use the TMT template to inform them about limitations.',
      not_opt_out: 'This is a frequent phrase not requiring an opt out; still, if unsure, you can always use the opt out bot.',
      no_opt_out: 'This is a frequent phrase not requiring an opt out; still, if unsure, you can always use the opt out bot.'
    };
    return guidanceByTag[tag] || 'Review the highlighted message and choose the appropriate response.';
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

  function hexToRgba(hex, alpha) {
    const normalized = String(hex || '').trim();
    const match = /^#?([a-f\d]{2})([a-f\d]{2})([a-f\d]{2})$/i.exec(normalized);
    if (!match) return `rgba(168, 85, 247, ${alpha})`;
    return `rgba(${parseInt(match[1], 16)}, ${parseInt(match[2], 16)}, ${parseInt(match[3], 16)}, ${alpha})`;
  }

  function safeClassName(value) {
    return String(value || 'unknown').replace(/[^a-z0-9_-]/gi, '-').toLowerCase();
  }

  function normalizeKeyword(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
  }

  function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function isOnlyMessageBodyMatch(messageText, matchedText) {
    return normalizeMessageBody(messageText) === normalizeMessageBody(matchedText);
  }

  function normalizeMessageBody(value) {
    return String(value || '')
      .toLowerCase()
      .replace(/^[\s"'`.,!?;:()[\]{}<>-]+|[\s"'`.,!?;:()[\]{}<>-]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function escapeHtml(value) {
    return String(value).replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
  }

  function clamp(value, min, max) {
    if (Number.isNaN(value)) return min;
    return Math.min(max, Math.max(min, value));
  }
})();
