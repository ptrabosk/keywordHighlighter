import "./settings.js";
import { getLoggingConfig } from "./src/logging/config.js";
import { logEvent, logFailure } from "./src/logging/logger.js";
import { pruneLogs } from "./src/logging/prune.js";
import { startSession, endSession } from "./src/logging/session.js";
import { enqueueEvent, getQueueStats, restoreUploadingEvents } from "./src/logging/storageQueue.js";
import { ERROR_CODES } from "./src/logging/types.js";
import { shouldUploadOnStartup, uploadPendingLogs } from "./src/logging/uploader.js";

const UPLOAD_ALARM_NAME = "keywordHighlighterLogUpload";

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
    const config = await getLoggingConfig();
    const stats = await getQueueStats();
    if (stats.estimatedBytes >= config.pruneInfoAtBytes) {
      const result = await pruneLogs();
      if (result.removedCount > 0) {
        await logEvent({
          eventType: "cache_pruned",
          severity: "warning",
          result: "success",
          surface: "background",
          metadata: {
            operation: "prune",
            failureCategory: reason
          }
        });
      }
    }
    await uploadPendingLogs(reason);
  } catch {
    // Logging must never affect extension behavior.
  }
}

async function initializeLoggingServiceWorker() {
  await getLoggingConfig();
  await ensureUploadAlarm();
  await restoreUploadingEvents();
  await startSession({ surface: "background" });
  if (await shouldUploadOnStartup()) {
    await runUpload("startup");
  }
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

globalThis.chrome?.runtime?.onMessage?.addListener((message, _sender, sendResponse) => {
  if (message?.type === "logging:event") {
    void (async () => {
      try {
        await enqueueEvent(message.event);
        const stats = await getQueueStats();
        const config = await getLoggingConfig();
        if (stats.pendingCount >= 100 || stats.estimatedBytes >= config.maxBatchBytes || message.event?.severity === "error") {
          await runUpload(message.event?.severity === "error" ? "serious_error" : "threshold");
        }
        sendResponse?.({ ok: true });
      } catch {
        sendResponse?.({ ok: false });
      }
    })();
    return true;
  }

  if (message?.type === "logging:uploadRequested") {
    runUpload(message.reason || "requested");
    sendResponse?.({ ok: true });
    return false;
  }

  if (message?.type === "highlighter:logEvent") {
    void (async () => {
      try {
        await logEvent(message.event || {});
        sendResponse?.({ ok: true });
      } catch {
        sendResponse?.({ ok: false });
      }
    })();
    return true;
  }

  if (message?.type === "highlighter:logFailure") {
    void (async () => {
      try {
        await logFailure(
          message.eventType,
          message.errorCode,
          message.errorMessage,
          message.metadata || {}
        );
        sendResponse?.({ ok: true });
      } catch {
        sendResponse?.({ ok: false });
      }
    })();
    return true;
  }

  return false;
});

void ensureDefaultSettings();
void initializeLoggingServiceWorker();
