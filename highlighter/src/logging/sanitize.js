import { LOGGING_CONFIG } from "./config.js";
import {
  byteSize,
  createUuid,
  getExtensionVersion,
  utcNow
} from "./sanitizePrimitives.js";
import {
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
const HIGHLIGHT_SHORTCUTS = new Set(["Shift+D", "Shift+N", "Shift+B", "Shift+C", "Shift+E"]);
const PAGE_URL_EVENT_TYPES = new Set(["highlight_detected", "highlight_shortcut_pressed"]);
const MAX_PAGE_URL_LENGTH = 2_048;
const DROPPED_EVENT_TYPES = new Set([
  "content_initialized",
  "options_opened",
  "render_completed",
  "settings_saved",
  "settings_reset",
  "cache_pruned"
]);

export { byteSize, createUuid, getExtensionVersion, utcNow };

function truncateString(value, maxLength) {
  const text = String(value ?? "");
  return text.length > maxLength ? text.slice(0, maxLength) : text;
}

function sanitizeSafeId(value, maxLength = 100) {
  if (value === undefined || value === null || value === "") return undefined;
  const text = truncateString(value, maxLength);
  return SAFE_ID_PATTERN.test(text) ? text : undefined;
}

function sanitizePageUrl(value) {
  if (typeof value !== "string" || !value || value.length > MAX_PAGE_URL_LENGTH) return undefined;
  try {
    const url = new URL(value);
    if (url.protocol !== "https:" || url.hostname !== "ui.attentivemobile.com" || url.port) return undefined;
    if (url.pathname !== "/concierge" && !url.pathname.startsWith("/concierge/")) return undefined;
    url.username = "";
    url.password = "";
    return url.href;
  } catch {
    return undefined;
  }
}

function sanitizeMetadata(metadata = {}) {
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

function sanitizeErrorMessage(message, fallback = "Operation failed") {
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

export function sanitizeEvent(input = {}) {
  if (!LOGGING_CONFIG.enabled) return null;
  if (DROPPED_EVENT_TYPES.has(input.eventType)) return null;
  if (!LOG_EVENT_TYPES.includes(input.eventType)) return null;

  const eventType = input.eventType;
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
  const ruleSource = sanitizeSafeId(input.ruleSource, 120);
  const batchId = sanitizeSafeId(input.batchId, 80);

  if (surface) event.surface = surface;
  if (ruleSource) event.ruleSource = ruleSource;
  if (Number.isFinite(input.durationMs) && input.durationMs >= 0) event.durationMs = Math.round(input.durationMs);
  if (input.errorCode) event.errorCode = sanitizeSafeId(input.errorCode, 80);
  if (input.errorMessage) event.errorMessage = sanitizeErrorMessage(input.errorMessage);
  if (batchId) event.batchId = batchId;

  if (surface === "content" && (severity === "error" || PAGE_URL_EVENT_TYPES.has(eventType))) {
    const pageUrl = sanitizePageUrl(input.pageUrl);
    if (pageUrl) event.pageUrl = pageUrl;
  }

  const metadata = sanitizeMetadata(input.metadata);
  if (eventType === "highlight_shortcut_pressed") {
    const shortcut = metadata?.shortcut;
    const highlightCount = metadata?.highlightCount;
    if (!HIGHLIGHT_SHORTCUTS.has(shortcut) || !Number.isInteger(highlightCount) || highlightCount < 1 || highlightCount > 1000) {
      return null;
    }
    event.metadata = { shortcut, highlightCount };
  } else if (metadata) {
    delete metadata.shortcut;
    delete metadata.highlightCount;
    if (Object.keys(metadata).length) event.metadata = metadata;
  }

  if (byteSize(event) <= MAX_EVENT_BYTES) return event;

  delete event.metadata;
  if (event.errorMessage) event.errorMessage = truncateString(event.errorMessage, 120);
  if (byteSize(event) <= MAX_EVENT_BYTES) return event;

  return null;
}
