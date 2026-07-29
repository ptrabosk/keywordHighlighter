import { getLoggingConfig } from "./config.js";
import { pruneLogs } from "./prune.js";
import { sanitizeEvent } from "./sanitize.js";
import { ERROR_CODES, STORAGE_KEYS } from "./types.js";
import {
  enqueueEvent,
  getQueueStats,
  storageGet,
  updateUploadStatus
} from "./storageQueue.js";

async function getActiveSessionId() {
  const result = await storageGet(STORAGE_KEYS.activeSession);
  return result[STORAGE_KEYS.activeSession]?.sessionId || "unknown";
}

function requestUpload(reason) {
  try {
    globalThis.chrome?.runtime
      ?.sendMessage?.({ type: "logging:uploadRequested", reason })
      ?.catch?.(() => {});
  } catch {
    // Best effort only; logging must never interrupt the popup.
  }
}

function shouldProxyToServiceWorker() {
  return typeof globalThis.window !== "undefined" && Boolean(globalThis.chrome?.runtime?.sendMessage);
}

async function sendEventToServiceWorker(event) {
  try {
    await globalThis.chrome.runtime.sendMessage({ type: "logging:event", event });
    return true;
  } catch {
    return false;
  }
}

export async function logEvent(input = {}) {
  const config = await getLoggingConfig();
  if (!config.enabled) return false;

  try {
    const event = sanitizeEvent({
      ...input,
      sessionId: input.sessionId || await getActiveSessionId()
    });
    if (!event) return false;

    if (shouldProxyToServiceWorker()) {
      return await sendEventToServiceWorker(event);
    }

    try {
      await enqueueEvent(event);
    } catch (error) {
      await pruneLogs({ targetBytes: Math.floor(config.softStorageLimitBytes * 0.8) });
      await enqueueEvent(event);
      await updateUploadStatus({
        lastErrorCode: ERROR_CODES.STORAGE_WRITE_FAILED,
        lastStorageErrorAt: new Date().toISOString()
      });
    }

    const stats = await getQueueStats();
    if (stats.pendingCount >= 100 || stats.estimatedBytes >= config.maxBatchBytes || input.severity === "error") {
      requestUpload(input.severity === "error" ? "serious_error" : "threshold");
    }

    return true;
  } catch {
    return false;
  }
}

export async function logFailure(eventType, errorCode, errorMessage, metadata = {}) {
  return await logEvent({
    eventType,
    severity: "error",
    result: "failure",
    errorCode,
    errorMessage,
    metadata
  });
}
