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

function rule(overrides) {
  return {
    id: overrides.id || "",
    name: overrides.name || overrides.tag,
    tag: overrides.tag,
    action: overrides.action || overrides.tag,
    pattern: overrides.pattern,
    type: overrides.type || "",
    flags: overrides.flags || "i",
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

test("compiles procedural close detectors used by the demo site", () => {
  const settings = core.mergeSettings(defaults, {});
  const rules = [
    rule({ id: "rule_combined_single_letter_only", tag: "close", pattern: "single letter", matchScope: "procedural" }),
    rule({ id: "rule_combined_number_only", tag: "close", pattern: "number only", matchScope: "procedural" }),
    rule({ id: "rule_06d01f1a0e0b3885", tag: "close", pattern: "link only", matchScope: "procedural" }),
    rule({ id: "rule_14492eac781ac6da", tag: "fuzzy_opt_out", pattern: "subscription candidate", matchScope: "procedural" }),
    rule({ id: "rule_b25458937a65a761", tag: "opt_out", pattern: "under 13", matchScope: "procedural" }),
    rule({ id: "rule_combined_reaction_reply", tag: "close", pattern: "reaction reply", matchScope: "procedural" }),
    rule({ id: "rule_combined_unavailable_auto_reply", tag: "close", pattern: "unavailable auto reply", matchScope: "procedural" }),
    rule({ id: "rule_combined_device_not_working", tag: "opt_out", pattern: "device not working", matchScope: "procedural" }),
    rule({ id: "rule_combined_txt_origin_question", tag: "txt", pattern: "origin question", matchScope: "procedural" })
  ];

  assert.equal(core.collectMatches("x", [rules[0]], settings).length, 1);
  assert.equal(core.collectMatches("xy", [rules[0]], settings).length, 0);
  assert.equal(core.collectMatches("45", [rules[1]], settings).length, 1);
  assert.equal(core.collectMatches("45 please", [rules[1]], settings).length, 0);
  assert.equal(core.collectMatches("https://example.com", [rules[2]], settings).length, 1);
  assert.equal(core.collectMatches("see https://example.com", [rules[2]], settings).length, 0);
  assert.equal(core.collectMatches("Please cancel my subscription.", [rules[3]], settings).length, 1);
  assert.equal(core.collectMatches("I am 12 years old.", [rules[4]], settings).length, 1);
  assert.equal(core.collectMatches("I am 13 years old.", [rules[4]], settings).length, 0);
  assert.equal(core.collectMatches('Loved "Thanks for your order"', [rules[5]], settings).length, 1);
  assert.equal(core.collectMatches("Sorry can't talk now.", [rules[6]], settings).length, 1);
  assert.equal(core.collectMatches("Sorry, I can't talk right now.", [rules[6]], settings).length, 1);
  assert.equal(core.collectMatches("This phone number cannot receive text messages please call instead.", [rules[7]], settings).length, 1);
  assert.ok(
    core.collectMatches("Who is this and why are you texting me?", [rules[8]], settings)
      .some((match) => match.rule.tag === "txt")
  );
});

test("compiles inventory regex rules before applying whole-message checks", () => {
  const settings = core.mergeSettings(defaults, {});
  const notOptedIn = rule({
    id: "rule_317fdbf0a6758d04",
    tag: "opt_out",
    type: "regex",
    pattern: "(?:never|didnt)?\\s*(?:opted\\s+in|signed\\s+up|subscribed?)",
    matchScope: "full_normalized_message"
  });

  assert.equal(core.collectMatches("Never opted in.", [notOptedIn], settings).length, 1);
  assert.equal(core.collectMatches("Never opted in. Please stop texting me.", [notOptedIn], settings).length, 0);
});

test("normalizes deterministic browser examples back to raw highlight spans", () => {
  const payload = JSON.parse(fs.readFileSync(path.join(__dirname, "../highlighter/data/rules/opt_out_deterministic_rules.json"), "utf8"));
  const settings = core.mergeSettings(defaults, {});
  const activeRules = core.getActiveRules(core.buildRules(payload.rules), settings);

  const cases = [
    ["i'm", "close", "i'm"],
    [
      "Send this text to subscribe to recurring automated personalized marketing alerts e g cart reminders from darc sport ref f jgm.",
      "close",
      "Send this text to subscribe"
    ],
    [
      "Claim 5 free shein products now click the link to help and let’s both win big.",
      "close",
      "Claim 5 free shein products"
    ],
    [
      "Claim 5 free shein products now click the link to help and let?s both win big.",
      "close",
      "Claim 5 free shein products"
    ],
    ["I am in 1st grade.", "opt_out", "1st grade"],
    ["Sorry, I can't talk right now.", "close", "can't talk right now"],
    ["Sorry, I can?t talk right now.", "close", "can?t talk right now"]
  ];

  for (const [text, tag, contains] of cases) {
    const matches = core.collectMatches(text, activeRules, settings);
    assert.ok(
      matches.some((match) => match.rule.tag === tag && text.slice(match.start, match.end).includes(contains)),
      `${text} should include ${tag}: ${contains}; got ${matches.map((match) => `${match.rule.tag}:${text.slice(match.start, match.end)}`).join(", ")}`
    );
  }

  assert.deepEqual(core.collectMatches("Stop by my house after delivery.", activeRules, settings), []);
});

test("highlights normalized punctuation and generated demo examples", () => {
  const payload = JSON.parse(fs.readFileSync(path.join(__dirname, "../highlighter/data/rules/opt_out_deterministic_rules.json"), "utf8"));
  const settings = core.mergeSettings(defaults, {});
  const activeRules = core.getActiveRules(core.buildRules(payload.rules), settings);

  const cases = [
    ["Auto generated text I'll call you later.", "close", "Auto generated text I'll call you later"],
    ["Don't want your promo.", "fuzzy_opt_out", "Don't want your promo"],
    ["Never text me again.", "opt_out", "Never text me again"],
    ["Customer service?", "reply", "Customer service"],
    [
      "10 shein freebies and a 50 allowance for the lucky just click and claim-so easy.",
      "close",
      "10 shein freebies and a 50 allowance for the lucky just click and claim-so easy"
    ],
    [
      "Please if you don't do this right now, stop texting me.",
      "opt_out",
      "if you don't do this right now, stop texting me"
    ]
  ];

  for (const [text, tag, contains] of cases) {
    const matches = core.collectMatches(text, activeRules, settings);
    assert.ok(
      matches.some((match) => match.rule.tag === tag && text.slice(match.start, match.end).includes(contains)),
      `${text} should include ${tag}: ${contains}; got ${matches.map((match) => `${match.rule.tag}:${text.slice(match.start, match.end)}`).join(", ")}`
    );
  }

  assert.deepEqual(core.collectMatches("Can I get help with my order?", activeRules, settings), []);
  assert.deepEqual(core.collectMatches("thx", activeRules, settings), []);
});

test("ambiguous slash patterns do not compile to unintended standalone words", () => {
  const payload = JSON.parse(fs.readFileSync(path.join(__dirname, "../highlighter/data/rules/opt_out_deterministic_rules.json"), "utf8"));
  const settings = core.mergeSettings(defaults, {});
  const activeRules = core.getActiveRules(core.buildRules(payload.rules), settings);

  const exactCases = [
    ["please end", "rule_a7188c1cef1b83cf", "please end"],
    ["kindly end", "rule_a7188c1cef1b83cf", "kindly end"],
    ["end", "rule_35a64c97cf6b24d5", "end"],
    ["bring suit", "rule_5b5fa6c84e118a26", "bring suit"],
    ["file suit", "rule_5b5fa6c84e118a26", "file suit"],
    ["bring a suit", "rule_4ee373f27aba3ba5", "bring a suit"],
    ["file a suit", "rule_4ee373f27aba3ba5", "file a suit"],
    ["Don't send me any more texts.", "rule_9fab5a743c276ca4", "Don't send me any more texts"],
    ["Do not call me again.", "rule_9fab5a743c276ca4", "Do not call me again"],
    ["dont message", "rule_9fab5a743c276ca4", "dont message"],
    ["donot write anymore", "rule_9fab5a743c276ca4", "donot write anymore"]
  ];

  for (const [text, id, span] of exactCases) {
    const matches = core.collectMatches(text, activeRules, settings);
    assert.ok(
      matches.some((match) => match.rule.id === id && text.slice(match.start, match.end) === span),
      `${text} should match ${id}: ${span}; got ${matches.map((match) => `${match.rule.id}:${text.slice(match.start, match.end)}`).join(", ")}`
    );
  }

  for (const text of ["please", "kindly", "bring", "file", "Don't", "do not", "dont", "donot", "messages"]) {
    assert.deepEqual(core.collectMatches(text, activeRules, settings), [], `${text} should not match by itself`);
  }
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

test("deterministic rules resolve QA diagnostic phrases to their intended actions", () => {
  const payload = JSON.parse(fs.readFileSync(path.join(__dirname, "../highlighter/data/rules/opt_out_deterministic_rules.json"), "utf8"));
  const settings = core.mergeSettings(defaults, {});
  const activeRules = core.getActiveRules(core.buildRules(payload.rules), settings);

  const cases = [
    ["Please stop texting me and remove me from your list.", [
      ["opt_out", "stop"]
    ]],
    ["who is this", [["txt", "who is this"]]],
    ["i dont know you", [["txt", "i dont know you"]]],
    ["we are done here", [["fuzzy_opt_out", "done"]]],
    ["finished", [["opt_out", "finished"]]],
    ["pause", [["opt_out", "pause"]]],
    ["shush", [["opt_out", "shush"]]],
    ["subscribe", [["close", "subscribe"]]],
    ["Please cancel my subscription.", [["fuzzy_opt_out", "cancel my subscription"]]],
    ['Loved "Thanks for your order"', [["close", "loved"]]],
    ["Never opted in.", [["opt_out", "never opted in"]]],
    ["Sorry, I can't talk right now.", [["close", "can't talk right now"]]]
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

test("deterministic cleanup rules cover requested variants and exclusions", () => {
  const payload = JSON.parse(fs.readFileSync(path.join(__dirname, "../highlighter/data/rules/opt_out_deterministic_rules.json"), "utf8"));
  const settings = core.mergeSettings(defaults, {});
  const rules = core.buildRules(payload.rules);
  const rulesById = new Map(rules.map((item) => [item.id, item]));
  const activeRules = core.getActiveRules(rules, settings);

  for (const text of ["spam", "spams", "spammer", "spamming"]) {
    const matches = core.collectMatches(text, [rulesById.get("rule_fed4cc7912c2263a")], settings);
    assert.equal(matches.length, 1, `${text} should match spam variants`);
  }
  assert.equal(core.collectMatches("spamalot", [rulesById.get("rule_fed4cc7912c2263a")], settings).length, 0);

  for (const text of ["end", "ends", "ending.", "ended!"]) {
    assert.equal(core.collectMatches(text, [rulesById.get("rule_35a64c97cf6b24d5")], settings).length, 1);
  }
  assert.equal(core.collectMatches("the movie ending was good", [rulesById.get("rule_35a64c97cf6b24d5")], settings).length, 0);

  assert.equal(core.collectMatches("take my number off", [rulesById.get("rule_9ae98939ff042262")], settings).length, 1);
  for (const text of ["take me", "take this", "take this anymore"]) {
    assert.equal(core.collectMatches(text, activeRules, settings).some((match) => match.rule.id === "rule_9ae98939ff042262"), false);
  }

  assert.equal(core.collectMatches("This seems fraudulent.", [rulesById.get("rule_1ff20c8e5b17a76f")], settings).length, 1);

  for (const text of ["quit playing", "stop playing", "quit lying", "stop lying"]) {
    assert.equal(core.collectMatches(text, [rulesById.get("rule_28a16c51871d9e83")], settings).length, 1);
  }

  for (const text of ["finish", "finished", "finishes", "finishing"]) {
    assert.equal(core.collectMatches(text, [rulesById.get("rule_5ad2f8fb3c22229d")], settings).length, 1);
  }
  assert.equal(core.collectMatches("please finish this order", activeRules, settings).some((match) => match.rule.id === "rule_5ad2f8fb3c22229d"), false);

  for (const text of ["pause", "paused", "pausing"]) {
    assert.equal(core.collectMatches(text, [rulesById.get("rule_523de625170a42d4")], settings).length, 1);
  }
  assert.equal(core.collectMatches("pause my subscription", activeRules, settings).some((match) => match.rule.id === "rule_523de625170a42d4"), false);

  assert.equal(core.collectMatches("Customer support?", activeRules, settings).some((match) => match.rule.id === "rule_d71b14fc71ed188f"), true);
  assert.equal(core.collectMatches("do not spam", [rulesById.get("rule_fe8eca5e5e5ff867")], settings).length, 0);

  for (const removedId of ["rule_aaec757169b5d045", "rule_cf5d12213cf5b726", "rule_754d2c360b0b43fe", "rule_41434a27f4e64824"]) {
    assert.equal(rulesById.has(removedId), false);
  }
});

test("standalone remove phrases do not block longer list-removal phrases", () => {
  const payload = JSON.parse(fs.readFileSync(path.join(__dirname, "../highlighter/data/rules/opt_out_deterministic_rules.json"), "utf8"));
  const settings = core.mergeSettings(defaults, {});
  const rules = core.buildRules(payload.rules);
  const rulesById = new Map(rules.map((item) => [item.id, item]));
  const activeRules = core.getActiveRules(rules, settings);

  assert.equal(core.collectMatches("remove me", activeRules, settings).some((match) => match.rule.id === "rule_3a9dc0981448dafb"), true);
  assert.equal(core.collectMatches("please remove", activeRules, settings).some((match) => match.rule.id === "rule_26cc75d8805d262e"), true);

  for (const text of ["please remove me", "please remove me from your list", "can you remove me please"]) {
    const matches = core.collectMatches(text, activeRules, settings);
    assert.equal(matches.some((match) => match.rule.id === "rule_3a9dc0981448dafb"), false, `${text} should not match standalone remove me`);
    assert.equal(matches.some((match) => match.rule.id === "rule_26cc75d8805d262e"), false, `${text} should not match standalone please remove`);
  }

  for (const listType of ["email", "text", "message", "messaging", "mailing", "mail"]) {
    const text = `Please remove me from your ${listType} list today.`;
    const matches = core.collectMatches(text, activeRules, settings);
    assert.ok(
      matches.some((match) => match.rule.id === "rule_remove_me_from_your_contact_list" && text.slice(match.start, match.end) === `remove me from your ${listType} list`),
      `${text} should match the contact-list removal rule`
    );
  }

  assert.equal(
    core.collectMatches("remove me from your email list", [rulesById.get("rule_remove_me_from_your_contact_list")], settings).length,
    1
  );
});

test("explicit done rules are tagged with the test action", () => {
  const payload = JSON.parse(fs.readFileSync(path.join(__dirname, "../highlighter/data/rules/opt_out_deterministic_rules.json"), "utf8"));
  const rulesById = new Map(core.buildRules(payload.rules).map((item) => [item.id, item]));

  for (const ruleId of [
    "rule_cc5eeb5fc6b88c64",
    "rule_9f9f434d2cfc8890",
    "rule_83b3924cfc4fb214",
    "rule_7a4aabc615457dc9",
    "rule_157e140013fc23de"
  ]) {
    assert.equal(rulesById.get(ruleId)?.tag, "test", `${ruleId} should use the test action`);
  }
});

test("gratitude no-action rules are limited to whole-message thanks variants", () => {
  const payload = JSON.parse(fs.readFileSync(path.join(__dirname, "../highlighter/data/rules/opt_out_deterministic_rules.json"), "utf8"));
  const settings = core.mergeSettings(defaults, {});
  const rules = core.buildRules(payload.rules);
  const thanks = rules.find((item) => item.id === "rule_800d066d9f05282c");
  const thx = rules.find((item) => item.id === "rule_b8bbd9e58a1e6618");
  const thankU = rules.find((item) => item.id === "rule_51122d616562849e");
  const activeRules = core.getActiveRules(rules, {
    ...settings,
    categories: {
      ...settings.categories,
      no_action: { ...settings.categories.no_action, enabled: true }
    }
  });

  assert.equal(core.collectMatches("thanks", [thanks], settings).length, 1);
  assert.equal(core.collectMatches("thanks for your help", [thanks], settings).length, 0);
  assert.equal(core.collectMatches("thx", [thx], settings).length, 1);
  assert.equal(core.collectMatches("thx for the update", [thx], settings).length, 0);
  assert.equal(core.collectMatches("thank u", [thankU], settings).length, 1);
  assert.equal(core.collectMatches("thank u for checking", [thankU], settings).length, 0);
  assert.equal(activeRules.some((item) => item.tag === "no_action"), false);
});

test("deterministic rules compile highlightable entries and skip procedural detectors", () => {
  const payload = JSON.parse(fs.readFileSync(path.join(__dirname, "../highlighter/data/rules/opt_out_deterministic_rules.json"), "utf8"));
  const settings = core.mergeSettings(defaults, {});
  const rules = core.buildRules(payload.rules);
  const procedural = rules.find((item) => item.id === "rule_451c36fb9b91ee65");
  const optOutPhrase = rules.find((item) => item.pattern === "remove me");
  const optionalGroupRule = rules.find((item) => item.id === "rule_9a0a246dfc518c29");
  const curlyQuoteRule = rules.find((item) => item.id === "rule_6da31ef70e2d6310");

  assert.equal(rules.length, 388);
  assert.equal(procedural.regex, null);
  assert.equal(optOutPhrase.tag, "opt_out");
  assert.equal(core.collectMatches("remove me", [optOutPhrase], settings).length, 1);
  assert.equal(core.collectMatches("please remove me", [optOutPhrase], settings).length, 0);
  assert.equal(core.collectMatches("I dont want this", [optionalGroupRule], settings).length, 1);
  assert.equal(
    core.collectMatches(
      "Im not receiving notifications if this is urgent reply urgent to send a notification through with your original message",
      [curlyQuoteRule],
      settings
    ).length,
    1
  );
});

test("deterministic hover text file has editable title, text, and name entries", () => {
  const rulesPayload = JSON.parse(fs.readFileSync(path.join(__dirname, "../highlighter/data/rules/opt_out_deterministic_rules.json"), "utf8"));
  const hoverPayload = JSON.parse(fs.readFileSync(path.join(__dirname, "../highlighter/data/rules/rule_hover_text.json"), "utf8"));
  const firstRule = rulesPayload.rules[0];
  const firstHover = hoverPayload.by_rule_id[firstRule.id];

  assert.equal(firstHover.title, firstRule.action);
  assert.equal(firstHover.text, firstRule.condition_summary);
  assert.equal(firstHover.name, firstRule.name);
  assert.equal(hoverPayload.defaults.user_added.title, "user_added");
  assert.equal(hoverPayload.defaults.user_added.name, "{pattern}");
});
