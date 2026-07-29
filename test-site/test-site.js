const RULE_SOURCE = '../highlighter/data/rules/opt_out_deterministic_rules.json';

const state = {
  messages: [],
  customMessages: [],
  filters: {
    category: 'all',
    subcategory: 'all',
    action: 'all'
  }
};

const els = {
  categoryFilter: document.querySelector('#categoryFilter'),
  subcategoryFilter: document.querySelector('#subcategoryFilter'),
  actionFilter: document.querySelector('#actionFilter'),
  messageInput: document.querySelector('#messageInput'),
  addMessage: document.querySelector('#addMessage'),
  customCount: document.querySelector('#customCount'),
  customList: document.querySelector('#customList'),
  messageDeck: document.querySelector('#messageDeck')
};

init().catch((error) => {
  console.error('[Demo site] Failed to initialize:', error);
  els.messageDeck.innerHTML = '<div class="empty-state">Demo site failed to initialize. Check the console for details.</div>';
});

async function init() {
  const rules = await loadRules();
  state.messages = [
    ...uniqueMessagesByText(rules.filter(isDemoRule).map(createRuleMessage)),
    ...excludedMessages.map(createExcludedMessage)
  ];
  renderFilters();
  bindControls();
  render();
  scheduleMetadataRefresh();
}

function bindControls() {
  els.categoryFilter.addEventListener('change', () => {
    state.filters.category = els.categoryFilter.value;
    render();
    scheduleMetadataRefresh();
  });
  els.subcategoryFilter.addEventListener('change', () => {
    state.filters.subcategory = els.subcategoryFilter.value;
    render();
    scheduleMetadataRefresh();
  });
  els.actionFilter.addEventListener('change', () => {
    state.filters.action = els.actionFilter.value;
    render();
    scheduleMetadataRefresh();
  });
  els.addMessage.addEventListener('click', addCustomMessage);
  els.messageInput.addEventListener('keydown', (event) => {
    if ((event.ctrlKey || event.metaKey) && event.key === 'Enter') addCustomMessage();
  });
}

function addCustomMessage() {
  const text = els.messageInput.value.trim();
  if (!text) return;
  const message = {
    id: `custom-${Date.now()}`,
    kind: 'custom',
    text,
    rule: null
  };
  state.customMessages.unshift(message);
  state.messages.unshift(message);
  els.messageInput.value = '';
  render();
  scheduleMetadataRefresh();
}

function render() {
  renderCustomList();
  renderMessages();
}

function renderFilters() {
  renderSelect(els.categoryFilter, 'All categories', uniqueRuleValues('category'));
  renderSelect(els.subcategoryFilter, 'All subcategories', uniqueRuleValues('subcategory'));
  renderSelect(els.actionFilter, 'All actions', uniqueRuleValues('action'));
}

function renderSelect(select, allLabel, values) {
  select.innerHTML = [
    `<option value="all">${escapeHtml(allLabel)}</option>`,
    ...values.map((value) => `<option value="${escapeHtml(value)}">${escapeHtml(value)}</option>`)
  ].join('');
}

function uniqueRuleValues(key) {
  return Array.from(new Set(
    state.messages
      .filter((message) => message.kind === 'rule')
      .map((message) => message.rule[key])
      .filter(Boolean)
  )).sort();
}

function isDemoRule(rule) {
  return (rule.action || rule.tag) !== 'no_action';
}

function uniqueMessagesByText(messages) {
  const seen = new Set();
  return messages.filter((message) => {
    const key = `${message.brandText || ''}\n${message.text}`;
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}

function renderCustomList() {
  els.customCount.textContent = `${state.customMessages.length} added`;
  if (!state.customMessages.length) {
    els.customList.innerHTML = '<div class="empty-sidebar">Added messages appear here.</div>';
    return;
  }

  const fragment = document.createDocumentFragment();
  for (const message of state.customMessages) {
    const item = document.createElement('a');
    item.className = 'custom-item';
    item.href = `#${message.id}`;
    item.textContent = message.text;
    fragment.appendChild(item);
  }
  els.customList.innerHTML = '';
  els.customList.appendChild(fragment);
}

function renderMessages() {
  const fragment = document.createDocumentFragment();
  let renderedExcludedHeading = false;
  for (const message of getVisibleMessages()) {
    if (message.kind === 'excluded' && !renderedExcludedHeading) {
      const heading = document.createElement('div');
      heading.className = 'section-heading';
      heading.innerHTML = '<h2>Excluded Messages</h2><p>Similar patterns that should remain unhighlighted.</p>';
      fragment.appendChild(heading);
      renderedExcludedHeading = true;
    }
    fragment.appendChild(renderMessage(message));
  }
  els.messageDeck.innerHTML = '';
  els.messageDeck.appendChild(fragment);
}

function renderMessage(message) {
  const article = document.createElement('article');
  article.id = message.id;
  article.className = 'message-card';
  article.dataset.messageId = message.id;
  article.dataset.kind = message.kind;

  article.innerHTML = `
    <div class="messages">
      ${renderBrandMessage(message)}
      <div class="message type-INBOUND" data-message-id="${escapeHtml(message.id)}">
        <div class="bubble">
          <p class="variant-caption">${renderInboundMessageText(message)}</p>
        </div>
      </div>
    </div>
    <div class="rule-line" data-rule-line>
      ${renderRuleLine(message)}
    </div>
  `;
  return article;
}

function renderInboundMessageText(message) {
  return escapeHtml(message.text);
}

function renderBrandMessage(message) {
  if (!message.brandText) return '';
  return `
    <div class="picnic--c-PJLV picnic--c-kgzfnN brand-message" data-speaker="Brand">
      <div class="picnic--c-PJLV picnic--c-PJLV-iciKXky-css brand-message__meta">
        <p class="picnic--c-cyRcZm picnic--c-cyRcZm-XTsru-variant-micro picnic--c-cyRcZm-itysWP-color-subdued">Jul 28, 2026, 2:49 pm</p>
      </div>
      <p class="picnic--c-cyRcZm picnic--c-cyRcZm-YfiYb-variant-caption picnic--c-cyRcZm-icbTBNv-css brand-message__text">${escapeHtml(message.brandText)}</p>
    </div>
  `;
}

function renderRuleLine(message) {
  if (message.kind === 'custom') return '<span class="tag tag-muted">No highlighted rules yet</span>';
  if (message.kind === 'excluded') return '<span class="tag tag-muted">Excluded pattern</span>';
  return renderRuleImplication(message.rule);
}

function renderRuleImplication(rule, matchedTags = []) {
  return `
    <div class="rule-tags">
      ${renderRuleChips(rule, matchedTags)}
    </div>
  `;
}

function renderRuleChips(rule, matchedTags = []) {
  const chips = [
    ['action', rule.action],
    ['category', rule.category],
    ['subcategory', rule.subcategory]
  ]
    .filter(([_label, value]) => Boolean(value))
    .map(([label, value]) => `<span class="tag">${escapeHtml(`${label}: ${value}`)}</span>`);

  return chips.join('');
}

function describeRuleImplication(rule) {
  const actionText = actionImplications[rule.action] || `Use ${humanizeToken(rule.action)} handling`;
  const subcategoryText = rule.subcategory ? ` for ${humanizeToken(rule.subcategory)}` : '';
  return `Implication: ${actionText}${subcategoryText}.`;
}

function describeRuleCondition(rule) {
  const condition = rule.conditionSummary || 'No trigger condition provided.';
  return `Rule ${rule.id}: ${rule.name}. Fires when: ${condition}`;
}

function humanizeToken(value) {
  return String(value || '')
    .replace(/[_-]+/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function renderDetectedTags(tags) {
  return [
    ...tags.map((tag) => `<span class="tag">${escapeHtml(tag)}</span>`)
  ].join('');
}

function scheduleMetadataRefresh() {
  window.clearTimeout(scheduleMetadataRefresh.timer);
  scheduleMetadataRefresh.timer = window.setTimeout(refreshDynamicMetadata, 300);
}

function refreshDynamicMetadata() {
  const messageById = new Map(state.messages.map((message) => [message.id, message]));
  for (const card of els.messageDeck.querySelectorAll('.message-card')) {
    const line = card.querySelector('[data-rule-line]');
    if (!line) continue;
    const highlights = Array.from(card.querySelectorAll('.amh-highlight'));
    const tags = new Set();
    for (const highlight of highlights) {
      const tag = highlight.dataset.amhRuleTag || 'rule';
      tags.add(tag);
    }
    const message = messageById.get(card.dataset.messageId);
    const sortedTags = Array.from(tags).sort();

    if (message?.kind === 'rule') {
      line.innerHTML = renderRuleImplication(message.rule, sortedTags);
      continue;
    }

    if (!sortedTags.length) {
      if (card.dataset.kind === 'custom') line.innerHTML = '<span class="tag tag-muted">No highlighted rules</span>';
      continue;
    }

    line.innerHTML = renderDetectedTags(sortedTags);
  }
}

function getVisibleMessages() {
  return state.messages.filter((message) => {
    if (message.kind === 'custom') return true;
    if (message.kind === 'excluded') return filtersAreDefault();
    if (state.filters.category !== 'all' && message.rule.category !== state.filters.category) return false;
    if (state.filters.subcategory !== 'all' && message.rule.subcategory !== state.filters.subcategory) return false;
    if (state.filters.action !== 'all' && message.rule.action !== state.filters.action) return false;
    return true;
  });
}

function filtersAreDefault() {
  return state.filters.category === 'all' && state.filters.subcategory === 'all' && state.filters.action === 'all';
}

async function loadRules() {
  const response = await fetch(RULE_SOURCE);
  if (!response.ok) throw new Error(`Rules fetch failed for ${RULE_SOURCE}: ${response.status}`);
  const payload = await response.json();
  return Array.isArray(payload.rules) ? payload.rules : flattenRules(payload.rules);
}

function flattenRules(value, output = []) {
  if (Array.isArray(value)) {
    value.forEach((item) => flattenRules(item, output));
    return output;
  }
  if (!value || typeof value !== 'object') return output;
  if (typeof value.pattern === 'string' && (typeof value.action === 'string' || typeof value.tag === 'string')) {
    output.push(value);
    return output;
  }
  Object.values(value).forEach((nested) => flattenRules(nested, output));
  return output;
}

function createRuleMessage(rule, index) {
  const action = rule.action || rule.tag || rule.category || 'unknown';
  return {
    id: `rule-message-${index + 1}`,
    kind: 'rule',
    text: sampleForRule(rule),
    brandText: brandSampleForRule(rule),
    rule: {
      id: rule.id || `rule-${index + 1}`,
      name: rule.name || 'unnamed_rule',
      action,
      category: rule.category || rule.subcategory || 'uncategorized',
      subcategory: rule.subcategory || '',
      matchScope: rule.match_scope || '',
      conditionSummary: rule.condition_summary || rule.pattern || ''
    }
  };
}

function brandSampleForRule(rule) {
  if (!isHotTopicRule(rule)) return '';
  return "Hot Topic: So, how often do you want to see our texts? They're full of deals & the latest drops. Reply with a number:\n\n1. Same\n2. Weekly\n3. Monthly\n4. Never";
}

function isHotTopicRule(rule) {
  return rule.category === 'hot_topic' || String(rule.name || '').startsWith('opt_outs_ml.hot_topic_');
}

function isHotTopicMessage(message) {
  return message.kind === 'rule' && message.rule?.category === 'hot_topic';
}

function createExcludedMessage(text, index) {
  return {
    id: `excluded-${index + 1}`,
    kind: 'excluded',
    text,
    rule: null
  };
}

function sampleForRule(rule) {
  const byRuleId = sampleOverridesByRuleId[rule.id];
  if (byRuleId) return byRuleId;

  const pattern = String(rule.pattern || '').trim();
  const byPattern = sampleOverridesByPattern[pattern];
  if (byPattern) return byPattern;

  if (hasDisplayAlternatives(pattern)) return sampleFromDisplayAlternatives(pattern, rule);

  const phrase = isProceduralRule(rule) ? '' : regexToReadableSample(pattern);
  return formatSampleForRule(phrase || fallbackSampleForRule(rule), rule);
}

function isProceduralRule(rule) {
  return rule.match_scope === 'procedural' || !rule.pattern || (Boolean(rule.match_scope) && looksLikeProceduralDescription(rule.pattern));
}

function looksLikeProceduralDescription(pattern) {
  const value = String(pattern || '');
  return /\b(?:customer|brand|message|detector|matches|contains|normalized|reply|including|configured)\b/i.test(value) && value.includes(' ');
}

function isPhraseScope(rule) {
  const scope = String(rule.match_scope || '');
  return scope.includes('phrase') || scope.includes('normalized') || scope.includes('keyword') || scope.includes('full');
}

function formatSampleForRule(value, rule) {
  const phrase = humanizeSample(value);
  if (!phrase) return fallbackSampleForRule(rule);
  if (isSingleWordSample(phrase)) return phrase.toLowerCase();
  if (isWholeMessageRule(rule) || isPhraseScope(rule)) return punctuateMessage(phrase);
  return sentenceContainingPhrase(phrase, rule);
}

function isWholeMessageRule(rule) {
  const action = String(rule.action || rule.tag || '');
  const scope = String(rule.match_scope || '');
  return action === 'close' || [
    'full_normalized_message',
    'exact_normalized_exclusion',
    'whole_inbound_message_for_not_opt_out'
  ].includes(scope);
}

function isSingleWordSample(value) {
  return /^[a-z0-9][a-z0-9'-]*$/i.test(String(value || '').trim());
}

function fallbackSampleForRule(rule) {
  const subcategory = String(rule.subcategory || rule.category || '').toLowerCase();
  if (subcategory.includes('customer_support')) return 'Help.';
  if (subcategory.includes('wrong_number')) return 'This is the wrong number.';
  if (subcategory.includes('not_interested')) return "I'm not interested anymore.";
  if (subcategory.includes('subscription')) return 'Please cancel my subscription.';
  if (subcategory.includes('auto_reply')) return "Sorry, I can't talk right now.";
  if (subcategory.includes('device_not_working')) return 'This phone number cannot receive text messages, please call instead.';
  return 'Please stop texting me.';
}

function sentenceContainingPhrase(phrase, rule) {
  const sample = humanizeSample(phrase);
  const subcategory = String(rule.subcategory || rule.category || '').toLowerCase();

  if (/[.!?]$/.test(sample)) return sample;
  if (subcategory.includes('legal')) return legalSentenceForPhrase(sample);
  if (/^(i|i'm|im|i am|we|this|that|my|you|who|what|where|why|how)\b/i.test(sample)) return punctuateMessage(sample);
  if (/^(do not|don't|dont|stop|unsubscribe|remove|delete|leave|block|cancel|end|quit|opt out|take me off|no more)\b/i.test(sample)) {
    return punctuateMessage(`Please ${sample}`);
  }
  if (subcategory.includes('customer_support')) return punctuateMessage(`Can I get ${sample}`);
  if (subcategory.includes('wrong_number')) return punctuateMessage(`This is the ${sample}`);
  if (subcategory.includes('legal') || subcategory.includes('spam') || subcategory.includes('scam')) {
    return punctuateMessage(`I'm going to report this as ${sample}`);
  }
  return punctuateMessage(`Please ${sample}`);
}

function hasDisplayAlternatives(value) {
  return /\s\/\s/.test(String(value || ''));
}

function sampleFromDisplayAlternatives(value, rule) {
  const pattern = String(value || '');
  const direct = sampleOverridesByPattern[pattern];
  if (direct) return direct;

  const option = pattern.split(/\s+\/\s+/).map((part) => part.trim()).find((part) => {
    return part && !/^(dont|donot|any|all|this|my number|communications?|texts?|text messages?|messages?)$/i.test(part);
  }) || pattern.split(/\s+\/\s+/)[0] || pattern;

  return sentenceContainingPhrase(option, rule);
}

function legalSentenceForPhrase(value) {
  const sample = humanizeSample(value).toLowerCase();
  if (/\bfile\s+a?\s*suit\b/.test(sample)) return "I'll file a suit against you.";
  if (/\bbring\s+a?\s*suit\b/.test(sample)) return "I'll bring a suit against you.";
  if (/\bsue your\b/.test(sample)) return "I'll sue your company.";
  if (/\bsued\b/.test(sample)) return 'You are getting sued.';
  if (/\bsuing\b/.test(sample)) return "I'm suing you.";
  if (/\blawyer\b/.test(sample) || /\blaw\b/.test(sample)) return "I'm calling my lawyer about this.";
  if (/\battorney\b/.test(sample)) return "I'm contacting my attorney.";
  if (/\blawsuit\b/.test(sample)) return "I'll start a lawsuit over these texts.";
  if (/\blitigation\b/.test(sample)) return 'This is going to litigation.';
  if (/\blegal action\b/.test(sample)) return "I'll take legal action.";
  if (/\bcomplaint\b/.test(sample)) return "I'm filing a complaint.";
  if (/\bfcc\b/.test(sample)) return "I'm reporting this to the FCC.";
  if (/\bftsa\b/.test(sample)) return "This violates the FTSA.";
  if (/\btcpa\b/.test(sample)) return "This violates the TCPA.";
  if (/\bfederal communications commission\b/.test(sample)) return "I'm reporting this to the Federal Communications Commission.";
  if (/\bflorida telephone solicitation act\b/.test(sample)) return 'This violates the Florida Telephone Solicitation Act.';
  if (/\btelephone consumer protection act\b/.test(sample)) return 'This violates the Telephone Consumer Protection Act.';
  if (/\bunlaw/.test(sample)) return 'These texts are unlawful.';
  if (/\bviolat/.test(sample)) return 'These texts violate the law.';
  return punctuateMessage(`I'm going to report this as ${value}`);
}

function punctuateMessage(value) {
  const text = capitalizeMessage(humanizeSample(value));
  if (!text) return text;
  if (/[.!?]$/.test(text)) return text;
  if (/^(who|what|where|why|how|can|could|would|do|does|did|is|are)\b/i.test(text)) return `${text}?`;
  return `${text}.`;
}

function capitalizeMessage(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^(asap|stfu|sybau|dnc|fu)$/i.test(text)) return text.toUpperCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function humanizeSample(value) {
  return String(value || '')
    .replaceAll('\u00e2\u20ac\u2122', "'")
    .replaceAll('\u00e2\u20ac\u0153', '"')
    .replaceAll('\u00e2\u20ac\u009d', '"')
    .replaceAll('\u00e2\u20ac\u00a2', '')
    .replace(/\bi ll\b/gi, "I'll")
    .replace(/\bi m\b/gi, "I'm")
    .replace(/\bdon t\b/gi, "don't")
    .replace(/\bcan t\b/gi, "can't")
    .replace(/\bi ve\b/gi, "I've")
    .replace(/\bi d\b/gi, "I'd")
    .replace(/\bi\b/g, 'I')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.!?,;:])/g, '$1')
    .trim();
}

function regexToReadableSample(pattern) {
  const sample = chooseFirstRegexAlternatives(String(pattern))
    .replace(/\^\s\*/g, '')
    .replace(/\s\*\$/g, '')
    .replace(/\^\\s\*/g, '')
    .replace(/\\s\*\$/g, '')
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .replace(/\[\.!\?,;:\]\*/g, '')
    .replace(/\(\?<!\[a-z0-9\]\)/g, '')
    .replace(/\(\?!\[a-z0-9\]\)/g, '')
    .replace(/\(\?<=\[a-z0-9\]\)/g, '')
    .replace(/\(\?=\[a-z0-9\]\)/g, '')
    .replace(/\\b/g, '')
    .replace(/\\W/g, ' ')
    .replace(/\\w\*/g, '')
    .replace(/\\d/g, '1')
    .replace(/\\s\+/g, ' ')
    .replace(/\\s\*/g, ' ')
    .replace(/\\s/g, ' ')
    .replace(/\\ /g, ' ')
    .replace(/\(\?:/g, '(')
    .replace(/\(([^()]+)\)/g, '$1')
    .replace(/\?:/g, '')
    .replace(/\[[^\]]+\]\*/g, '')
    .replace(/\[[^\]]+\]\+/g, 'text')
    .replace(/\[[^\]]+\]/g, '')
    .replace(/\{[0-9,]+\}/g, '')
    .replace(/\.\*/g, ' ')
    .replace(/\.\+/g, ' text ')
    .replace(/\?/g, '')
    .replace(/\+/g, '')
    .replace(/\*/g, '')
    .replace(/\\/g, '')
    .replace(/[()]/g, '')
    .replace(/\|.*$/g, '')
    .replace(/\s+/g, ' ')
    .trim();
  return sample || 'stop';
}

function chooseFirstRegexAlternatives(value) {
  let output = String(value || '');
  let previous = '';
  while (output !== previous) {
    previous = output;
    output = output.replace(/\(\?:([^()]*\|[^()]*)\)\??/g, (_match, group) => group.split('|')[0]);
    output = output.replace(/\(([^()]*\|[^()]*)\)\??/g, (_match, group) => group.split('|')[0]);
  }
  return output;
}

function escapeHtml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#039;');
}

const sampleOverridesByRuleId = {
  rule_451c36fb9b91ee65: '2 messages a week is fine.',
  rule_39802d76d8b46842: '4 never text me again.',
  rule_combined_single_letter_only: 'x',
  rule_combined_number_only: '45',
  rule_06d01f1a0e0b3885: 'https://example.com',
  rule_0818cc4a204d72a2: 'Send this text to subscribe to recurring automated personalized marketing alerts e g cart reminders from darc sport ref f jgm.',
  rule_14492eac781ac6da: 'Please cancel my subscription.',
  rule_2598a349be6b6683: 'Claim 5 free shein products now click the link to help and let\u2019s both win big.',
  rule_317fdbf0a6758d04: 'Never opted in.',
  rule_510bd44ff37f855b: 'Claim 5 free shein products now click the link to help and let\u2019s both win big.',
  rule_9501f80f59e3b9fd: "i'm",
  rule_combined_reaction_reply: 'Loved "Thanks for your order"',
  rule_b25458937a65a761: 'I am 12 years old.',
  rule_combined_unavailable_auto_reply: "Sorry, I can't talk right now.",
  rule_combined_device_not_working: 'This phone number cannot receive text messages please call instead.',
  rule_combined_txt_origin_question: 'Who is this and why are you texting me?',
  rule_db58d4f1407e1a87: 'I am in grade 1.',
  rule_fbc658efd1856775: 'I am in 1st grade.',
  rule_cb94613c9b6507b3: "I'm in 1st grade."
};

const sampleOverridesByPattern = {
  '\\bdone\\b': 'we are done here',
  "(not|this (isn't|isnt)) my number": 'not my number',
  '^done$': 'done',
  '^stop$': 'stop',
  '^quit$': 'quit',
  '^end$': 'end',
  '^remove$': 'remove',
  '^quiet$': 'quiet',
  '^unsubscribe$': 'unsubscribe',
  '^finished$': 'finished',
  '^pause$': 'pause',
  '^shush$': 'shush',
  '^bye$': 'bye',
  '^help$': 'help',
  '^support$': 'support',
  '^customer service$': 'Customer service?',
  '^refund$': 'Refund.',
  '^too expensive$': 'Too expensive.',
  '^yo$': 'yo',
  '^shop$': 'shop',
  '^start$': 'start',
  '^subscribe$': 'subscribe',
  '^top$': 'top',
  '^unstop$': 'unstop',
  "I don't / do not want": "I don't want these texts anymore.",
  'bring / file a suit': "I'll file a suit against you.",
  'bring / file suit': "I'll file suit against you.",
  "don't / do not / dont / donot": "Don't text me.",
  "don't / do not / dont / donot text / send / contact / message / bother / talk / call / write / call or text me any more / anymore / again": "Don't text me anymore.",
  'end any / all communication / communications / texts / text messages / messages': 'End all text messages.',
  'end communication / communications / texts / text messages / messages / this / contact / contacting': 'End all communication.',
  'please / kindly end': 'Please end these texts.',
  "don't / do not / dont / donot send me any more / anymore texts / messages / text messages": "Don't send me any more texts.",
  'halt texts / messages / text messages': 'Halt text messages.',
  'never send / text / contact / message / bother / talk': 'Never text me again.',
  'take me / this / my number off': 'Take me off your list.',
  'block...': 'block',
  'lawy...': 'lawyer',
  'annoy...': 'annoying',
  'attorn...': 'attorney',
  'bother...': 'bothering',
  'fraud...': 'fraud',
  'harass...': 'harassing',
  'lawl...': 'lawyer',
  'laws...': 'lawsuit',
  'litigat...': 'litigation',
  'quit...': 'quitting',
  'report...': 'reporting',
  'scam...': 'scam',
  'terminat...': 'terminate',
  'unsuscrib...': 'unsuscribe',
  'sue your': "I'll sue your company.",
  'sued': 'You are getting sued.',
  'BBB': "I'm reporting you to the BBB.",
  '\\b(bring|file)\\s+a\\s+suit\\b': "I'll file a suit against you.",
  '\\b(bring|file)\\s+suit\\b': "I'll file suit against you.",
  '\\bFCC\\b': "I'm reporting this to the FCC.",
  '\\bTCPA\\b': 'This violates the TCPA.',
  '\\bfederal communications commission\\b': "I'm reporting this to the Federal Communications Commission.",
  '\\bflorida telephone solicitation act\\b': 'This violates the Florida Telephone Solicitation Act.',
  '\\bftsa\\b': 'This violates the FTSA.',
  '\\bsuing\\b': "I'm suing you.",
  '\\btelephone consumer protection act\\b': 'This violates the Telephone Consumer Protection Act.',
  '\\bunlaw\\w*': 'These texts are unlawful.',
  '\\bviolat\\w*': 'These texts violate the law.',
  '(?:sue you|legal\\s+action|attorney|lawyer|complaint| bbb | better business bureau )': "I'll take legal action.",
  'im going to sue you': "I'm going to sue you.",
  'im reporting you to the bbb': "I'm reporting you to the BBB.",
  'report(ed)?': "I'm reporting this.",
  'sue|lawsuit|legal action|attorney|lawyer|complaint': "I'll take legal action.",
  'federal communications commission': "I'm reporting this to the Federal Communications Commission.",
  'florida telephone solicitation act': 'This violates the Florida Telephone Solicitation Act.',
  'lawl\\w*': "I'm calling my lawyer.",
  'laws\\w*': "I'll start a lawsuit.",
  'litigat\\w*': 'This is going to litigation.',
  'telephone consumer protection act': 'This violates the Telephone Consumer Protection Act.'
};

const actionImplications = {
  close: 'Close the thread without treating it as an opt-out',
  opt_out: 'Opt the customer out',
  fuzzy_opt_out: 'Review as likely opt-out intent',
  tmt: 'Treat as too-many-texts feedback',
  txt: 'Answer the texting/source question',
  reply: 'Reply with support',
  no_action: 'Take no automation action'
};

const excludedMessages = [
  'Can you stop by the store later?',
  'I will remove the item from my cart myself.',
  'The sign says unsubscribe for emails, but I still need order help.',
  'I am not interested in the blue color, do you have black?',
  'Please cancel my order before it ships.',
  'Where is my order right now?',
  'Can you update my shipping address?',
  'I need fewer sizes in this bundle.',
  'This text on the product page is confusing.',
  'My phone number changed on the account page.',
  'I got too many items in my package.',
  'Stop by my house after delivery.',
  'Remove the discount code from checkout.',
  'I am done checking out but need my receipt.',
  'The word quit appears on the shirt graphic.',
  'Can you block the sender on my account login?',
  'Please delete the duplicate order only.',
  'I need help with returns and exchanges.',
  'This message says reply STOP, what does that mean?',
  'Do you have subscription options for monthly delivery?'
];
