import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, "../highlighter/src/highlight/shortcutTelemetry.js"), "utf8");

function loadShortcutTelemetry() {
  const context = { globalThis: {} };
  vm.runInNewContext(source, context, { filename: "shortcutTelemetry.js" });
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

test("recognizes only trusted, non-repeating Shift+D/N/B/C keydowns", () => {
  const telemetry = loadShortcutTelemetry();
  for (const key of ["d", "D", "n", "N", "b", "B", "c", "C"]) {
    assert.equal(telemetry.normalizeShortcutEvent(keyEvent(key)), `Shift+${key.toUpperCase()}`);
  }

  assert.equal(telemetry.normalizeShortcutEvent(keyEvent("A")), null);
  assert.equal(telemetry.normalizeShortcutEvent(keyEvent("D", { shiftKey: false })), null);
  assert.equal(telemetry.normalizeShortcutEvent(keyEvent("D", { repeat: true })), null);
  assert.equal(telemetry.normalizeShortcutEvent(keyEvent("D", { isTrusted: false })), null);
});

test("allows extra modifiers and does not inspect the focused field", () => {
  const telemetry = loadShortcutTelemetry();
  assert.equal(telemetry.normalizeShortcutEvent(keyEvent("d", {
    ctrlKey: true,
    altKey: true,
    metaKey: true,
    target: { tagName: "TEXTAREA", isContentEditable: true }
  })), "Shift+D");
});

test("counts rendered logical rule highlights once, including off-screen highlights", () => {
  const telemetry = loadShortcutTelemetry();
  const elements = [
    highlight("multipart-1"),
    highlight("multipart-1"),
    highlight("offscreen-2"),
    highlight(null),
    highlight("hidden-layout", { hasLayout: false }),
    highlight("hidden-display", { display: "none" }),
    highlight("hidden-visibility", { visibility: "hidden" }),
    highlight("hidden-opacity", { opacity: "0" })
  ];
  const root = { querySelectorAll: (selector) => selector === ".amh-highlight" ? elements : [] };
  const view = { getComputedStyle: (element) => element.style };

  assert.equal(telemetry.countRenderedHighlightGroups(root, { view }), 3);
  assert.equal(telemetry.countRenderedHighlightGroups({ querySelectorAll: () => [] }, { view }), 0);
});

test("content listener logs bounded metadata without intercepting host keyboard behavior", () => {
  const contentSource = fs.readFileSync(path.join(__dirname, "../highlighter/content.js"), "utf8");
  assert.match(contentSource, /addEventListener\('keydown',[\s\S]*}, true\)/);
  assert.match(contentSource, /eventType: 'highlight_shortcut_pressed'/);
  assert.match(contentSource, /shortcut,\s*highlightCount/);
  assert.doesNotMatch(contentSource, /preventDefault\(|stopPropagation\(|stopImmediatePropagation\(/);
  assert.doesNotMatch(contentSource, /matchedText[\s\S]{0,120}highlight_shortcut_pressed/);
});
