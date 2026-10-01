import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, "../highlighter/src/content/messageContext.js"), "utf8");

function loadMessageContext() {
  const context = { globalThis: {} };
  vm.runInNewContext(source, context, { filename: "messageContext.js" });
  return context.globalThis.AMH_MESSAGE_CONTEXT;
}

// Builds a flat conversation of fake elements in document order. `scoped`
// controls whether the inbound message finds a `[class*="messages"]` container
// via closest(), or has to fall back to walking parentElement.
function conversation(items, { scoped = true } = {}) {
  const { BRAND_MESSAGE_SELECTOR } = loadMessageContext();
  const container = { nodeType: 1, parentElement: null, closest: () => null };
  const nodes = items.map(([kind, text], index) => ({
    kind,
    index,
    nodeType: 1,
    textContent: text,
    parentElement: container,
    compareDocumentPosition(other) {
      return other.index > this.index ? 4 : 2;
    },
    closest(selector) {
      return scoped && selector.includes('[class*="messages"]') ? container : null;
    }
  }));
  container.querySelectorAll = (selector) =>
    selector === BRAND_MESSAGE_SELECTOR ? nodes.filter((node) => node.kind === "brand") : [];
  return nodes;
}

test("returns the most recent brand messages before the inbound message", () => {
  const { getRecentBrandMessageTexts } = loadMessageContext();
  const nodes = conversation([
    ["brand", "one"],
    ["brand", "two"],
    ["brand", "three"],
    ["brand", "four"],
    ["inbound", "4"],
    ["brand", "after"]
  ]);
  assert.deepEqual(Array.from(getRecentBrandMessageTexts(nodes[4], 3)), ["two", "three", "four"]);
});

test("ignores brand messages that come after or are empty", () => {
  const { getRecentBrandMessageTexts } = loadMessageContext();
  const nodes = conversation([
    ["inbound", "4"],
    ["brand", "later"],
    ["brand", ""]
  ]);
  assert.deepEqual(Array.from(getRecentBrandMessageTexts(nodes[0], 3)), []);
});

test("falls back to ancestors when no conversation container matches", () => {
  const { getRecentBrandMessageTexts } = loadMessageContext();
  const nodes = conversation([
    ["brand", "prompt"],
    ["inbound", "2"]
  ], { scoped: false });
  assert.deepEqual(Array.from(getRecentBrandMessageTexts(nodes[1], 3)), ["prompt"]);
});
