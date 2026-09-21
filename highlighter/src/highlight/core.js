(function installHighlightCore(globalScope) {
  'use strict';

  const MAX_CUSTOM_KEYWORD_LENGTH = 128;
  const MAX_CUSTOM_KEYWORD_TEXT_LENGTH = 256;
  const EXPECTED_SCHEMA_VERSION = 2;
  const EXPECTED_REGISTRY_NAME = 'unified_deterministic_opt_out_rules';
  const EXPECTED_RULE_COUNT = 202;
  const ACTIONS = new Set(['opt_out', 'fuzzy_opt_out', 'reply', 'no_action', 'txt', 'tmt', 'close']);
  const TARGETS = new Set(['raw_customer', 'normalized_customer', 'combined']);
  const MATCH_TYPES = new Set(['regex_search', 'full_match', 'bounded_phrase', 'exact', 'exact_set', 'detector']);
  const DETECTOR_NAMES = new Set([
    'hot_topic_not_opt_out',
    'hot_topic_opt_out',
    'single_letter_only',
    'number_only',
    'reaction_reply',
    'emoji_only_non_stop',
    'no_notifications',
    'driving_auto_reply',
    'unavailable_auto_reply',
    'device_not_working',
    'txt_origin_question',
    'empty_customer_message',
    'real_word_collision',
    'under_13',
    'language_filter_non_opt_out',
    'bounded_block_intent',
    'targeted_legal_intent',
    'link_only'
  ]);
  const GUARD_NAMES = new Set([
    'unsubscribe_intent',
    'offensive_intent',
    'legal_intent',
    'not_interested_intent',
    'wrong_number_intent',
    'block_intent',
    'opt_in_intent'
  ]);
  const SAFE_COLLISION_WORDS = new Set([
    'no', 'price', 'shop', 'top', 'the', 'nice', 'oh', 'save', 'sri', 'test',
    'ok', 'yes', 'okay', 'email', 'url', 'chat'
  ]);
  const STOP_SIGNAL_EMOJIS = new Set(['🖕', '🛑', '✋', '🙅', '🚫', '🔕']);

  function validateRuleRegistry(payload) {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      throw new Error('Rule registry must be a JSON object.');
    }
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
    for (let index = 1; index <= EXPECTED_RULE_COUNT; index += 1) {
      const expectedId = `R${String(index).padStart(4, '0')}`;
      if (!ids.has(expectedId)) throw new Error(`Rule registry is missing ${expectedId}.`);
    }
    return payload;
  }

  function validateRuleDefinition(rule, index, ids) {
    const location = `rules[${index}]`;
    if (!rule || typeof rule !== 'object' || Array.isArray(rule)) {
      throw new Error(`${location} must be an object.`);
    }
    if (!/^R\d{4}$/.test(rule.rule_id || '')) throw new Error(`${location} has an invalid rule_id.`);
    if (ids.has(rule.rule_id)) throw new Error(`Rule registry contains duplicate rule_id ${rule.rule_id}.`);
    ids.add(rule.rule_id);
    if (!ACTIONS.has(rule.action)) throw new Error(`${rule.rule_id} has unsupported action ${rule.action}.`);
    if (!TARGETS.has(rule.target)) throw new Error(`${rule.rule_id} has unsupported target ${rule.target}.`);
    if (!MATCH_TYPES.has(rule.match_type)) throw new Error(`${rule.rule_id} has unsupported match_type ${rule.match_type}.`);
    if (rule.guard && !GUARD_NAMES.has(rule.guard)) throw new Error(`${rule.rule_id} has unsupported guard ${rule.guard}.`);

    if (rule.match_type === 'detector') {
      if (!DETECTOR_NAMES.has(rule.detector)) throw new Error(`${rule.rule_id} has unsupported detector ${rule.detector}.`);
      return;
    }
    const hasPattern = typeof rule.pattern === 'string' && rule.pattern.length > 0;
    const hasPatterns = Array.isArray(rule.patterns) && rule.patterns.length > 0 && rule.patterns.every((item) => typeof item === 'string' && item.length > 0);
    if (!hasPattern && !hasPatterns) throw new Error(`${rule.rule_id} has no usable pattern data.`);
    if ((rule.match_type === 'exact_set' || Array.isArray(rule.patterns)) && !hasPatterns) {
      throw new Error(`${rule.rule_id} requires a non-empty patterns array.`);
    }
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
    return rule;
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
    const merged = { ...base, ...override, categories: {} };
    const categoryKeys = Object.keys(base.categories || {});
    for (const key of categoryKeys) {
      const categoryOverride = override?.categories?.[key] || {};
      merged.categories[key] = {
        ...(base.categories && base.categories[key] ? base.categories[key] : {}),
        ...categoryOverride,
        label: base.categories[key].label
      };
      if (key === 'txt' && String(categoryOverride.color || '').toUpperCase() === '#F6DA71') {
        merged.categories[key].color = base.categories[key].color;
      }
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
      target: 'raw_customer',
      matchTarget: 'raw_customer',
      matchType: 'regex_search',
      pattern: escapeRegex(keyword),
      patterns: [keyword],
      conditionSummary: settings.customKeywordTextByPattern?.[keyword] || '',
      source: 'popup custom keyword',
      regexes: [new RegExp(escapeRegex(keyword), 'gi')],
      exactPatterns: null,
      executable: true
    }));
  }

  function getActiveRules(rules, settings) {
    const configuredRules = rules
      .filter((rule) => {
        if (rule.tag === 'no_action') return false;
        const category = settings.categories[rule.tag];
        return rule.executable && category && category.enabled !== false;
      })
      .sort((a, b) => (settings.categories[a.tag]?.priority ?? 999) - (settings.categories[b.tag]?.priority ?? 999));
    return [...getCustomKeywordRules(settings), ...configuredRules];
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

  function collectMatches(text, activeRules, settings) {
    const candidates = [];
    const messageText = String(text || '');
    const rawContext = { text: messageText, normalized: false, rawSpans: null };
    const normalizedContext = normalizeSearchTextWithMapping(messageText);

    for (const rule of activeRules) {
      const effectiveGuard = rule.guard || implicitGuardForRule(rule);
      if (!guardAllows(effectiveGuard, normalizedContext.text)) continue;
      const matches = collectRuleMatches(rule, messageText, rawContext, normalizedContext);
      for (const candidate of matches) {
        const rawValue = messageText.slice(candidate.start, candidate.end);
        const normalizedValue = normalizeComparableText(rawValue);
        if (/^f\s*u$/i.test(normalizedValue) && normalizedContext.text !== 'fu' && normalizedContext.text !== 'f u') continue;
        if (shouldSuppressContextualStopMatch(normalizedValue, messageText, candidate.end)) continue;
        candidates.push(candidate);
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

  function collectRuleMatches(rule, messageText, rawContext, normalizedContext) {
    if (!rule || !rule.executable || rule.target === 'combined') return [];
    if (rule.matchType === 'detector') {
      return detectorMatches(rule.detector, messageText, normalizedContext.text)
        ? [wholeMessageCandidate(messageText, rule)]
        : [];
    }
    if (rule.matchType === 'exact' || rule.matchType === 'exact_set') {
      return rule.exactPatterns?.has(normalizedContext.text)
        ? [wholeMessageCandidate(messageText, rule)]
        : [];
    }

    const context = rule.target === 'raw_customer' ? rawContext : normalizedContext;
    const output = [];
    for (const regex of rule.regexes || []) {
      regex.lastIndex = 0;
      let match;
      while ((match = regex.exec(context.text)) !== null) {
        if (!match[0]) {
          regex.lastIndex += 1;
          continue;
        }
        if (rule.matchType === 'full_match') {
          output.push(wholeMessageCandidate(messageText, rule));
          break;
        }
        const span = mapSearchSpanToRaw(context, match.index, match.index + match[0].length);
        output.push({ start: span.start, end: span.end, length: span.end - span.start, rule });
      }
    }
    return output;
  }

  function wholeMessageCandidate(messageText, rule) {
    return { start: 0, end: messageText.length, length: messageText.length, rule };
  }

  function detectorMatches(detector, rawText, normalizedText) {
    switch (detector) {
      case 'hot_topic_not_opt_out':
      case 'hot_topic_opt_out':
        return false;
      case 'single_letter_only':
        return /^[A-Za-z]$/.test(normalizedText);
      case 'number_only':
        return /^\d+$/.test(normalizedText);
      case 'reaction_reply':
        return isReactionReply(normalizedText);
      case 'emoji_only_non_stop':
        return isEmojiOnlyWithoutStopSignal(rawText);
      case 'no_notifications':
        return normalizedText.includes('not receiving notifications if this is urgent reply urgent to send a notification through with your original message');
      case 'driving_auto_reply':
        return /^(?:im driving sent from|im driving with focus turned on|driving cant text)\b/.test(normalizedText)
          || (/\bdriving\b/.test(normalizedText) && /\b(?:cant|cannot|can not)\s+(?:text|reply|respond)\b/.test(normalizedText));
      case 'unavailable_auto_reply':
        return isUnavailableAutoReply(normalizedText);
      case 'device_not_working':
        return isDeviceNotWorking(normalizedText);
      case 'txt_origin_question':
        return isTextOriginQuestion(normalizedText);
      case 'empty_customer_message':
        return !String(rawText || '').trim();
      case 'real_word_collision':
        return SAFE_COLLISION_WORDS.has(normalizedText);
      case 'under_13':
        return isUnderThirteen(normalizedText);
      case 'language_filter_non_opt_out':
        return isConservativeNonOptOutLanguage(normalizedText);
      case 'bounded_block_intent':
        return /\b(?:block|blocking|blocked)\s+(?:(?:your|this|the)\s+)?(?:you|u|this|these|texts?|messages?|number|sender)\b/.test(normalizedText)
          || /\b(?:im|i am|ill|i will)\s+(?:block|blocking)\s+(?:(?:your|this|the)\s+)?(?:you|u|this|these|texts?|messages?|number|sender)\b/.test(normalizedText);
      case 'targeted_legal_intent':
        return hasLegalIntent(normalizedText);
      case 'link_only':
        return isLinkOnly(rawText);
      default:
        return false;
    }
  }

  function isReactionReply(text) {
    return text.includes('reacted to')
      || /^(?:liked|loved|emphasized|laughed at|disliked|questioned)\s+/.test(text)
      || /^(?:removed a|removed from)\s+/.test(text);
  }

  function isEmojiOnlyWithoutStopSignal(value) {
    const text = String(value || '').trim();
    if (!text || Array.from(STOP_SIGNAL_EMOJIS).some((emoji) => text.includes(emoji))) return false;
    try {
      return /\p{Extended_Pictographic}/u.test(text)
        && /^(?:\p{Extended_Pictographic}|\p{Emoji_Modifier}|[\u200D\uFE0E\uFE0F\s])+$/u.test(text);
    } catch (_error) {
      return false;
    }
  }

  function isUnavailableAutoReply(text) {
    return /^(?:hey i m currently unavailable i ll get back to you as soon as i can|sorry i cant talk(?: right)? now|sorry cant talk(?: right)? now|thank you for contacting me i m unable to chat right now but i ll reply to your text as soon as i can thanks|thanks for reaching out i cant chat(?: at the moment| now) but i ll text you back as soon as i can(?: thanks.*)?)$/.test(text)
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
      || /\bwhy (?:are|r) (?:you|u) (?:texting|messaging|msging|contacting) me\b/.test(text)
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
        return /^(?:stop|unsubscribe|unsub|opt out|optout|dnc|remove me|please remove|go away|beat it|leave me alone|close|cancel)$/.test(text)
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
        return text === 'start' || /\b(?:subscribe|opt in|sign me up|unstop|start (?:texts?|messages?))\b/.test(text);
      default:
        return false;
    }
  }

  function implicitGuardForRule(rule) {
    if (rule.id === 'R0170') return 'not_interested_intent';
    return '';
  }

  function hasLegalIntent(text) {
    return /\b(?:law|lawyer|attorney|sue|suing|sued|lawsuit|legal action|complaint|report|reporting|reported|bbb|better business bureau|fcc|ftsa|tcpa|federal communications commission|telephone consumer protection act)\b/.test(text);
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

  function normalizeSearchTextWithMapping(value) {
    const chars = [];
    const rawSpans = [];
    let pendingSpaceSpan = null;
    const text = String(value || '');
    let rawIndex = 0;
    for (const codePoint of text) {
      const sourceSpan = { start: rawIndex, end: rawIndex + codePoint.length };
      const folded = codePoint.normalize('NFKD').toLowerCase();
      for (const char of folded) {
        if (/\p{M}/u.test(char)) continue;
        if (/[\p{L}\p{N}]/u.test(char)) {
          if (pendingSpaceSpan !== null && chars.length) {
            chars.push(' ');
            rawSpans.push(pendingSpaceSpan);
          }
          pendingSpaceSpan = null;
          chars.push(char);
          rawSpans.push(sourceSpan);
        } else if (isIgnorableSearchPunctuation(char)) {
          continue;
        } else if (chars.length) {
          pendingSpaceSpan = pendingSpaceSpan
            ? { start: pendingSpaceSpan.start, end: sourceSpan.end }
            : sourceSpan;
        }
      }
      rawIndex += codePoint.length;
    }
    return { text: chars.join(''), normalized: true, rawSpans };
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
      if (!inCharacterClass && char === '?' && (output.endsWith('(') || isRegexQuestionMarkSyntax(output))) {
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
      if (!inCharacterClass && char === '.' && /[*+]/.test(text[index + 1] || '')) {
        output += char;
        continue;
      }
      if (!inCharacterClass && /[-,.:;!?]/.test(char)) {
        output += '\\s+';
        continue;
      }
      output += char;
    }
    return output.replace(/\\s\+\s+/g, '\\s+');
  }

  function isRegexQuestionMarkSyntax(output) {
    const previous = String(output || '').at(-1);
    return Boolean(previous && !/[\s(|]/.test(previous));
  }

  function normalizeMessageBody(value) {
    return normalizeComparableText(value);
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
    buildRules,
    clamp,
    collectEscalationBulletMatches,
    collectMatches,
    describeRule,
    detectorMatches,
    escalationBulletRules,
    escapeRegex,
    getActiveRules,
    getCustomKeywordRules,
    getKeywordPattern,
    guardAllows,
    mergeSettings,
    normalizeComparableText,
    normalizeCustomKeywordTextMap,
    normalizeEscalationBulletText,
    normalizeKeyword,
    normalizeMessageBody,
    translatePythonUnicodeEscapes,
    uniqueRegexFlags,
    validateRuleRegistry
  });
})(globalThis);
