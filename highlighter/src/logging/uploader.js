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
  if (!config.enabled) {
    await updateUploadStatus({ ...buildFailureStatus(await getUploadStatus(), "UPLOAD_DISABLED"), configFingerprint: fingerprint });
    return { uploaded: false, reason: "disabled" };
  }
  if (!isConfigured(config)) {
    await updateUploadStatus({ ...buildFailureStatus(await getUploadStatus(), "UPLOAD_INVALID_CONFIGURATION"), configFingerprint: fingerprint });
    return { uploaded: false, reason: "not_configured" };
  }

  let uploadStatus = await getUploadStatus();
  if (uploadStatus.blockedUntilConfigurationChange && (uploadStatus.configFingerprint !== fingerprint || reason === "diagnostics")) {
    uploadStatus = await updateUploadStatus(clearPermanentFailureStatus(uploadStatus));
  }
  if (!shouldRetry(uploadStatus)) {
    return { uploaded: false, reason: "backoff_active" };
  }

  await restoreUploadingEvents();

  const batchId = createUuid();
  const events = await selectUploadBatch(batchId, {
    maxEvents: config.maxBatchEvents,
    maxBytes: config.maxBatchBytes
  });

  if (!events.length) return { uploaded: false, reason: "empty" };

  const body = {
    apiKey: config.apiKey,
    batchId,
    extensionVersion: getExtensionVersion(),
    sentAt: utcNow(),
    reason,
    events
  };

  if (new TextEncoder().encode(JSON.stringify(body)).length > config.maxBatchBytes) {
    await restoreBatch(batchId);
    await updateUploadStatus({ ...buildFailureStatus(uploadStatus, "UPLOAD_PAYLOAD_TOO_LARGE"), configFingerprint: fingerprint });
    await recordUploadFailure("UPLOAD_PAYLOAD_TOO_LARGE", { operation: "upload", failureCategory: "payload" });
    return { uploaded: false, reason: "payload_too_large" };
  }

  try {
    const response = await fetch(config.endpointUrl, {
      method: "POST",
      headers: { "Content-Type": "text/plain;charset=utf-8" },
      body: JSON.stringify(body),
      redirect: "follow"
    });

    if (!response.ok) {
      const errorCode = response.status === 401 || response.status === 403
        ? ERROR_CODES.UPLOAD_UNAUTHORIZED
        : ERROR_CODES.UPLOAD_HTTP_FAILED;
      throw Object.assign(new Error("Upload HTTP failure"), { errorCode, httpStatus: response.status });
    }

    const responseBody = await response.json();
    const acknowledgement = validateUploadResponse(responseBody, batchId);
    await removeEventsById([...acknowledgement.acceptedEventIds, ...acknowledgement.rejectedEventIds]);
    await markUploadSuccess();
    return {
      uploaded: true,
      batchId,
      acceptedCount: acknowledgement.acceptedEventIds.length,
      rejectedCount: acknowledgement.rejectedEventIds.length
    };
  } catch (error) {
    const errorCode = error?.errorCode || ERROR_CODES.UPLOAD_NETWORK_FAILED;
    await restoreBatch(batchId);
    const nextStatus = { ...buildFailureStatus(uploadStatus, errorCode), configFingerprint: fingerprint };
    await updateUploadStatus(nextStatus);
    await recordUploadFailure(errorCode, {
      operation: "upload",
      httpStatus: error?.httpStatus,
      retryCount: nextStatus.consecutiveFailures,
      failureCategory: isPermanentUploadFailure(errorCode) ? "permanent" : "temporary",
      uploadBatchSize: events.length
    });
    return { uploaded: false, reason: "failed", errorCode };
  } finally {
    const meta = await getQueueMeta();
    await updateUploadStatus({ lastUploadAt: utcNow(), estimatedBytes: meta.estimatedBytes });
  }
}

export async function shouldUploadOnStartup() {
  const config = await getLoggingConfig();
  const [stats, meta] = await Promise.all([getQueueStats(), getQueueMeta()]);
  if (!stats.pendingCount) return false;
  if (stats.pendingCount >= 100 || stats.estimatedBytes >= config.maxBatchBytes) return true;
  if (!meta.lastSuccessfulUploadAt) return true;
  return Date.now() - Date.parse(meta.lastSuccessfulUploadAt) > config.uploadIntervalMinutes * 60_000;
}
