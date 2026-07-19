import { LOGGING_CONFIG } from "./config.js";
import { logEvent, logFailure } from "./logger.js";
import { pruneLogs } from "./prune.js";
import { startSession, updateSessionActivity, endSession, getActiveSession, sessionTestHooks } from "./session.js";
import { getQueueStats, getUploadStatus } from "./storageQueue.js";
import { uploadPendingLogs } from "./uploader.js";

export {
  getActiveSession,
  getQueueStats,
  getUploadStatus,
  logEvent,
  logFailure,
  pruneLogs,
  sessionTestHooks,
  startSession,
  updateSessionActivity,
  uploadPendingLogs
};

export function installLoggingDiagnostics() {
  if (!LOGGING_CONFIG.diagnosticsEnabled || typeof globalThis.window === "undefined") return;

  globalThis.window.keywordHighlighterLogging = {
    createTestInfoEvent: () => logEvent({
      eventType: "content_initialized",
      severity: "info",
      result: "success",
      metadata: { operation: "diagnostics" }
    }),
    createTestErrorEvent: () => logFailure(
      "unexpected_exception",
      "UNEXPECTED_ERROR",
      "Diagnostic test error",
      { operation: "diagnostics" }
    ),
    getQueueStats,
    getUploadStatus,
    triggerUpload: () => uploadPendingLogs("diagnostics"),
    triggerPruning: () => pruneLogs()
  };
}

export async function endCurrentSession() {
  await endSession("success");
}
