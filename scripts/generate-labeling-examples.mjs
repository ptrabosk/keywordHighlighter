import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import '../highlighter/settings.js';
import '../highlighter/src/highlight/core.js';
import {
  HOT_TOPIC_BRAND_MESSAGE,
  exampleMatchesRule,
  isHotTopicRule,
  ruleFingerprint
} from './labeling-example-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');
const rulesPath = path.join(root, 'highlighter/data/rules/opt_out_deterministic_rules.json');
const outputPath = path.join(root, 'labeling-site/rule_examples.json');
const core = globalThis.AMH_HIGHLIGHT_CORE;
const settings = core.mergeSettings(globalThis.DEFAULT_SETTINGS, {});
const payload = JSON.parse(fs.readFileSync(rulesPath, 'utf8'));
const rawRules = Array.isArray(payload.rules) ? payload.rules : core.flattenRules(payload.rules);
const builtRulesById = new Map(core.buildRules(payload.rules).map((rule) => [rule.id, rule]));
const examples = {};
const failures = [];

function main() {
  for (const rule of rawRules) {
    const builtRule = builtRulesById.get(rule.id);
    const brandMessage = isHotTopicRule(rule) ? HOT_TOPIC_BRAND_MESSAGE : '';
    const caught = pickCaughtExample(rule, builtRule, brandMessage);
    const notCaught = pickNotCaughtExample(rule, builtRule, brandMessage);

    if (!caught || !notCaught) {
      failures.push({
        id: rule.id,
        name: rule.name,
        reason: !caught ? 'no caught example' : 'no notCaught example'
      });
      continue;
    }

    examples[rule.id] = {
      ruleName: rule.name || '',
      patternHash: ruleFingerprint(rule),
      caught,
      notCaught,
      ...(brandMessage ? { brandMessage } : {})
    };
  }

  if (failures.length) {
    console.error(JSON.stringify(failures, null, 2));
    process.exitCode = 1;
  } else {
    fs.writeFileSync(outputPath, `${JSON.stringify(examples, null, 2)}\n`);
    console.log(`Wrote ${Object.keys(examples).length} examples to ${path.relative(root, outputPath)}`);
  }
}


function pickCaughtExample(rule, builtRule, brandMessage) {
  for (const candidate of caughtCandidates(rule)) {
    if (matches(rule, builtRule, candidate, brandMessage)) return candidate;
  }
  return '';
}

function pickNotCaughtExample(rule, builtRule, brandMessage) {
  for (const candidate of notCaughtCandidates(rule)) {
    if (!matches(rule, builtRule, candidate, brandMessage)) return candidate;
  }
  return '';
}

function matches(rule, builtRule, customerMessage, brandMessage = '') {
  return exampleMatchesRule({
    core,
    settings,
    rule,
    builtRule,
    example: { customerMessage, brandMessage }
  });
}

function caughtCandidates(rule) {
  const override = caughtOverridesByRuleId[rule.id];
  const pattern = String(rule.pattern || '').trim();
  const candidates = [];

  if (override) candidates.push(override);
  if (caughtOverridesByPattern[pattern]) candidates.push(caughtOverridesByPattern[pattern]);

  if (isHotTopicRule(rule)) {
    candidates.push(String(rule.name || '').endsWith('opt_out') ? '4' : '2');
  }

  if (rule.type === 'deterministic_detector') {
    candidates.push(...deterministicCandidates(rule));
  } else if (rule.type === 'literal_phrase' || rule.type === 'vocabulary') {
    candidates.push(pattern, formatSampleForRule(pattern, rule), punctuateMessage(pattern));
  } else if (rule.type === 'regex') {
    for (const readable of regexReadableCandidates(pattern)) {
      candidates.push(readable);
      candidates.push(humanizeSample(readable));
      candidates.push(formatSampleForRule(readable, rule));
      if (!isAnchoredPattern(pattern)) candidates.push(sentenceContainingPhrase(readable, rule));
    }
  }

  candidates.push(fallbackSampleForRule(rule));
  return uniqueNonEmpty(candidates);
}

function notCaughtCandidates(rule) {
  if (rule.id === 'rule_451c36fb9b91ee65') return ['4', 'never', ''];
  if (rule.id === 'rule_39802d76d8b46842') return ['2', 'weekly', 'hello there'];
  return uniqueNonEmpty([
    notCaughtOverridesByRuleId[rule.id],
    'i am a girl',
    'hello there',
    'blue dress',
    'order question',
    'shipping update',
    'thanks for checking'
  ]);
}

function deterministicCandidates(rule) {
  const name = String(rule.name || '');
  if (name === 'combined.single_letter_only') return ['x', 'A'];
  if (name === 'combined.number_only') return ['45', '123'];
  if (name === 'zapOptOuts.classifier.is_link') return ['https://example.com', 'www.example.com'];
  if (name === 'zapOptOuts.workflow.node_4.subscription.subscription_candidate') return ['Please cancel my subscription.', 'Remove my subscriptions.'];
  if (name === 'combined.reaction_reply') return ['Loved "Thanks for your order"', 'Reacted to "Thanks"'];
  if (name === 'autoQAMessages.under_13_age_threshold') return ['I am three', 'I am 12 years old.'];
  if (name === 'combined.unavailable_auto_reply') return ["Sorry, I can't talk right now.", "Sorry can't talk now."];
  if (name === 'combined.device_not_working') return ['This phone number cannot receive text messages please call instead.'];
  if (name === 'combined.txt_origin_question') return ['Who is this and why are you texting me?', 'I dont know you.'];
  return [];
}

function regexReadableCandidates(pattern) {
  const variants = expandRegexAlternatives(pattern).slice(0, 120);
  return uniqueNonEmpty([
    regexToReadableSample(pattern),
    ...variants.map(regexToReadableSample),
    ...variants.map(stripRegexBoundaries)
  ]);
}

function expandRegexAlternatives(pattern) {
  let variants = [String(pattern || '')];
  let changed = true;
  while (changed && variants.length < 160) {
    changed = false;
    const next = [];
    for (const variant of variants) {
      const group = findInnermostAlternativeGroup(variant);
      if (!group) {
        next.push(variant);
        continue;
      }
      changed = true;
      for (const option of group.options) {
        next.push(`${variant.slice(0, group.start)}${option}${variant.slice(group.end)}`);
      }
    }
    variants = next.slice(0, 160);
  }
  return variants;
}

function findInnermostAlternativeGroup(value) {
  const text = String(value || '');
  const stack = [];
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    if (char === '\\') {
      index += 1;
      continue;
    }
    if (char === '(') stack.push(index);
    if (char !== ')') continue;
    const start = stack.pop();
    if (start === undefined) continue;
    const body = text.slice(start + 1, index).replace(/^\?:/, '').replace(/^[<!=]+/, '');
    if (!body.includes('|') || /[()]/.test(body)) continue;
    return {
      start,
      end: index + 1,
      options: body.split('|')
    };
  }
  return null;
}

function regexToReadableSample(pattern) {
  return stripRegexBoundaries(chooseFirstRegexAlternatives(String(pattern || '')))
    .replace(/\[\.!\?,;:\]\*/g, '')
    .replace(/\(\?<!\[a-z0-9\]\)/g, '')
    .replace(/\(\?!\[a-z0-9\]\)/g, '')
    .replace(/\(\?<=\[a-z0-9\]\)/g, '')
    .replace(/\(\?=\[a-z0-9\]\)/g, '')
    .replace(/\\b/g, '')
    .replace(/\\W/g, ' ')
    .replace(/\[\\W_\]\*/g, '')
    .replace(/\[\\W_\]\+/g, ' ')
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
}

function stripRegexBoundaries(value) {
  return String(value || '')
    .replace(/\^\s\*/g, '')
    .replace(/\s\*\$/g, '')
    .replace(/\^\\s\*/g, '')
    .replace(/\\s\*\$/g, '')
    .replace(/^\^/, '')
    .replace(/\$$/, '')
    .trim();
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

function formatSampleForRule(value, rule) {
  const phrase = humanizeSample(value);
  if (!phrase) return fallbackSampleForRule(rule);
  if (isSingleWordSample(phrase)) return phrase.toLowerCase();
  if (isWholeMessageRule(rule) || isPhraseScope(rule) || isAnchoredPattern(rule.pattern)) return punctuateMessage(phrase);
  return sentenceContainingPhrase(phrase, rule);
}

function sentenceContainingPhrase(phrase, rule) {
  const sample = humanizeSample(phrase);
  const subcategory = String(rule.subcategory || rule.category || '').toLowerCase();

  if (!sample) return fallbackSampleForRule(rule);
  if (/[.!?]$/.test(sample)) return sample;
  if (subcategory.includes('legal')) return legalSentenceForPhrase(sample);
  if (/^(i|i'm|im|i am|we|this|that|my|you|who|what|where|why|how)\b/i.test(sample)) return punctuateMessage(sample);
  if (/^(do not|don't|dont|donot|stop|unsubscribe|remove|delete|leave|block|cancel|end|quit|opt out|take me off|no more)\b/i.test(sample)) {
    return punctuateMessage(`Please ${sample}`);
  }
  if (subcategory.includes('customer_support')) return punctuateMessage(`Can I get ${sample}`);
  if (subcategory.includes('wrong_number')) return punctuateMessage(`This is the ${sample}`);
  if (subcategory.includes('legal') || subcategory.includes('spam') || subcategory.includes('scam')) {
    return punctuateMessage(`I'm going to report this as ${sample}`);
  }
  return punctuateMessage(`Please ${sample}`);
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

function capitalizeMessage(value) {
  const text = String(value || '').trim();
  if (!text) return '';
  if (/^(asap|stfu|sybau|dnc|fu)$/i.test(text)) return text.toUpperCase();
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function isPhraseScope(rule) {
  const scope = String(rule.match_scope || '').toLowerCase();
  return scope.includes('phrase') || scope.includes('normalized') || scope.includes('keyword') || scope.includes('full');
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

function isAnchoredPattern(value) {
  const pattern = String(value || '').trim();
  return pattern.startsWith('^') || pattern.endsWith('$');
}

function fallbackSampleForRule(rule) {
  const subcategory = String(rule.subcategory || rule.category || '').toLowerCase();
  if (subcategory.includes('customer_support')) return 'Help.';
  if (subcategory.includes('wrong_number')) return 'This is the wrong number.';
  if (subcategory.includes('not_interested')) return "I'm not interested anymore.";
  if (subcategory.includes('subscription')) return 'Please cancel my subscription.';
  if (subcategory.includes('auto_reply')) return "Sorry, I can't talk right now.";
  if (subcategory.includes('device_not_working')) return 'This phone number cannot receive text messages please call instead.';
  return 'Please stop texting me.';
}

function uniqueNonEmpty(values) {
  const seen = new Set();
  const output = [];
  for (const value of values) {
    const text = String(value || '').trim();
    if (!text || seen.has(text)) continue;
    seen.add(text);
    output.push(text);
  }
  return output;
}

const caughtOverridesByRuleId = {
  rule_451c36fb9b91ee65: '2',
  rule_39802d76d8b46842: '4',
  rule_combined_single_letter_only: 'x',
  rule_combined_number_only: '45',
  rule_06d01f1a0e0b3885: 'https://example.com',
  rule_0818cc4a204d72a2: 'Send this text to subscribe to recurring automated personalized marketing alerts e g cart reminders from darc sport ref f jgm.',
  rule_14492eac781ac6da: 'Please cancel my subscription.',
  rule_2598a349be6b6683: 'Claim 5 free shein products now click the link to help and lets both win big.',
  rule_317fdbf0a6758d04: 'Never opted in.',
  rule_43211f1e95245113: "I'll file a suit against you.",
  rule_510bd44ff37f855b: 'Claim 5 free shein products now click the link to help and lets both win big.',
  rule_9a0a246dfc518c29: 'I dont want this',
  rule_3d56b72204be6281: 'no longer want this',
  rule_6da31ef70e2d6310: 'Im not receiving notifications if this is urgent reply urgent to send a notification through with your original message',
  rule_093f86528f285ea8: '10 shein freebies and a 50 allowance for the lucky just click and claim-so easy',
  rule_59ac8944eebd47b2: 'cancel my order',
  rule_9501f80f59e3b9fd: "i'm",
  rule_combined_reaction_reply: 'Loved "Thanks for your order"',
  rule_324c508204bec0e9: 'if you dont do this right now stop texting me',
  rule_55d69eabd731a280: 'reported',
  rule_898d3b22cf673bf4: 'dont text',
  rule_e51dc7d4ebc2632c: 'unsubscribe',
  rule_aafaf0652c3b58e9: 'dont text',
  rule_0d2cc297cd7cc1e0: 'no more texts',
  rule_b25458937a65a761: 'I am three',
  rule_fc89e4910657c938: 'I am 12',
  rule_combined_unavailable_auto_reply: "Sorry, I can't talk right now.",
  rule_combined_device_not_working: 'This phone number cannot receive text messages please call instead.',
  rule_combined_txt_origin_question: 'Who is this and why are you texting me?',
  rule_db58d4f1407e1a87: 'I am in grade 1.',
  rule_fbc658efd1856775: 'I am in 1st grade.',
  rule_cb94613c9b6507b3: 'im in 1st grade'
};

const notCaughtOverridesByRuleId = {
  rule_b25458937a65a761: 'i am a girl'
};

const caughtOverridesByPattern = {
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

main();
