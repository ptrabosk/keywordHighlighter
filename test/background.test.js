import test from "node:test";
import assert from "node:assert/strict";

import { createChromeStub, dispatchRuntimeMessage, waitFor } from "./helpers/browser.js";

// background.js registers its listeners on import, so install the Chrome
// stub first. Each test file runs in its own process.
const stub = createChromeStub();
globalThis.chrome = stub.chrome;
globalThis.fetch = undefined;
const { LOGGING_CONFIG } = await import("../highlighter/src/logging/config.js");
await import("../highlighter/background.js");
const originalConfig = { ...LOGGING_CONFIG };
const send = (message) => dispatchRuntimeMessage(stub, message);

test("initializes default settings and the logging session", async () => {
  await waitFor(() => stub.stores.sync.amhSettings);
  assert.deepEqual(stub.stores.sync.amhSettings.customKeywords, []);
  await waitFor(() => stub.stores.local.activeSession);

  for (const listener of stub.listeners.installed) await listener();
  assert.ok(stub.stores.sync.amhSettings, "existing settings are kept");
});

test("queues logged events and failures from extension pages", async () => {
  assert.deepEqual(await send({ type: "highlighter:logEvent", event: { eventType: "rules_loaded", severity: "info", result: "success", surface: "content" } }), { ok: true });
  assert.deepEqual(await send({ type: "highlighter:logFailure", eventType: "render_failed", errorCode: "RENDER_FAILED", errorMessage: "boom", metadata: { operation: "render" } }), { ok: true });
  assert.deepEqual(await send({ type: "logging:event", event: { eventType: "render_failed", severity: "error", result: "failure", surface: "content" } }), { ok: true });
  assert.deepEqual(await send({ type: "logging:event" }), { ok: true });
  assert.deepEqual(await send({ type: "logging:uploadRequested", reason: "manual" }), { ok: true });
  assert.deepEqual(await send({ type: "logging:uploadRequested" }), { ok: true });
  assert.equal(await send({ type: "unknown" }), undefined);
  assert.equal(await send(null), undefined);
});

test("reports logging diagnostics for unconfigured, configured, and malformed endpoints", async () => {
  const unconfigured = await send({ type: "highlighter:getDiagnostics" });
  assert.equal(unconfigured.ok, true);
  assert.equal(unconfigured.diagnostics.loggingConfig.configured, false);

  Object.assign(LOGGING_CONFIG, { endpointUrl: "https://script.google.com/macros/s/abc/exec", apiKey: "k".repeat(32) });
  globalThis.fetch = async () => ({ ok: false, status: 500, json: async () => ({}) });
  const configured = await send({ type: "highlighter:runDiagnosticsUpload" });
  assert.equal(configured.diagnostics.loggingConfig.configured, true);
  assert.equal(configured.diagnostics.loggingConfig.endpointHost, "script.google.com");

  Object.assign(LOGGING_CONFIG, { endpointUrl: "not a url" });
  const malformed = await send({ type: "highlighter:getDiagnostics" });
  assert.equal(malformed.diagnostics.loggingConfig.endpointHost, "");

  Object.assign(LOGGING_CONFIG, { endpointUrl: "", apiKey: "" });
  assert.equal((await send({ type: "highlighter:getDiagnostics" })).diagnostics.loggingConfig.configured, false);
  Object.assign(LOGGING_CONFIG, originalConfig);
  globalThis.fetch = undefined;
});

test("runs uploads on the alarm and ends the session on suspend", async () => {
  for (const listener of stub.listeners.alarm) {
    listener({ name: "keywordHighlighterLogUpload" });
    listener({ name: "other" });
  }
  for (const listener of stub.listeners.suspend) listener();
  await waitFor(() => stub.stores.local.uploadStatus);
});

test("answers with a fallback when storage fails", async () => {
  const originalGet = stub.chrome.storage.local.get;
  stub.chrome.storage.local.get = async () => { throw new Error("storage down"); };
  assert.deepEqual(await send({ type: "highlighter:getDiagnostics" }), { ok: false });
  stub.chrome.storage.local.get = originalGet;

  const originalSyncGet = stub.chrome.storage.sync.get;
  stub.chrome.storage.sync.get = async () => { throw new Error("sync down"); };
  for (const listener of stub.listeners.installed) await listener();
  stub.chrome.storage.sync.get = originalSyncGet;
});
