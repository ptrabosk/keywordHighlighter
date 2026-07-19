const EVENTS_SHEET_NAME = "Events_keywordHighlighter";
const BATCHES_SHEET_NAME = "Upload_Batches_keywordHighlighter";
const INDEX_SHEET_NAME = "Event_ID_Index_keywordHighlighter";

const EVENTS_HEADERS = [
  "Received At",
  "Event Timestamp",
  "Event ID",
  "Session ID",
  "Event Type",
  "Severity",
  "Result",
  "Surface",
  "Page Host",
  "Rule Source",
  "Duration Ms",
  "Extension Version",
  "Error Code",
  "Error Message",
  "Metadata JSON",
  "Batch ID"
];

const BATCH_HEADERS = [
  "Batch ID",
  "Received At",
  "Event Count",
  "Accepted Count",
  "Rejected Count",
  "First Event Timestamp",
  "Last Event Timestamp",
  "Extension Version",
  "Processing Result",
  "Rejection Summary"
];

const EVENT_TYPES = [
  "session_started",
  "session_ended",
  "session_abandoned",
  "content_initialized",
  "popup_opened",
  "options_opened",
  "rules_loaded",
  "render_completed",
  "settings_saved",
  "settings_reset",
  "rules_load_failed",
  "settings_load_failed",
  "settings_save_failed",
  "storage_read_failed",
  "storage_write_failed",
  "unexpected_exception",
  "upload_failed",
  "cache_pruned"
];

const SEVERITIES = ["info", "warning", "error"];
const RESULTS = ["success", "failure", "cancelled", "unknown"];
const UPLOAD_STATES = ["pending", "uploading"];
const METADATA_KEYS = ["operation", "trigger", "areaName", "changeSource", "retryCount", "httpStatus", "failureCategory"];
const EVENT_FIELDS = [
  "schemaVersion",
  "eventId",
  "sessionId",
  "timestamp",
  "eventType",
  "severity",
  "result",
  "extensionVersion",
  "surface",
  "pageHost",
  "ruleSource",
  "durationMs",
  "errorCode",
  "errorMessage",
  "metadata",
  "uploadState",
  "uploadAttempts",
  "batchId"
];
const INDEX_HEADERS = ["Event ID", "Status", "Reserved At", "Batch ID", "Written At"];

function setupLoggingSheets() {
  const spreadsheet = getSpreadsheet_();
  ensureSheet_(spreadsheet, EVENTS_SHEET_NAME, EVENTS_HEADERS);
  ensureSheet_(spreadsheet, BATCHES_SHEET_NAME, BATCH_HEADERS);
  const indexSheet = ensureSheet_(spreadsheet, INDEX_SHEET_NAME, INDEX_HEADERS);
  indexSheet.hideSheet();
}

function doPost(e) {
  const receivedAt = new Date().toISOString();
  const lock = LockService.getScriptLock();
  try {
    const body = parseJsonBody_(e);
    validateRequestShape_(body);
    validateApiKey_(body.apiKey);

    lock.waitLock(30 * 1000);
    const spreadsheet = getSpreadsheet_();
    const eventsSheet = ensureSheet_(spreadsheet, EVENTS_SHEET_NAME, EVENTS_HEADERS);
    const batchesSheet = ensureSheet_(spreadsheet, BATCHES_SHEET_NAME, BATCH_HEADERS);
    const indexSheet = ensureSheet_(spreadsheet, INDEX_SHEET_NAME, INDEX_HEADERS);
    indexSheet.hideSheet();

    const validEvents = [];
    const acceptedEventIds = [];
    const newRows = [];
    const rejected = [];
    const acceptedTimestamps = [];
    const rowsToMarkWritten = [];

    body.events.forEach(function(event) {
      const validation = validateEvent_(event);
      if (!validation.valid) {
        rejected.push({ eventId: safeString_(event && event.eventId, 80), reason: validation.reason });
        return;
      }
      validEvents.push(event);
    });

    const incomingIds = validEvents.map(function(event) { return event.eventId; });
    const indexRecords = loadIndexRecords_(indexSheet, incomingIds);
    const eventRowsById = findExistingEventRows_(eventsSheet, incomingIds);
    const newIndexRows = [];
    const newIndexEvents = [];

    validEvents.forEach(function(event) {
      const record = indexRecords[event.eventId];
      if (record && record.status === "written") {
        acceptedEventIds.push(event.eventId);
        acceptedTimestamps.push(event.timestamp);
        return;
      }

      if (record && eventRowsById[event.eventId]) {
        markIndexWritten_(indexSheet, record.row, receivedAt);
        acceptedEventIds.push(event.eventId);
        acceptedTimestamps.push(event.timestamp);
        return;
      }

      if (!record) {
        newIndexRows.push([
          sheetSafe_(event.eventId),
          "reserved",
          receivedAt,
          sheetSafe_(body.batchId),
          ""
        ]);
        newIndexEvents.push(event);
      } else if (record.status === "reserved") {
        newRows.push(eventToRow_(event, body.batchId, receivedAt));
        rowsToMarkWritten.push(record.row);
        acceptedEventIds.push(event.eventId);
        acceptedTimestamps.push(event.timestamp);
      } else {
        rejected.push({ eventId: safeString_(event.eventId, 80), reason: "INVALID_INDEX_STATE" });
      }
    });

    if (newIndexRows.length) {
      const startRow = indexSheet.getLastRow() + 1;
      indexSheet.getRange(startRow, 1, newIndexRows.length, INDEX_HEADERS.length).setValues(newIndexRows);
      newIndexEvents.forEach(function(event, index) {
        newRows.push(eventToRow_(event, body.batchId, receivedAt));
        rowsToMarkWritten.push(startRow + index);
        acceptedEventIds.push(event.eventId);
        acceptedTimestamps.push(event.timestamp);
      });
    }

    if (newRows.length) {
      eventsSheet.getRange(eventsSheet.getLastRow() + 1, 1, newRows.length, EVENTS_HEADERS.length).setValues(newRows);
    }
    rowsToMarkWritten.forEach(function(row) {
      markIndexWritten_(indexSheet, row, receivedAt);
    });

    const sortedTimestamps = acceptedTimestamps.slice().sort();
    batchesSheet.getRange(batchesSheet.getLastRow() + 1, 1, 1, BATCH_HEADERS.length).setValues([[
      sheetSafe_(body.batchId),
      receivedAt,
      body.events.length,
      acceptedEventIds.length,
      rejected.length,
      sortedTimestamps[0] || "",
      sortedTimestamps[sortedTimestamps.length - 1] || "",
      sheetSafe_(safeString_(body.extensionVersion, 40)),
      rejected.length ? "PARTIAL_SUCCESS" : "SUCCESS",
      sheetSafe_(rejectionSummary_(rejected))
    ]]);

    return jsonResponse_({
      success: true,
      batchId: body.batchId,
      acceptedEventIds: acceptedEventIds,
      rejected: rejected
    });
  } catch (error) {
    return jsonResponse_({
      success: false,
      errorCode: error.publicCode || "SERVER_ERROR",
      message: "Request was rejected"
    });
  } finally {
    try {
      lock.releaseLock();
    } catch (releaseError) {
      // Lock may not have been acquired.
    }
  }
}

function parseJsonBody_(e) {
  try {
    return JSON.parse(e && e.postData && e.postData.contents ? e.postData.contents : "");
  } catch (error) {
    throw publicError_("INVALID_JSON");
  }
}

function validateRequestShape_(body) {
  const allowed = ["apiKey", "batchId", "extensionVersion", "sentAt", "reason", "events"];
  if (!body || typeof body !== "object" || Array.isArray(body)) throw publicError_("INVALID_REQUEST");
  Object.keys(body).forEach(function(key) {
    if (allowed.indexOf(key) === -1) throw publicError_("INVALID_REQUEST");
  });
  if (!body.apiKey || typeof body.apiKey !== "string") throw publicError_("UNAUTHORIZED");
  if (!body.batchId || typeof body.batchId !== "string") throw publicError_("INVALID_REQUEST");
  if (!body.extensionVersion || typeof body.extensionVersion !== "string") throw publicError_("INVALID_REQUEST");
  if (!body.sentAt || isNaN(Date.parse(body.sentAt))) throw publicError_("INVALID_REQUEST");
  if (!Array.isArray(body.events) || body.events.length > 200) throw publicError_("INVALID_REQUEST");
}

function validateApiKey_(apiKey) {
  const expected = PropertiesService.getScriptProperties().getProperty("LOG_API_KEY");
  if (!expected || apiKey !== expected) throw publicError_("UNAUTHORIZED");
}

function validateEvent_(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return invalid_("INVALID_SCHEMA");
  if (jsonBytes_(event) > 4096) return invalid_("EVENT_TOO_LARGE");
  for (const key in event) {
    if (EVENT_FIELDS.indexOf(key) === -1) return invalid_("UNKNOWN_FIELD");
  }
  if (event.schemaVersion !== 1) return invalid_("INVALID_SCHEMA_VERSION");
  if (!isSafeString_(event.eventId, 80)) return invalid_("INVALID_EVENT_ID");
  if (!isSafeString_(event.sessionId, 80)) return invalid_("INVALID_SESSION_ID");
  if (!event.timestamp || isNaN(Date.parse(event.timestamp))) return invalid_("INVALID_TIMESTAMP");
  if (EVENT_TYPES.indexOf(event.eventType) === -1) return invalid_("INVALID_EVENT_TYPE");
  if (SEVERITIES.indexOf(event.severity) === -1) return invalid_("INVALID_SEVERITY");
  if (RESULTS.indexOf(event.result) === -1) return invalid_("INVALID_RESULT");
  if (!isSafeString_(event.extensionVersion, 40)) return invalid_("INVALID_EXTENSION_VERSION");
  if (UPLOAD_STATES.indexOf(event.uploadState) === -1) return invalid_("INVALID_UPLOAD_STATE");
  if (!Number.isInteger(event.uploadAttempts) || event.uploadAttempts < 0) return invalid_("INVALID_UPLOAD_ATTEMPTS");
  if (event.surface !== undefined && !isSafeString_(event.surface, 40)) return invalid_("INVALID_SURFACE");
  if (event.pageHost !== undefined && !isSafeString_(event.pageHost, 120)) return invalid_("INVALID_PAGE_HOST");
  if (event.ruleSource !== undefined && !isSafeString_(event.ruleSource, 120)) return invalid_("INVALID_RULE_SOURCE");
  if (event.durationMs !== undefined && (typeof event.durationMs !== "number" || event.durationMs < 0)) return invalid_("INVALID_DURATION");
  if (event.errorCode !== undefined && !isSafeString_(event.errorCode, 80)) return invalid_("INVALID_ERROR_CODE");
  if (event.errorMessage !== undefined && !isStringWithin_(event.errorMessage, 200)) return invalid_("INVALID_ERROR_MESSAGE");
  if (event.batchId !== undefined && !isSafeString_(event.batchId, 80)) return invalid_("INVALID_BATCH_ID");
  if (event.metadata !== undefined && !isValidMetadata_(event.metadata)) return invalid_("INVALID_METADATA");
  return { valid: true };
}

function isValidMetadata_(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const keys = Object.keys(metadata);
  if (keys.length > 10) return false;
  return keys.every(function(key) {
    const value = metadata[key];
    if (METADATA_KEYS.indexOf(key) === -1) return false;
    if (typeof value === "string") return value.length <= 100;
    if (typeof value === "number") return isFinite(value);
    return typeof value === "boolean";
  });
}

function eventToRow_(event, requestBatchId, receivedAt) {
  return [
    sheetSafe_(receivedAt),
    sheetSafe_(event.timestamp),
    sheetSafe_(event.eventId),
    sheetSafe_(event.sessionId),
    sheetSafe_(event.eventType),
    sheetSafe_(event.severity),
    sheetSafe_(event.result),
    sheetSafe_(event.surface || ""),
    sheetSafe_(event.pageHost || ""),
    sheetSafe_(event.ruleSource || ""),
    event.durationMs === undefined ? "" : event.durationMs,
    sheetSafe_(event.extensionVersion),
    sheetSafe_(event.errorCode || ""),
    sheetSafe_(event.errorMessage || ""),
    sheetSafe_(event.metadata ? JSON.stringify(event.metadata) : ""),
    sheetSafe_(event.batchId || requestBatchId)
  ];
}

function getSpreadsheet_() {
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty("SPREADSHEET_ID");
  if (!spreadsheetId) throw publicError_("SERVER_NOT_CONFIGURED");
  return SpreadsheetApp.openById(spreadsheetId);
}

function ensureSheet_(spreadsheet, name, headers) {
  const sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
  }
  return sheet;
}

function loadIndexRecords_(indexSheet, eventIds) {
  const records = {};
  eventIds.forEach(function(eventId) {
    const cell = indexSheet
      .createTextFinder(eventId)
      .matchEntireCell(true)
      .findNext();
    if (!cell || cell.getColumn() !== 1) return;
    const row = cell.getRow();
    const values = indexSheet.getRange(row, 1, 1, INDEX_HEADERS.length).getValues()[0];
    records[eventId] = {
      row: row,
      status: values[1] || "written"
    };
  });
  return records;
}

function findExistingEventRows_(eventsSheet, eventIds) {
  const rows = {};
  eventIds.forEach(function(eventId) {
    const cell = eventsSheet
      .createTextFinder(eventId)
      .matchEntireCell(true)
      .findNext();
    if (cell && cell.getColumn() === 3) rows[eventId] = cell.getRow();
  });
  return rows;
}

function markIndexWritten_(indexSheet, row, writtenAt) {
  indexSheet.getRange(row, 2, 1, 4).setValues([["written", "", "", writtenAt]]);
}

function rejectionSummary_(rejected) {
  if (!rejected.length) return "";
  const counts = {};
  rejected.forEach(function(item) {
    counts[item.reason] = (counts[item.reason] || 0) + 1;
  });
  return JSON.stringify(counts);
}

function jsonResponse_(body) {
  return ContentService
    .createTextOutput(JSON.stringify(body))
    .setMimeType(ContentService.MimeType.JSON);
}

function publicError_(code) {
  const error = new Error(code);
  error.publicCode = code;
  return error;
}

function invalid_(reason) {
  return { valid: false, reason: reason };
}

function isSafeString_(value, maxLength) {
  return isStringWithin_(value, maxLength) && /^[a-zA-Z0-9._:-]+$/.test(value);
}

function isStringWithin_(value, maxLength) {
  return typeof value === "string" && value.length > 0 && value.length <= maxLength;
}

function safeString_(value, maxLength) {
  return typeof value === "string" ? value.slice(0, maxLength) : "";
}

function sheetSafe_(value) {
  if (typeof value !== "string") return value;
  return /^[=+\-@]/.test(value) ? "'" + value : value;
}

function jsonBytes_(value) {
  return Utilities.newBlob(JSON.stringify(value)).getBytes().length;
}
