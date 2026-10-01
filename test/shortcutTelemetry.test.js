import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, "../highlighter/src/highlight/shortcutTelemetry.js");
// The file URL lets coverage tools attribute this vm-run script to its source.
const sourceUrl = pathToFileURL(sourcePath).href;
const source = fs.readFileSync(sourcePath, "utf8");

function loadShortcutTelemetry() {
  const context = { globalThis: {} };
  vm.runInNewContext(source, context, { filename: sourceUrl });
  return context.globalThis.AMH_SHORTCUT_TELEMETRY;
}

function keyEvent(key, overrides = {}) {
  return {
    key,
    isTrusted: true,
    shiftKey: true,
    repeat: false,
    ...overrides
  };
}

function highlight(groupId, options = {}) {
  return {
    dataset: groupId ? { amhMatchGroupId: groupId } : {},
    getClientRects: () => options.hasLayout === false ? [] : [{}],
    style: {
      display: options.display || "inline",
      visibility: options.visibility || "visible",
      opacity: options.opacity ?? "1"
    }
  };
}

test("recognizes only trusted, non-repeating Shift+D/N/B/C/E keydowns", () => {
  const telemetry = loadShortcutTelemetry();
  for (const key of ["d", "D", "n", "N", "b", "B", "c", "C", "e", "E"]) {
    assert.equal(telemetry.normalizeShortcutEvent(keyEvent(key)), `Shift+${key.toUpperCase()}`);
  }

  assert.equal(telemetry.normalizeShortcutEvent(keyEvent("A")), null);
  assert.equal(telemetry.normalizeShortcutEvent(keyEvent("D", { shiftKey: false })), null);
  assert.equal(telemetry.normalizeShortcutEvent(keyEvent("D", { repeat: true })), null);
  assert.equal(telemetry.normalizeShortcutEvent(keyEvent("D", { isTrusted: false })), null);
});

test("rejects extra modifiers and ignores editable fields", () => {
  const telemetry = loadShortcutTelemetry();
  assert.equal(telemetry.normalizeShortcutEvent(keyEvent("d", {
    ctrlKey: true,
    altKey: true,
    metaKey: true,
  })), null);

  for (const target of [
    { tagName: "INPUT" },
    { tagName: "TEXTAREA" },
    { isContentEditable: true },
    { closest: () => ({}) }
  ]) {
    assert.equal(telemetry.normalizeShortcutEvent(keyEvent("d", { target })), null);
  }
});

test("counts rendered message highlights, including off-screen ones, and skips hidden ones", () => {
  const telemetry = loadShortcutTelemetry();
  const messages = [
    highlight(null),
    highlight(null),
    highlight(null, { hasLayout: false }),
    highlight(null, { display: "none" }),
    highlight(null, { visibility: "hidden" }),
    highlight(null, { opacity: "0" })
  ];
  const root = { querySelectorAll: (selector) => selector === ".amh-message-highlight" ? messages : [] };
  const view = { getComputedStyle: (element) => element.style };

  assert.equal(telemetry.countRenderedHighlightGroups(root, { view }), 2);
  assert.equal(telemetry.countRenderedHighlightGroups({ querySelectorAll: () => [] }, { view }), 0);
});

test("counts highlighted messages and escalation notes together", () => {
  const telemetry = loadShortcutTelemetry();
  const bySelector = {
    ".amh-message-highlight": [highlight(null), highlight(null, { display: "none" })],
    ".amh-escalation-highlight": [highlight(null), highlight(null)],
    ".amh-highlight": [highlight(null)]
  };
  const root = { querySelectorAll: (selector) => bySelector[selector] || [] };
  const view = { getComputedStyle: (element) => element.style };

  // Legacy in-text spans are no longer rendered, so they are not counted.
  assert.equal(telemetry.countRenderedHighlightGroups(root, { view }), 3);
});

test("content listener logs bounded metadata without intercepting host keyboard behavior", () => {
  const contentSource = fs.readFileSync(path.join(__dirname, "../highlighter/content.js"), "utf8");
  assert.match(contentSource, /addEventListener\('keydown',[\s\S]*}, true\)/);
  assert.match(contentSource, /eventType: 'highlight_shortcut_pressed'/);
  assert.match(contentSource, /shortcut,\s*highlightCount/);
  assert.doesNotMatch(contentSource, /preventDefault\(|stopPropagation\(|stopImmediatePropagation\(/);
  assert.doesNotMatch(contentSource, /matchedText[\s\S]{0,120}highlight_shortcut_pressed/);
});
