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
const hoverPath = path.join(__dirname, "../highlighter/data/rules/rule_hover_text.json");
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
  assert.equal(payload.rules.length, 220);
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
});

test("builds all 220 rules with the schema-v2 runtime interface", () => {
  const rules = buildRules();
  assert.equal(rules.length, 220);
  assert.equal(new Set(rules.map((rule) => rule.id)).size, 220);
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
  const longText = "d".repeat(300);
  const merged = settings({
    opacity: 9,
    customKeywords: [" launch code ", "launch   code", { pattern: "VIP", text: "Added in popup" }, longKeyword, ""],
    customKeywordTextByPattern: { "launch code": "Custom hover copy", [longKeyword]: longText },
    categories: { user_added: { color: "#000000" }, opt_out: { enabled: false } }
  });

  assert.equal(merged.opacity, 0.85);
  assert.deepEqual(merged.customKeywords, ["launch code", "VIP", "k".repeat(128)]);
  assert.equal(merged.customKeywordTextByPattern["launch code"], "Custom hover copy");
  assert.equal(merged.customKeywordTextByPattern.VIP, "Added in popup");
  assert.equal(merged.customKeywordTextByPattern["k".repeat(128)].length, 256);
  assert.equal(merged.categories.user_added.color, defaults.categories.user_added.color);
  assert.equal(merged.categories.opt_out.enabled, false);

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
  assert.equal(defaults.categories.txt.label, "Texting Explanation");
  assert.equal(defaults.categories.reply.color, "#bbcfa4");
  assert.equal(defaults.categories.close.color, "#FAF4DF");

  const migrated = settings({
    categories: {
      test: { enabled: true, label: "Test", color: "#22c55e" },
      txt: { label: "Texting/source question", color: "#F6DA71" }
    }
  });
  assert.equal(Object.hasOwn(migrated.categories, "test"), false);
  assert.equal(migrated.categories.txt.label, "Texting Explanation");
  assert.equal(migrated.categories.txt.color, "#8fded4");

  const enabledNoAction = settings({ categories: { no_action: { enabled: true } } });
  assert.equal(core.getActiveRules(buildRules(), enabledNoAction).some((rule) => rule.action === "no_action"), false);
});

test("executes every declarative match type", () => {
  const cases = [
    ["spam", "R0015", "regex_search"],
    ["No.", "R0009", "full_match"],
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
  assert.equal(core.collectMatches("stpp now", [ruleById("R0187")], settings()).length, 0);
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
  assert.equal(phrases.length, 379);
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
    ["emoji_only_non_stop", "😊✨", true],
    ["emoji_only_non_stop", "🛑", false],
    ["no_notifications", "I'm not receiving notifications. If this is urgent reply urgent to send a notification through with your original message.", true],
    ["driving_auto_reply", "I'm driving with Focus turned on", true],
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
    ["legal_intent", "lawlessness", false],
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
  for (const text of ["Stop by my house after delivery.", "kung fu", "lawlessness", "the order is done", "start the engine", "shipping is no longer available"]) {
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
    ["spam", "fuzzy_opt_out"]
  ];
  for (const [text, action] of cases) {
    assert.ok(actionsFor(text).includes(action), `${text} should produce ${action}`);
  }
  assert.equal(actionsFor("stop")[0], "opt_out");
});

test("keeps earliest, longest, then category-priority conflict resolution", () => {
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
  assert.deepEqual(matches.map((match) => match.rule.id), ["long"]);
});

test("matches an empty-message detector in core without creating a non-empty span", () => {
  const matches = core.collectMatches("   ", [ruleById("R0138")], settings());
  assert.equal(matches.length, 1);
  assert.deepEqual([matches[0].start, matches[0].end], [0, 3]);
});

test("disables configured categories without affecting other actions", () => {
  const configured = settings({ categories: { opt_out: { enabled: false } } });
  const active = core.getActiveRules(buildRules(), configured);
  assert.equal(active.some((rule) => rule.action === "opt_out"), false);
  assert.equal(active.some((rule) => rule.action === "reply"), true);
});

test("custom keyword rules escape punctuation and are ordered before built-ins", () => {
  const configured = settings({ customKeywords: ["launch.code?"] });
  const active = core.getActiveRules(buildRules(), configured);
  const matches = core.collectMatches("Flag launch.code? now", active, configured);
  assert.equal(active[0].id, "user_added:0");
  assert.equal(matches[0].rule.id, "user_added:0");
});

test("generated hover guidance covers every R-ID exactly once", () => {
  const registry = loadRegistry();
  const hover = JSON.parse(fs.readFileSync(hoverPath, "utf8"));
  assert.deepEqual(Object.keys(hover.by_rule_id).sort(), registry.rules.map((rule) => rule.rule_id).sort());
  for (const rule of registry.rules) {
    assert.deepEqual(hover.by_rule_id[rule.rule_id].title, rule.action);
    assert.equal(hover.by_rule_id[rule.rule_id].name, rule.rule_id);
    assert.ok(hover.by_rule_id[rule.rule_id].text);
    assert.doesNotMatch(hover.by_rule_id[rule.rule_id].text, /\\b|\(\?:/);
  }
  assert.equal(hover.defaults.user_added.name, "{pattern}");
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
