export const SCHEMA_VERSION = 1;

export const LOG_EVENT_TYPES = Object.freeze([
  "session_started",
  "session_ended",
  "session_abandoned",
  "popup_opened",
  "rules_loaded",
  "highlight_detected",
  "highlight_shortcut_pressed",
  "rules_load_failed",
  "settings_load_failed",
  "settings_save_failed",
  "storage_read_failed",
  "storage_write_failed",
  "render_failed",
  "unexpected_exception",
  "upload_failed",
]);

export const LOG_SEVERITIES = Object.freeze(["info", "warning", "error"]);
export const LOG_RESULTS = Object.freeze(["success", "failure", "cancelled", "unknown"]);
export const UPLOAD_STATES = Object.freeze(["pending", "uploading"]);

export const ERROR_CODES = Object.freeze({
  RULES_LOAD_FAILED: "RULES_LOAD_FAILED",
  SETTINGS_LOAD_FAILED: "SETTINGS_LOAD_FAILED",
  SETTINGS_SAVE_FAILED: "SETTINGS_SAVE_FAILED",
  RENDER_FAILED: "RENDER_FAILED",
  STORAGE_READ_FAILED: "STORAGE_READ_FAILED",
  STORAGE_WRITE_FAILED: "STORAGE_WRITE_FAILED",
  UPLOAD_NETWORK_FAILED: "UPLOAD_NETWORK_FAILED",
  UPLOAD_HTTP_FAILED: "UPLOAD_HTTP_FAILED",
  UPLOAD_INVALID_RESPONSE: "UPLOAD_INVALID_RESPONSE",
  UPLOAD_UNAUTHORIZED: "UPLOAD_UNAUTHORIZED",
  UPLOAD_PERMANENT_FAILURE: "UPLOAD_PERMANENT_FAILURE",
  UNEXPECTED_ERROR: "UNEXPECTED_ERROR"
});

export const METADATA_ALLOWLIST = Object.freeze([
  "operation",
  "trigger",
  "areaName",
  "changeSource",
  "retryCount",
  "httpStatus",
  "failureCategory",
  "shortcut",
  "highlightCount",
  "pageUrl",
  "ruleCount",
  "matchedCount",
  "renderedCount",
  "queuePendingCount",
  "queueBytes",
  "uploadBatchSize",
  "configState"
]);

export const STORAGE_KEYS = Object.freeze({
  queueMeta: "logQueueMeta",
  activeSession: "activeSession",
  uploadStatus: "uploadStatus",
  loggingConfig: "loggingConfig"
});

export const CHUNK_PREFIX = "logChunk_";
export const MAX_METADATA_PROPERTIES = 10;
export const MAX_METADATA_STRING_LENGTH = 100;
export const MAX_ERROR_MESSAGE_LENGTH = 200;
export const MAX_EVENT_BYTES = 4_096;
export const MAX_CHUNK_EVENTS = 200;
export const MAX_CHUNK_BYTES = 200_000;

export const NAVIGATION_EVENT_TYPES = Object.freeze([
  "popup_opened",
  "rules_loaded",
  "session_started",
  "session_ended",
  "session_abandoned"
]);
