import { getLoggingConfig } from "./config.js";
import { buildFailureStatus, clearPermanentFailureStatus, isPermanentUploadFailure, shouldRetry } from "./retry.js";
import { createUuid, getExtensionVersion, sanitizeEvent, utcNow } from "./sanitize.js";
import { ERROR_CODES, STORAGE_KEYS } from "./types.js";
import {
  getQueueMeta,
  getQueueStats,
  getUploadStatus,
  markUploadSuccess,
  removeEventsById,
  restoreBatch,
  restoreUploadingEvents,
  selectUploadBatch,
  storageGet,
  updateUploadStatus
} from "./storageQueue.js";
import { enqueueEvent } from "./storageQueue.js";

function isConfigured(config) {
  const endpointUrl = config.endpointUrl || "";
  const apiKey = config.apiKey || "";
  return Boolean(
    config.enabled &&
    endpointUrl &&
    apiKey &&
    !endpointUrl.includes("REPLACE_WITH_") &&
    !endpointUrl.includes("YOUR_DEPLOYMENT_ID") &&
    !apiKey.includes("REPLACE_WITH_") &&
    !apiKey.includes("replace-with-")
  );
}

function configFingerprint(config) {
  const text = `${config.endpointUrl || ""}|${config.apiKey || ""}`;
  let hash = 0;
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) - hash + text.charCodeAt(index)) | 0;
  }
  return `v1:${text.length}:${Math.abs(hash)}`;
}

async function recordUploadFailure(errorCode, metadata = {}) {
  const status = await getUploadStatus();
  const now = Date.now();
  const lastLoggedAt = status.lastUploadFailureEventAt ? Date.parse(status.lastUploadFailureEventAt) : 0;
  if (now - lastLoggedAt < 15 * 60_000) return;

  const session = (await storageGet(STORAGE_KEYS.activeSession))[STORAGE_KEYS.activeSession];
  const event = sanitizeEvent({
    sessionId: session?.sessionId || "unknown",
    eventType: "upload_failed",
    severity: "warning",
    result: "failure",
    errorCode,
    errorMessage: "Log upload failed",
    metadata
  });
  if (event) await enqueueEvent(event);
  await updateUploadStatus({ lastUploadFailureEventAt: utcNow() });
}

function validateUploadResponse(responseBody, batchId) {
  if (!responseBody || typeof responseBody !== "object") {
    throw Object.assign(new Error("Upload response was not JSON"), { errorCode: ERROR_CODES.UPLOAD_INVALID_RESPONSE });
  }
  if (responseBody.success !== true || responseBody.batchId !== batchId || !Array.isArray(responseBody.acceptedEventIds)) {
    throw Object.assign(new Error("Upload response did not acknowledge the batch"), { errorCode: ERROR_CODES.UPLOAD_INVALID_RESPONSE });
  }
  return {
    acceptedEventIds: responseBody.acceptedEventIds.filter((eventId) => typeof eventId === "string"),
    rejectedEventIds: Array.isArray(responseBody.rejected)
      ? responseBody.rejected.map((item) => item?.eventId).filter((eventId) => typeof eventId === "string")
      : []
  };
}

export async function uploadPendingLogs(reason = "scheduled") {
  const config = await getLoggingConfig();
  const fingerprint = configFingerprint(config);
  const ready = await prepareUploadStatus(config, fingerprint, reason);
  if (ready.stopped) return ready.stopped;
  const { uploadStatus } = ready;

  await restoreUploadingEvents();
  const batchId = createUuid();
  const events = await selectUploadBatch(batchId, {
    maxEvents: config.maxBatchEvents,
    maxBytes: config.maxBatchBytes
  });
  if (!events.length) return { uploaded: false, reason: "empty" };

  const body = { apiKey: config.apiKey, batchId, extensionVersion: getExtensionVersion(), sentAt: utcNow(), reason, events };
  if (new TextEncoder().encode(JSON.stringify(body)).length > config.maxBatchBytes) {
    return rejectOversizedBatch(batchId, uploadStatus, fingerprint);
  }

  try {
    return await sendBatch(config.endpointUrl, body, batchId);
  } catch (error) {
    return handleUploadError(error, { batchId, uploadStatus, fingerprint, batchSize: events.length });
  } finally {
    const meta = await getQueueMeta();
    await updateUploadStatus({ lastUploadAt: utcNow(), estimatedBytes: meta.estimatedBytes });
  }
}

// Resolves to { stopped } when no upload should happen, else { uploadStatus }.
async function prepareUploadStatus(config, fingerprint, reason) {
  if (!config.enabled) return { stopped: await recordConfigurationFailure("UPLOAD_DISABLED", fingerprint, "disabled") };
  if (!isConfigured(config)) {
    return { stopped: await recordConfigurationFailure("UPLOAD_INVALID_CONFIGURATION", fingerprint, "not_configured") };
  }
  let uploadStatus = await getUploadStatus();
  // A permanent failure is retried once the configuration changes or diagnostics ask for it.
  if (uploadStatus.blockedUntilConfigurationChange && (uploadStatus.configFingerprint !== fingerprint || reason === "diagnostics")) {
    uploadStatus = await updateUploadStatus(clearPermanentFailureStatus(uploadStatus));
  }
  if (!shouldRetry(uploadStatus)) return { stopped: { uploaded: false, reason: "backoff_active" } };
  return { uploadStatus };
}

async function recordConfigurationFailure(errorCode, fingerprint, reason) {
  await updateUploadStatus({ ...buildFailureStatus(await getUploadStatus(), errorCode), configFingerprint: fingerprint });
  return { uploaded: false, reason };
}

async function rejectOversizedBatch(batchId, uploadStatus, fingerprint) {
  await restoreBatch(batchId);
  await updateUploadStatus({ ...buildFailureStatus(uploadStatus, "UPLOAD_PAYLOAD_TOO_LARGE"), configFingerprint: fingerprint });
  await recordUploadFailure("UPLOAD_PAYLOAD_TOO_LARGE", { operation: "upload", failureCategory: "payload" });
  return { uploaded: false, reason: "payload_too_large" };
}

async function sendBatch(endpointUrl, body, batchId) {
  const response = await fetch(endpointUrl, {
    method: "POST",
    headers: { "Content-Type": "text/plain;charset=utf-8" },
    body: JSON.stringify(body),
    redirect: "follow"
  });
  if (!response.ok) throw httpUploadError(response.status);

  const acknowledgement = validateUploadResponse(await response.json(), batchId);
  await removeEventsById([...acknowledgement.acceptedEventIds, ...acknowledgement.rejectedEventIds]);
  await markUploadSuccess();
  return {
    uploaded: true,
    batchId,
    acceptedCount: acknowledgement.acceptedEventIds.length,
    rejectedCount: acknowledgement.rejectedEventIds.length
  };
}

function httpUploadError(httpStatus) {
  const errorCode = httpStatus === 401 || httpStatus === 403 ? ERROR_CODES.UPLOAD_UNAUTHORIZED : ERROR_CODES.UPLOAD_HTTP_FAILED;
  return Object.assign(new Error("Upload HTTP failure"), { errorCode, httpStatus });
}

// Puts the batch back in the queue and records the failure for backoff.
async function handleUploadError(error, { batchId, uploadStatus, fingerprint, batchSize }) {
  const errorCode = error?.errorCode || ERROR_CODES.UPLOAD_NETWORK_FAILED;
  await restoreBatch(batchId);
  const nextStatus = { ...buildFailureStatus(uploadStatus, errorCode), configFingerprint: fingerprint };
  await updateUploadStatus(nextStatus);
  await recordUploadFailure(errorCode, {
    operation: "upload",
    httpStatus: error?.httpStatus,
    retryCount: nextStatus.consecutiveFailures,
    failureCategory: isPermanentUploadFailure(errorCode) ? "permanent" : "temporary",
    uploadBatchSize: batchSize
  });
  return { uploaded: false, reason: "failed", errorCode };
}

export async function shouldUploadOnStartup() {
  const config = await getLoggingConfig();
  const [stats, meta] = await Promise.all([getQueueStats(), getQueueMeta()]);
  if (!stats.pendingCount) return false;
  if (stats.pendingCount >= 100 || stats.estimatedBytes >= config.maxBatchBytes) return true;
  if (!meta.lastSuccessfulUploadAt) return true;
  return Date.now() - Date.parse(meta.lastSuccessfulUploadAt) > config.uploadIntervalMinutes * 60_000;
}
