import "./settings.js";
import { getLoggingConfig } from "./src/logging/config.js";
import { logEvent, logFailure } from "./src/logging/logger.js";
import { pruneLogs } from "./src/logging/prune.js";
import { startSession, endSession } from "./src/logging/session.js";
import { enqueueEvent, getQueueStats, getUploadStatus, restoreUploadingEvents } from "./src/logging/storageQueue.js";
import { ERROR_CODES } from "./src/logging/types.js";
import { shouldUploadOnStartup, uploadPendingLogs } from "./src/logging/uploader.js";

const UPLOAD_ALARM_NAME = "keywordHighlighterLogUpload";
let loggingInitialized = false;

function summarizeLoggingConfig(config) {
  const endpointUrl = config.endpointUrl || "";
  const apiKey = config.apiKey || "";
  let endpointHost = "";
  try {
    endpointHost = endpointUrl ? new URL(endpointUrl).hostname : "";
  } catch {
    endpointHost = "";
  }
  const configured = Boolean(
    config.enabled &&
    endpointUrl &&
    apiKey &&
    !endpointUrl.includes("REPLACE_WITH_") &&
    !endpointUrl.includes("YOUR_DEPLOYMENT_ID") &&
    !apiKey.includes("REPLACE_WITH_") &&
    !apiKey.includes("replace-with-")
  );
  return {
    enabled: config.enabled !== false,
    configured,
    endpointHost,
    uploadIntervalMinutes: config.uploadIntervalMinutes,
    maxBatchEvents: config.maxBatchEvents,
    maxBatchBytes: config.maxBatchBytes
  };
}

async function getDiagnostics() {
  const [config, queueStats, uploadStatus, statsResult] = await Promise.all([
    getLoggingConfig(),
    getQueueStats(),
    getUploadStatus(),
    chrome.storage.local.get("amhLastStats")
  ]);
  return {
    loggingConfig: summarizeLoggingConfig(config),
    queueStats,
    uploadStatus,
    lastStats: statsResult.amhLastStats || null
  };
}

async function ensureDefaultSettings() {
  try {
    const existing = await chrome.storage.sync.get(globalThis.SETTINGS_KEY);
    if (!existing[globalThis.SETTINGS_KEY]) {
      await chrome.storage.sync.set({ [globalThis.SETTINGS_KEY]: globalThis.DEFAULT_SETTINGS });
    }
  } catch (error) {
    await logFailure(
      "settings_save_failed",
      ERROR_CODES.SETTINGS_SAVE_FAILED,
      "Default settings could not be initialized",
      { operation: "initializeDefaults" }
    );
  }
}

async function ensureUploadAlarm() {
  if (!globalThis.chrome?.alarms) return;
  const config = await getLoggingConfig();
  await chrome.alarms.create(UPLOAD_ALARM_NAME, {
    periodInMinutes: config.uploadIntervalMinutes,
    delayInMinutes: config.uploadIntervalMinutes
  });
}

async function runUpload(reason) {
  try {
    await restoreUploadingEvents();
    await pruneLogs();
    await uploadPendingLogs(reason);
  } catch {
    // Logging must never affect extension behavior.
  }
}

async function initializeLoggingServiceWorker() {
  if (loggingInitialized) return true;
  await getLoggingConfig();
  await ensureUploadAlarm();
  await restoreUploadingEvents();
  await startSession({ surface: "background" });
  loggingInitialized = true;
  if (await shouldUploadOnStartup()) {
    await runUpload("startup");
  }
  return true;
}

function respondAsync(task, sendResponse, fallback) {
  void task().then((response) => sendResponse?.(response)).catch(() => sendResponse?.(fallback));
  return true;
}

chrome.runtime.onInstalled.addListener(async () => {
  await ensureDefaultSettings();
});

globalThis.chrome?.alarms?.onAlarm?.addListener((alarm) => {
  if (alarm.name === UPLOAD_ALARM_NAME) {
    runUpload("alarm");
  }
});

globalThis.chrome?.runtime?.onSuspend?.addListener(() => {
  void endSession("success");
});

globalThis.chrome?.runtime?.onMessage?.addListener(function handleRuntimeMessage(message, _sender, sendResponse) {
  if (message?.type === "logging:event") {
    return respondAsync(async function queueLoggedEvent() {
      await initializeLoggingServiceWorker();
      const event = { ...(message.event || {}) };
      await enqueueEvent(event);
      const stats = await getQueueStats();
      const config = await getLoggingConfig();
      if (stats.pendingCount >= 100 || stats.estimatedBytes >= config.maxBatchBytes || message.event?.severity === "error") {
        await runUpload(message.event?.severity === "error" ? "serious_error" : "threshold");
      }
      return { ok: true };
    }, sendResponse, { ok: false });
  }

  if (message?.type === "logging:uploadRequested") {
    runUpload(message.reason || "requested");
    sendResponse?.({ ok: true });
    return false;
  }

  if (message?.type === "highlighter:getDiagnostics") {
    return respondAsync(async () => {
      await initializeLoggingServiceWorker();
      return { ok: true, diagnostics: await getDiagnostics() };
    }, sendResponse, { ok: false });
  }

  if (message?.type === "highlighter:runDiagnosticsUpload") {
    return respondAsync(async () => {
      await initializeLoggingServiceWorker();
      await runUpload("diagnostics");
      return { ok: true, diagnostics: await getDiagnostics() };
    }, sendResponse, { ok: false });
  }

  if (message?.type === "highlighter:logEvent") {
    return respondAsync(async () => {
      await initializeLoggingServiceWorker();
      await logEvent({ ...(message.event || {}) });
      return { ok: true };
    }, sendResponse, { ok: false });
  }

  if (message?.type === "highlighter:logFailure") {
    return respondAsync(async () => {
      await initializeLoggingServiceWorker();
      await logFailure(message.eventType, message.errorCode, message.errorMessage, message.metadata || {});
      return { ok: true };
    }, sendResponse, { ok: false });
  }

  return false;
});

void ensureDefaultSettings();
void initializeLoggingServiceWorker();
