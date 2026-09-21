import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import "../highlighter/settings.js";
import "../highlighter/src/highlight/core.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const core = globalThis.AMH_HIGHLIGHT_CORE;
const defaults = globalThis.DEFAULT_SETTINGS;
const bullet = String.fromCharCode(0x2022);
const normalizedRulesPath = path.join(__dirname, "../highlighter/data/rules/opt_out_deterministic_rules_normalized_ids.json");
const normalizedHoverPath = path.join(__dirname, "../highlighter/data/rules/rule_hover_text_normalized_ids.json");
const observedPhrasesPath = path.join(__dirname, "fixtures/observed-opt-out-phrases.json");

function loadNormalizedRules() {
  return JSON.parse(fs.readFileSync(normalizedRulesPath, "utf8"));
}

function buildNormalizedRules() {
  return core.buildRules(loadNormalizedRules().rules);
}

function rule(overrides) {
  return {
    id: overrides.id || "",
    name: overrides.name || overrides.tag,
    tag: overrides.tag,
    action: overrides.action || overrides.tag,
    pattern: overrides.pattern,
    type: overrides.type || "",
    flags: overrides.flags || "i",
    detector: overrides.detector || "",
    matchScope: overrides.matchScope || "",
    regex: core.compileRegex(overrides)
  };
}

test("flattens and compiles nested consolidated rule shapes", () => {
  const rules = core.buildRules({
    group: {
      nested: [
        { name: "stop", tag: "opt_out", pattern: "\\bstop\\b", source: "fixture" },
        { name: "bad", tag: "opt_out", pattern: "[" }
      ]
    }
  });

  assert.equal(rules.length, 2);
  assert.equal(rules[0].groupPath, "group.nested");
  assert.ok(rules[0].regex instanceof RegExp);
  assert.equal(rules[1].regex, null);
});

test("merges settings, deduplicates custom keywords, and preserves the fixed custom color", () => {
  const longKeyword = "k".repeat(140);
  const longText = "d".repeat(300);
  const settings = core.mergeSettings(defaults, {
    opacity: 9,
    customKeywords: [" launch code ", "launch   code", { pattern: "VIP", text: "Added in popup" }, longKeyword, ""],
    customKeywordTextByPattern: { "launch code": "Custom hover copy", [longKeyword]: longText },
    categories: {
      user_added: { color: "#000000" },
      opt_out: { enabled: false }
    }
  });

  assert.equal(settings.opacity, 0.85);
  assert.deepEqual(settings.customKeywords, ["launch code", "VIP", "k".repeat(128)]);
  assert.equal(settings.customKeywordTextByPattern["launch code"], "Custom hover copy");
  assert.equal(settings.customKeywordTextByPattern.VIP, "Added in popup");
  assert.equal(settings.customKeywordTextByPattern["k".repeat(128)].length, 256);
  assert.equal(settings.categories.user_added.color, defaults.categories.user_added.color);
  assert.equal(settings.categories.opt_out.enabled, false);
});

test("default action colors match response actions and no-action is disabled", () => {
  assert.equal(defaults.categories.opt_out.color, "#DF6A30");
  assert.equal(defaults.categories.fuzzy_opt_out.color, "#F0B368");
  assert.equal(defaults.categories.test.color, "#22c55e");
  assert.equal(defaults.categories.tmt.color, "#A3C3F1");
  assert.equal(defaults.categories.txt.color, "#F6DA71");
  assert.equal(defaults.categories.reply.color, "#D6DF22");
  assert.equal(defaults.categories.close.color, "#FAF4DF");
  assert.equal(defaults.categories.no_action.enabled, false);
});

test("collects earliest longest non-overlapping matches by category priority", () => {
  const settings = core.mergeSettings(defaults, {});
  const activeRules = [
    rule({ tag: "opt_out", pattern: "stop sending" }),
    rule({ tag: "tmt", pattern: "stop sending me so many messages" }),
    rule({ tag: "txt", pattern: "messages" })
  ];

  const matches = core.collectMatches("Stop sending me so many messages please", activeRules, settings);

  assert.equal(matches.length, 1);
  assert.equal(matches[0].rule.tag, "tmt");
  assert.equal(matches[0].start, 0);
  assert.equal(matches[0].end, "Stop sending me so many messages".length);
});

test("only accepts not_opt_out matches when they cover the message body", () => {
  const settings = core.mergeSettings(defaults, {});
  const activeRules = [rule({ tag: "not_opt_out", pattern: "where is my order" })];

  assert.equal(core.collectMatches("Where is my order?", activeRules, settings).length, 1);
  assert.equal(core.collectMatches("Can you tell me where is my order?", activeRules, settings).length, 0);
});

test("custom keyword rules escape literal punctuation and run before configured rules", () => {
  const settings = core.mergeSettings(defaults, {
    customKeywords: ["launch.code?"]
  });
  const activeRules = core.getActiveRules([rule({ tag: "opt_out", pattern: "launch.code" })], settings);
  const matches = core.collectMatches("Flag launch.code? now", activeRules, settings);

  assert.equal(activeRules[0].tag, "user_added");
  assert.equal(matches[0].rule.tag, "user_added");
  assert.equal(matches[0].length, "launch.code?".length);
});

test("never activates no-action rules even when settings enable them", () => {
  const settings = core.mergeSettings(defaults, {
    categories: {
      no_action: { enabled: true }
    }
  });
  const activeRules = core.getActiveRules([
    rule({ tag: "no_action", pattern: "thanks" }),
    rule({ tag: "reply", pattern: "help" })
  ], settings);

  assert.deepEqual(activeRules.map((item) => item.tag), ["reply"]);
});

test("compiles procedural close detectors", () => {
  const settings = core.mergeSettings(defaults, {});
  const rules = [
    rule({ id: "close_2", tag: "close", detector: "single_letter_only", pattern: "single letter", matchScope: "procedural" }),
    rule({ id: "close_3", tag: "close", detector: "number_only", pattern: "number only", matchScope: "procedural" }),
    rule({ id: "close_44", name: "zapOptOuts.classifier.is_link", tag: "close", pattern: "link only", matchScope: "procedural" }),
    rule({ id: "opt_out_30", tag: "opt_out", detector: "under_13", pattern: "under 13", matchScope: "procedural" }),
    rule({ id: "close_4", tag: "close", detector: "reaction_reply", pattern: "reaction reply", matchScope: "procedural" }),
    rule({ id: "close_11", tag: "close", detector: "unavailable_auto_reply", pattern: "unavailable auto reply", matchScope: "procedural" }),
    rule({ id: "opt_out_5", tag: "opt_out", detector: "device_not_working", pattern: "device not working", matchScope: "procedural" }),
    rule({ id: "txt_1", tag: "txt", detector: "txt_origin_question", pattern: "origin question", matchScope: "procedural" })
  ];

  assert.equal(core.collectMatches("x", [rules[0]], settings).length, 1);
  assert.equal(core.collectMatches("xy", [rules[0]], settings).length, 0);
  assert.equal(core.collectMatches("45", [rules[1]], settings).length, 1);
  assert.equal(core.collectMatches("45 please", [rules[1]], settings).length, 0);
  assert.equal(core.collectMatches("https://example.com", [rules[2]], settings).length, 1);
  assert.equal(core.collectMatches("see https://example.com", [rules[2]], settings).length, 0);
  assert.equal(core.collectMatches("I am 12 years old.", [rules[3]], settings).length, 1);
  assert.equal(core.collectMatches("I am 8.", [rules[3]], settings).length, 0);
  assert.equal(core.collectMatches("I am 13 years old.", [rules[3]], settings).length, 0);
  assert.equal(core.collectMatches('Loved "Thanks for your order"', [rules[4]], settings).length, 1);
  assert.equal(core.collectMatches("Sorry can't talk now.", [rules[5]], settings).length, 1);
  assert.equal(core.collectMatches("Sorry, I can't talk right now.", [rules[5]], settings).length, 1);
  assert.equal(core.collectMatches("This phone number cannot receive text messages please call instead.", [rules[6]], settings).length, 1);
  assert.ok(
    core.collectMatches("Who is this and why are you texting me?", [rules[7]], settings)
      .some((match) => match.rule.tag === "txt")
  );
});

test("compiles inventory regex rules before applying whole-message checks", () => {
  const settings = core.mergeSettings(defaults, {});
  const notOptedIn = rule({
    id: "opt_out_fixture",
    tag: "opt_out",
    type: "regex",
    pattern: "(?:never|didnt)?\\s*(?:opted\\s+in|signed\\s+up|subscribed?)",
    matchScope: "full_normalized_message"
  });

  assert.equal(core.collectMatches("Never opted in.", [notOptedIn], settings).length, 1);
  assert.equal(core.collectMatches("Never opted in. Please stop texting me.", [notOptedIn], settings).length, 0);
});

test("extension-ready stem patterns highlight the whole matching word", () => {
  const settings = core.mergeSettings(defaults, {});
  const activeRules = [rule({ tag: "opt_out", pattern: "block...", matchScope: "extension_ready_phrase" })];
  const matches = core.collectMatches("block", activeRules, settings);

  assert.equal(matches.length, 1);
  assert.equal(matches[0].length, "block".length);
  assert.equal(core.collectMatches("blocking", activeRules, settings).length, 1);
});

test("collects full matching escalation bullet lines", () => {
  const text = [
    `${bullet} ESC restock inquiries`,
    "",
    `${bullet} Please respond immediately`,
    "",
    `${bullet} Close when the client takes over`,
    "",
    `${bullet} Let the customer have the last word`
  ].join("\n");

  const matches = core.collectEscalationBulletMatches(text);

  assert.deepEqual(matches.map((match) => text.slice(match.start, match.end)), [
    `${bullet} Please respond immediately`,
    `${bullet} Close when the client takes over`,
    `${bullet} Let the customer have the last word`
  ]);
  assert.deepEqual(matches.map((match) => match.rule.name), [
    "escalation_immediately",
    "escalation_client_takeover",
    "escalation_last_word"
  ]);
});

test("requires uppercase letters in escalation temp and shortcut code bullets", () => {
  const text = `${bullet} use ABC temp\n${bullet} use Abc temp\n${bullet} USE XYZ TEMP\n${bullet} use DEF shortcut\n${bullet} use Def shortcut`;
  const matches = core.collectEscalationBulletMatches(text);

  assert.deepEqual(matches.map((match) => text.slice(match.start, match.end)), [
    `${bullet} use ABC temp`,
    `${bullet} USE XYZ TEMP`,
    `${bullet} use DEF shortcut`
  ]);
});

test("normalizes escalation no esc and post purchase bullets", () => {
  const text = `${bullet} NO ESC for this case\n${bullet} post-purchase issue\n${bullet} post purchase support\n${bullet} escrow question`;
  const matches = core.collectEscalationBulletMatches(text);

  assert.deepEqual(matches.map((match) => text.slice(match.start, match.end)), [
    `${bullet} NO ESC for this case`,
    `${bullet} post-purchase issue`,
    `${bullet} post purchase support`
  ]);
  assert.deepEqual(matches.map((match) => match.rule.name), [
    "escalation_no_esc",
    "escalation_post_purchase",
    "escalation_post_purchase"
  ]);
});

test("loads the complete normalized-ID inventory and compiles its executable rules", () => {
  const payload = loadNormalizedRules();
  const rules = core.buildRules(payload.rules);
  const ids = new Set(rules.map((item) => item.id));

  assert.equal(rules.length, 161);
  assert.equal(ids.size, rules.length);
  for (const rule of rules) {
    assert.match(rule.id, new RegExp(`^${rule.action}_\\d+$`));
    assert.equal(rule.tag, rule.action);
    assert.ok(rule.conditionSummary);
    if (rule.aliasOf) assert.equal(ids.has(rule.aliasOf), true, `${rule.id} aliases missing ${rule.aliasOf}`);
    if (rule.matchScope !== "procedural") assert.ok(rule.regex, `${rule.id} should compile`);
  }
});

test("extracts executable conditions from normalized rule summaries", () => {
  assert.equal(core.getConfiguredPattern({
    action: "opt_out",
    type: "regex",
    match_scope: "regex_search",
    condition_summary: "Human explanation. Match condition: ^stop$"
  }), "^stop$");
  assert.equal(core.getConfiguredPattern({
    action: "opt_out",
    type: "literal_phrase",
    match_scope: "contains_full_normalized_phrase",
    condition_summary: "stop texting"
  }), "stop texting");
});

test("normalized rules and hover guidance have a one-to-one normalized-ID mapping", () => {
  const payload = loadNormalizedRules();
  const hover = JSON.parse(fs.readFileSync(normalizedHoverPath, "utf8"));
  const ruleIds = payload.rules.map((item) => item.id).sort();
  const hoverIds = Object.keys(hover.by_rule_id).sort();

  assert.deepEqual(hoverIds, ruleIds);
  assert.deepEqual(hover.by_rule_name, {});
  for (const rule of payload.rules) {
    const entry = hover.by_rule_id[rule.id];
    assert.equal(entry.name, rule.name);
    const expectedTitle = rule.action === "no_action" ? "close" : rule.action;
    assert.equal(entry.title.toLowerCase().replace(/[- ]/g, "_"), expectedTitle);
    assert.ok(entry.text);
  }
});

test("all approved observed phrases match their categorized opt-out rule", () => {
  const fixture = JSON.parse(fs.readFileSync(observedPhrasesPath, "utf8"));
  const rules = buildNormalizedRules();
  const settings = core.mergeSettings(defaults, {});
  const ruleIds = {
    explicit_command: "opt_out_20",
    explicit_request: "opt_out_4",
    harassment_rejection: "opt_out_7",
    blocking_rejection: "opt_out_22",
    wrong_number: "opt_out_23",
    offensive_rejection: "opt_out_33"
  };
  const allPhrases = Object.values(fixture).flat();
  const activeRules = core.getActiveRules(rules, settings);

  assert.equal(allPhrases.length, 193);
  assert.equal(new Set(allPhrases).size, allPhrases.length);
  for (const [subcategory, phrases] of Object.entries(fixture)) {
    const target = rules.find((item) => item.id === ruleIds[subcategory]);
    assert.ok(target, `missing ${ruleIds[subcategory]}`);
    assert.equal(target.subcategory, subcategory);
    assert.deepEqual(target.observedPhrases, phrases);
    for (const phrase of phrases) {
      const matches = core.collectMatches(phrase, [target], settings);
      assert.equal(matches.length, 1, `${JSON.stringify(phrase)} should match ${target.id}`);
      assert.equal(matches[0].rule.action, "opt_out");
      assert.equal(matches[0].rule.prediction, 1);
      assert.equal(matches[0].rule.category, "opt_out");
      assert.ok(
        core.collectMatches(phrase, activeRules, settings).some((match) => match.rule.action === "opt_out"),
        `${JSON.stringify(phrase)} should remain opt_out in the complete inventory`
      );
    }
  }
  assert.ok(core.collectMatches("i would like to opt out of these messages\n\n", activeRules, settings)
    .some((match) => match.rule.action === "opt_out"));
});

test("short observed opt-out variants are whole-message matches only", () => {
  const rules = buildNormalizedRules();
  const settings = core.mergeSettings(defaults, {});
  const commandRule = rules.find((item) => item.id === "opt_out_20");
  const requestRule = rules.find((item) => item.id === "opt_out_4");

  for (const phrase of ["step", "cxl", "arrt", "sto0"]) {
    assert.equal(core.collectMatches(phrase, [commandRule], settings).length, 1, phrase);
  }
  for (const sentence of ["step one", "the cxl order", "arrt project", "code sto0 value"]) {
    assert.equal(core.collectMatches(sentence, [commandRule], settings).length, 0, sentence);
  }
  assert.equal(core.collectMatches("never", [requestRule], settings).length, 1);
  assert.equal(core.collectMatches("never mind", [requestRule], settings).length, 0);
});

test("normalizes mathematical-script letters and maps matches to complete raw spans", () => {
  const rules = buildNormalizedRules();
  const settings = core.mergeSettings(defaults, {});
  const requestRule = rules.find((item) => item.id === "opt_out_4");
  const cases = [
    "𝓢𝓽𝓸𝓹 𝓽𝓮𝔁𝓽",
    "Please 𝓢𝓽𝓸𝓹 𝓽𝓮𝔁𝓽"
  ];

  for (const text of cases) {
    const matches = core.collectMatches(text, [requestRule], settings);
    assert.equal(matches.length, 1, text);
    assert.equal(text.slice(matches[0].start, matches[0].end), text);
    assert.equal(matches[0].rule.action, "opt_out");
  }
});

test("normalized inventory retains representative action behavior", () => {
  const activeRules = core.getActiveRules(buildNormalizedRules(), core.mergeSettings(defaults, {}));
  const cases = [
    ["wrong number", "opt_out"],
    ["who is this", "txt"],
    ["customer service", "reply"],
    ["i am done with this brand", "fuzzy_opt_out"],
    ["Sorry, I can't talk right now.", "close"],
    ["I am in 1st grade.", "opt_out"]
  ];

  for (const [text, action] of cases) {
    const matches = core.collectMatches(text, activeRules, core.mergeSettings(defaults, {}));
    assert.ok(matches.some((match) => match.rule.action === action), `${text} should produce ${action}`);
  }
  assert.deepEqual(core.collectMatches("Stop by my house after delivery.", activeRules, core.mergeSettings(defaults, {})), []);
});
