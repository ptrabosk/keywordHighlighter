import { utcNow } from "./sanitize.js";

const BACKOFF_MINUTES = [5, 15, 30, 60];
const MAX_BACKOFF_MINUTES = 240;
const PERMANENT_ERROR_CODES = new Set([
  "UPLOAD_UNAUTHORIZED",
  "UPLOAD_PERMANENT_FAILURE",
  "UPLOAD_INVALID_CONFIGURATION",
  "UPLOAD_PAYLOAD_TOO_LARGE",
  "UPLOAD_DISABLED"
]);

export function isPermanentUploadFailure(errorCode) {
  return PERMANENT_ERROR_CODES.has(errorCode);
}

export function nextRetryTimestamp(consecutiveFailures, now = new Date(), random = Math.random) {
  const index = Math.max(0, Math.min(consecutiveFailures - 1, BACKOFF_MINUTES.length - 1));
  const baseMinutes = consecutiveFailures >= 5 ? MAX_BACKOFF_MINUTES : BACKOFF_MINUTES[index];
  const jitterMs = baseMinutes * 60_000 * 0.1 * random();
  return new Date(now.getTime() + baseMinutes * 60_000 + jitterMs).toISOString();
}

export function shouldRetry(uploadStatus = {}, now = new Date()) {
  if (uploadStatus.blockedUntilConfigurationChange) return false;
  if (!uploadStatus.nextRetryAt) return true;
  return Date.parse(uploadStatus.nextRetryAt) <= now.getTime();
}

export function buildFailureStatus(currentStatus = {}, errorCode, now = new Date()) {
  const consecutiveFailures = (Number(currentStatus.consecutiveFailures) || 0) + 1;
  return {
    consecutiveFailures,
    blockedUntilConfigurationChange: isPermanentUploadFailure(errorCode) || undefined,
    permanentErrorCode: isPermanentUploadFailure(errorCode) ? errorCode : undefined,
    nextRetryAt: isPermanentUploadFailure(errorCode) ? undefined : nextRetryTimestamp(consecutiveFailures, now),
    lastErrorCode: errorCode,
    lastUploadAt: utcNow()
  };
}

export function clearPermanentFailureStatus(currentStatus = {}) {
  return {
    ...currentStatus,
    blockedUntilConfigurationChange: undefined,
    permanentErrorCode: undefined,
    nextRetryAt: undefined
  };
}
