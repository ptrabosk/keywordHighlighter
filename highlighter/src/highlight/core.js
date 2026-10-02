(function installHighlightCore(globalScope) {
  'use strict';

  const normalizeRegexPatternForSearch = globalScope.AMH_REGEX_NORMALIZATION.normalizeRegexPatternForSearch;

  const MIN_CUSTOM_KEYWORD_LENGTH = 3;
  const MAX_CUSTOM_KEYWORD_LENGTH = 128;
  const MAX_CUSTOM_KEYWORDS = 40;
  const EXPECTED_SCHEMA_VERSION = 2;
  const EXPECTED_REGISTRY_NAME = 'unified_deterministic_opt_out_rules';
  const EXPECTED_RULE_COUNT = 214;
  // no_action rules are valid registry entries but have no category, so they never highlight.
  const ACTIONS = new Set(['opt_out', 'fuzzy_opt_out', 'reply', 'txt', 'tmt', 'close', 'no_action']);
  const TARGETS = new Set(['raw_customer', 'normalized_customer', 'combined']);
  const MATCH_TYPES = new Set(['regex_search', 'full_match', 'bounded_phrase', 'exact', 'exact_set', 'detector']);
  // Each detector receives (rawText, normalizedText). Hot Topic detectors need
  // the preceding brand prompt, so they never match here; see classifyMessage.
  const DETECTORS = Object.freeze({
    hot_topic_not_opt_out: () => false,
    hot_topic_opt_out: () => false,
    single_letter_only: (_raw, text) => /^[A-Za-z]$/.test(text),
    number_only: (_raw, text) => /^\d+$/.test(text),
    reaction_reply: (raw) => isTapbackReaction(raw),
    emoji_only_non_stop: (raw) => isEmojiOnlyWithoutStopSignal(raw),
    no_notifications: (_raw, text) => text.includes('not receiving notifications if this is urgent reply urgent to send a notification through with your original message'),
    driving_auto_reply: (raw) => isDrivingAutoReply(raw),
    unavailable_auto_reply: (_raw, text) => isUnavailableAutoReply(text),
    device_not_working: (_raw, text) => isDeviceNotWorking(text),
    txt_origin_question: (_raw, text) => isTextOriginQuestion(text),
    empty_customer_message: (raw) => !String(raw || '').trim(),
    real_word_collision: (_raw, text) => SAFE_COLLISION_WORDS.has(text),
    under_13: (_raw, text) => isUnderThirteen(text),
    language_filter_non_opt_out: (_raw, text) => isConservativeNonOptOutLanguage(text),
    bounded_block_intent: (_raw, text) => hasBoundedBlockIntent(text),
    targeted_legal_intent: (_raw, text) => hasLegalIntent(text),
    link_only: (raw) => isLinkOnly(raw)
  });
  const DETECTOR_NAMES = new Set(Object.keys(DETECTORS));
  const GUARD_NAMES = new Set([
    'unsubscribe_intent',
    'offensive_intent',
    'legal_intent',
    'not_interested_intent',
    'wrong_number_intent',
    'block_intent',
    'opt_in_intent'
  ]);
  const WHOLE_MESSAGE_MATCH_TYPES = new Set(['detector', 'exact', 'exact_set']);
  const RULE_ENUM_FIELDS =Object.freeze([['action', ACTIONS], ['target', TARGETS], ['match_type', MATCH_TYPES]]);
  const SAFE_COLLISION_WORDS = new Set([
    'no', 'price', 'shop', 'top', 'the', 'nice', 'oh', 'save', 'sri', 'test',
    'ok', 'yes', 'okay', 'email', 'url', 'chat',
    'spot', 'atop', 'stip', 'inscribe', 'banned', 'canceled', 'cancellation'
  ]);
  const STOP_SIGNAL_EMOJIS = new Set(['🖕', '🛑', '✋', '🙅', '🚫', '🔕']);
  const EMOJI_RE = /[\p{Extended_Pictographic}\p{Emoji_Modifier}\p{Regional_Indicator}\uFE0E\uFE0F\u200D\u20E3\u{E0020}-\u{E007F}]/gu;

  function validateRuleRegistry(payload) {
    if (!isPlainObject(payload)) throw new Error('Rule registry must be a JSON object.');
    if (payload.schema_version !== EXPECTED_SCHEMA_VERSION) {
      throw new Error(`Rule registry schema_version must be ${EXPECTED_SCHEMA_VERSION}.`);
    }
    if (payload.registry_name !== EXPECTED_REGISTRY_NAME) {
      throw new Error(`Rule registry_name must be ${EXPECTED_REGISTRY_NAME}.`);
    }
    if (!Array.isArray(payload.rules) || payload.rules.length !== EXPECTED_RULE_COUNT) {
      throw new Error(`Rule registry must contain exactly ${EXPECTED_RULE_COUNT} rules.`);
    }

    const ids = new Set();
    payload.rules.forEach((rule, index) => validateRuleDefinition(rule, index, ids));
    return payload;
  }

  function validateRuleDefinition(rule, index, ids) {
    validateRuleIdentity(rule, index, ids);
    validateRuleEnums(rule);
    if (rule.match_type === 'detector') {
      if (!DETECTOR_NAMES.has(rule.detector)) throw new Error(`${rule.rule_id} has unsupported detector ${rule.detector}.`);
    } else {
      validatePatternData(rule);
    }
  }

  function validateRuleIdentity(rule, index, ids) {
    const location = `rules[${index}]`;
    if (!isPlainObject(rule)) throw new Error(`${location} must be an object.`);
    if (!/^R\d{4}$/.test(rule.rule_id || '')) throw new Error(`${location} has an invalid rule_id.`);
    if (ids.has(rule.rule_id)) throw new Error(`Rule registry contains duplicate rule_id ${rule.rule_id}.`);
    ids.add(rule.rule_id);
  }

  function validateRuleEnums(rule) {
    for (const [field, allowed] of RULE_ENUM_FIELDS) {
      if (!allowed.has(rule[field])) throw new Error(`${rule.rule_id} has unsupported ${field} ${rule[field]}.`);
    }
    if (rule.guard && !GUARD_NAMES.has(rule.guard)) throw new Error(`${rule.rule_id} has unsupported guard ${rule.guard}.`);
  }

  // Non-detector rules need a `pattern`, or a `patterns` list (required for exact_set).
  function validatePatternData(rule) {
    const hasPattern = isNonEmptyString(rule.pattern);
    const hasPatterns = Array.isArray(rule.patterns) && rule.patterns.length > 0 && rule.patterns.every(isNonEmptyString);
    if (!hasPattern && !hasPatterns) throw new Error(`${rule.rule_id} has no usable pattern data.`);
    const needsPatterns = rule.match_type === 'exact_set' || Array.isArray(rule.patterns);
    if (needsPatterns && !hasPatterns) throw new Error(`${rule.rule_id} requires a non-empty patterns array.`);
  }

  function isPlainObject(value) {
    return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
  }

  function isNonEmptyString(value) {
    return typeof value === 'string' && value.length > 0;
  }

  function buildRules(payload) {
    validateRuleRegistry(payload);
    return payload.rules.map(compileRuleDefinition);
  }

  function compileRuleDefinition(value) {
    const patterns = Array.isArray(value.patterns) ? [...value.patterns] : [value.pattern];
    const rule = {
      id: value.rule_id,
      name: value.rule_id,
      tag: value.action,
      action: value.action,
      target: value.target,
      matchTarget: value.target,
      matchType: value.match_type,
      pattern: typeof value.pattern === 'string' ? value.pattern : '',
      patterns,
      flags: value.flags || '',
      detector: value.detector || '',
      guard: value.guard || '',
      conditionSummary: describeRule(value),
      exactPatterns: null,
      regexes: [],
      executable: true
    };

    if (rule.matchType === 'exact' || rule.matchType === 'exact_set') {
      rule.exactPatterns = new Set(patterns.map(normalizeComparableText).filter(Boolean));
    } else if (rule.matchType === 'bounded_phrase') {
      rule.regexes = patterns.map(compileBoundedPhrase);
    } else if (rule.matchType === 'regex_search' || rule.matchType === 'full_match') {
      rule.regexes = [compileRegistryRegex(rule, rule.pattern)];
    }
    rule.readsEmoji = readsEmoji(rule);
    rule.emojiStop = rule.readsEmoji && rule.action === 'opt_out' && mentionsStopEmoji(rule.pattern);
    return rule;
  }

  // A raw-message rule whose pattern contains an emoji must see the message as written;
  // every other rule reads it with emojis removed.
  function decodeEscapes(pattern) {
    return String(pattern || '')
      .replace(/\\U([0-9a-fA-F]{8})/g, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .replace(/\\u\{([0-9a-fA-F]{1,6})\}/g, (_match, hex) => String.fromCodePoint(Number.parseInt(hex, 16)))
      .replace(/\\u([0-9a-fA-F]{4})/g, (_match, hex) => String.fromCharCode(Number.parseInt(hex, 16)));
  }

  function readsEmoji(rule) {
    return rule.target === 'raw_customer' && /\p{Extended_Pictographic}/u.test(decodeEscapes(rule.pattern));
  }

  function mentionsStopEmoji(pattern) {
    const decoded = decodeEscapes(pattern);
    return Array.from(STOP_SIGNAL_EMOJIS).some((emoji) => decoded.includes(emoji));
  }

  function describeRule(rule) {
    const target = String(rule.target || '').replace(/_/g, ' ');
    if (rule.match_type === 'detector') {
      return `Runs the ${String(rule.detector || '').replace(/_/g, ' ')} detector against the ${target}.`;
    }
    const count = Array.isArray(rule.patterns) ? rule.patterns.length : 1;
    if (rule.match_type === 'exact_set') return `Matches the complete ${target} against one of ${count} configured phrases.`;
    if (rule.match_type === 'exact') return `Matches one exact ${target} phrase.`;
    if (rule.match_type === 'full_match') return `Matches a configured expression against the complete ${target}.`;
    if (rule.match_type === 'bounded_phrase') return `Matches ${count} configured phrase${count === 1 ? '' : 's'} on Unicode word boundaries in the ${target}.`;
    return `Searches the ${target} for a configured expression.`;
  }

  function compileRegistryRegex(rule, sourcePattern) {
    let pattern = repairCommonMojibake(String(sourcePattern || ''));
    const translated = translatePythonUnicodeEscapes(pattern);
    pattern = translated.pattern;
    if (rule.target === 'normalized_customer') pattern = normalizeRegexPatternForSearch(pattern);
    if (rule.matchType === 'full_match') pattern = `^(?:${pattern})$`;
    const flags = uniqueRegexFlags(`${rule.flags || ''}g${translated.needsUnicode ? 'u' : ''}`);
    try {
      return new RegExp(pattern, flags);
    } catch (error) {
      throw new Error(`${rule.id} has an invalid JavaScript regular expression: ${error.message || error}`);
    }
  }

  function translatePythonUnicodeEscapes(pattern) {
    let needsUnicode = false;
    const translated = String(pattern || '').replace(/\\U([0-9a-fA-F]{8})/g, (_match, hex) => {
      needsUnicode = true;
      return `\\u{${Number.parseInt(hex, 16).toString(16)}}`;
    });
    return { pattern: translated, needsUnicode };
  }

  function compileBoundedPhrase(pattern) {
    const normalized = normalizeComparableText(pattern);
    const body = normalized.split(' ').filter(Boolean).map(escapeRegex).join('\\s+');
    if (!body) throw new Error('Bounded phrase cannot normalize to an empty value.');
    return new RegExp(`(?<![\\p{L}\\p{N}])${body}(?![\\p{L}\\p{N}])`, 'giu');
  }

  function mergeSettings(base, override = {}) {
    const merged = { ...base, ...override, categories: mergeCategories(base.categories || {}, override?.categories) };
    merged.opacity = clamp(Number(merged.opacity ?? base.opacity), 0.08, 0.85);
    merged.selector = String(merged.selector || base.selector);
    merged.customKeywords = mergeCustomKeywords(base, override);
    // Hover text was removed; drop any value left in older stored settings.
    delete merged.customKeywordTextByPattern;
    return merged;
  }

  // Only known categories survive. Stored overrides may change a color, but
  // never the label, priority, the user_added color, or (removed) on/off state.
  function mergeCategories(baseCategories, overrideCategories) {
    const categories = {};
    for (const [key, baseCategory] of Object.entries(baseCategories)) {
      const { enabled: _ignoredEnabled, ...categoryOverride } = overrideCategories?.[key] || {};
      categories[key] = { ...baseCategory, ...categoryOverride, label: baseCategory.label, priority: baseCategory.priority };
      if (isRetiredColorOverride(key, categoryOverride.color)) categories[key].color = baseCategory.color;
    }
    if (categories.user_added) categories.user_added.color = baseCategories.user_added.color;
    return categories;
  }

  // The old yellow TXT color was replaced; stored copies of it fall back to the default.
  function isRetiredColorOverride(key, color) {
    return key === 'txt' && String(color || '').toUpperCase() === '#F6DA71';
  }

  function mergeCustomKeywords(base, override) {
    const keywords = Array.isArray(override?.customKeywords)
      ? Array.from(new Set(override.customKeywords.map(normalizeKeyword).filter(Boolean)))
      : [...(base.customKeywords || [])];
    return keywords.slice(0, MAX_CUSTOM_KEYWORDS);
  }

  function getCustomKeywordRules(settings) {
    if (!settings.categories.user_added) return [];
    return (settings.customKeywords || []).map((keyword, index) => ({
      id: `user_added:${index}`,
      name: keyword,
      tag: 'user_added',
      action: 'user_added',
      target: 'raw_customer',
      matchTarget: 'raw_customer',
      matchType: 'regex_search',
      pattern: escapeRegex(keyword),
      patterns: [keyword],
      conditionSummary: '',
      source: 'popup custom keyword',
      regexes: [new RegExp(escapeRegex(keyword), 'gi')],
      exactPatterns: null,
      executable: true
    }));
  }

  function getActiveRules(rules, settings) {
    const configuredRules = rules
      .filter((rule) => rule.executable && settings.categories[rule.tag])
      .sort((a, b) => getRulePriority(a, settings) - getRulePriority(b, settings));
    return [...getCustomKeywordRules(settings), ...configuredRules];
  }

  // Reaction, emoji stop, emoji only and Hot Topic outrank every category; the categories then
  // run opt out, fuzzy opt out, tmt, txt, reply, close (no_action has no category and never paints).
  function getRulePriority(rule, settings) {
    if (rule.detector === 'reaction_reply') return 0;
    if (rule.emojiStop) return 1;
    if (rule.detector === 'emoji_only_non_stop') return 2;
    if (rule.detector === 'hot_topic_opt_out' || rule.detector === 'hot_topic_not_opt_out') return 3;
    return settings.categories[rule.tag]?.priority ?? 999;
  }

  const escalationBulletRules = Object.freeze([
    Object.freeze({
      id: 'code:escalation_immediately',
      name: 'escalation_immediately',
      tag: 'escalation_action',
      label: 'Escalation action',
      regex: /\bimmediately\b/i
    }),
    Object.freeze({
      id: 'code:escalation_use_temp',
      name: 'escalation_use_temp',
      tag: 'escalation_action',
      label: 'Escalation action',
      regex: /\b(?:use|Use|USE)\s+[A-Z]+\s+(?:temp|Temp|TEMP)\b/
    }),
    Object.freeze({
      id: 'code:escalation_use_shortcut',
      name: 'escalation_use_shortcut',
      tag: 'escalation_action',
      label: 'Escalation action',
      regex: /\b(?:use|Use|USE)\s+[A-Z]+\s+(?:shortcut|Shortcut|SHORTCUT)\b/
    }),
    Object.freeze({
      id: 'code:escalation_no_esc',
      name: 'escalation_no_esc',
      tag: 'escalation_action',
      label: 'Escalation action',
      normalizedRegex: /\bno esc\b/
    }),
    Object.freeze({
      id: 'code:escalation_post_purchase',
      name: 'escalation_post_purchase',
      tag: 'escalation_action',
      label: 'Escalation action',
      normalizedRegex: /\bpost purchase\b/
    }),
    Object.freeze({
      id: 'code:escalation_client_takeover',
      name: 'escalation_client_takeover',
      tag: 'escalation_action',
      label: 'Escalation action',
      regex: /\bclose\s+when\s+(?:the\s+)?client\s+takes\s+over\b/i
    }),
    Object.freeze({
      id: 'code:escalation_last_word',
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

  // Returns non-overlapping matches, best first: category priority, then
  // earliest, then longest.
  function collectMatches(text, activeRules, settings) {
    const messageText = String(text || '');
    const rawContext = { text: messageText, normalized: false, rawSpans: null };
    // Same text with every emoji blanked out (same length, so spans still map to the message).
    rawContext.withoutEmoji = { text: messageText.replace(EMOJI_RE, (emoji) => ' '.repeat(emoji.length)), normalized: false, rawSpans: null };
    const normalizedContext = normalizeSearchTextWithMapping(messageText);
    // Regex rules are also tried against the text with apostrophes as spaces ("doesn t"),
    // matching the zapOptOuts engine; registry patterns are authored against both forms.
    const spacedContext = normalizeSearchTextWithMapping(messageText, true);
    normalizedContext.alternate = spacedContext.text === normalizedContext.text ? null : spacedContext;
    const candidates = activeRules.flatMap((rule) => collectAllowedRuleMatches(rule, messageText, rawContext, normalizedContext));
    candidates.sort((a, b) => compareCandidates(a, b, settings));
    return selectNonOverlapping(candidates);
  }

  function collectAllowedRuleMatches(rule, messageText, rawContext, normalizedContext) {
    const effectiveGuard = rule.guard || implicitGuardForRule(rule);
    if (!guardAllows(effectiveGuard, normalizedContext.text)) return [];
    return collectRuleMatches(rule, messageText, rawContext, normalizedContext)
      .filter((candidate) => !isSuppressedCandidate(candidate, messageText, normalizedContext.text));
  }

  // "f u" only counts as the whole message, and "stop by" is not an opt-out.
  function isSuppressedCandidate(candidate, messageText, normalizedMessage) {
    const normalizedValue = normalizeComparableText(messageText.slice(candidate.start, candidate.end));
    if (/^f\s*u$/i.test(normalizedValue) && normalizedMessage !== 'fu' && normalizedMessage !== 'f u') return true;
    return shouldSuppressContextualStopMatch(normalizedValue, messageText, candidate.end);
  }

  function compareCandidates(a, b, settings) {
    return (getRulePriority(a.rule, settings) - getRulePriority(b.rule, settings))
      || (a.start - b.start)
      || (b.length - a.length);
  }

  function selectNonOverlapping(sortedCandidates) {
    const accepted = [];
    for (const candidate of sortedCandidates) {
      if (!accepted.some((existing) => candidate.start < existing.end && candidate.end > existing.start)) {
        accepted.push(candidate);
      }
    }
    return accepted;
  }

  function collectRuleMatches(rule, messageText, rawContext, normalizedContext) {
    if (!rule || !rule.executable || rule.target === 'combined') return [];
    if (WHOLE_MESSAGE_MATCH_TYPES.has(rule.matchType)) {
      return wholeMessageRuleMatches(rule, messageText, normalizedContext.text) ? [wholeMessageCandidate(messageText, rule)] : [];
    }
    const contexts = rule.target === 'raw_customer'
      ? [rule.readsEmoji || rule.tag === 'user_added' ? rawContext : rawContext.withoutEmoji]
      : [normalizedContext, normalizedContext.alternate].filter(Boolean);
    return contexts.flatMap((context) => (rule.regexes || []).flatMap((regex) => collectRegexMatches(rule, regex, context, messageText)));
  }

  function wholeMessageRuleMatches(rule, messageText, normalizedText) {
    if (rule.matchType === 'detector') return detectorMatches(rule.detector, messageText, normalizedText);
    return Boolean(rule.exactPatterns?.has(normalizedText));
  }

  function collectRegexMatches(rule, regex, context, messageText) {
    const output = [];
    regex.lastIndex = 0;
    let match;
    while ((match = regex.exec(context.text)) !== null) {
      if (!match[0]) {
        regex.lastIndex += 1;
        continue;
      }
      // A full_match rule always covers the whole message.
      if (rule.matchType === 'full_match') return [wholeMessageCandidate(messageText, rule)];
      const span = mapSearchSpanToRaw(context, match.index, match.index + match[0].length);
      output.push({ start: span.start, end: span.end, length: span.end - span.start, rule });
    }
    return output;
  }

  function wholeMessageCandidate(messageText, rule) {
    return { start: 0, end: messageText.length, length: messageText.length, rule };
  }

  function detectorMatches(detector, rawText, normalizedText) {
    const detect = Object.hasOwn(DETECTORS, detector) ? DETECTORS[detector] : null;
    return detect ? detect(rawText, normalizedText) : false;
  }

  // Driving auto-replies. The patterns and known variations are generated from the DRIVING_*
  // constants in zapOptOuts/optout_classifier/deterministic_rules.py so both engines agree;
  // regenerate them when zap's change. The "can't text" form is matched on the raw message.
  const DRIVING_DATA = {
    "normalized": "^i ?m not receiving notifications if this is urgent reply urgent to send a notification through with your original message i ?m driving with do not disturb while driving turned on i ?ll see your message when i get where i ?m going if this is urgent please call me$|^(?:auto reply )?(?:i am|i m|im) driving$|^driving can ?t text$|^estoy conduciendo$|^je suis au volant$|^i m driving(?: with focus turned on| and can t receive texts) i ll see your message when i get where i m going(?: thanks)?(?: i m not receiving notifications if this is urgent reply urgent to send a notification through with your original message)?$",
    "cantText": "^\\s*(?:driving,\\s*can(?:['’`]|\\s)?t\\s+text|manejan\\.,\\s*no\\s+puedo\\s+escrib)[.!-]?\\s*-?\\s*sent\\s+from[ \\t]*[^\\r\\n]{0,20}?(?:\\s*(?:driving,\\s*can(?:['’`]|\\s)?t\\s+text|manejan\\.,\\s*no\\s+puedo\\s+escrib)[.!-]?\\s*-?\\s*sent\\s+from[ \\t]*[^\\r\\n]{0,20}?)*\\s*$",
    "variations": [
      "I’m driving with Do Not Disturb While Driving. I’ll see your message when I get where I’m going. If this is urgent please call me! 😊<br>(I’m not receiving notifications. If this is urgent, reply “urgent” to send a notification through with your original message.)",
      "I’m driving with Focus turned on. I’ll see your message when I get where I’m going. If this is urgent, please call.<br><br>(I’m not receiving notifications. If this is urgent, reply “urgent” to send a notification through with your original message.)",
      "I’m driving. I’ll see your message when I get where I’m going. Or please call my cell phone<br><br>(I’m not receiving notifications. If this is urgent, reply “urgent” to send a notification through with your original message.)",
      "I am currently driving and cannot reply to text. If needed, please call my phone and I can talk via Bluetooth. Thanks! Powered by TRUCE.",
      "I’m driving with Do Not Disturb While Driving turned on. I’ll see your message when I get where I’m going. If this is urgent please call me.<br><br>(I’m not receiving notifications. If this is urgent, reply “urgent” to send a notification through with your original message.)",
      "(I’m not receiving notifications. If this is urgent, reply “urgent” to send a notification through with your original message.)<br><br>I’m driving with Do Not Disturb While Driving turned on. I’ll see your message when I get where I’m going. If urgent please call me. Safe travels.",
      "I’m driving and can’t respond to text messages right now. If you need to reach me, please call me.<br><br>(I’m not receiving notifications. If this is urgent, reply “urgent” to send a notification through with your original message.)",
      "I’ currently driving and not able to respond by text. If this is urgent please call. Thanks!Shelley<br><br>(I’m not receiving notifications. If this is urgent, reply “urgent” to send a notification through with your original message.)",
      "Uuhhh, her driving with her hands on 10 & 2! 🙄Her don’t text and drive, that’s ILLEGAL! 😬 She promises to holla back when she gets where she’s going. ❤️🌹<br><br>(I’m not receiving notifications. If this is urgent, reply “urgent” to send a notification through with your original message.)"
    ]
  };
  const DRIVING_AUTO_REPLY = new RegExp(DRIVING_DATA.normalized);
  const DRIVING_CANT_TEXT = new RegExp(DRIVING_DATA.cantText, 'i');
  const DRIVING_VARIATIONS = new Set(DRIVING_DATA.variations.map((value) => normalizeComparableText(stripHtmlBreaks(value))));

  function stripHtmlBreaks(value) {
    return String(value || '').replace(/<br\s*\/?>/gi, ' ');
  }

  // Zap also tries the text with apostrophes as spaces ("i m driving").
  function isDrivingAutoReply(rawText) {
    const raw = stripHtmlBreaks(rawText);
    const variants = new Set([normalizeComparableText(raw), normalizeSearchTextWithMapping(raw, true).text]);
    return [...variants].some((value) => DRIVING_VARIATIONS.has(value) || DRIVING_AUTO_REPLY.test(value))
      || DRIVING_CANT_TEXT.test(String(rawText || ''));
  }

  function hasBoundedBlockIntent(text) {
    return /\b(?:block|blocking|blocked)\s+(?:(?:your|this|the)\s+)?(?:you|u|this|these|texts?|messages?|number|sender)\b/.test(text)
      || /\b(?:im|i am|ill|i will)\s+(?:block|blocking)\s+(?:(?:your|this|the)\s+)?(?:you|u|this|these|texts?|messages?|number|sender)\b/.test(text);
  }

  // A tapback is the entire message: a reaction prefix followed by the quoted original.
  // Any trailing text means the customer wrote something of their own, so it is not
  // treated as a reaction. Reaction (tapback) detection. The pattern data below is generated from the REACTION_*
  // constants in zapOptOuts/optout_classifier/deterministic_rules.py so both engines recognize
  // the same prefixes, quote pairs and nested/suffix forms; regenerate it when zap's change.
  const REACTION_DATA = {
    "prefixes": [
      "liked|loved|emphasized|emphasised|laughed at|disliked|questioned",
      "(?:[\\u{1f000}-\\u{1faff}\\u2600-\\u27bf]\\ufe0f?|!!\\ufe0f?)\\s+(?:a|to)",
      "reacted(?:\\s+with\\s+a\\s+(?:sticker|photomoji)|\\s+\\S+)?\\s+to",
      "removed(?:\\s+\\S+){0,4}\\s+from",
      "reacciono\\s+con\\s+(?:\\S+|un\\s+sticker)\\s+a|se\\s+ha\\s+reaccionado\\s+con\\s+\\S+\\s+a",
      "se\\s+ha\\s+anadido\\s+\\S+\\s+a",
      "se\\s+quito\\s+\\S+\\s+de|elimino\\s+\\S+\\s+de|ha\\s+eliminado(?:\\s+\\S+){0,4}\\s+de",
      "dudo\\s+sobre|duda\\s+sobre|dejo\\s+de\\s+dudar\\s+sobre|ya\\s+no\\s+duda\\s+sobre",
      "exclamo\\s+por|dejo\\s+de\\s+exclamar\\s+por",
      "le\\s+(?:gusto|dio\\s+risa|encanta|gusta|sorprende|hace\\s+gracia|encanto)",
      "no\\s+le\\s+(?:gusto|gusta)|ya\\s+no\\s+le\\s+(?:gusta|hace\\s+gracia|encanta)",
      "dejo\\s+de\\s+(?:gustarle|darle\\s+risa|encantarle|no\\s+gustarle)",
      "questionou|riu\\s+de|curtiu|nao\\s+curtiu|gostou\\s+de|adorou",
      "reagiu\\s+com\\s+\\S+\\s+a|removeu\\s+(?:\\S+|uma\\s+(?:risada|exclamacao))\\s+de|enfatizou",
      "a\\s+ajoute\\s+(?:un\\s+rire|un\\s+point\\s+d.interrogation|des\\s+points\\s+d.exclamation)\\s+a",
      "a\\s+reagi(?:\\s+avec)?\\s+\\S+\\s+a",
      "ha\\s+aggiunto\\s+(?:un\\s+cuoricino|il\\s+punto\\s+interrogativo|i\\s+punti\\s+esclamativi)\\s+a",
      "ha\\s+reagito\\s+con\\s+\\S+\\s+a|ha\\s+rimosso\\s+\\S+\\s+da|trova\\s+divertente",
      "Đa\\s+(?:xoa|tha|tuong\\s+tac|nhan\\s+manh|nghi\\s+van|yeu\\s+thich|khong\\s+thich|thich)\\b(?:\\s+\\S+){0,4}",
      "用\\S+回应了|已用\\S+回應|喜欢|喜歡|不喜欢|不喜歡|惊叹|驚嘆",
      "Посмеялись\\s+над|Отмечено|Не\\s+понравилось|Понравилось",
      "Отреагировал\\(а\\)\\s+\\S+\\s+на\\s+сообщение|Подобається|Піддає\\s+сумніву",
      "وضع\\(ت\\)\\s+(?:إعجابًا|عدم\\s+إعجاب)\\s+على|ضحك\\(ت\\)\\s+على",
      "أحب.{0,20}?\\(ت\\)|تساءل\\(ت\\)\\s+عن|تفاعل\\(ت\\)\\s+\\S+\\s+على|أك.{0,20}?د\\(ت\\)\\s+على",
      "Αντεδρασε\\s+με\\s+\\S+\\s+σε|reageerde\\s+met\\s+\\S+\\s+op|gaf\\s+een\\s+hartje\\s+aan",
      "verwijderde\\s+een\\s+duim\\s+omlaag\\s+van",
      "bereaksi\\s+\\S+\\s+terhadap|menyukai",
      "(?:soru\\s+isareti|gulme\\s+isareti|kalp)\\s+eklendi:|soru\\s+isareti\\s+silindi:|begenildi:",
      "ชอบ|ตั้งคําถาม|føjede\\s+et\\s+hjerte\\s+til|l’ha\\s+sorpres",
      "[\\u{1f000}-\\u{1faff}\\u2600-\\u27bf]\\ufe0f?\\s+ចំពោះ"
    ],
    "quotePairs": [
      [
        "\"",
        "\""
      ],
      [
        "“",
        "”"
      ],
      [
        "‘",
        "’"
      ],
      [
        "'",
        "'"
      ],
      [
        "«",
        "»"
      ],
      [
        "‹",
        "›"
      ],
      [
        "「",
        "」"
      ],
      [
        "『",
        "』"
      ],
      [
        "�",
        "�"
      ]
    ],
    "payloadMax": 2000,
    "nested": "(?:(?:a\\s+ajoute\\s+un|a\\s+attribue\\s+la\\s+mention)\\s+@@P@@\\s+a\\s+@@P@@|a\\s+retire\\s+son\\s+@@P@@\\s+de\\s+@@P@@|ha\\s+aggiunto\\s+@@P@@\\s+a\\s+@@P@@|reagiu\\s+com\\s+@@P@@\\s+a\\s+@@P@@|reagira\\s+s\\s+@@P@@\\s+na\\s+@@P@@|Додано\\s+реакцію\\s+@@P@@\\s+на\\s+@@P@@)",
    "suffix": "(?:对\\s*@@P@@\\s*表示了?\\s*\\S+|vond\\s+@@P@@\\s+(?:niet\\s+leuk|leuk))",
    "maxChars": 4000
  };
  const REACTION_PAYLOAD = `(?:${REACTION_DATA.quotePairs.map(([open, close]) => {
    const body = close === "'" || close === '\u2019' ? `(?:[^${close}]|(?<=\\w)${close}(?=\\w))` : `[^${close}]`;
    return `${open}${body}{0,${REACTION_DATA.payloadMax}}${close}`;
  }).join('|')})`;
  const REACTION_SEGMENT = `(?:(?:${REACTION_DATA.prefixes.join('|')})\\s*${REACTION_PAYLOAD}|${REACTION_DATA.nested.replaceAll('@@P@@', REACTION_PAYLOAD)}|${REACTION_DATA.suffix.replaceAll('@@P@@', REACTION_PAYLOAD)})`;
  const REACTION_REPLY = new RegExp(`^\\s*${REACTION_SEGMENT}(?:\\s*${REACTION_SEGMENT})*(?:\\s*[.!?])?(?:\\s*(?:cool|wow))?\\s*$`, 'isu');
  const REACTION_NORMALIZED_REPLIES = new Set([
    'emphasized an image', 'laughed at an image', 'liked a contact', 'liked an image',
    'loved a contact', 'loved an image', 'reacted to an image'
  ]);

  // Same folding as zap's fold_text_variants, then zero-width characters are removed.
  function foldReactionText(value) {
    return repairCommonMojibake(String(value || '').replace(/<br\s*\/?>/gi, ' '))
      .normalize('NFKC').normalize('NFKD').replace(/[̀-ͯ]+/g, '').normalize('NFKC')
      .replace(/[\u200B-\u200D\uFEFF]/g, '');
  }

  function isTapbackReaction(value) {
    let text = foldReactionText(value).trim();
    if (text.length > REACTION_DATA.maxChars) return false;
    if (text.startsWith('"') && text.endsWith('"') && text.includes('\u201C')) text = text.slice(1, -1).trim();
    if (REACTION_REPLY.test(text)) return true;
    return REACTION_NORMALIZED_REPLIES.has(normalizeComparableText(text));
  }

  // The Hot Topic survey asks for one of four numbered choices. Only a reply
  // that is nothing but a choice is classified; anything else falls through to
  // the regular rules so an added "stop" is never hidden.
  function isHotTopicPrompt(text) {
    const normalized = normalizeComparableText(text);
    return normalized.startsWith('hot topic') &&
      /\b1\s+same\b/.test(normalized) &&
      /\b2\s+weekly\b/.test(normalized) &&
      /\b3\s+monthly\b/.test(normalized) &&
      /\b4\s+never\b/.test(normalized);
  }

  // Picks the rule that colors a whole message. `texts` are the message's
  // paragraphs; each contributes its best match, and a Hot Topic reply adds its
  // contextual rule. `getRecentBrandTexts` is only called for choice-only
  // replies, so the DOM lookback is skipped for ordinary messages.
  function classifyMessage(texts, activeRules, settings, { rules = [], getRecentBrandTexts = () => [] } = {}) {
    const candidates = [];
    const hotTopicRule = findHotTopicRule(texts.join('\n'), rules, getRecentBrandTexts);
    if (hotTopicRule) candidates.push(hotTopicRule);
    for (const text of texts) {
      if (!String(text || '').trim()) continue;
      const [best] = collectMatches(text, activeRules, settings);
      if (best) candidates.push(best.rule);
    }
    return pickHighestPriorityRule(candidates, settings);
  }

  function findHotTopicRule(replyText, rules, getRecentBrandTexts) {
    const detector = classifyHotTopicReply(replyText);
    if (!detector || !getRecentBrandTexts().some((text) => isHotTopicPrompt(text))) return null;
    return rules.find((rule) => rule.detector === detector) || null;
  }

  // Stable: among equal priorities the earliest candidate (paragraph order) wins.
  function pickHighestPriorityRule(candidates, settings) {
    return [...candidates].sort((a, b) => getRulePriority(a, settings) - getRulePriority(b, settings))[0] || null;
  }

  function classifyHotTopicReply(text) {
    const normalized = normalizeComparableText(text);
    if (/^(?:4|four)$/.test(normalized) || /\bnever\b/.test(normalized)) return 'hot_topic_opt_out';
    if (/^(?:(?:1|one)(?: same)?|same|(?:2|two)(?: weekly)?|weekly|(?:3|three)(?: monthly)?|monthly)$/.test(normalized)) {
      return 'hot_topic_not_opt_out';
    }
    return '';
  }

  function isEmojiOnlyWithoutStopSignal(value) {
    const text = String(value || '').trim();
    if (!text) return false;
    // Up to 8 emojis containing a stop signal belong to the emoji-stop tier; longer runs do not.
    const emojiCount = (text.match(/\p{Extended_Pictographic}/gu) || []).length;
    if (emojiCount <= 8 && Array.from(STOP_SIGNAL_EMOJIS).some((emoji) => text.includes(emoji))) return false;
    try {
      return /\p{Extended_Pictographic}/u.test(text)
        && /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|[\u200D\uFE0E\uFE0F\s])+$/u.test(text);
    } catch (_error) {
      return false;
    }
  }

  function isUnavailableAutoReply(text) {
    // Normalized text drops apostrophes ("im", "ill", "cant"); "i ?m" also accepts the spaced form.
    return /^(?:hey i ?m currently unavailable i ?ll get back to you as soon as i can|sorry i ?cant talk(?: right)? now|sorry (?:can ?t|cant) talk(?: right)? now|thank you for contacting me i ?m unable to chat right now but i ?ll reply to your text as soon as i can thanks|thanks for reaching out i (?:can ?t|cant) chat(?: at the moment| now) but i ?ll text you back as soon as i can(?: thanks.*)?)$/.test(text)
      || text.includes('not receiving notifications if this is urgent reply urgent');
  }

  function isDeviceNotWorking(text) {
    return /\b(?:phone|number|device)\b.*\b(?:doesnt|does not|cant|cannot|can not)\b.*\b(?:receive|accept|support)\b.*\b(?:texts?|messages?|sms)\b/.test(text)
      || /\bkosher talk only device\b.*\bdoes not accept text messages\b/.test(text)
      || /\bnot accepting (?:messages|texts?|emails?)\b/.test(text);
  }

  function isTextOriginQuestion(text) {
    return /\b(?:how|where) did (?:you|u) get my (?:number|phone number|contact)\b/.test(text)
      || /\bwho gave (?:you|u) my (?:number|phone number|contact)\b/.test(text)
      || /\bwhy (?:am i|do i) (?:getting|get|receive|receiving) (?:these )?(?:texts?|text messages?|messages?|msgs?)\b/.test(text)
      || /\bwhy (?:the fuck )?(?:are|r) (?:you|u) (?:texting|messaging|msging|contacting) me\b/.test(text)
      || /\bwhy do (?:you|u) (?:text|message|msg) me\b/.test(text)
      || /\bwhy do (?:you|u) keep (?:texting|messaging|contacting)(?: me)?\b/.test(text)
      || /\bwhy (?:are|r) (?:you|u) sending (?:me )?(?:texts?|text messages?|messages?|msgs?)\b/.test(text)
      || /\bwhy did (?:you|u) (?:text|message|msg|contact) me\b/.test(text)
      || /\bwhy did i get (?:this|these) (?:text|texts|message|messages|msg|msgs)\b/.test(text)
      || /\bi (?:dont|do not) know (?:you|u)\b/.test(text)
      || /\bwho (?:is|are) (?:this|you|u)\b/.test(text);
  }

  function isUnderThirteen(text) {
    const ageWords = '(?:one|two|three|four|five|six|seven|eight|nine|ten|eleven|twelve)';
    const ageValues = `(?:[0-9]|1[0-2]|${ageWords})`;
    return new RegExp(`\\bmy age is\\s*${ageValues}\\b|\\b(?:im|i am)(?:\\s+(?:only|just))?\\s*${ageValues}\\s*(?:years? old|yrs? old|yo|y o)\\b`).test(text)
      || /\b(?:grade [1-6]|[1-6](?:st|nd|rd|th) grade|first grader|second grader|third grader|sixth grader|elementary school|grade school|primary school|under 13|younger than 13)\b/.test(text);
  }

  function isConservativeNonOptOutLanguage(text) {
    if (!text || /\b(?:stop|unsub|unsubscribe|opt out|remove|delete|block|cancel|dnc)\b/.test(text)) return false;
    // "sh", "shh", "shhh" are shush requests (opt out), not gibberish.
    if (/^(?:sh+|shush)$/.test(text)) return false;
    if (SAFE_COLLISION_WORDS.has(text)) return true;
    return /^[a-z]{4,12}$/.test(text) && !/[aeiou]/.test(text);
  }

  function isLinkOnly(rawText) {
    const tokens = String(rawText || '').trim().split(/\s+/).filter(Boolean);
    return tokens.length > 0 && tokens.every((token) => /^(?:https?:\/\/|www\.)\S+$/i.test(token));
  }

  function guardAllows(guard, text) {
    if (!guard) return true;
    switch (guard) {
      case 'unsubscribe_intent':
        if (/\bstop by\b/.test(text)) return false;
        return /^(?:stop|unsubscribe|unsub|opt out|optout|dnc|remove me|please remove|go away|beat it|leave me alone|close|cancel|sh+|shush)$/.test(text)
          || /\b(?:stop|end|halt|remove|delete|unsubscribe|unsub|opt out|dnc|dont|do not|never|no more|take|pull)\b.*\b(?:me|my|texts?|messages?|sms|emails?|calls?|contact|communication|number|list|again|anymore)\b/.test(text)
          || /\b(?:leave me alone|take me off|turn (?:that|this|it) off|get out|shut up)\b/.test(text);
      case 'offensive_intent':
        return /^(?:fu|f u)$/.test(text) || /\b(?:fuck|fucking|stfu|sybau|bitch)\b/.test(text);
      case 'legal_intent':
        return hasLegalIntent(text);
      case 'not_interested_intent':
        return hasNotInterestedIntent(text);
      case 'wrong_number_intent':
        return /\b(?:wrong (?:number|person)|not me|not my number|this is not me|isnt my number|someone else had this number|new (?:phone )?number)\b/.test(text);
      case 'block_intent':
        return /\b(?:block|blocking|blocked|uninstall|uninstalled|uninstaller)\b/.test(text)
          && /\b(?:i|im|ill|you|u|texts?|messages?|number|all)\b/.test(text);
      case 'opt_in_intent':
        return /^start(?:s|ed|ing)?$/.test(text) || /\b(?:subscribe|opt in|sign me up|unstop|start (?:texts?|messages?))\b/.test(text);
      case 'opt_out_instruction':
        // Zap's opt_out_instruction_signal ignores questions and reported/page wording.
        return !(/\b(?:page|website|instructions?|screen) (?:say|says|said|show|shows|showed)\b/.test(text)
          || /\b(?:what does|what is|how do i|why does)\b.{0,40}\b(?:stop|unsubscribe|opt out)\b/.test(text)
          || /\b(?:customer|person|user|they|he|she) (?:said|says|wrote|asked|texted|typed|sent)\b.{0,40}\b(?:stop|unsubscribe|remove me)\b/.test(text));
      default:
        return false;
    }
  }

  function implicitGuardForRule(rule) {
    if (rule.id === 'R0170') return 'not_interested_intent';
    if (rule.id === 'R0228') return 'opt_out_instruction';
    return '';
  }

  // Mirrors the harmonized legal-intent rule (opt_out_19 / legal-intent-v2): a message
  // is legal intent when any independently authored clause is a first-person legal threat
  // or names a regulator. Normalized text has no punctuation, so only "but"/"however" split it.
  const LEGAL_AUTHORITY = '(?:(?:the )?police|(?:an? )?(?:attorney|lawyer|regulator))';
  const LEGAL_AGENCY = '(?:bbb|better business bureau|fcc|federal communications commission|ftsa|tcpa|florida telephone solicitation act|telephone consumer protection act)';
  const LEGAL_NEGATED = new RegExp(`\\b(?:not|never|wont|wouldnt|dont) (?:be |go |going to )?(?:sue|report|press charges|(?:call|contact) ${LEGAL_AUTHORITY})\\b`);
  const LEGAL_REPORTED = /\b(?:said|says|asked|asks|wonder(?:ed|ing)?|what does|how do i)\b.{0,40}\b(?:sue|legal action|press charges|report fraud|call (?:the )?police)\b/;
  // Kept from the previous highlighter rule: "where do I report this" is a question, not a threat.
  const LEGAL_HOW_TO_REPORT = /\b(?:who|where|how|what) (?:can|could|do|should|would) i (?:report|file|make|submit|lodge)\b/;
  const LEGAL_BARE = new RegExp(`^(?:sue|legal action|press charges|call (?:the )?police|bbb|report fraud|(?:call|contact) ${LEGAL_AUTHORITY})$`);
  const LEGAL_THREAT = new RegExp(`\\b(?:(?:i|we) (?:am |are )?(?:going to |gonna )?(?:sue|report|reporting you|press charges|(?:call|contact) ${LEGAL_AUTHORITY})|(?:i|we) will (?:sue|report|press charges|(?:call|contact) ${LEGAL_AUTHORITY})|you (?:are getting|will be) sued|fil(?:e|ing) (?:a )?(?:complaint|lawsuit)|this is against the law)\\b`);
  const LEGAL_AGENCY_ACTION = new RegExp(`\\b(?:report(?:ing)? you to|contact(?:ing)?|call(?:ing)?|fil(?:e|ing) (?:a )?complaint with) (?:the )?${LEGAL_AGENCY}\\b`);
  const LEGAL_AGENCY_VIOLATION = new RegExp(`\\b(?:this|that|you|your (?:texts?|messages?)|these (?:texts?|messages?)) (?:violates?|is in violation of) (?:the )?${LEGAL_AGENCY}\\b`);

  function hasLegalIntent(text) {
    return String(text || '')
      .split(/\b(?:but|however)\b/)
      .map((clause) => compactCommonContractions(normalizeComparableText(clause)))
      .filter(Boolean)
      .some(isLegalIntentClause);
  }

  function compactCommonContractions(text) {
    return text.replace(/\bi m\b/g, 'im').replace(/\b(don|can|doesn|isn|wasn|won|shouldn|wouldn|couldn) t\b/g, '$1t');
  }

  function isLegalIntentClause(text) {
    if (LEGAL_NEGATED.test(text) || LEGAL_REPORTED.test(text) || LEGAL_HOW_TO_REPORT.test(text)) return false;
    return LEGAL_BARE.test(text)
      || /\b(?:i am|i m|im|we are|we re) reporting you\b/.test(text)
      || LEGAL_THREAT.test(text)
      || /\b(?:bbb|better business bureau)\b/.test(text)
      || LEGAL_AGENCY_ACTION.test(text)
      || LEGAL_AGENCY_VIOLATION.test(text);
  }

  function hasNotInterestedIntent(text) {
    if (/\b(?:not interested|dont want|do not want|sick of|tired of|not subscribing|not doing business|not a customer anymore|never (?:come back|shop here again))\b/.test(text)) return true;
    if (text === 'no longer') return true;
    if (/\b(?:order|task|work|delivery|cooking|loading|download|upload|payment)\b/.test(text)) return false;
    return /^(?:done|im done|i am done|we are done|were done)(?: here| with (?:you|u|this|these|the brand|this brand))?$/.test(text)
      || /\bno longer (?:want|needed|a customer)\b/.test(text);
  }

  function shouldSuppressContextualStopMatch(normalizedValue, messageText, end) {
    return normalizedValue === 'stop' && /^\s+by\b/i.test(messageText.slice(end));
  }

  // Lowercases, strips accents, and collapses punctuation/space runs to one
  // space, recording for every output character the raw span it came from.
  function normalizeSearchTextWithMapping(value, spaceApostrophes = false) {
    const state = { chars: [], rawSpans: [], pendingSpaceSpan: null };
    let rawIndex = 0;
    for (const codePoint of String(value || '')) {
      const sourceSpan = { start: rawIndex, end: rawIndex + codePoint.length };
      for (const char of codePoint.normalize('NFKD').toLowerCase()) appendSearchChar(state, char, sourceSpan, spaceApostrophes);
      rawIndex += codePoint.length;
    }
    return { text: state.chars.join(''), normalized: true, rawSpans: state.rawSpans };
  }

  // Letters and digits are kept; combining marks and apostrophes are dropped;
  // any other run becomes a single space, emitted only between words.
  function appendSearchChar(state, char, sourceSpan, spaceApostrophes = false) {
    if (/\p{M}/u.test(char) || (!spaceApostrophes && isIgnorableSearchPunctuation(char))) return;
    if (!/[\p{L}\p{N}]/u.test(char)) {
      if (state.chars.length) state.pendingSpaceSpan = extendSpan(state.pendingSpaceSpan, sourceSpan);
      return;
    }
    if (state.pendingSpaceSpan !== null) {
      state.chars.push(' ');
      state.rawSpans.push(state.pendingSpaceSpan);
      state.pendingSpaceSpan = null;
    }
    state.chars.push(char);
    state.rawSpans.push(sourceSpan);
  }

  function extendSpan(span, next) {
    return span ? { start: span.start, end: next.end } : next;
  }

  function normalizeComparableText(value) {
    return normalizeSearchTextWithMapping(repairCommonMojibake(String(value || ''))).text;
  }

  function repairCommonMojibake(value) {
    return String(value || '')
      .replace(/â€™|â€˜/g, "'")
      .replace(/â€œ|â€/g, '"')
      .replace(/â€“|â€”/g, '-');
  }

  function isIgnorableSearchPunctuation(char) {
    return char === "'" || char === '`' || char === '\u2018' || char === '\u2019';
  }

  function mapSearchSpanToRaw(searchContext, start, end) {
    if (!searchContext.normalized) return { start, end };
    const rawSpans = searchContext.rawSpans || [];
    const startSpan = rawSpans[start] || { start: 0, end: 0 };
    const endSpan = rawSpans[Math.max(start, end - 1)] || startSpan;
    return { start: startSpan.start, end: endSpan.end };
  }

  function normalizeMessageBody(value) {
    return normalizeComparableText(value);
  }

  function normalizeKeyword(value) {
    const keyword = limitText(getKeywordPattern(value).trim().replace(/\s+/g, ' '), MAX_CUSTOM_KEYWORD_LENGTH);
    return keyword.length >= MIN_CUSTOM_KEYWORD_LENGTH ? keyword : '';
  }

  function getKeywordPattern(value) {
    if (value && typeof value === 'object') return String(value.pattern || value.name || '');
    return String(value || '');
  }

  function limitText(value, maxLength) {
    return String(value || '').slice(0, maxLength).trim();
  }

  function escapeRegex(value) {
    return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  }

  function uniqueRegexFlags(flags) {
    return Array.from(new Set(String(flags || '').split(''))).filter((flag) => 'dgimsuvy'.includes(flag)).join('');
  }

  function clamp(value, min, max) {
    if (Number.isNaN(value)) return min;
    return Math.min(max, Math.max(min, value));
  }

  globalScope.AMH_HIGHLIGHT_CORE = Object.freeze({
    MAX_CUSTOM_KEYWORDS,
    MAX_CUSTOM_KEYWORD_LENGTH,
    MIN_CUSTOM_KEYWORD_LENGTH,
    buildRules,
    clamp,
    classifyHotTopicReply,
    classifyMessage,
    collectEscalationBulletMatches,
    collectMatches,
    describeRule,
    detectorMatches,
    escalationBulletRules,
    escapeRegex,
    getActiveRules,
    getCustomKeywordRules,
    getKeywordPattern,
    getRulePriority,
    guardAllows,
    isHotTopicPrompt,
    isTapbackReaction,
    mergeSettings,
    normalizeComparableText,
    normalizeEscalationBulletText,
    normalizeKeyword,
    normalizeMessageBody,
    pickHighestPriorityRule,
    translatePythonUnicodeEscapes,
    uniqueRegexFlags,
    validateRuleRegistry
  });
})(globalThis);
