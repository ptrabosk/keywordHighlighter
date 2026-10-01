import test from "node:test";
import assert from "node:assert/strict";

import { createChromeStub, createDom, dispatchRuntimeMessage, loadScripts, readExtensionFile, waitFor } from "./helpers/browser.js";

const manifest = JSON.parse(readExtensionFile("manifest.json"));
const CONTENT_SCRIPTS = manifest.content_scripts[0].js;
const REGISTRY = readExtensionFile("data/rules/opt_out_rules.json");
const HOT_TOPIC = "Hot Topic: reply 1 Same, 2 Weekly, 3 Monthly, 4 Never";

const PAGE = `
  <section><h1>CUSTOMER</h1></section>
  <div class="messages">
    <div data-speaker="Brand"><p class="variant-caption">${HOT_TOPIC}</p></div>
    <div class="msg type-INBOUND" data-message-id="m1"><p class="variant-caption">4</p></div>
    <div class="msg type-INBOUND" id="multi"><p class="variant-caption">customer service</p><p class="variant-caption">STOP</p></div>
    <div class="msg type-INBOUND" id="plain"><p class="variant-caption">hello there</p></div>
    <div class="brand-message"><p class="variant-caption">• Please respond immediately</p></div>
  </div>`;

function jsonResponse(body, { ok = true, status = 200 } = {}) {
  return { ok, status, text: async () => body };
}

async function startContentScript({ html = PAGE, sync = {}, fetchImpl, url } = {}) {
  const stub = createChromeStub({ sync });
  const dom = createDom(html, { chrome: stub.chrome, url });
  dom.window.fetch = fetchImpl || (async () => jsonResponse(REGISTRY));
  loadScripts(dom, CONTENT_SCRIPTS);
  return { stub, dom, window: dom.window, document: dom.window.document };
}

const isHighlighted = (element) => element.classList.contains("amh-message-highlight");
const highlightEvents = (stub) => stub.sent.filter((message) => message.event?.eventType === "highlight_detected");

test("highlights whole inbound messages by priority, Hot Topic replies, and notes", async () => {
  const { stub, document } = await startContentScript();
  const multi = document.querySelector("#multi");
  await waitFor(() => isHighlighted(multi));

  // "STOP" in the second paragraph outranks "customer service" in the first.
  assert.equal(multi.dataset.amhTooltipTitle, "Opt out");
  assert.equal(document.querySelector('[data-message-id="m1"]').dataset.amhTooltipTitle, "Opt out");
  assert.equal(isHighlighted(document.querySelector("#plain")), false);
  assert.equal(isHighlighted(document.querySelector('[data-speaker="Brand"]')), false, "brand prompts are never highlighted");
  assert.equal(document.querySelectorAll(".amh-escalation-highlight").length, 1);
  assert.equal(document.querySelector(".amh-highlight-count").textContent, "3");

  const events = highlightEvents(stub);
  assert.equal(events.length, 2);
  assert.ok(events.every((message) => message.event.pageUrl.startsWith("https://ui.attentivemobile.com/concierge/")));
});

test("re-renders on settings changes without re-logging highlights, and clears when disabled", async () => {
  const { stub, window, document } = await startContentScript();
  await waitFor(() => isHighlighted(document.querySelector("#multi")));
  const logged = highlightEvents(stub).length;

  await window.chrome.storage.sync.set({ amhSettings: { customKeywords: ["hello"] } });
  await waitFor(() => isHighlighted(document.querySelector("#plain")));
  assert.equal(document.querySelector("#plain").dataset.amhTooltipTitle, "User added");
  assert.equal(highlightEvents(stub).length, logged + 1, "only the newly highlighted message is logged");

  await window.chrome.storage.sync.set({ amhSettings: { enabled: false } });
  assert.equal(document.querySelectorAll(".amh-message-highlight, .amh-escalation-highlight, .amh-highlight-count").length, 0);
});

test("highlights messages added later through the mutation observer", async () => {
  const { document } = await startContentScript();
  await waitFor(() => isHighlighted(document.querySelector("#multi")));

  const added = document.createElement("div");
  added.className = "msg type-INBOUND";
  added.innerHTML = '<p class="variant-caption">wrong number</p>';
  document.querySelector(".messages").append(added);
  await waitFor(() => isHighlighted(added));
  assert.equal(added.dataset.amhTooltipTitle, "Opt out");
});

test("shows the category label on hover and un-hovers when moving between messages", async () => {
  const { window, document } = await startContentScript();
  const multi = document.querySelector("#multi");
  const hotTopic = document.querySelector('[data-message-id="m1"]');
  await waitFor(() => isHighlighted(multi));

  const hover = (type, target, relatedTarget = null) =>
    target.dispatchEvent(new window.MouseEvent(type, { bubbles: true, clientX: 5, clientY: 5, relatedTarget }));
  hover("mouseover", multi.querySelector("p"));
  const tooltip = document.querySelector(".amh-tooltip");
  assert.equal(tooltip.textContent, "Opt out");
  assert.equal(tooltip.dataset.visible, "true");
  hover("mousemove", multi);

  // Moving within the same message keeps it hovered.
  hover("mouseout", multi.querySelector("p"), multi);
  assert.ok(multi.classList.contains("amh-highlight--hover"));

  hover("mouseout", multi, hotTopic);
  assert.equal(multi.classList.contains("amh-highlight--hover"), false);
  assert.equal(tooltip.dataset.visible, "false");

  hover("mouseover", document.querySelector(".amh-escalation-highlight"));
  assert.equal(tooltip.textContent, "Escalation action");
});

test("answers stats and refresh requests from the popup", async () => {
  const { stub, document } = await startContentScript();
  await waitFor(() => isHighlighted(document.querySelector("#multi")));

  const stats = await dispatchRuntimeMessage(stub, { type: "AMH_GET_STATS" });
  assert.equal(stats.stats.loadedRules, 211);
  const refreshed = await dispatchRuntimeMessage(stub, { type: "AMH_REFRESH", settings: { customKeywords: ["hello"] } });
  assert.ok(refreshed.stats.highlightedElements >= 3);
  assert.equal(await dispatchRuntimeMessage(stub, { type: "OTHER" }), undefined);
  assert.equal(await dispatchRuntimeMessage(stub, null), undefined);
});

test("ignores synthetic shortcut keypresses", async () => {
  const { stub, window, document } = await startContentScript();
  await waitFor(() => isHighlighted(document.querySelector("#multi")));
  document.body.dispatchEvent(new window.KeyboardEvent("keydown", { key: "D", shiftKey: true, bubbles: true }));
  assert.equal(stub.sent.some((message) => message.event?.eventType === "highlight_shortcut_pressed"), false);
});

test("removes the badge outside the customer view and on unsupported pages", async () => {
  const noHeading = await startContentScript({ html: PAGE.replace("<h1>CUSTOMER</h1>", "<h1>OTHER</h1>") });
  await waitFor(() => isHighlighted(noHeading.document.querySelector("#multi")));
  assert.equal(noHeading.document.querySelector(".amh-highlight-count"), null);

  const otherPage = await startContentScript({ url: "https://ui.attentivemobile.com/settings" });
  await waitFor(() => isHighlighted(otherPage.document.querySelector("#multi")));
  assert.equal(otherPage.document.querySelector(".amh-highlight-count"), null);
});

test("reports rule-loading failures without highlighting", async () => {
  for (const fetchImpl of [
    async () => jsonResponse("", { ok: false, status: 404 }),
    async () => jsonResponse("<html>not json"),
    async () => { throw new Error("offline"); }
  ]) {
    const { stub, document } = await startContentScript({ fetchImpl });
    await waitFor(() => document.documentElement.dataset.amhInitError);
    assert.match(document.documentElement.dataset.amhInitError, /Rules load failed/);
    assert.ok(stub.sent.some((message) => message.event?.eventType === "rules_load_failed"));
    assert.equal(document.querySelectorAll(".amh-message-highlight").length, 0);
  }
});

test("falls back to defaults when settings cannot be read", async () => {
  const stub = createChromeStub();
  stub.chrome.storage.sync.get = async () => { throw new Error("sync unavailable"); };
  const dom = createDom(PAGE, { chrome: stub.chrome });
  dom.window.fetch = async () => jsonResponse(REGISTRY);
  loadScripts(dom, CONTENT_SCRIPTS);
  await waitFor(() => isHighlighted(dom.window.document.querySelector("#multi")));
  assert.ok(stub.sent.some((message) => message.event?.eventType === "settings_load_failed"));
});

test("logs page errors and unhandled rejections to the console with render state", async () => {
  const { window, document } = await startContentScript();
  await waitFor(() => isHighlighted(document.querySelector("#multi")));
  const warnings = [];
  window.console.warn = (...args) => warnings.push(args);

  window.dispatchEvent(new window.ErrorEvent("error", { message: "boom", error: new Error("boom"), filename: "page.js", lineno: 3, colno: 4 }));
  window.dispatchEvent(new window.ErrorEvent("error", {}));
  const rejection = new window.Event("unhandledrejection");
  rejection.reason = new Error("rejected");
  window.dispatchEvent(rejection);
  window.dispatchEvent(new window.Event("unhandledrejection"));

  assert.equal(warnings.length, 4);
  assert.equal(warnings[0][1].message, "boom");
  assert.equal(warnings[1][1].message, "unknown error");
  assert.equal(warnings[2][1].message, "rejected");
  assert.equal(warnings[3][1].message, "unknown rejection");
  assert.ok(warnings[0][1].highlighter.renders >= 1);
});
