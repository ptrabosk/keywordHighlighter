import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, "../google-apps-script/Code.gs"), "utf8");

function loadReceiver() {
  const context = vm.createContext({ console });
  vm.runInContext(source, context, { filename: "Code.gs" });
  return context;
}

test("receiver validates shortcut metadata as an exact two-field contract", () => {
  const receiver = loadReceiver();
  assert.equal(receiver.isValidShortcutMetadata_({ shortcut: "Shift+D", highlightCount: 1 }), true);
  assert.equal(receiver.isValidShortcutMetadata_({ shortcut: "Shift+C", highlightCount: 1000 }), true);
  assert.equal(receiver.isValidShortcutMetadata_({ shortcut: "Shift+A", highlightCount: 1 }), false);
  assert.equal(receiver.isValidShortcutMetadata_({ shortcut: "Shift+D", highlightCount: 0 }), false);
  assert.equal(receiver.isValidShortcutMetadata_({ shortcut: "Shift+D", highlightCount: 1, text: "no" }), false);
});

test("receiver uses the 17-column event schema without Page Host", () => {
  assert.doesNotMatch(source, /"Page Host"/);
  assert.match(source, /"Surface",\s*"Page URL",\s*"Profile Email"/);
  assert.match(source, /"Metadata JSON",\s*"Batch ID"/);
});

test("receiver enforces total and shortcut daily quotas independently", () => {
  const receiver = loadReceiver();
  const shortcut = { eventType: "highlight_shortcut_pressed" };
  const operational = { eventType: "rules_loaded" };

  const nearLimits = { day: "2026-08-14", total: 24999, shortcuts: 9999 };
  assert.equal(receiver.consumeQuota_(nearLimits, shortcut), true);
  assert.deepEqual(nearLimits, { day: "2026-08-14", total: 25000, shortcuts: 10000 });
  assert.equal(receiver.consumeQuota_(nearLimits, operational), false);

  const shortcutLimited = { day: "2026-08-14", total: 10000, shortcuts: 10000 };
  assert.equal(receiver.consumeQuota_(shortcutLimited, shortcut), false);
  assert.equal(receiver.consumeQuota_(shortcutLimited, operational), true);
});

test("retention row deletion groups contiguous rows and deletes from the bottom", () => {
  const receiver = loadReceiver();
  const calls = [];
  const sheet = { deleteRows: (start, count) => calls.push([start, count]) };
  receiver.deleteSheetRows_(sheet, [2, 3, 4, 8, 10, 11]);
  assert.deepEqual(calls, [[10, 2], [8, 1], [2, 3]]);
});
