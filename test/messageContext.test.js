import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath, pathToFileURL } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const sourcePath = path.join(__dirname, "../highlighter/src/content/messageContext.js");
// The file URL lets coverage tools attribute this vm-run script to its source.
const sourceUrl = pathToFileURL(sourcePath).href;
const source = fs.readFileSync(sourcePath, "utf8");

function loadMessageContext() {
  const context = { globalThis: {} };
  vm.runInNewContext(source, context, { filename: sourceUrl });
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

// Fake nodes for isRelevantMutation. The extension selector is recognized by
// its ".amh-tooltip" part; anything else is the message-content selector.
const isExtensionSelector = (selector) => selector.includes(".amh-tooltip");
function element({ inContent = false, inExtension = false, isContent = false, isExtension = false, containsContent = false } = {}) {
  return {
    nodeType: 1,
    parentElement: null,
    closest: (selector) => ((isExtensionSelector(selector) ? inExtension || isExtension : inContent || isContent) ? {} : null),
    matches: (selector) => (isExtensionSelector(selector) ? isExtension : isContent),
    querySelector: (selector) => (!isExtensionSelector(selector) && containsContent ? {} : null)
  };
}
const textNode = (nodeValue, parentElement = null) => ({ nodeType: 3, nodeValue, parentElement });
const childList = (target, addedNodes = [], removedNodes = []) => ({ type: "childList", target, addedNodes, removedNodes });

test("text edits count only inside message content", () => {
  const { isRelevantMutation } = loadMessageContext();
  assert.equal(isRelevantMutation({ type: "characterData", target: textNode("hi", element({ inContent: true })) }), true);
  assert.equal(isRelevantMutation({ type: "characterData", target: textNode("hi", element()) }), false);
  assert.equal(isRelevantMutation({ type: "characterData", target: textNode("hi", null) }), false);
});

test("added or removed nodes count when they touch message content", () => {
  const { isRelevantMutation } = loadMessageContext();
  const content = element({ inContent: true });
  assert.equal(isRelevantMutation(childList(content, [textNode("new reply")])), true);
  assert.equal(isRelevantMutation(childList(content, [textNode("   ")])), false);
  assert.equal(isRelevantMutation(childList(content, [], [element()])), true, "removed from content");
  assert.equal(isRelevantMutation(childList(element(), [element({ containsContent: true })])), true, "new message list");
  assert.equal(isRelevantMutation(childList(element(), [element({ isContent: true })])), true);
  assert.equal(isRelevantMutation(childList(element(), [element()])), false, "unrelated page change");
  assert.equal(isRelevantMutation(childList(element(), [{ nodeType: 8 }])), false, "comment node");
});

test("the extension's own DOM changes are ignored", () => {
  const { isRelevantMutation } = loadMessageContext();
  const content = element({ inContent: true });
  assert.equal(isRelevantMutation(childList(content, [element({ isExtension: true })], [textNode("STOP")])), false);
  assert.equal(isRelevantMutation(childList(element({ inExtension: true }), [textNode("label")])), false);
});
