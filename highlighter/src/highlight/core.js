(function installHighlightCore(globalScope) {
  'use strict';

  function flattenRules(value, path = [], output = []) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => flattenRules(item, path.concat(index), output));
      return output;
    }
    if (!value || typeof value !== 'object') return output;
    if (typeof value.pattern === 'string' && typeof value.tag === 'string') {
      output.push({
        name: value.name || 'unnamed_rule',
        tag: value.tag,
        pattern: value.pattern,
        flags: value.flags || '',
        source: value.source || '',
        groupPath: path.filter((part) => typeof part === 'string').join('.')
      });
      return output;
    }
    for (const [key, nested] of Object.entries(value)) {
      flattenRules(nested, path.concat(key), output);
    }
    return output;
  }

  function compileRegex(rule) {
    try {
      const suppliedFlags = rule.flags || 'i';
      const flags = uniqueRegexFlags(`${suppliedFlags}g`);
      return new RegExp(rule.pattern, flags);
    } catch (_error) {
      return null;
    }
  }

  function uniqueRegexFlags(flags) {
    return Array.from(new Set(String(flags || '').split(''))).filter((flag) => 'dgimsuvy'.includes(flag)).join('');
  }

  function buildRules(payloadRules) {
    return flattenRules(payloadRules).map((rule, index) => ({
      ...rule,
      id: `${rule.tag}:${rule.name || 'rule'}:${index}`,
      regex: compileRegex(rule)
    }));
  }

  function mergeSettings(base, override = {}) {
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

  function getCustomKeywordRules(settings) {
    const category = settings.categories.custom_keywords;
    if (!category || category.enabled === false) return [];
    return (settings.customKeywords || []).map((keyword, index) => ({
      id: `custom_keywords:${index}`,
      name: 'custom_keyword',
      tag: 'custom_keywords',
      pattern: escapeRegex(keyword),
      source: 'popup custom keyword',
      groupPath: 'customKeywords',
      regex: new RegExp(escapeRegex(keyword), 'gi')
    }));
  }

  function getActiveRules(rules, settings) {
    const configuredRules = rules
      .filter((rule) => {
        const category = settings.categories[rule.tag];
        return rule.regex && category && category.enabled !== false;
      })
      .sort((a, b) => (settings.categories[a.tag]?.priority ?? 999) - (settings.categories[b.tag]?.priority ?? 999));
    return [...getCustomKeywordRules(settings), ...configuredRules];
  }

  const escalationBulletRules = Object.freeze([
    Object.freeze({
      name: 'escalation_immediately',
      tag: 'escalation_action',
      label: 'Escalation action',
      regex: /\bimmediately\b/i
    }),
    Object.freeze({
      name: 'escalation_use_temp',
      tag: 'escalation_action',
      label: 'Escalation action',
      regex: /\b(?:use|Use|USE)\s+[A-Z]+\s+(?:temp|Temp|TEMP)\b/
    }),
    Object.freeze({
      name: 'escalation_use_shortcut',
      tag: 'escalation_action',
      label: 'Escalation action',
      regex: /\b(?:use|Use|USE)\s+[A-Z]+\s+(?:shortcut|Shortcut|SHORTCUT)\b/
    }),
    Object.freeze({
      name: 'escalation_no_esc',
      tag: 'escalation_action',
      label: 'Escalation action',
      normalizedRegex: /\bno esc\b/
    }),
    Object.freeze({
      name: 'escalation_post_purchase',
      tag: 'escalation_action',
      label: 'Escalation action',
      normalizedRegex: /\bpost purchase\b/
    }),
    Object.freeze({
      name: 'escalation_client_takeover',
      tag: 'escalation_action',
      label: 'Escalation action',
      regex: /\bclose\s+when\s+(?:the\s+)?client\s+takes\s+over\b/i
    }),
    Object.freeze({
      name: 'escalation_last_word',
      tag: 'escalation_action',
      label: 'Escalation action',
      regex: /\blet\s+the\s+customer\s+have\s+the\s+last\s+word\b/i
    })
  ]);

  function collectEscalationBulletMatches(text) {
    const matches = [];
    const bulletRegex = /•[^\r\n]*/g;
    let bulletMatch;
    while ((bulletMatch = bulletRegex.exec(String(text || ''))) !== null) {
      const bulletText = bulletMatch[0];
      const normalizedBulletText = normalizeEscalationBulletText(bulletText);
      const rule = escalationBulletRules.find((item) => escalationBulletRuleMatches(item, bulletText, normalizedBulletText));
      if (!rule) continue;
      matches.push({
        start: bulletMatch.index,
        end: bulletMatch.index + bulletText.length,
        length: bulletText.length,
        rule
      });
    }
    return matches;
  }

  function escalationBulletRuleMatches(rule, bulletText, normalizedBulletText) {
    if (rule.normalizedRegex) return rule.normalizedRegex.test(normalizedBulletText);
    return rule.regex.test(bulletText);
  }

  function normalizeEscalationBulletText(value) {
    return String(value || '')
      .normalize('NFKC')
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, ' ')
      .replace(/\s+/g, ' ')
      .trim();
  }

  function collectMatches(text, activeRules, settings) {
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
      return (settings.categories[a.rule.tag]?.priority ?? 999) - (settings.categories[b.rule.tag]?.priority ?? 999);
    });
    const accepted = [];
    for (const candidate of candidates) {
      if (!accepted.some((existing) => candidate.start < existing.end && candidate.end > existing.start)) {
        accepted.push(candidate);
      }
    }
    return accepted.sort((a, b) => a.start - b.start);
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

  function normalizeKeyword(value) {
    return String(value || '').trim().replace(/\s+/g, ' ');
  }

  function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function clamp(value, min, max) {
    if (Number.isNaN(value)) return min;
    return Math.min(max, Math.max(min, value));
  }

  globalScope.AMH_HIGHLIGHT_CORE = Object.freeze({
    buildRules,
    clamp,
    collectEscalationBulletMatches,
    collectMatches,
    compileRegex,
    escalationBulletRules,
    escapeRegex,
    flattenRules,
    getActiveRules,
    getCustomKeywordRules,
    isOnlyMessageBodyMatch,
    mergeSettings,
    normalizeEscalationBulletText,
    normalizeKeyword,
    normalizeMessageBody,
    uniqueRegexFlags
  });
})(globalThis);
