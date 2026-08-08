(function installHighlightCore(globalScope) {
  'use strict';

  const MAX_CUSTOM_KEYWORD_LENGTH = 128;
  const MAX_CUSTOM_KEYWORD_TEXT_LENGTH = 256;

  function flattenRules(value, path = [], output = []) {
    if (Array.isArray(value)) {
      value.forEach((item, index) => flattenRules(item, path.concat(index), output));
      return output;
    }
    if (!value || typeof value !== 'object') return output;
    if (typeof value.pattern === 'string' && (typeof value.tag === 'string' || typeof value.action === 'string')) {
      const tag = value.tag || value.action;
      output.push({
        id: value.id || '',
        name: value.name || 'unnamed_rule',
        tag,
        action: value.action || tag,
        pattern: value.pattern,
        type: value.type || '',
        flags: value.flags || '',
        source: value.source || '',
        optOut: value.opt_out || '',
        matchScope: value.match_scope || '',
        matchTarget: value.match_target || '',
        conditionSummary: value.condition_summary || '',
        groupPath: path.filter((part) => typeof part === 'string').join('.')
      });
      return output;
    }
    for (const [key, nested] of Object.entries(value)) {
      flattenRules(nested, path.concat(key), output);
    }
    return output;
  }

  function sortSimpleBoundedAlternatives(pattern) {
    return String(pattern || '').replace(/\\b\((?!\?:)([^()]+(?:\|[^()]+)+)\)\\b/g, (_match, alternatives) => {
      const sorted = alternatives
        .split('|')
        .sort((a, b) => strippedRegexLength(b) - strippedRegexLength(a));
      return `\\b(${sorted.join('|')})\\b`;
    });
  }

  function strippedRegexLength(value) {
    return String(value || '').replace(/\\[a-z]\+?/gi, ' ').replace(/\\./g, '.').length;
  }

  function compileRegex(rule) {
    try {
      const proceduralRegex = getProceduralRegex(rule);
      if (proceduralRegex) return proceduralRegex;
      if (isProceduralRule(rule)) return null;
      const suppliedFlags = rule.flags || 'i';
      const flags = uniqueRegexFlags(`${suppliedFlags}g`);
      return new RegExp(getRegexPattern(rule), flags);
    } catch (_error) {
      return null;
    }
  }

  function isProceduralRule(rule) {
    return rule.matchScope === 'procedural' || !rule.pattern || (!rule.type && Boolean(rule.matchScope) && looksLikeProceduralDescription(rule.pattern));
  }

  function looksLikeProceduralDescription(pattern) {
    const value = String(pattern || '');
    return /\b(?:customer|brand|message|detector|matches|contains|normalized|reply|including|configured)\b/i.test(value) && value.includes(' ');
  }

  function getRegexPattern(rule) {
    const scope = String(rule.matchScope || '');
    if (scope.includes('extension_ready_phrase') && /\.\.\.$/.test(rule.pattern)) {
      return stemPatternToRegex(rule.pattern);
    }
    if (rule.id === 'rule_317fdbf0a6758d04' || rule.name === 'zapOptOuts.workflow.node_4.opt_out.not_opted_in') {
      return '(?:never|didnt)\\s*(?:opted\\s+in|signed\\s+up|subscribed?)|(?:opted\\s+in|signed\\s+up)';
    }
    if (rule.id === 'rule_9501f80f59e3b9fd' || rule.name === 'zapOptOuts.deterministic_js.not_opt_out.020.i_m') {
      return 'i\\s*m|im';
    }
    if (rule.id === 'rule_bc981d8e383b5305') {
      return "\\b(no more messages|no more texts|don't reach out|do not send|don't send|stop messaging|stop texting|unsubscribe|delete me|opt out|opt-out|unsub|ban me|stop)\\b";
    }
    if (rule.type === 'regex' || scope.includes('regex')) {
      return shouldSearchNormalizedText(rule) ? normalizeRegexPatternForSearch(rule.pattern) : rule.pattern;
    }
    if (scope.includes('phrase') || scope.includes('normalized') || scope.includes('keyword') || scope.includes('full')) {
      return phraseToFlexibleRegex(rule.pattern);
    }
    return rule.pattern;
  }

  function getProceduralRegex(rule) {
    if (rule.id === 'rule_combined_single_letter_only' || rule.name === 'combined.single_letter_only') return /^[A-Za-z]$/g;
    if (rule.id === 'rule_combined_number_only' || rule.name === 'combined.number_only') return /^\d+$/g;
    if (rule.id === 'rule_06d01f1a0e0b3885' || rule.name === 'zapOptOuts.classifier.is_link') {
      return /^(?:https?:\/\/\S+|www\.\S+)(?:\s+(?:https?:\/\/\S+|www\.\S+))*$/gi;
    }
    if (rule.id === 'rule_14492eac781ac6da' || rule.name === 'zapOptOuts.workflow.node_4.subscription.subscription_candidate') {
      return /\b(?:cancel|remove|stop|delete)\w*\b[\s\S]{0,80}\bsubscriptions?\b|\bsubscriptions?\b[\s\S]{0,80}\b(?:cancel|remove|stop|delete)\w*\b/gi;
    }
    if (rule.id === 'rule_b25458937a65a761' || rule.name === 'autoQAMessages.under_13_age_threshold') {
      return /\b(?:my age is\s*)?(?:[0-9]|1[0-2]|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\s*(?:years?\s*old|yrs?\s*old|yo|y\/o)\b|\bmy age is\s*(?:[0-9]|1[0-2]|one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)\b|\b(?:grade\s*[1-6]|[1-6](?:st|nd|rd|th)\s*grade)\b/gi;
    }
    if (rule.id === 'rule_combined_reaction_reply' || rule.name === 'combined.reaction_reply') {
      return /^(?:reacted to .+|(?:liked|loved|emphasized|disliked|questioned) .+|laughed at .+|removed (?:a |from ).+)[\s.!?]*$/gi;
    }
    if (rule.id === 'rule_combined_unavailable_auto_reply' || rule.name === 'combined.unavailable_auto_reply') {
      return /^(?:hey,?\s+i(?:'|\?|’)?m currently unavailable,?\s+i(?:'|\?|’)?ll get back to you as soon as i can|i(?:'|\?|’)?m not receiving notifications if this is urgent reply urgent to send a notification through with your original message|sorry,?\s+i\s+can(?:'|\?|’)?t talk (?:right )?now|sorry,?\s+can(?:'|\?|’)?t talk (?:right )?now|thank you for contacting me,?\s+i(?:'|\?|’)?m unable to chat right now but i(?:'|\?|’)?ll reply to your text as soon as i can,?\s+thanks|thanks for reaching out,?\s+i can(?:'|\?|’)?t chat(?: at the moment| now) but i(?:'|\?|’)?ll text you back as soon as i can(?:,?\s+thanks(?: child of christ| sent from text free)?)?|thanks for reaching out text me and if you have ig please message me let mee feed you set all notifications)[\s.!?]*$/gi;
    }
    if (rule.id === 'rule_combined_device_not_working' || rule.name === 'combined.device_not_working') {
      return /^(?:this is an automatic message this is a kosher talk only device and does not accept text messages please call instead|this number does(?:n'?t| not) support text please call instead|this phone(?: number)? can(?:not|'?t) receive text messages please call instead|this phone does not accept text messages please call instead(?: this is an automatic reply)?)[\s.!?]*$/gi;
    }
    if (rule.id === 'rule_combined_txt_origin_question' || rule.name === 'combined.txt_origin_question') {
      return /\bhow did (?:you|u) get my (?:number|phone number|contact)\b|\bwhere did (?:you|u) get my (?:number|phone number|contact)\b|\bwho gave (?:you|u) my (?:number|phone number|contact)\b|\bwhy (?:am i|do i) (?:getting|get|receive|receiving) (?:these )?(?:texts?|text messages?|messages?|msgs?)\b|\bwhy (?:are|r) (?:you|u) (?:texting|messaging|msging|contacting) me\b|\bwhy (?:are|r) (?:you|u) sending (?:me )?(?:texts?|text messages?|messages?|msgs?)\b|\bwhy did (?:you|u) (?:text|message|msg|contact) me\b|\bwhy did i get (?:this|these) (?:text|texts|message|messages|msg|msgs)\b|\bwhy do (?:you|u) (?:text|message|msg) me\b|\bwhy do (?:you|u) keep (?:texting|messaging|contacting)(?: me)?\b|\bi (?:dont|do not) know (?:you|u)\b|\bwho (?:is|are) (?:this|you|u)\b/gi;
    }
    return null;
  }

  function phraseToFlexibleRegex(value) {
    if (hasDisplayAlternatives(value)) return displayAlternativesToRegex(value);
    const words = String(value || '').trim().split(/\s+/).filter(Boolean).map(escapeRegex);
    if (!words.length) return '';
    return `\\b${joinFlexibleWords(words)}\\b`;
  }

  function hasDisplayAlternatives(value) {
    return /\s\/\s/.test(String(value || ''));
  }

  function displayAlternativesToRegex(value) {
    const parts = String(value || '').split(/\s+\/\s+/).map((part) => part.trim()).filter(Boolean);
    if (!parts.length) return '';
    const prefix = parts[0].split(/\s+/).filter(Boolean).map(escapeRegex);
    if (prefix.length < 2) return `\\b(?:${parts.map(escapeRegex).join('|')})\\b`;
    const lead = prefix[0];
    const firstAlternative = prefix.slice(1).join('[\\W_]+');
    const alternatives = [firstAlternative, ...parts.slice(1).map(escapeRegex)]
      .filter(Boolean)
      .join('|');
    return `\\b${lead}[\\W_]+(?:${alternatives})(?:[\\W_]+(?:me|you|us|again|anymore))*\\b`;
  }

  function joinFlexibleWords(words) {
    const output = [];
    for (let index = 0; index < words.length; index += 1) {
      if (index > 0) output.push(isContractionPair(words[index - 1], words[index]) ? '[\\W_]*' : '[\\W_]+');
      output.push(words[index]);
    }
    return output.join('');
  }

  function isContractionPair(left, right) {
    return /^(?:i|you|we|they|he|she|it|that|there|what|who|do|don|doesn|didn|can|couldn|wouldn|shouldn|won|isn|aren|wasn|werent|havent|hasnt|hadnt)$/i.test(left)
      && /^(?:m|re|ve|ll|d|s|t)$/i.test(right);
  }

  function normalizeRegexPatternForSearch(pattern) {
    let output = '';
    let escaped = false;
    let inCharacterClass = false;
    let inQuantifierBrace = false;
    let skippedQuantifiableToken = false;

    const text = String(pattern || '');
    for (let index = 0; index < text.length; index += 1) {
      const char = text[index];
      if (escaped) {
        output += char;
        escaped = false;
        skippedQuantifiableToken = false;
        continue;
      }
      if (char === '\\') {
        output += char;
        escaped = true;
        skippedQuantifiableToken = false;
        continue;
      }
      if (char === '[') inCharacterClass = true;
      if (char === ']') inCharacterClass = false;
      if (!inCharacterClass && char === '{') {
        inQuantifierBrace = true;
        output += char;
        continue;
      }
      if (inQuantifierBrace) {
        output += char;
        if (char === '}') inQuantifierBrace = false;
        continue;
      }

      if (!inCharacterClass && /['`\u2018\u2019\u201c\u201d]/.test(char)) {
        skippedQuantifiableToken = true;
        continue;
      }
      if (!inCharacterClass && char === '?' && skippedQuantifiableToken) {
        skippedQuantifiableToken = false;
        continue;
      }
      skippedQuantifiableToken = false;

      if (!inCharacterClass && char === '?' && output.endsWith('(')) {
        output += char;
        continue;
      }
      if (!inCharacterClass && char === '?' && isRegexQuestionMarkSyntax(output)) {
        output += char;
        continue;
      }
      if (!inCharacterClass && /[!=]/.test(char) && (output.endsWith('(?') || output.endsWith('(?<'))) {
        output += char;
        continue;
      }
      if (!inCharacterClass && char === ':' && output.endsWith('(?')) {
        output += char;
        continue;
      }
      if (!inCharacterClass && char === '.' && text[index + 1] === '*') {
        output += char;
        continue;
      }
      if (!inCharacterClass && /[-,.:;!?—–]/.test(char)) {
        output += '\\s+';
        continue;
      }
      output += char;
    }
    return sortSimpleBoundedAlternatives(output).replace(/\\s\+\s+/g, '\\s+');
  }

  function isRegexQuestionMarkSyntax(output) {
    const previous = String(output || '').at(-1);
    return Boolean(previous && !/[\s(|]/.test(previous));
  }

  function stemPatternToRegex(value) {
    const stem = String(value || '').replace(/\.\.\.$/, '').trim();
    if (!stem) return '';
    return `\\b${escapeRegex(stem)}\\w*\\b`;
  }

  function uniqueRegexFlags(flags) {
    return Array.from(new Set(String(flags || '').split(''))).filter((flag) => 'dgimsuvy'.includes(flag)).join('');
  }

  function buildRules(payloadRules) {
    return flattenRules(payloadRules).map((rule, index) => ({
      ...rule,
      id: rule.id || `${rule.tag}:${rule.name || 'rule'}:${index}`,
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
    if (base.categories?.user_added && merged.categories.user_added) {
      merged.categories.user_added.color = base.categories.user_added.color;
    }
    merged.opacity = clamp(Number(merged.opacity ?? base.opacity), 0.08, 0.85);
    merged.selector = String(merged.selector || base.selector);
    merged.customKeywords = Array.isArray(override?.customKeywords)
      ? Array.from(new Set(override.customKeywords.map(normalizeKeyword).filter(Boolean)))
      : [...(base.customKeywords || [])];
    merged.customKeywordTextByPattern = normalizeCustomKeywordTextMap(
      override?.customKeywords,
      override?.customKeywordTextByPattern || base.customKeywordTextByPattern || {}
    );
    return merged;
  }

  function getCustomKeywordRules(settings) {
    const category = settings.categories.user_added;
    if (!category || category.enabled === false) return [];
    return (settings.customKeywords || []).map((keyword, index) => ({
      id: `user_added:${index}`,
      name: keyword,
      tag: 'user_added',
      action: 'user_added',
      pattern: escapeRegex(keyword),
      conditionSummary: settings.customKeywordTextByPattern?.[keyword] || '',
      source: 'popup custom keyword',
      groupPath: 'customKeywords',
      regex: new RegExp(escapeRegex(keyword), 'gi')
    }));
  }

  function getActiveRules(rules, settings) {
    const configuredRules = rules
      .filter((rule) => {
        if (rule.tag === 'no_action') return false;
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
    const bulletRegex = /\u2022[^\r\n]*/g;
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
    const messageText = String(text || '');
    const rawSearchContext = { text: messageText, normalized: false, rawIndexes: null };
    let normalizedSearchContext = null;
    for (const rule of activeRules) {
      const searchContext = shouldSearchNormalizedText(rule)
        ? (normalizedSearchContext ||= normalizeSearchTextWithMapping(messageText))
        : rawSearchContext;
      rule.regex.lastIndex = 0;
      let match;
      while ((match = rule.regex.exec(searchContext.text)) !== null) {
        const value = match[0];
        if (!value) {
          rule.regex.lastIndex += 1;
          continue;
        }
        const span = mapSearchSpanToRaw(searchContext, match.index, match.index + value.length);
        const rawValue = messageText.slice(span.start, span.end);
        if (/^fu$/i.test(rawValue) && /[a-z0-9_-]/i.test(`${messageText[span.start - 1] || ''}${messageText[span.end] || ''}`)) {
          continue;
        }
        if (shouldSuppressContextualNonOptOutMatch(rule, messageText, span.start, span.end)) {
          continue;
        }
        if (shouldMatchWholeMessage(rule) && !isOnlyMessageBodyMatch(messageText, rawValue)) {
          continue;
        }
        candidates.push({ start: span.start, end: span.end, length: span.end - span.start, rule });
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

  function shouldSearchNormalizedText(rule) {
    const target = String(rule.matchTarget || '').toLowerCase();
    const scope = String(rule.matchScope || '').toLowerCase();
    return (
      target.includes('normalized') ||
      scope.includes('normalized') ||
      scope.includes('full') ||
      scope.includes('exact') ||
      scope.includes('whole')
    );
  }

  function normalizeSearchTextWithMapping(value) {
    const chars = [];
    const rawIndexes = [];
    let pendingSpaceIndex = null;
    const text = String(value || '');
    for (let index = 0; index < text.length; index += 1) {
      const folded = foldSearchChar(text[index]);
      for (const char of folded) {
        if (/[a-z0-9]/.test(char)) {
          if (pendingSpaceIndex !== null && chars.length) {
            chars.push(' ');
            rawIndexes.push(pendingSpaceIndex);
          }
          pendingSpaceIndex = null;
          chars.push(char);
          rawIndexes.push(index);
        } else if (isIgnorableSearchPunctuation(char) || isLikelyMojibakeApostrophe(char, text, index)) {
          continue;
        } else if (chars.length) {
          pendingSpaceIndex = index;
        }
      }
    }
    return {
      text: chars.join(''),
      normalized: true,
      rawIndexes
    };
  }

  function foldSearchChar(char) {
    return String(char || '')
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]+/g, '')
      .normalize('NFKC')
      .toLowerCase();
  }

  function isIgnorableSearchPunctuation(char) {
    return char === "'" || char === '`' || char === '\u2018' || char === '\u2019';
  }

  function isLikelyMojibakeApostrophe(char, text, index) {
    if (char !== '?') return false;
    return /[A-Za-z]/.test(text[index - 1] || '') && /[A-Za-z]/.test(text[index + 1] || '');
  }

  function mapSearchSpanToRaw(searchContext, start, end) {
    if (!searchContext.normalized) return { start, end };
    const rawIndexes = searchContext.rawIndexes || [];
    const rawStart = rawIndexes[start] ?? 0;
    const rawEnd = (rawIndexes[Math.max(start, end - 1)] ?? rawStart) + 1;
    return { start: rawStart, end: rawEnd };
  }

  function shouldSuppressContextualNonOptOutMatch(rule, text, start, end) {
    const matchedText = text.slice(start, end);
    if (!/^stop$/i.test(normalizeMessageBody(matchedText))) return false;
    return /^\s+by\b/i.test(text.slice(end));
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
    return limitText(getKeywordPattern(value).trim().replace(/\s+/g, ' '), MAX_CUSTOM_KEYWORD_LENGTH);
  }

  function getKeywordPattern(value) {
    if (value && typeof value === 'object') return String(value.pattern || value.name || '');
    return String(value || '');
  }

  function normalizeCustomKeywordTextMap(customKeywords, existingTextByPattern = {}) {
    const textByPattern = {};
    for (const item of customKeywords || []) {
      if (item && typeof item === 'object') {
        const pattern = normalizeKeyword(item);
        if (pattern) textByPattern[pattern] = limitText(item.text || existingTextByPattern[pattern] || '', MAX_CUSTOM_KEYWORD_TEXT_LENGTH);
      }
    }
    for (const [pattern, text] of Object.entries(existingTextByPattern || {})) {
      const normalized = normalizeKeyword(pattern);
      if (normalized && !(normalized in textByPattern)) textByPattern[normalized] = limitText(text || '', MAX_CUSTOM_KEYWORD_TEXT_LENGTH);
    }
    return textByPattern;
  }

  function limitText(value, maxLength) {
    return String(value || '').slice(0, maxLength).trim();
  }

  function shouldMatchWholeMessage(rule) {
    return rule.tag === 'not_opt_out' || rule.tag === 'close' || [
      'full_normalized_message',
      'exact_normalized_exclusion',
      'whole_inbound_message_for_not_opt_out'
    ].includes(rule.matchScope);
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
    getKeywordPattern,
    getRegexPattern,
    isOnlyMessageBodyMatch,
    isProceduralRule,
    mergeSettings,
    normalizeEscalationBulletText,
    normalizeCustomKeywordTextMap,
    normalizeKeyword,
    normalizeMessageBody,
    uniqueRegexFlags
  });
})(globalThis);
