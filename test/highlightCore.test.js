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

function rule(overrides) {
  return {
    name: overrides.name || overrides.tag,
    tag: overrides.tag,
    pattern: overrides.pattern,
    flags: overrides.flags || "i",
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
  const settings = core.mergeSettings(defaults, {
    opacity: 9,
    customKeywords: [" launch code ", "launch   code", ""],
    categories: {
      custom_keywords: { color: "#000000" },
      opt_out: { enabled: false }
    }
  });

  assert.equal(settings.opacity, 0.85);
  assert.deepEqual(settings.customKeywords, ["launch code"]);
  assert.equal(settings.categories.custom_keywords.color, defaults.categories.custom_keywords.color);
  assert.equal(settings.categories.opt_out.enabled, false);
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

  assert.equal(activeRules[0].tag, "custom_keywords");
  assert.equal(matches[0].rule.tag, "custom_keywords");
  assert.equal(matches[0].length, "launch.code?".length);
});

test("collects full matching escalation bullet lines", () => {
  const text = [
    "• ESC restock inquiries",
    "",
    "• Please respond immediately",
    "",
    "• Close when the client takes over",
    "",
    "• Let the customer have the last word"
  ].join("\n");

  const matches = core.collectEscalationBulletMatches(text);

  assert.deepEqual(matches.map((match) => text.slice(match.start, match.end)), [
    "• Please respond immediately",
    "• Close when the client takes over",
    "• Let the customer have the last word"
  ]);
  assert.deepEqual(matches.map((match) => match.rule.name), [
    "escalation_immediately",
    "escalation_client_takeover",
    "escalation_last_word"
  ]);
});

test("requires uppercase letters in escalation temp and shortcut code bullets", () => {
  const text = "• use ABC temp\n• use Abc temp\n• USE XYZ TEMP\n• use DEF shortcut\n• use Def shortcut";
  const matches = core.collectEscalationBulletMatches(text);

  assert.deepEqual(matches.map((match) => text.slice(match.start, match.end)), [
    "• use ABC temp",
    "• USE XYZ TEMP",
    "• use DEF shortcut"
  ]);
});

test("normalizes escalation no esc and post purchase bullets", () => {
  const text = "• NO ESC for this case\n• post-purchase issue\n• post purchase support\n• escrow question";
  const matches = core.collectEscalationBulletMatches(text);

  assert.deepEqual(matches.map((match) => text.slice(match.start, match.end)), [
    "• NO ESC for this case",
    "• post-purchase issue",
    "• post purchase support"
  ]);
  assert.deepEqual(matches.map((match) => match.rule.name), [
    "escalation_no_esc",
    "escalation_post_purchase",
    "escalation_post_purchase"
  ]);
});

test("consolidated rules resolve QA diagnostic phrases to their intended categories", () => {
  const payload = JSON.parse(fs.readFileSync(path.join(__dirname, "../highlighter/data/rules/consolidated_rules.json"), "utf8"));
  const settings = core.mergeSettings(defaults, {});
  const activeRules = core.getActiveRules(core.buildRules(payload.rules), settings);

  const cases = [
    ["Please stop texting me and remove me from your list.", [
      ["opt_out", "stop texting"],
      ["opt_out", "remove me from your list"]
    ]],
    ["who is this", [["txt", "who is this"]]],
    ["i dont know you", [["txt", "i dont know you"]]],
    ["we are done here", [["fuzzy_opt_out", "done"]]],
    ["finished", [["fuzzy_opt_out", "finished"]]],
    ["pause", [["fuzzy_opt_out", "pause"]]],
    ["shush", [["fuzzy_opt_out", "shush"]]],
    ["subscribe", [["not_opt_out", "subscribe"]]]
  ];

  for (const [text, expected] of cases) {
    const matches = core.collectMatches(text, activeRules, settings);
    for (const [tag, contains] of expected) {
      assert.ok(
        matches.some((match) => match.rule.tag === tag && text.slice(match.start, match.end).toLowerCase().includes(contains)),
        `${text} should include ${tag}: ${contains}; got ${matches.map((match) => `${match.rule.tag}:${text.slice(match.start, match.end)}`).join(", ")}`
      );
    }
  }
});

test("consolidated rules compile and preserve UTF-8-sensitive emoji patterns", () => {
  const payload = JSON.parse(fs.readFileSync(path.join(__dirname, "../highlighter/data/rules/consolidated_rules.json"), "utf8"));
  const rules = core.buildRules(payload.rules);
  const invalid = rules.filter((item) => !item.regex);
  const stopEmoji = rules.find((item) => item.name === "stop_emoji");

  assert.equal(rules.length, 411);
  assert.deepEqual(invalid, []);
  assert.ok(stopEmoji.pattern.includes("🛑"));
  assert.match("🛑", stopEmoji.regex);
});
