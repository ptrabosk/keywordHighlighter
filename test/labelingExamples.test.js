import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import '../highlighter/settings.js';
import '../highlighter/src/highlight/core.js';
import { exampleMatchesRule, ruleFingerprint } from '../scripts/labeling-example-utils.mjs';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const core = globalThis.AMH_HIGHLIGHT_CORE;
const settings = core.mergeSettings(globalThis.DEFAULT_SETTINGS, {});
const rulesPayload = JSON.parse(fs.readFileSync(path.join(__dirname, '../highlighter/data/rules/opt_out_deterministic_rules.json'), 'utf8'));
const examples = JSON.parse(fs.readFileSync(path.join(__dirname, '../labeling-site/rule_examples.json'), 'utf8'));
const rules = Array.isArray(rulesPayload.rules) ? rulesPayload.rules : core.flattenRules(rulesPayload.rules);
const builtRulesById = new Map(core.buildRules(rulesPayload.rules).map((rule) => [rule.id, rule]));

function matches(rule, entry, field) {
  return exampleMatchesRule({
    core,
    settings,
    rule,
    builtRule: builtRulesById.get(rule.id),
    example: {
      customerMessage: entry[field],
      brandMessage: entry.brandMessage || ''
    }
  });
}

test('labeling examples cover every deterministic inventory rule exactly once', () => {
  const expectedIds = rules.map((rule) => rule.id).sort();
  const actualIds = Object.keys(examples).sort();
  assert.deepEqual(actualIds, expectedIds);
});

test('labeling examples are fresh and match only their intended polarity', () => {
  for (const rule of rules) {
    const entry = examples[rule.id];
    assert.equal(entry.ruleName, rule.name, `${rule.id} should reference the current rule name`);
    assert.equal(entry.patternHash, ruleFingerprint(rule), `${rule.id} should reference the current rule pattern hash`);
    assert.equal(typeof entry.caught, 'string', `${rule.id} should have one caught string`);
    assert.equal(typeof entry.notCaught, 'string', `${rule.id} should have one notCaught string`);
    assert.ok(entry.caught.trim(), `${rule.id} caught example should not be blank`);
    assert.ok(entry.notCaught.trim(), `${rule.id} notCaught example should not be blank`);
    assert.equal(matches(rule, entry, 'caught'), true, `${rule.id} should catch: ${entry.caught}`);
    assert.equal(matches(rule, entry, 'notCaught'), false, `${rule.id} should not catch: ${entry.notCaught}`);
  }
});

test('under-13 labeling examples use the requested caught and not-caught shape', () => {
  const rule = rules.find((item) => item.id === 'rule_b25458937a65a761');
  const entry = examples.rule_b25458937a65a761;

  assert.equal(entry.caught, 'I am three');
  assert.equal(entry.notCaught, 'i am a girl');
  assert.equal(matches(rule, entry, 'caught'), true);
  assert.equal(matches(rule, entry, 'notCaught'), false);
});
