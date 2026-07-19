import { LOGGING_CONFIG } from "./config.js";
import {
  ERROR_CODES,
  LOG_EVENT_TYPES,
  LOG_RESULTS,
  LOG_SEVERITIES,
  MAX_ERROR_MESSAGE_LENGTH,
  MAX_EVENT_BYTES,
  MAX_METADATA_PROPERTIES,
  MAX_METADATA_STRING_LENGTH,
  METADATA_ALLOWLIST,
  SCHEMA_VERSION
} from "./types.js";

const SAFE_ID_PATTERN = /^[a-zA-Z0-9._:-]+$/;

export function byteSize(value) {
  return new TextEncoder().encode(typeof value === "string" ? value : JSON.stringify(value)).length;
}

export function utcNow() {
  return new Date().toISOString();
}

export function createUuid() {
  if (globalThis.crypto?.randomUUID) {
    return globalThis.crypto.randomUUID();
  }

  const bytes = new Uint8Array(16);
  if (globalThis.crypto?.getRandomValues) {
    globalThis.crypto.getRandomValues(bytes);
  } else {
    for (let index = 0; index < bytes.length; index += 1) {
      bytes[index] = Math.floor(Math.random() * 256);
    }
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

export function getExtensionVersion() {
  try {
    return globalThis.chrome?.runtime?.getManifest?.().version || "unknown";
  } catch {
    return "unknown";
  }
}

export function truncateString(value, maxLength) {
  const text = String(value ?? "");
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

export function sanitizeSafeId(value, maxLength = 100) {
  if (value === undefined || value === null || value === "") return undefined;
  const text = truncateString(value, maxLength);
  return SAFE_ID_PATTERN.test(text) ? text : undefined;
}

export function sanitizeMetadata(metadata = {}) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return undefined;

  const allowed = new Set(METADATA_ALLOWLIST);
  const sanitized = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (Object.keys(sanitized).length >= MAX_METADATA_PROPERTIES) break;
    if (!allowed.has(key)) continue;

    if (typeof value === "string") {
      sanitized[key] = truncateString(value, MAX_METADATA_STRING_LENGTH);
    } else if (typeof value === "number" && Number.isFinite(value)) {
      sanitized[key] = value;
    } else if (typeof value === "boolean") {
      sanitized[key] = value;
    }
  }

  return Object.keys(sanitized).length ? sanitized : undefined;
}

export function sanitizeErrorMessage(message, fallback = "Operation failed") {
  const text = message ? String(message) : fallback;
  const redacted = text
    .replace(/https?:\/\/\S+/gi, "[url]")
    .replace(/[a-zA-Z0-9._%+-]+@[a-zA-Z0-9.-]+\.[a-z]{2,}/gi, "[email]")
    .replace(/\b(api[_-]?key|token|secret|password|authorization)=?[^\s&]+/gi, "$1=[redacted]")
    .replace(/\bBearer\s+[a-zA-Z0-9._~+/=-]+/gi, "Bearer [token]")
    .replace(/\b(customer|case|order)(?:[_\s-]*(?:id|number|no))?[:#=\s-]+[a-zA-Z0-9._:-]{4,}\b/gi, "$1 [redacted]")
    .replace(/\bat\s+\S+:\d+:\d+\b/g, "at [stack]");
  return truncateString(redacted, MAX_ERROR_MESSAGE_LENGTH);
}

export function sanitizeError(error, errorCode = ERROR_CODES.UNEXPECTED_ERROR, fallback = "Unexpected error") {
  const errorClass = error?.name && /^[a-zA-Z0-9_.:-]+$/.test(error.name)
    ? truncateString(error.name, 80)
    : undefined;

  return {
    errorCode,
    errorMessage: sanitizeErrorMessage(error?.message, fallback),
    metadata: sanitizeMetadata({
      operation: "unexpected",
      failureCategory: errorClass
    })
  };
}

export function sanitizeEvent(input = {}) {
  if (!LOGGING_CONFIG.enabled) return null;

  const eventType = LOG_EVENT_TYPES.includes(input.eventType) ? input.eventType : "unexpected_exception";
  const severity = LOG_SEVERITIES.includes(input.severity) ? input.severity : "info";
  const result = LOG_RESULTS.includes(input.result) ? input.result : "unknown";

  const event = {
    schemaVersion: SCHEMA_VERSION,
    eventId: sanitizeSafeId(input.eventId, 80) || createUuid(),
    sessionId: sanitizeSafeId(input.sessionId, 80) || "unknown",
    timestamp: input.timestamp && !Number.isNaN(Date.parse(input.timestamp)) ? new Date(input.timestamp).toISOString() : utcNow(),
    eventType,
    severity,
    result,
    extensionVersion: truncateString(input.extensionVersion || getExtensionVersion(), 40),
    uploadState: "pending",
    uploadAttempts: Number.isInteger(input.uploadAttempts) && input.uploadAttempts >= 0 ? input.uploadAttempts : 0
  };

  const surface = sanitizeSafeId(input.surface, 40);
  const pageHost = sanitizeSafeId(input.pageHost, 120);
  const ruleSource = sanitizeSafeId(input.ruleSource, 120);
  const batchId = sanitizeSafeId(input.batchId, 80);

  if (surface) event.surface = surface;
  if (pageHost) event.pageHost = pageHost;
  if (ruleSource) event.ruleSource = ruleSource;
  if (Number.isFinite(input.durationMs) && input.durationMs >= 0) event.durationMs = Math.round(input.durationMs);
  if (input.errorCode) event.errorCode = sanitizeSafeId(input.errorCode, 80);
  if (input.errorMessage) event.errorMessage = sanitizeErrorMessage(input.errorMessage);
  if (batchId) event.batchId = batchId;

  const metadata = sanitizeMetadata(input.metadata);
  if (metadata) event.metadata = metadata;

  if (byteSize(event) <= MAX_EVENT_BYTES) return event;

  delete event.metadata;
  if (event.errorMessage) event.errorMessage = truncateString(event.errorMessage, 120);
  if (byteSize(event) <= MAX_EVENT_BYTES) return event;

  return null;
}
