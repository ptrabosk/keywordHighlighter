import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import "../highlighter/settings.js";
import "../highlighter/src/highlight/regexNormalization.js";
import "../highlighter/src/highlight/core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const rootRegistryPath = path.join(__dirname, "../opt_out_rules.json");
const packagedRegistryPath = path.join(__dirname, "../highlighter/data/rules/opt_out_rules.json");
const core = globalThis.AMH_HIGHLIGHT_CORE;
const defaults = globalThis.DEFAULT_SETTINGS;
const bullet = String.fromCodePoint(0x2022);

function loadRegistry() {
  return JSON.parse(fs.readFileSync(packagedRegistryPath, "utf8"));
}

function buildRules() {
  return core.buildRules(loadRegistry());
}

function settings(overrides = {}) {
  return core.mergeSettings(defaults, overrides);
}

function activeRules(overrides = {}) {
  return core.getActiveRules(buildRules(), settings(overrides));
}

function ruleById(id) {
  const rule = buildRules().find((item) => item.id === id);
  assert.ok(rule, `missing ${id}`);
  return rule;
}

function actionsFor(text, rules = activeRules()) {
  return core.collectMatches(text, rules, settings()).map((match) => match.rule.action);
}

test("canonical and packaged schema-v2 registries are byte-identical", () => {
  assert.deepEqual(fs.readFileSync(packagedRegistryPath), fs.readFileSync(rootRegistryPath));

  const payload = loadRegistry();
  assert.equal(payload.schema_version, 2);
  assert.equal(payload.registry_name, "unified_deterministic_opt_out_rules");
  assert.equal(payload.rules.length, 215);
  assert.deepEqual(
    payload.rules.map((rule) => rule.rule_id),
    JSON.parse(fs.readFileSync(rootRegistryPath, "utf8")).rules.map((rule) => rule.rule_id)
  );
});

test("registry validation rejects incompatible or incomplete payloads", () => {
  const wrongVersion = loadRegistry();
  wrongVersion.schema_version = 3;
  assert.throws(() => core.buildRules(wrongVersion), /schema_version must be 2/);

  const duplicate = loadRegistry();
  duplicate.rules[1].rule_id = duplicate.rules[0].rule_id;
  assert.throws(() => core.buildRules(duplicate), /duplicate rule_id R0001/);

  const unknownGuard = loadRegistry();
  unknownGuard.rules[8].guard = "unknown_guard";
  assert.throws(() => core.buildRules(unknownGuard), /unsupported guard/);

  const unknownDetector = loadRegistry();
  unknownDetector.rules[0].detector = "unknown_detector";
  assert.throws(() => core.buildRules(unknownDetector), /unsupported detector/);

  const truncated = loadRegistry();
  truncated.rules.pop();
  assert.throws(() => core.buildRules(truncated), /exactly 215 rules/);

  const noAction = loadRegistry();
  noAction.rules[0].action = "bogus_action";
  assert.throws(() => core.buildRules(noAction), /unsupported action bogus_action/);
});

test("builds all 215 rules with the schema-v2 runtime interface", () => {
  const rules = buildRules();
  assert.equal(rules.length, 215);
  assert.equal(new Set(rules.map((rule) => rule.id)).size, 215);
  for (const rule of rules) {
    assert.match(rule.id, /^R\d{4}$/);
    assert.equal(rule.name, rule.id);
    assert.equal(rule.tag, rule.action);
    assert.equal(rule.executable, true);
    assert.ok(rule.conditionSummary);
  }
});

test("merges settings and keeps stable user-added IDs", () => {
  const longKeyword = "k".repeat(140);
  const merged = settings({
    opacity: 9,
    // Older stored settings may hold keyword objects and hover text.
    customKeywords: [" launch code ", "launch   code", { pattern: "VIP", text: "Added in popup" }, longKeyword, "", "ab"],
    customKeywordTextByPattern: { "launch code": "Custom hover copy" },
    categories: { user_added: { color: "#000000" }, opt_out: { enabled: false } }
  });

  assert.equal(merged.opacity, 0.85);
  assert.deepEqual(merged.customKeywords, ["launch code", "VIP", "k".repeat(128)]);
  assert.equal(Object.hasOwn(merged, "customKeywordTextByPattern"), false);
  assert.equal(merged.categories.user_added.color, defaults.categories.user_added.color);
  assert.equal(Object.hasOwn(merged.categories.opt_out, "enabled"), false);

  const customRules = core.getCustomKeywordRules(merged);
  assert.deepEqual(customRules.map((rule) => rule.id), ["user_added:0", "user_added:1", "user_added:2"]);
});

test("default action colors and no-action behavior remain unchanged", () => {
  assert.equal(defaults.opacity, 0.25);
  assert.equal(Object.hasOwn(defaults.categories, "test"), false);
  assert.equal(defaults.categories.opt_out.color, "#fa8d75");
  assert.equal(defaults.categories.fuzzy_opt_out.color, "#ffcb99");
  assert.equal(defaults.categories.tmt.color, "#8fded4");
  assert.equal(defaults.categories.txt.color, defaults.categories.tmt.color);
  assert.equal(defaults.categories.txt.label, "TXT");
  assert.equal(defaults.categories.reply.color, "#5C9E3E");
  assert.equal(defaults.categories.close.color, "#E0A800");

  const migrated = settings({
    categories: {
      test: { enabled: true, label: "Test", color: "#22c55e" },
      txt: { label: "Texting/source question", color: "#F6DA71" }
    }
  });
  assert.equal(Object.hasOwn(migrated.categories, "test"), false);
  assert.equal(migrated.categories.txt.label, "TXT");
  assert.equal(migrated.categories.txt.color, "#8fded4");

  assert.equal(Object.hasOwn(defaults.categories, "no_action"), false);
  assert.equal(Object.hasOwn(settings({ categories: { no_action: { color: "#000000" } } }).categories, "no_action"), false);
});

test("custom keywords require three characters and are capped", () => {
  assert.equal(core.normalizeKeyword("ab"), "");
  assert.equal(core.normalizeKeyword("  a  b "), "a b");
  assert.equal(core.normalizeKeyword("abc"), "abc");

  const many = Array.from({ length: core.MAX_CUSTOM_KEYWORDS + 5 }, (_value, index) => `keyword${index}`);
  const merged = settings({ customKeywords: many });
  assert.equal(merged.customKeywords.length, core.MAX_CUSTOM_KEYWORDS);
  assert.deepEqual(merged.customKeywords, many.slice(0, core.MAX_CUSTOM_KEYWORDS));
});

test("executes every declarative match type", () => {
  const cases = [
    ["unsubscribe me", "R0016", "regex_search"],
    ["N-no", "R0009", "full_match"],
    ["Please fuck off now", "R0020", "bounded_phrase"],
    ["no longer", "R0034", "exact"],
    ["stpp", "R0187", "exact_set"]
  ];

  for (const [text, id, matchType] of cases) {
    const rule = ruleById(id);
    assert.equal(rule.matchType, matchType);
    assert.equal(core.collectMatches(text, [rule], settings()).length, 1, `${id}: ${text}`);
  }
  assert.equal(core.collectMatches("No thanks", [ruleById("R0009")], settings()).length, 0);
  assert.equal(core.collectMatches("No", [ruleById("R0009")], settings()).length, 0);
  assert.equal(core.collectMatches("nah stop", [ruleById("R0009")], settings()).length, 1);
  assert.equal(core.collectMatches("stpp now", [ruleById("R0187")], settings()).length, 0);
});

test("rewrites registry regexes for normalized search without touching regex syntax", () => {
  const normalize = globalThis.AMH_REGEX_NORMALIZATION.normalizeRegexPatternForSearch;
  const cases = [
    // Dropped quotes, including the "?" that made them optional.
    ["don't", "dont"],
    ["don'?t", "dont"],
    ["it’s", "its"],
    // Literal punctuation becomes whitespace, collapsed to one \s+.
    ["a.b", "a\\s+b"],
    ["a-b", "a\\s+b"],
    ["x, y; z: w!", "x\\s+y\\s+z\\s+w\\s+"],
    ["hi.?", "hi\\s+?"],
    // Escapes, character classes, and quantifier braces are copied verbatim.
    ["\\.", "\\."],
    ["[.,-]", "[.,-]"],
    ["[a'b]?", "[a'b]?"],
    ["[{]", "[{]"],
    ["a{1,3}", "a{1,3}"],
    // Group, lookaround, optional, and wildcard syntax is preserved.
    ["(?:x)", "(?:x)"],
    ["(?=y)", "(?=y)"],
    ["(?!z)", "(?!z)"],
    ["(?<=a)", "(?<=a)"],
    ["(?<!b)", "(?<!b)"],
    ["a?", "a?"],
    [".*", ".*"],
    [".+", ".+"],
    ["", ""]
  ];
  for (const [pattern, expected] of cases) {
    assert.equal(normalize(pattern), expected, pattern);
  }
});

test("normalizes punctuation, contractions, accents, and stylized letters with raw span mapping", () => {
  const dontWant = ruleById("R0035");
  assert.equal(core.collectMatches("I don’t want anything from you.", [dontWant], settings()).length, 1);
  assert.equal(core.normalizeMessageBody("  CÁFÉ—TEST!  "), "cafe test");

  const stop = ruleById("R0187");
  const stylized = "𝓢𝓽𝓸𝓹";
  const matches = core.collectMatches(stylized, [stop], settings());
  assert.equal(matches.length, 1);
  assert.equal(matches[0].start, 0);
  assert.equal(matches[0].end, stylized.length);
});

test("supports raw emoji rules and translates Python Unicode escapes", () => {
  const middleFinger = ruleById("R0007");
  const stopEmoji = ruleById("R0008");
  assert.match(middleFinger.regexes[0].source, /\\u\{1f595\}/i);
  assert.equal(middleFinger.regexes[0].unicode, true);
  assert.equal(stopEmoji.regexes[0].unicode, true);
  assert.equal(core.collectMatches("🖕", [middleFinger], settings()).length, 1);
  assert.equal(core.collectMatches("🛑 ✋", [stopEmoji], settings()).length, 1);
  assert.equal(core.collectMatches("✋🏻", [stopEmoji], settings()).length, 1);
  assert.equal(core.collectMatches("✋🏿 🛑", [stopEmoji], settings()).length, 1);
  assert.equal(core.collectMatches("hello 🛑", [stopEmoji], settings()).length, 0);
});

test("uses Unicode-aware bounded phrases", () => {
  assert.equal(core.collectMatches("no me contactes", [ruleById("R0141")], settings()).length, 1);
  assert.equal(core.collectMatches("不要再联系我", [ruleById("R0160")], settings()).length, 1);
  assert.equal(core.collectMatches("prefixno me contactessuffix", [ruleById("R0141")], settings()).length, 0);
});

test("every configured literal phrase matches its owning rule", () => {
  const rules = buildRules().filter((rule) => ["exact", "exact_set", "bounded_phrase"].includes(rule.matchType) && !rule.guard);
  const phrases = rules.flatMap((rule) => rule.patterns.map((phrase) => [rule, phrase]));
  assert.equal(phrases.length, 507);
  for (const [rule, phrase] of phrases) {
    assert.equal(core.collectMatches(phrase, [rule], settings()).length, 1, `${rule.id}: ${phrase}`);
  }
});

test("implements all detector names with positive and negative behavior", () => {
  const detectorCases = [
    ["single_letter_only", "x", true],
    ["single_letter_only", "xy", false],
    ["number_only", "45", true],
    ["number_only", "45 please", false],
    ["reaction_reply", 'Loved "Thanks for your order"', true],
    ["reaction_reply", "Laughed at “that deal”", true],
    ["reaction_reply", "Emphasized an image", true],
    ["reaction_reply", 'Removed a heart from "Sale today"', true],
    ["reaction_reply", 'Reacted \u{1F602} to "Sale today"', true],
    ["reaction_reply", 'Loved "sale" but stop texting me now', false],
    ["reaction_reply", "I reacted to your ad. STOP texting me", false],
    ["reaction_reply", "Loved it", false],
    ["emoji_only_non_stop", "😊✨", true],
    ["emoji_only_non_stop", "🛑", false],
    ["no_notifications", "I'm not receiving notifications. If this is urgent reply urgent to send a notification through with your original message.", true],
    ["driving_auto_reply", "I'm driving with Focus turned on. I'll see your message when I get where I'm going.", true],
    ["driving_auto_reply", "Manejan., no puedo escrib. \nSent from MY ALTIMA", true],
    ["driving_auto_reply", "I'm driving with Focus turned on", false],
    ["unavailable_auto_reply", "Sorry, I can't talk right now.", true],
    ["device_not_working", "This phone cannot receive text messages.", true],
    ["txt_origin_question", "Who is this and why are you texting me?", true],
    ["empty_customer_message", "   ", true],
    ["real_word_collision", "shop", true],
    ["under_13", "I am 12 years old", true],
    ["under_13", "I am 13 years old", false],
    ["language_filter_non_opt_out", "qwrty", true],
    ["language_filter_non_opt_out", "help", false],
    ["bounded_block_intent", "I will block your number", true],
    ["targeted_legal_intent", "I will report you to the FCC", true],
    ["link_only", "https://example.com www.example.org", true],
    ["link_only", "see https://example.com", false],
    ["hot_topic_not_opt_out", "1", false],
    ["hot_topic_opt_out", "4", false]
  ];

  for (const [detector, raw, expected] of detectorCases) {
    assert.equal(core.detectorMatches(detector, raw, core.normalizeMessageBody(raw)), expected, `${detector}: ${raw}`);
  }
  assert.equal(new Set(loadRegistry().rules.filter((rule) => rule.match_type === "detector").map((rule) => rule.detector)).size, 17);
});

test("enforces every named guard against the complete normalized message", () => {
  const cases = [
    ["unsubscribe_intent", "stop texting me", true],
    ["unsubscribe_intent", "stop by my house", false],
    ["offensive_intent", "fuck you", true],
    ["offensive_intent", "kung fu", false],
    ["legal_intent", "I will sue you", true],
    ["legal_intent", "I will report you", true],
    ["legal_intent", "I'm reporting you", true],
    ["legal_intent", "I will report this company", true],
    ["legal_intent", "Who can I report this to?", false],
    ["legal_intent", "Where do I report this company?", false],
    ["legal_intent", "lawlessness", false],
    ["legal_intent", "I have a complaint about my order", false],
    ["legal_intent", "complaint", false],
    ["legal_intent", "How do I file a complaint about my order?", false],
    ["legal_intent", "I'm filing a complaint against you", true],
    ["legal_intent", "I will file a complaint with the FCC", true],
    ["legal_intent", "I made a complaint to the BBB", true],
    ["not_interested_intent", "I'm done with this brand", true],
    ["not_interested_intent", "the order is done", false],
    ["wrong_number_intent", "you have the wrong number", true],
    ["wrong_number_intent", "the wrong color", false],
    ["block_intent", "I will block you", true],
    ["block_intent", "block party", false],
    ["opt_in_intent", "start", true],
    ["opt_in_intent", "start the engine", false]
  ];
  for (const [guard, raw, expected] of cases) {
    assert.equal(core.guardAllows(guard, core.normalizeMessageBody(raw)), expected, `${guard}: ${raw}`);
  }

  const integratedCases = [
    ["R0016", "stop texting me"],
    ["R0023", "fuck you"],
    ["R0031", "I will sue you"],
    ["R0035", "I don't want anything from you"],
    ["R0038", "wrong number"],
    ["R0041", "I'm blocking you"],
    ["R0107", "start"]
  ];
  for (const [id, message] of integratedCases) {
    assert.equal(core.collectMatches(message, [ruleById(id)], settings()).length, 1, `${id}: ${message}`);
  }
});

test("prevents representative false-positive highlights", () => {
  const rules = activeRules();
  for (const text of ["Stop by my house after delivery.", "kung fu", "lawlessness", "the order is done", "start the engine", "shipping is no longer available", "Why would you need an RFID blocking card if the wallet has RFID-blocking wireless theft protection?", "spam is annoying", "lol that was funny", "this is a test of the order", "i dont want to wait"]) {
    assert.deepEqual(core.collectMatches(text, rules, settings()), [], text);
  }
});

test("retains representative action behavior and priority", () => {
  const cases = [
    ["wrong number", "opt_out"],
    ["who is this", "txt"],
    ["customer service", "reply"],
    ["I'm done with this brand", "fuzzy_opt_out"],
    ["Sorry, I can't talk right now.", "close"],
    ["I am 12 years old.", "opt_out"],
    ["spam", "tmt"]
  ];
  for (const [text, action] of cases) {
    assert.ok(actionsFor(text).includes(action), `${text} should produce ${action}`);
  }
  assert.equal(actionsFor("stop")[0], "opt_out");
});

test("a lone no closes, and only real tapbacks outrank an opt-out", () => {
  assert.equal(actionsFor("no")[0], "close");
  assert.equal(actionsFor("No.")[0], "close");
  assert.equal(actionsFor("n no")[0], "opt_out");
  assert.equal(actionsFor("No stop")[0], "opt_out");
  assert.equal(actionsFor('Loved "Reply STOP to opt out"')[0], "close");
  assert.equal(actionsFor("I reacted to your ad. STOP texting me")[0], "opt_out");
  assert.equal(actionsFor('Loved "sale" but stop texting me now')[0], "opt_out");
});

test("classifies Hot Topic prompts and choice-only replies", () => {
  const prompt = "Hot Topic: How often do you want texts? Reply 1 Same, 2 Weekly, 3 Monthly, 4 Never";
  assert.equal(core.isHotTopicPrompt(prompt), true);
  assert.equal(core.isHotTopicPrompt("How often? 1 Same, 2 Weekly, 3 Monthly, 4 Never"), false);

  for (const reply of ["4", "Four!", "never", "4 - Never", "I never ordered", "please never text me again"]) {
    assert.equal(core.classifyHotTopicReply(reply), "hot_topic_opt_out", reply);
  }
  for (const reply of ["1", "two", "Weekly", "3 monthly", "same."]) {
    assert.equal(core.classifyHotTopicReply(reply), "hot_topic_not_opt_out", reply);
  }
  for (const reply of ["2 but stop", "4 please stop", "maybe", ""]) {
    assert.equal(core.classifyHotTopicReply(reply), "", reply);
  }
});

test("classifies a whole message across paragraphs by rule priority", () => {
  const rules = buildRules();
  const active = core.getActiveRules(rules, settings());
  const classify = (texts, options = {}) => core.classifyMessage(texts, active, settings(), { rules, ...options })?.action ?? null;

  // A later paragraph with a higher-priority match wins over an earlier one.
  assert.equal(classify(["customer service", "stop"]), "opt_out");
  assert.equal(classify(["stop", "customer service"]), "opt_out");
  assert.equal(classify(["", "   ", "wrong number"]), "opt_out");
  assert.equal(classify(["hello there"]), null);
  assert.equal(classify([]), null);
});

test("classifies Hot Topic replies only when a preceding prompt is present", () => {
  const rules = buildRules();
  const active = core.getActiveRules(rules, settings());
  const prompt = "Hot Topic: reply 1 Same, 2 Weekly, 3 Monthly, 4 Never";
  let lookups = 0;
  const withPrompt = () => { lookups += 1; return ["Thanks for shopping", prompt]; };
  const classify = (texts, getRecentBrandTexts) =>
    core.classifyMessage(texts, active, settings(), { rules, getRecentBrandTexts });

  assert.equal(classify(["4"], withPrompt).detector, "hot_topic_opt_out");
  assert.equal(classify(["Weekly"], withPrompt).detector, "hot_topic_not_opt_out");
  // Without the prompt, "4" is just a number-only reply.
  assert.equal(classify(["4"], () => []).detector, "number_only");
  // Anything besides a bare choice falls through to the regular rules.
  assert.equal(classify(["2 but stop texting me"], withPrompt).action, "opt_out");

  lookups = 0;
  classify(["stop texting me"], withPrompt);
  assert.equal(lookups, 0, "the brand lookback only runs for choice-only replies");
});

test("pickHighestPriorityRule is stable for equal priorities", () => {
  const first = { id: "a", tag: "reply" };
  const second = { id: "b", tag: "reply" };
  const optOut = { id: "c", tag: "opt_out" };
  assert.equal(core.pickHighestPriorityRule([first, second], settings()).id, "a");
  assert.equal(core.pickHighestPriorityRule([first, second, optOut], settings()).id, "c");
  assert.equal(core.pickHighestPriorityRule([], settings()), null);
});

test("resolves conflicts by category priority, then earliest, then longest", () => {
  const runtimeRule = (id, action, pattern) => ({
    id,
    name: id,
    tag: action,
    action,
    target: "raw_customer",
    matchType: "regex_search",
    regexes: [new RegExp(pattern, "gi")],
    executable: true
  });
  const rules = [
    runtimeRule("short", "opt_out", "stop sending"),
    runtimeRule("long", "tmt", "stop sending me so many messages"),
    runtimeRule("late", "txt", "messages")
  ];
  const matches = core.collectMatches("Stop sending me so many messages please", rules, settings());
  assert.deepEqual(matches.map((match) => match.rule.id), ["short", "late"]);
});

test("matches an empty-message detector in core without creating a non-empty span", () => {
  const matches = core.collectMatches("   ", [ruleById("R0138")], settings());
  assert.equal(matches.length, 1);
  assert.deepEqual([matches[0].start, matches[0].end], [0, 3]);
});

test("ignores stored category enabled flags", () => {
  const configured = settings({ categories: { opt_out: { enabled: false }, user_added: { enabled: false } }, customKeywords: ["launch"] });
  const active = core.getActiveRules(buildRules(), configured);
  assert.equal(active.some((rule) => rule.action === "opt_out"), true);
  assert.equal(active.some((rule) => rule.action === "user_added"), true);
});

test("custom keyword rules escape punctuation and are ordered before built-ins", () => {
  const configured = settings({ customKeywords: ["launch.code?"] });
  const active = core.getActiveRules(buildRules(), configured);
  const matches = core.collectMatches("Flag launch.code? now", active, configured);
  assert.equal(active[0].id, "user_added:0");
  assert.equal(matches[0].rule.id, "user_added:0");
});


test("preserves all seven escalation rule IDs and matching behavior", () => {
  assert.deepEqual(core.escalationBulletRules.map((rule) => rule.id), [
    "code:escalation_immediately",
    "code:escalation_use_temp",
    "code:escalation_use_shortcut",
    "code:escalation_no_esc",
    "code:escalation_post_purchase",
    "code:escalation_client_takeover",
    "code:escalation_last_word"
  ]);

  const text = [
    `${bullet} Please respond immediately`,
    `${bullet} use ABC temp`,
    `${bullet} use DEF shortcut`,
    `${bullet} NO ESC for this case`,
    `${bullet} post-purchase issue`,
    `${bullet} Close when the client takes over`,
    `${bullet} Let the customer have the last word`,
    `${bullet} use Abc temp`
  ].join("\n");
  assert.deepEqual(
    core.collectEscalationBulletMatches(text).map((match) => match.rule.id),
    core.escalationBulletRules.map((rule) => rule.id)
  );
});

test("whole-message rules and shush requests behave as tightened", () => {
  for (const text of ["done", "I'm done", "lol", "test", "spam"]) {
    assert.ok(core.collectMatches(text, activeRules(), settings()).length > 0, text);
  }
  for (const text of ["sh", "shh", "shhh", "shush"]) assert.equal(actionsFor(text)[0], "opt_out", text);
  assert.equal(actionsFor("i dont want it")[0], "fuzzy_opt_out");
  assert.equal(actionsFor("thank you very much").includes("no_action"), false);
});

test("opt-out instruction boilerplate is an opt out unless it is a question or page wording", () => {
  for (const text of ["stop to opt out", "STOP to end", "Welcome to Rewards! Learn more: https://x.co  STOP to End", "unsubscribe by texting stop"]) {
    assert.equal(actionsFor(text)[0], "opt_out", text);
  }
  for (const text of ["what does stop to end mean", "the page says reply stop to end"]) {
    assert.equal(actionsFor(text).includes("opt_out"), false, text);
  }
});

test("priority runs reaction, emoji stop, emoji only, Hot Topic, then the categories in order", () => {
  const s = settings();
  const priority = (id) => core.getRulePriority(ruleById(id), s);
  assert.ok(priority("R0005") < priority("R0008"), "reaction before emoji stop");
  assert.ok(priority("R0007") === priority("R0008"), "both stop-emoji rules share a tier");
  assert.ok(priority("R0008") < priority("R0006"), "emoji stop before emoji only");
  assert.ok(priority("R0006") < priority("R0001"), "emoji only before Hot Topic");
  const categories = ["opt_out", "fuzzy_opt_out", "tmt", "txt", "reply", "close"].map((tag) => s.categories[tag].priority);
  assert.ok(priority("R0001") < categories[0], "Hot Topic before opt out");
  assert.deepEqual([...categories].sort((a, b) => a - b), categories, "opt out, fuzzy, tmt, txt, reply, close");
  assert.equal(Object.hasOwn(s.categories, "no_action"), false, "no action never outranks a category");
});

test("emoji stop outranks everything else; other rules read the message without emojis", () => {
  assert.equal(actionsFor("🛑")[0], "opt_out");
  assert.equal(actionsFor("🖕 thanks")[0], "opt_out");
  assert.equal(actionsFor("👍")[0], "close");
  // A raw-text rule no longer misses a phrase an emoji sits inside.
  assert.equal(actionsFor("fuck 😠 you")[0], "opt_out");
  assert.equal(actionsFor("Thank you 😊").includes("opt_out"), false);
});

test("matches ARRÊT as an opt out", () => {
  const stop = ruleById("R0187");
  assert.equal(core.collectMatches("ARRÊT", [stop], settings()).length, 1);
});

test("matches Spanish and French stop, end, revoke, out, opt out, and unsubscribe phrases", () => {
  const stop = ruleById("R0187");
  for (const text of ["Cancelar", "PARAR", "Arrêt", "Annuler", "Désabonner"]) {
    assert.equal(core.collectMatches(text, [stop], settings()).length, 1, text);
  }
  const spanish = ruleById("R0141");
  for (const text of ["quiero cancelar mi suscripción", "Revoco mi consentimiento", "quiero salir de la lista"]) {
    assert.equal(core.collectMatches(text, [spanish], settings()).length, 1, text);
  }
  const french = ruleById("R0142");
  for (const text of ["Je veux annuler mon abonnement", "Désinscrivez-moi", "Retirez-moi de la liste"]) {
    assert.equal(core.collectMatches(text, [french], settings()).length, 1, text);
  }
});

test("matches 'enough' of the texts as an opt out, but not 'not enough'", () => {
  const enough = ruleById("R0229");
  for (const text of ["Enough of the text messages", "enough text messages", "enough texts", "Enough of the texts!", "I've had enough of these texts", "enough with the messages", "enough already with the texting", "enough of your sms"]) {
    assert.equal(core.collectMatches(text, [enough], settings()).length, 1, text);
  }
  for (const text of ["not enough texts", "there is enough time", "enough food"]) {
    assert.equal(core.collectMatches(text, [enough], settings()).length, 0, text);
  }
});

test("matches Arabic-script 'stop' as an opt out", () => {
  const arabic = ruleById("R0230");
  for (const text of ["ستوب", "ستوب!", "  ستوب  "]) {
    assert.equal(core.collectMatches(text, [arabic], settings()).length, 1, text);
  }
});
