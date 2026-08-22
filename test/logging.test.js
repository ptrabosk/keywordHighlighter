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
import { LOG_EVENT_TYPES } from "../highlighter/src/logging/types.js";

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
    eventType: "rules_loaded",
    severity: "info",
    result: "success",
    ...overrides
  });
}

test("sanitizes events with allowlisted metadata, truncation, version, and byte enforcement", () => {
  resetEnvironment();
  const sanitized = sanitizeEvent({
    sessionId: "session-1",
    eventType: "unexpected_exception",
    severity: "loud",
    result: "success",
    surface: "content",
    pageHost: "https://ui.attentivemobile.com/concierge/conversation/123",
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
  assert.equal(sanitized.pageHost, undefined);
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

test("shortcut events accept only normalized shortcuts and a bounded highlight count", () => {
  resetEnvironment();
  const valid = sanitizeEvent({
    sessionId: "session-1",
    eventType: "highlight_shortcut_pressed",
    severity: "info",
    result: "success",
    pageHost: "https://ui.attentivemobile.com/concierge/",
    metadata: {
      shortcut: "Shift+D",
      highlightCount: 2,
      operation: "must-not-survive",
      messageText: "must-not-survive"
    }
  });

  assert.deepEqual(valid.metadata, { shortcut: "Shift+D", highlightCount: 2 });
  assert.equal(sanitizeEvent({
    eventType: "highlight_shortcut_pressed",
    metadata: { shortcut: "Shift+A", highlightCount: 1 }
  }), null);
  assert.equal(sanitizeEvent({
    eventType: "highlight_shortcut_pressed",
    metadata: { shortcut: "Shift+C", highlightCount: 0 }
  }), null);

  const unrelated = sanitizeEvent({
    eventType: "render_completed",
    metadata: { shortcut: "Shift+D", highlightCount: 4, operation: "render" }
  });
  assert.equal(unrelated, null);
});

test("logging keeps only the requested event contract and diagnostics", () => {
  resetEnvironment();
  const allowed = [
    "session_started", "session_ended", "session_abandoned", "popup_opened", "rules_loaded",
    "highlight_detected", "highlight_shortcut_pressed", "rules_load_failed", "settings_load_failed",
    "settings_save_failed", "storage_read_failed", "storage_write_failed", "render_failed",
    "unexpected_exception", "upload_failed"
  ];
  for (const eventType of allowed) {
    const metadata = eventType === "highlight_shortcut_pressed"
      ? { shortcut: "Shift+D", highlightCount: 1 }
      : {
        ruleCount: 2,
        matchedCount: 1,
        renderedCount: 1,
        queuePendingCount: 3,
        queueBytes: 400,
        uploadBatchSize: 3,
        configState: "configured",
        ignored: "drop"
      };
    assert.equal(sanitizeEvent({ eventType, metadata: {
      ...metadata
    } })?.eventType, eventType);
  }
  for (const eventType of ["content_initialized", "options_opened", "render_completed", "settings_saved", "settings_reset", "cache_pruned"]) {
    assert.equal(sanitizeEvent({ eventType }), null);
  }
});

test("committed logging config contains placeholders and no runtime dynamic import", () => {
  const configSource = fs.readFileSync(path.join(__dirname, "../highlighter/src/logging/config.js"), "utf8");
  const gitignoreSource = fs.readFileSync(path.join(__dirname, "../.gitignore"), "utf8");

  assert.match(configSource, /REPLACE_WITH_APPS_SCRIPT_EXEC_URL/);
  assert.match(configSource, /REPLACE_WITH_LOCAL_API_KEY/);
  assert.doesNotMatch(configSource, /script\.google\.com\/macros\/s\/[A-Za-z0-9_-]{20,}\/exec/);
  assert.doesNotMatch(configSource, /\bimport\s*\(/);
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
    eventType: "rules_loaded",
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

test("placeholder logging configuration is treated as not configured", async () => {
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

test("session lifecycle events are omitted while useful info events remain", async () => {
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

  await logEvent({ eventType: "rules_loaded", severity: "info", result: "success" });
  assert.deepEqual(
    (await loadAllChunks()).flatMap((chunk) => chunk.chunk.events.map((item) => item.eventType)),
    ["session_abandoned", "session_started", "rules_loaded"]
  );
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
    eventType: "rules_loaded",
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
  assert.match(source, /function doGet\(\)/);
  assert.match(source, /receiverVersion/);
  assert.match(source, /INDEX_HEADERS = \["Event ID", "Status", "Reserved At", "Batch ID", "Written At"\]/);
  assert.match(source, /newIndexRows\.length/);
  assert.match(source, /setValues\(newRows\)/);
  assert.match(source, /markIndexWritten_/);
  assert.match(source, /DUPLICATE_EVENT_ID/);
  assert.match(source, /SHEET_HEADER_MISMATCH/);
  assert.match(source, /function sheetSafe_/);
  assert.doesNotMatch(source, /pageHost/);
  assert.match(source, /function findRowByExactCellValue_/);
  assert.match(source, /KW_DAILY_EVENT_LIMIT = 25000/);
  assert.match(source, /KW_DAILY_SHORTCUT_LIMIT = 10000/);
  assert.match(source, /function consumeQuota_/);
  assert.match(source, /RATE_LIMITED/);
  assert.match(source, /KW_SHORTCUT_RETENTION_DAYS = 90/);
  assert.match(source, /function purgeExpiredShortcutEvents/);
  assert.match(source, /ensureShortcutRetentionTrigger_/);
  assert.match(source, /createTextFinder/);
  assert.match(source, /matchEntireCell\(true\)/);
  assert.doesNotMatch(source, /console\.error/);
});

test("Apps Script and extension logging event type contracts stay in sync", () => {
  const source = fs.readFileSync(path.join(__dirname, "../google-apps-script/Code.gs"), "utf8");
  const match = source.match(/const KW_EVENT_TYPES = \[([\s\S]*?)\];/);
  assert.ok(match, "Apps Script KW_EVENT_TYPES constant is present");

  const appsScriptEventTypes = Array.from(match[1].matchAll(/"([^"]+)"/g), (item) => item[1]);
  assert.deepEqual(appsScriptEventTypes, LOG_EVENT_TYPES);
  assert.ok(appsScriptEventTypes.includes("render_failed"));
});

test("diagnostics endpoints and reduced render telemetry hooks are present", () => {
  const backgroundSource = fs.readFileSync(path.join(__dirname, "../highlighter/background.js"), "utf8");
  const contentSource = fs.readFileSync(path.join(__dirname, "../highlighter/content.js"), "utf8");

  assert.match(backgroundSource, /highlighter:getDiagnostics/);
  assert.match(backgroundSource, /highlighter:runDiagnosticsUpload/);
  assert.doesNotMatch(backgroundSource, /apiKey:\s*config\.apiKey/);
  assert.match(contentSource, /RENDER_LOG_INTERVAL_MS/);
  assert.doesNotMatch(contentSource, /function pageHost/);
  assert.match(contentSource, /maybeLogRenderCompleted/);
  assert.match(contentSource, /render_failed/);
  assert.match(contentSource, /clearAllHighlights/);
  assert.match(contentSource, /!state\.settings\.enabled/);
});

test("content highlighter matches full message elements before wrapping text nodes", () => {
  const contentSource = fs.readFileSync(path.join(__dirname, "../highlighter/content.js"), "utf8");

  assert.match(contentSource, /function collectTextNodeSegments\(element\)/);
  assert.match(contentSource, /segments\.map\(\(segment\) => segment\.text\)\.join\(''\)/);
  assert.match(contentSource, /core\.collectMatches\(text, activeRules, state\.settings\)/);
  assert.match(contentSource, /function mapMatchesToTextNodeSegments\(segments, matches, fullText\)/);
  assert.match(contentSource, /matchedText: fullText\.slice\(match\.start, match\.end\)/);
  assert.match(contentSource, /isMultiPart: intersectingSegments\.length > 1/);
  assert.match(contentSource, /function getHighlightClassName\(match\)/);
  assert.match(contentSource, /applyTooltipData\(span, match\.rule, match\.matchedText\)/);
  assert.doesNotMatch(contentSource, /function highlightTextNode\(node, activeRules\)/);
});

test("content highlighter only includes Hot Topic brand message targets", () => {
  const contentSource = fs.readFileSync(path.join(__dirname, "../highlighter/content.js"), "utf8");

  assert.match(contentSource, /\.brand-message__text/);
  assert.match(contentSource, /\[class\*="brand-message"\] p\[class\*="variant-caption"\]/);
  assert.match(contentSource, /isHotTopicBrandPrompt\(node\.textContent \|\| ''\)/);
  assert.match(contentSource, /function isHotTopicBrandElement\(element\)/);
  assert.doesNotMatch(contentSource, /node\.closest\('div\[class\*="type-INBOUND"\], \[class\*="brand-message"\]'\)/);
  assert.doesNotMatch(contentSource, /querySelectorAll\('p\[class\*="variant-caption"\]'\)\.filter\(\(node\) => node instanceof HTMLElement && isVisible\(node\)\)/);
});

test("content highlighter treats Hot Topic brand/customer context as one message match", () => {
  const contentSource = fs.readFileSync(path.join(__dirname, "../highlighter/content.js"), "utf8");

  assert.match(contentSource, /function collectContextualMessageMatches\(element, text\)/);
  assert.match(contentSource, /function getHotTopicContextualRule\(element, text\)/);
  assert.match(contentSource, /HOT_TOPIC_BRAND_LOOKBACK_LIMIT = 3/);
  assert.match(contentSource, /function getRecentBrandMessageTexts\(element, limit\)/);
  assert.match(contentSource, /opt_outs_ml\.hot_topic_opt_out/);
  assert.match(contentSource, /opt_outs_ml\.hot_topic_not_opt_out/);
  assert.match(contentSource, /createHotTopicFallbackRule/);
  assert.match(contentSource, /\[data-speaker="Brand"\] p\[class\*="variant-caption"\]/);
  assert.match(contentSource, /start: 0,\s*end: text\.length,\s*length: text\.length/s);
  assert.match(contentSource, /mergeContextualMatches/);
});

test("demo Hot Topic messages are not pre-split into context highlights", () => {
  const demoSource = fs.readFileSync(path.join(__dirname, "../test-site/test-site.js"), "utf8");

  assert.match(demoSource, /function renderInboundMessageText\(message\) {\s*return escapeHtml\(message\.text\);\s*}/);
  assert.doesNotMatch(demoSource, /replace\(\/\\b\(4\|four\|never\)\\b\/gi/);
});
