import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { LOGGING_CONFIG } from "../highlighter/src/logging/config.js";
import { logEvent } from "../highlighter/src/logging/logger.js";
import { pruneLogs } from "../highlighter/src/logging/prune.js";
import { buildFailureStatus, nextRetryTimestamp, shouldRetry } from "../highlighter/src/logging/retry.js";
import { sanitizeEvent } from "../highlighter/src/logging/sanitize.js";
import { endSession, startSession } from "../highlighter/src/logging/session.js";
import {
  enqueueEvent,
  getQueueStats,
  getUploadStatus,
  loadAllChunks,
  removeEventsById,
  restoreUploadingEvents,
  selectUploadBatch,
  storageGet,
  storageSet
} from "../highlighter/src/logging/storageQueue.js";
import { uploadPendingLogs } from "../highlighter/src/logging/uploader.js";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const originalConfig = { ...LOGGING_CONFIG };

function createChromeMock() {
  const store = {};
  const alarmListeners = [];
  const messages = [];
  let failSetCount = 0;

  return {
    store,
    messages,
    failNextSet() {
      failSetCount += 1;
    },
    api: {
      runtime: {
        getManifest: () => ({ version: "1.0.0" }),
        sendMessage: async (message) => {
          messages.push(message);
        },
        onMessage: {
          addListener: () => {}
        }
      },
      alarms: {
        create: async () => {},
        onAlarm: {
          addListener: (listener) => alarmListeners.push(listener)
        }
      },
      storage: {
        local: {
          async get(keys) {
            if (keys === null || keys === undefined) return { ...store };
            if (typeof keys === "string") return { [keys]: store[keys] };
            if (Array.isArray(keys)) {
              return Object.fromEntries(keys.map((key) => [key, store[key]]));
            }
            return Object.fromEntries(Object.keys(keys).map((key) => [key, store[key] ?? keys[key]]));
          },
          async set(items) {
            if (failSetCount > 0) {
              failSetCount -= 1;
              throw new Error("quota");
            }
            Object.assign(store, JSON.parse(JSON.stringify(items)));
          },
          async remove(keys) {
            const list = Array.isArray(keys) ? keys : [keys];
            for (const key of list) delete store[key];
          }
        }
      }
    }
  };
}

function resetEnvironment() {
  const chromeMock = createChromeMock();
  globalThis.chrome = chromeMock.api;
  globalThis.fetch = undefined;
  delete globalThis.window;
  Object.assign(LOGGING_CONFIG, originalConfig, {
    enabled: true,
    endpointUrl: "REPLACE_WITH_APPS_SCRIPT_EXEC_URL",
    apiKey: "REPLACE_WITH_LOCAL_API_KEY"
  });
  return chromeMock;
}

function event(overrides = {}) {
  return sanitizeEvent({
    sessionId: "session-1",
    eventType: "content_initialized",
    severity: "info",
    result: "success",
    ...overrides
  });
}

test("sanitizes events with allowlisted metadata, truncation, version, and byte enforcement", () => {
  resetEnvironment();
  const sanitized = sanitizeEvent({
    sessionId: "session-1",
    eventType: "unexpected-event",
    severity: "loud",
    result: "success",
    surface: "content",
    pageHost: "ui.attentivemobile.com",
    ruleSource: "consolidated_rules",
    metadata: {
      operation: "x".repeat(150),
      ignored: "drop-me",
      httpStatus: 500
    },
    errorMessage: `Problem at https://example.com/path?token=secret ${"y".repeat(300)}`
  });

  assert.equal(sanitized.eventType, "unexpected_exception");
  assert.equal(sanitized.severity, "info");
  assert.equal(sanitized.extensionVersion, "1.0.0");
  assert.equal(sanitized.surface, "content");
  assert.equal(sanitized.pageHost, "ui.attentivemobile.com");
  assert.equal(sanitized.ruleSource, "consolidated_rules");
  assert.equal(sanitized.metadata.operation.length, 100);
  assert.equal(sanitized.metadata.ignored, undefined);
  assert.equal(sanitized.errorMessage.includes("https://"), false);

  const large = sanitizeEvent({
    sessionId: "session-1",
    eventType: "unexpected_exception",
    severity: "error",
    result: "failure",
    metadata: { operation: "x".repeat(10_000) },
    errorMessage: "z".repeat(10_000)
  });
  assert.ok(JSON.stringify(large).length < 4096);
});

test("committed logging config contains placeholders and local override example is available", () => {
  const configSource = fs.readFileSync(path.join(__dirname, "../highlighter/src/logging/config.js"), "utf8");
  const localExampleSource = fs.readFileSync(path.join(__dirname, "../highlighter/src/logging/config.local.example.js"), "utf8");
  const gitignoreSource = fs.readFileSync(path.join(__dirname, "../.gitignore"), "utf8");

  assert.match(configSource, /REPLACE_WITH_APPS_SCRIPT_EXEC_URL/);
  assert.match(configSource, /REPLACE_WITH_LOCAL_API_KEY/);
  assert.doesNotMatch(configSource, /script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec/);
  assert.match(localExampleSource, /YOUR_DEPLOYMENT_ID/);
  assert.match(gitignoreSource, /highlighter\/src\/logging\/config\.local\.js/);
});

test("redacts sensitive strings from error messages", () => {
  resetEnvironment();
  const sanitized = sanitizeEvent({
    sessionId: "session-1",
    eventType: "unexpected_exception",
    severity: "error",
    result: "failure",
    errorMessage: "Failed for jane@example.com with Bearer abc.def token=secret customer id CUST-12345 at file.js:10:20 https://example.com?a=b"
  });

  assert.equal(sanitized.errorMessage.includes("jane@example.com"), false);
  assert.equal(sanitized.errorMessage.includes("abc.def"), false);
  assert.equal(sanitized.errorMessage.includes("secret"), false);
  assert.equal(sanitized.errorMessage.includes("CUST-12345"), false);
  assert.equal(sanitized.errorMessage.includes("https://"), false);
});

test("popup logging proxies sanitized events to the service worker without local queue writes", async () => {
  const chromeMock = resetEnvironment();
  globalThis.window = {};
  let proxiedMessage = null;
  globalThis.chrome.runtime.sendMessage = async (message) => {
    proxiedMessage = message;
    return { ok: true };
  };

  const ok = await logEvent({
    sessionId: "session-1",
    eventType: "content_initialized",
    severity: "info",
    result: "success",
    metadata: { operation: "render", ignored: "drop-me" }
  });

  assert.equal(ok, true);
  assert.equal(proxiedMessage.type, "logging:event");
  assert.equal(proxiedMessage.event.metadata.operation, "render");
  assert.equal(proxiedMessage.event.metadata.ignored, undefined);
  assert.equal(chromeMock.store.logChunk_000001, undefined);
});

test("creates chunked queue storage and rolls over after 200 events", async () => {
  resetEnvironment();
  for (let index = 0; index < 201; index += 1) {
    await enqueueEvent(event({ eventId: `event-${index}` }));
  }

  const chunks = await loadAllChunks();
  const stats = await getQueueStats();
  assert.equal(chunks.length, 2);
  assert.equal(chunks[0].chunk.events.length, 200);
  assert.equal(chunks[1].chunk.events.length, 1);
  assert.equal(stats.pendingCount, 201);
  assert.ok(stats.estimatedBytes > 0);
});

test("selects oldest pending batch, marks uploading, and respects limits", async () => {
  resetEnvironment();
  for (let index = 0; index < 5; index += 1) {
    await enqueueEvent(event({ eventId: `event-${index}`, timestamp: new Date(2026, 0, index + 1).toISOString() }));
  }

  const batch = await selectUploadBatch("batch-1", { maxEvents: 3, maxBytes: 500_000 });
  assert.deepEqual(batch.map((item) => item.eventId), ["event-0", "event-1", "event-2"]);
  assert.equal(batch.every((item) => item.uploadState === "uploading" && item.uploadAttempts === 1), true);

  const stats = await getQueueStats();
  assert.equal(stats.pendingCount, 2);
  assert.equal(stats.uploadingCount, 3);
});

test("removes accepted and rejected events without failing on duplicate acknowledgements", async () => {
  resetEnvironment();
  await enqueueEvent(event({ eventId: "accepted-1" }));
  await enqueueEvent(event({ eventId: "rejected-1" }));
  await removeEventsById(["accepted-1", "accepted-1", "rejected-1"]);

  const stats = await getQueueStats();
  assert.equal(stats.eventCount, 0);
});

test("uploads batches, removes acknowledgements, handles malformed responses, and restores failures", async () => {
  resetEnvironment();
  Object.assign(LOGGING_CONFIG, {
    endpointUrl: "https://script.google.com/macros/s/test/exec",
    apiKey: "local-key"
  });

  await enqueueEvent(event({ eventId: "accepted-1" }));
  await enqueueEvent(event({ eventId: "rejected-1" }));
  globalThis.fetch = async () => ({
    ok: true,
    json: async () => ({
      success: true,
      batchId: "not-the-generated-batch",
      acceptedEventIds: []
    })
  });

  const bad = await uploadPendingLogs("test");
  assert.equal(bad.uploaded, false);
  assert.equal((await getQueueStats()).pendingCount, 3);

  globalThis.fetch = async (_url, request) => {
    const body = JSON.parse(request.body);
    return {
      ok: true,
      json: async () => ({
        success: true,
        batchId: body.batchId,
        acceptedEventIds: ["accepted-1"],
        rejected: [{ eventId: "rejected-1", reason: "INVALID_SCHEMA" }]
      })
    };
  };

  const statusBefore = await storageGet("uploadStatus");
  assert.ok(statusBefore.uploadStatus.nextRetryAt);
  await storageSet({ uploadStatus: { consecutiveFailures: 0 } });
  const good = await uploadPendingLogs("test");
  assert.equal(good.uploaded, true);
  assert.equal((await getQueueStats()).eventCount, 1);
});

test("retry timing backs off, gates retries, and resets after success status updates", () => {
  const now = new Date("2026-07-19T12:00:00.000Z");
  assert.equal(nextRetryTimestamp(1, now, () => 0), "2026-07-19T12:05:00.000Z");
  assert.equal(nextRetryTimestamp(5, now, () => 0), "2026-07-19T16:00:00.000Z");
  assert.equal(shouldRetry({ nextRetryAt: "2026-07-19T12:01:00.000Z" }, now), false);
  assert.equal(shouldRetry({ nextRetryAt: "2026-07-19T11:59:00.000Z" }, now), true);
  assert.equal(shouldRetry({ blockedUntilConfigurationChange: true }, now), false);
  assert.equal(buildFailureStatus({ consecutiveFailures: 1 }, "UPLOAD_NETWORK_FAILED", now).consecutiveFailures, 2);
  assert.equal(buildFailureStatus({ consecutiveFailures: 1 }, "UPLOAD_UNAUTHORIZED", now).blockedUntilConfigurationChange, true);
});

test("permanent upload failures block recurring retries until config changes or diagnostics run", async () => {
  resetEnvironment();
  Object.assign(LOGGING_CONFIG, {
    endpointUrl: "https://script.google.com/macros/s/test/exec",
    apiKey: "local-key"
  });
  await enqueueEvent(event({ eventId: "blocked-1" }));
  globalThis.fetch = async () => ({ ok: false, status: 401, json: async () => ({}) });

  const first = await uploadPendingLogs("alarm");
  assert.equal(first.errorCode, "UPLOAD_UNAUTHORIZED");
  assert.equal((await getUploadStatus()).blockedUntilConfigurationChange, true);

  let fetchCount = 0;
  globalThis.fetch = async () => {
    fetchCount += 1;
    return { ok: true, json: async () => ({}) };
  };
  const blocked = await uploadPendingLogs("alarm");
  assert.equal(blocked.reason, "backoff_active");
  assert.equal(fetchCount, 0);

  Object.assign(LOGGING_CONFIG, { apiKey: "local-key-rotated" });
  globalThis.fetch = async (_url, request) => {
    fetchCount += 1;
    const body = JSON.parse(request.body);
    return {
      ok: true,
      json: async () => ({ success: true, batchId: body.batchId, acceptedEventIds: ["blocked-1"] })
    };
  };
  const recovered = await uploadPendingLogs("alarm");
  assert.equal(recovered.uploaded, true);
  assert.equal((await getUploadStatus()).blockedUntilConfigurationChange, undefined);
});

test("example local config placeholders are treated as not configured", async () => {
  resetEnvironment();
  Object.assign(LOGGING_CONFIG, {
    endpointUrl: "https://script.google.com/macros/s/YOUR_DEPLOYMENT_ID/exec",
    apiKey: "REPLACE_WITH_LOCAL_API_KEY"
  });
  await enqueueEvent(event({ eventId: "placeholder-1" }));

  let fetchCalled = false;
  globalThis.fetch = async () => {
    fetchCalled = true;
    return { ok: true, json: async () => ({}) };
  };

  const result = await uploadPendingLogs("alarm");
  assert.equal(result.reason, "not_configured");
  assert.equal(fetchCalled, false);
  assert.equal((await getUploadStatus()).blockedUntilConfigurationChange, true);
});

test("detects abandoned sessions and records a replacement session", async () => {
  resetEnvironment();
  await storageSet({
    activeSession: {
      sessionId: "old-session",
      startedAt: "2026-07-19T10:00:00.000Z",
      lastActivityAt: "2026-07-19T10:00:00.000Z",
      surface: "content",
      lastStepId: "step-1",
      lastStepIndex: 1
    }
  });

  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-07-19T11:00:00.000Z");
  try {
    const session = await startSession();
    assert.notEqual(session.sessionId, "old-session");
  } finally {
    Date.now = originalNow;
  }

  const chunks = await loadAllChunks();
  const types = chunks.flatMap((chunk) => chunk.chunk.events.map((item) => item.eventType));
  assert.deepEqual(types, ["session_abandoned", "session_started"]);
});

test("ended sessions are cleared and are not later marked abandoned", async () => {
  resetEnvironment();
  await storageSet({
    activeSession: {
      sessionId: "old-session",
      startedAt: "2026-07-19T10:00:00.000Z",
      lastActivityAt: "2026-07-19T10:00:00.000Z"
    }
  });

  await endSession("success");
  assert.equal((await storageGet("activeSession")).activeSession, undefined);

  const originalNow = Date.now;
  Date.now = () => Date.parse("2026-07-19T11:00:00.000Z");
  try {
    await startSession();
  } finally {
    Date.now = originalNow;
  }

  const types = (await loadAllChunks()).flatMap((chunk) => chunk.chunk.events.map((item) => item.eventType));
  assert.deepEqual(types, ["session_ended", "session_started"]);
});

test("service worker restart restores uploading events to pending", async () => {
  resetEnvironment();
  await enqueueEvent(event({ eventId: "restart-1" }));
  const batch = await selectUploadBatch("batch-restart", { maxEvents: 1, maxBytes: 500_000 });
  assert.equal(batch[0].uploadState, "uploading");

  await restoreUploadingEvents();
  const chunks = await loadAllChunks();
  const restored = chunks[0].chunk.events[0];
  assert.equal(restored.uploadState, "pending");
  assert.equal(restored.batchId, undefined);
});

test("prunes by severity retention and storage pressure", async () => {
  resetEnvironment();
  await enqueueEvent(event({
    eventId: "old-info",
    severity: "info",
    timestamp: "2026-07-01T00:00:00.000Z"
  }));
  await enqueueEvent(event({
    eventId: "old-warning",
    severity: "warning",
    timestamp: "2026-07-01T00:00:00.000Z"
  }));
  await enqueueEvent(event({
    eventId: "recent-error",
    eventType: "unexpected_exception",
    severity: "error",
    result: "failure",
    timestamp: "2026-07-18T00:00:00.000Z",
    errorCode: "UNEXPECTED_ERROR",
    errorMessage: "Unexpected"
  }));

  const result = await pruneLogs({ now: new Date("2026-07-19T00:00:00.000Z") });
  assert.equal(result.removedCount, 2);
  const chunks = await loadAllChunks();
  assert.deepEqual(chunks.flatMap((chunk) => chunk.chunk.events.map((item) => item.eventId)), ["recent-error"]);
});

test("logging survives one storage write failure by pruning and retrying", async () => {
  const chromeMock = resetEnvironment();
  chromeMock.failNextSet();
  const ok = await logEvent({
    sessionId: "session-1",
    eventType: "content_initialized",
    severity: "info",
    result: "success"
  });

  assert.equal(ok, true);
  assert.equal((await getQueueStats()).eventCount, 1);
});

test("Apps Script source reserves IDs before writes and escapes sheet formulas", () => {
  const source = fs.readFileSync(path.join(__dirname, "../google-apps-script/Code.gs"), "utf8");
  assert.match(source, /Events_keywordHighlighter/);
  assert.match(source, /Upload_Batches_keywordHighlighter/);
  assert.match(source, /Event_ID_Index_keywordHighlighter/);
  assert.match(source, /INDEX_HEADERS = \["Event ID", "Status", "Reserved At", "Batch ID", "Written At"\]/);
  assert.match(source, /newIndexRows\.length/);
  assert.match(source, /setValues\(newRows\)/);
  assert.match(source, /markIndexWritten_/);
  assert.match(source, /function sheetSafe_/);
  assert.doesNotMatch(source, /console\.error/);
});
