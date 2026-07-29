import crypto from 'node:crypto';

export const HOT_TOPIC_BRAND_MESSAGE = [
  'Hot Topic: So, how often do you want to see our texts?',
  'Reply with a number:',
  '1. Same',
  '2. Weekly',
  '3. Monthly',
  '4. Never'
].join('\n');

const DIRECT_REGEX_FLAGS = new Set('dgimsuvy'.split(''));

export function ruleFingerprint(rule) {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify({
      name: rule.name || '',
      pattern: rule.pattern || '',
      flags: rule.flags || '',
      match_scope: rule.match_scope || rule.matchScope || '',
      match_target: rule.match_target || rule.matchTarget || '',
      condition_summary: rule.condition_summary || rule.conditionSummary || ''
    }))
    .digest('hex')
    .slice(0, 16);
}

export function exampleMatchesRule({ core, settings, rule, builtRule, example }) {
  const customerMessage = String(example?.customerMessage ?? example?.caught ?? example?.notCaught ?? '');
  const brandMessage = String(example?.brandMessage || '');

  if (isHotTopicRule(rule)) {
    return hotTopicRuleMatches(rule, customerMessage, brandMessage);
  }

  if (builtRule?.regex) {
    return core.collectMatches(customerMessage, [builtRule], settings).some((match) => match.rule.id === builtRule.id);
  }

  return fallbackRuleMatches(rule, customerMessage, brandMessage);
}

export function normalizeSearchText(value) {
  const chars = [];
  let pendingSpace = false;
  for (const rawChar of String(value || '')) {
    const folded = rawChar
      .normalize('NFKD')
      .replace(/[\u0300-\u036f]+/g, '')
      .normalize('NFKC')
      .toLowerCase();

    for (const char of folded) {
      if (/[a-z0-9]/.test(char)) {
        if (pendingSpace && chars.length) chars.push(' ');
        pendingSpace = false;
        chars.push(char);
      } else if (char === "'" || char === '`' || char === '\u2018' || char === '\u2019') {
        continue;
      } else if (chars.length) {
        pendingSpace = true;
      }
    }
  }
  return chars.join('').trim();
}

export function isHotTopicRule(rule) {
  return String(rule.name || '').startsWith('opt_outs_ml.hot_topic_') || String(rule.category || '') === 'hot_topic';
}

function hotTopicRuleMatches(rule, customerMessage, brandMessage) {
  const brand = normalizeSearchText(brandMessage);
  const customer = normalizeSearchText(customerMessage);
  const isPrompt = brand.startsWith('hot topic') && /\b1\s+same\b[\s\S]*\b2\s+weekly\b[\s\S]*\b3\s+monthly\b[\s\S]*\b4\s+never\b/.test(brand);
  if (!isPrompt || !customer) return false;
  const hasOptOutToken = /\b(?:4|four|never)\b/.test(customer);
  return String(rule.name || '') === 'opt_outs_ml.hot_topic_opt_out' ? hasOptOutToken : !hasOptOutToken;
}

function fallbackRuleMatches(rule, customerMessage, brandMessage) {
  const regex = compileDirectRuleRegex(rule);
  if (!regex) return false;

  const rawText = selectRawText(rule, customerMessage, brandMessage);
  const text = shouldSearchRawText(rule) ? rawText : normalizeSearchText(rawText);
  regex.lastIndex = 0;

  let match;
  while ((match = regex.exec(text)) !== null) {
    if (!match[0]) {
      regex.lastIndex += 1;
      continue;
    }
    if (!shouldMatchWholeMessage(rule)) return true;
    if (normalizeSearchText(rawText) === normalizeSearchText(match[0])) return true;
  }

  return false;
}

function compileDirectRuleRegex(rule) {
  if (String(rule.type || '') !== 'regex') return null;
  try {
    const flags = uniqueRegexFlags(`${rule.flags || 'i'}g`);
    return new RegExp(String(rule.pattern || ''), flags);
  } catch (_error) {
    return null;
  }
}

function selectRawText(rule, customerMessage, brandMessage) {
  const target = String(rule.match_target || rule.matchTarget || '').toLowerCase();
  if (target.includes('brand_message + customer_message')) return `${brandMessage}\n${customerMessage}`;
  if (target.includes('brand') && !target.includes('customer')) return brandMessage;
  return customerMessage;
}

function shouldSearchRawText(rule) {
  const scope = String(rule.match_scope || rule.matchScope || '').toLowerCase();
  const target = String(rule.match_target || rule.matchTarget || '').toLowerCase();
  return scope.includes('raw') || target.includes('raw') || target.includes('inbound dom message text');
}

function shouldMatchWholeMessage(rule) {
  const action = String(rule.action || rule.tag || '').toLowerCase();
  const scope = String(rule.match_scope || rule.matchScope || '').toLowerCase();
  return action === 'close' || action === 'not_opt_out' || [
    'full_normalized_message',
    'exact_normalized_exclusion',
    'whole_inbound_message_for_not_opt_out'
  ].includes(scope);
}

function uniqueRegexFlags(flags) {
  return Array.from(new Set(String(flags || '').split(''))).filter((flag) => DIRECT_REGEX_FLAGS.has(flag)).join('');
}
