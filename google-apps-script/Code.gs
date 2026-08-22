const KW_EVENTS_SHEET_NAME = "Events_keywordHighlighter";
const KW_BATCHES_SHEET_NAME = "Upload_Batches_keywordHighlighter";
const KW_INDEX_SHEET_NAME = "Event_ID_Index_keywordHighlighter";
const KW_RECEIVER_VERSION = "1.3.0";
const KW_DAILY_QUOTA_PROPERTY = "KEYWORD_HIGHLIGHTER_DAILY_QUOTA";
const KW_DAILY_EVENT_LIMIT = 25000;
const KW_DAILY_SHORTCUT_LIMIT = 10000;
const KW_SHORTCUT_RETENTION_DAYS = 90;
const KW_SHORTCUT_EVENT_TYPE = "highlight_shortcut_pressed";
const KW_SHORTCUTS = ["Shift+D", "Shift+N", "Shift+B", "Shift+C"];

const KW_EVENTS_HEADERS = [
  "Received At",
  "Event Timestamp",
  "Event ID",
  "Session ID",
  "Event Type",
  "Severity",
  "Result",
  "Surface",
  "Page URL",
  "Profile Email",
  "Rule Source",
  "Duration Ms",
  "Extension Version",
  "Error Code",
  "Error Message",
  "Metadata JSON",
  "Batch ID"
];

const KW_BATCH_HEADERS = [
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

const KW_EVENT_TYPES = [
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
];

const KW_SEVERITIES = ["info", "warning", "error"];
const KW_RESULTS = ["success", "failure", "cancelled", "unknown"];
const KW_UPLOAD_STATES = ["pending", "uploading"];
const KW_METADATA_KEYS = ["operation", "trigger", "areaName", "changeSource", "retryCount", "httpStatus", "failureCategory", "shortcut", "highlightCount", "pageUrl", "ruleCount", "matchedCount", "renderedCount", "queuePendingCount", "queueBytes", "uploadBatchSize", "configState"];
const KW_EVENT_FIELDS = [
  "schemaVersion",
  "eventId",
  "sessionId",
  "timestamp",
  "eventType",
  "severity",
  "result",
  "extensionVersion",
  "surface",
  "pageUrl",
  "profileEmail",
  "ruleSource",
  "durationMs",
  "errorCode",
  "errorMessage",
  "metadata",
  "uploadState",
  "uploadAttempts",
  "batchId"
];
const KW_INDEX_HEADERS = ["Event ID", "Status", "Reserved At", "Batch ID", "Written At"];

function setupLoggingSheets() {
  const spreadsheet = getSpreadsheet_();
  ensureSheet_(spreadsheet, KW_EVENTS_SHEET_NAME, KW_EVENTS_HEADERS);
  ensureSheet_(spreadsheet, KW_BATCHES_SHEET_NAME, KW_BATCH_HEADERS);
  const indexSheet = ensureSheet_(spreadsheet, KW_INDEX_SHEET_NAME, KW_INDEX_HEADERS);
  indexSheet.hideSheet();
  ensureShortcutRetentionTrigger_();
}

function doGet() {
  try {
    const spreadsheet = getSpreadsheet_();
    const sheetStatus = [
      sheetHealth_(spreadsheet, KW_EVENTS_SHEET_NAME, KW_EVENTS_HEADERS),
      sheetHealth_(spreadsheet, KW_BATCHES_SHEET_NAME, KW_BATCH_HEADERS),
      sheetHealth_(spreadsheet, KW_INDEX_SHEET_NAME, KW_INDEX_HEADERS)
    ];
    return jsonResponse_({
      success: true,
      receiverVersion: KW_RECEIVER_VERSION,
      spreadsheetConfigured: true,
      sheets: sheetStatus
    });
  } catch (error) {
    return jsonResponse_({
      success: false,
      receiverVersion: KW_RECEIVER_VERSION,
      spreadsheetConfigured: false,
      errorCode: error.publicCode || "SERVER_ERROR"
    });
  }
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
    const eventsSheet = ensureSheet_(spreadsheet, KW_EVENTS_SHEET_NAME, KW_EVENTS_HEADERS);
    const batchesSheet = ensureSheet_(spreadsheet, KW_BATCHES_SHEET_NAME, KW_BATCH_HEADERS);
    const indexSheet = ensureSheet_(spreadsheet, KW_INDEX_SHEET_NAME, KW_INDEX_HEADERS);
    indexSheet.hideSheet();

    const validEvents = [];
    const acceptedEventIds = [];
    const newRows = [];
    const rejected = [];
    const acceptedTimestamps = [];
    const rowsToMarkWritten = [];
    const seenEventIds = Object.create(null);
    const quota = loadDailyQuota_(receivedAt);
    const quotaStartTotal = quota.total;
    const quotaStartShortcuts = quota.shortcuts;

    body.events.forEach(function(event) {
      const validation = validateEvent_(event);
      if (!validation.valid) {
        rejected.push({ eventId: safeString_(event && event.eventId, 80), reason: validation.reason });
        return;
      }
      if (seenEventIds[event.eventId]) {
        rejected.push({ eventId: safeString_(event.eventId, 80), reason: "DUPLICATE_EVENT_ID" });
        return;
      }
      seenEventIds[event.eventId] = true;
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
        if (!consumeQuota_(quota, event)) {
          rejected.push({ eventId: event.eventId, reason: "RATE_LIMITED" });
          return;
        }
        newIndexRows.push([
          sheetSafe_(event.eventId),
          "reserved",
          receivedAt,
          sheetSafe_(body.batchId),
          ""
        ]);
        newIndexEvents.push(event);
      } else if (record.status === "reserved") {
        if (!consumeQuota_(quota, event)) {
          rejected.push({ eventId: event.eventId, reason: "RATE_LIMITED" });
          return;
        }
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
      indexSheet.getRange(startRow, 1, newIndexRows.length, KW_INDEX_HEADERS.length).setValues(newIndexRows);
      newIndexEvents.forEach(function(event, index) {
        newRows.push(eventToRow_(event, body.batchId, receivedAt));
        rowsToMarkWritten.push(startRow + index);
        acceptedEventIds.push(event.eventId);
        acceptedTimestamps.push(event.timestamp);
      });
    }

    if (newRows.length) {
      eventsSheet.getRange(eventsSheet.getLastRow() + 1, 1, newRows.length, KW_EVENTS_HEADERS.length).setValues(newRows);
    }
    rowsToMarkWritten.forEach(function(row) {
      markIndexWritten_(indexSheet, row, receivedAt);
    });
    if (quota.total !== quotaStartTotal || quota.shortcuts !== quotaStartShortcuts) {
      saveDailyQuota_(quota);
    }

    const sortedTimestamps = acceptedTimestamps.slice().sort();
    batchesSheet.getRange(batchesSheet.getLastRow() + 1, 1, 1, KW_BATCH_HEADERS.length).setValues([[
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
  const expected = PropertiesService.getScriptProperties().getProperty("KEYWORD_HIGHLIGHTER_LOG_API_KEY");
  if (!expected || apiKey !== expected) throw publicError_("UNAUTHORIZED");
}

function validateEvent_(event) {
  if (!event || typeof event !== "object" || Array.isArray(event)) return invalid_("INVALID_SCHEMA");
  if (jsonBytes_(event) > 4096) return invalid_("EVENT_TOO_LARGE");
  for (const key in event) {
    if (KW_EVENT_FIELDS.indexOf(key) === -1) return invalid_("UNKNOWN_FIELD");
  }
  if (event.schemaVersion !== 1) return invalid_("INVALID_SCHEMA_VERSION");
  if (!isSafeString_(event.eventId, 80)) return invalid_("INVALID_EVENT_ID");
  if (!isSafeString_(event.sessionId, 80)) return invalid_("INVALID_SESSION_ID");
  if (!event.timestamp || isNaN(Date.parse(event.timestamp))) return invalid_("INVALID_TIMESTAMP");
  if (KW_EVENT_TYPES.indexOf(event.eventType) === -1) return invalid_("INVALID_EVENT_TYPE");
  if (KW_SEVERITIES.indexOf(event.severity) === -1) return invalid_("INVALID_SEVERITY");
  if (KW_RESULTS.indexOf(event.result) === -1) return invalid_("INVALID_RESULT");
  if (!isSafeString_(event.extensionVersion, 40)) return invalid_("INVALID_EXTENSION_VERSION");
  if (KW_UPLOAD_STATES.indexOf(event.uploadState) === -1) return invalid_("INVALID_UPLOAD_STATE");
  if (!Number.isInteger(event.uploadAttempts) || event.uploadAttempts < 0) return invalid_("INVALID_UPLOAD_ATTEMPTS");
  if (event.surface !== undefined && !isSafeString_(event.surface, 40)) return invalid_("INVALID_SURFACE");
  if (event.pageUrl !== undefined && !isStringWithin_(event.pageUrl, 2000)) return invalid_("INVALID_PAGE_URL");
  if (event.profileEmail !== undefined && !isStringWithin_(event.profileEmail, 254)) return invalid_("INVALID_PROFILE_EMAIL");
  if (event.ruleSource !== undefined && !isSafeString_(event.ruleSource, 120)) return invalid_("INVALID_RULE_SOURCE");
  if (event.durationMs !== undefined && (typeof event.durationMs !== "number" || event.durationMs < 0)) return invalid_("INVALID_DURATION");
  if (event.errorCode !== undefined && !isSafeString_(event.errorCode, 80)) return invalid_("INVALID_ERROR_CODE");
  if (event.errorMessage !== undefined && !isStringWithin_(event.errorMessage, 200)) return invalid_("INVALID_ERROR_MESSAGE");
  if (event.batchId !== undefined && !isSafeString_(event.batchId, 80)) return invalid_("INVALID_BATCH_ID");
  if (event.metadata !== undefined && !isValidMetadata_(event.metadata)) return invalid_("INVALID_METADATA");
  if (event.eventType === KW_SHORTCUT_EVENT_TYPE && !isValidShortcutMetadata_(event.metadata)) {
    return invalid_("INVALID_SHORTCUT_METADATA");
  }
  if (event.eventType !== KW_SHORTCUT_EVENT_TYPE && event.metadata &&
      (event.metadata.shortcut !== undefined || event.metadata.highlightCount !== undefined)) {
    return invalid_("INVALID_SHORTCUT_METADATA");
  }
  return { valid: true };
}

function isValidShortcutMetadata_(metadata) {
  if (!metadata || Object.keys(metadata).length !== 2) return false;
  if (KW_SHORTCUTS.indexOf(metadata.shortcut) === -1) return false;
  return Number.isInteger(metadata.highlightCount) && metadata.highlightCount >= 1 && metadata.highlightCount <= 1000;
}

function isValidMetadata_(metadata) {
  if (!metadata || typeof metadata !== "object" || Array.isArray(metadata)) return false;
  const keys = Object.keys(metadata);
  if (keys.length > 10) return false;
  return keys.every(function(key) {
    const value = metadata[key];
    if (KW_METADATA_KEYS.indexOf(key) === -1) return false;
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
    sheetSafe_(event.pageUrl || ""),
    sheetSafe_(event.profileEmail || ""),
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
  const spreadsheetId = PropertiesService.getScriptProperties().getProperty("KEYWORD_HIGHLIGHTER_SPREADSHEET_ID");
  if (!spreadsheetId) throw publicError_("SERVER_NOT_CONFIGURED");
  return SpreadsheetApp.openById(spreadsheetId);
}

function loadDailyQuota_(receivedAt) {
  const day = String(receivedAt).slice(0, 10);
  let stored = null;
  try {
    stored = JSON.parse(PropertiesService.getScriptProperties().getProperty(KW_DAILY_QUOTA_PROPERTY) || "null");
  } catch (error) {
    stored = null;
  }
  if (!stored || stored.day !== day) return { day: day, total: 0, shortcuts: 0 };
  return {
    day: day,
    total: Math.max(0, Number(stored.total) || 0),
    shortcuts: Math.max(0, Number(stored.shortcuts) || 0)
  };
}

function consumeQuota_(quota, event) {
  if (quota.total >= KW_DAILY_EVENT_LIMIT) return false;
  if (event.eventType === KW_SHORTCUT_EVENT_TYPE && quota.shortcuts >= KW_DAILY_SHORTCUT_LIMIT) return false;
  quota.total += 1;
  if (event.eventType === KW_SHORTCUT_EVENT_TYPE) quota.shortcuts += 1;
  return true;
}

function saveDailyQuota_(quota) {
  PropertiesService.getScriptProperties().setProperty(KW_DAILY_QUOTA_PROPERTY, JSON.stringify(quota));
}

function ensureShortcutRetentionTrigger_() {
  const handler = "purgeExpiredShortcutEvents";
  const exists = ScriptApp.getProjectTriggers().some(function(trigger) {
    return trigger.getHandlerFunction() === handler;
  });
  if (!exists) ScriptApp.newTrigger(handler).timeBased().everyDays(1).atHour(3).create();
}

function purgeExpiredShortcutEvents() {
  const lock = LockService.getScriptLock();
  lock.waitLock(30 * 1000);
  try {
    const spreadsheet = getSpreadsheet_();
    const eventsSheet = ensureSheet_(spreadsheet, KW_EVENTS_SHEET_NAME, KW_EVENTS_HEADERS);
    const indexSheet = ensureSheet_(spreadsheet, KW_INDEX_SHEET_NAME, KW_INDEX_HEADERS);
    const lastRow = eventsSheet.getLastRow();
    if (lastRow < 2) return { deletedEvents: 0, deletedIndexRows: 0 };

    const cutoff = Date.now() - KW_SHORTCUT_RETENTION_DAYS * 24 * 60 * 60 * 1000;
    const values = eventsSheet.getRange(2, 1, lastRow - 1, 5).getValues();
    const eventRows = [];
    const eventIds = Object.create(null);
    values.forEach(function(row, index) {
      const receivedAt = row[0] instanceof Date ? row[0].getTime() : Date.parse(row[0]);
      if (row[4] === KW_SHORTCUT_EVENT_TYPE && isFinite(receivedAt) && receivedAt < cutoff) {
        eventRows.push(index + 2);
        eventIds[String(row[2])] = true;
      }
    });

    const indexRows = [];
    const indexLastRow = indexSheet.getLastRow();
    if (indexLastRow >= 2 && Object.keys(eventIds).length) {
      const indexIds = indexSheet.getRange(2, 1, indexLastRow - 1, 1).getValues();
      indexIds.forEach(function(row, index) {
        if (eventIds[String(row[0])]) indexRows.push(index + 2);
      });
    }

    deleteSheetRows_(eventsSheet, eventRows);
    deleteSheetRows_(indexSheet, indexRows);
    return { deletedEvents: eventRows.length, deletedIndexRows: indexRows.length };
  } finally {
    lock.releaseLock();
  }
}

function deleteSheetRows_(sheet, rows) {
  if (!rows.length) return;
  const sorted = rows.slice().sort(function(a, b) { return a - b; });
  const ranges = [];
  let start = sorted[0];
  let end = start;
  sorted.slice(1).forEach(function(row) {
    if (row === end + 1) {
      end = row;
      return;
    }
    ranges.push([start, end]);
    start = row;
    end = row;
  });
  ranges.push([start, end]);
  ranges.reverse().forEach(function(range) {
    sheet.deleteRows(range[0], range[1] - range[0] + 1);
  });
}

function ensureSheet_(spreadsheet, name, headers) {
  const sheet = spreadsheet.getSheetByName(name) || spreadsheet.insertSheet(name);
  if (sheet.getLastRow() === 0) {
    sheet.getRange(1, 1, 1, headers.length).setValues([headers]);
    return sheet;
  }
  const actual = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const headersReady = headers.every(function(header, index) {
    return actual[index] === header;
  });
  if (!headersReady) throw publicError_("SHEET_HEADER_MISMATCH");
  return sheet;
}

function loadIndexRecords_(indexSheet, eventIds) {
  const records = {};
  const wanted = uniqueValues_(eventIds);
  const lastRow = indexSheet.getLastRow();
  if (lastRow < 2 || !wanted.length) return records;
  wanted.forEach(function(eventId) {
    const row = findRowByExactCellValue_(indexSheet, 1, eventId);
    if (!row) return;
    records[eventId] = {
      row: row,
      status: indexSheet.getRange(row, 2).getValue() || "written"
    };
  });
  return records;
}

function findExistingEventRows_(eventsSheet, eventIds) {
  const rows = {};
  const wanted = uniqueValues_(eventIds);
  const lastRow = eventsSheet.getLastRow();
  if (lastRow < 2 || !wanted.length) return rows;
  wanted.forEach(function(eventId) {
    const row = findRowByExactCellValue_(eventsSheet, 3, eventId);
    if (row) rows[eventId] = row;
  });
  return rows;
}

function findRowByExactCellValue_(sheet, column, value) {
  const lastRow = sheet.getLastRow();
  if (lastRow < 2 || !value) return null;
  const finder = sheet.getRange(2, column, lastRow - 1, 1)
    .createTextFinder(value)
    .matchEntireCell(true);
  const match = finder.findNext();
  return match ? match.getRow() : null;
}

function sheetHealth_(spreadsheet, name, headers) {
  const sheet = spreadsheet.getSheetByName(name);
  if (!sheet) return { name: name, exists: false, headersReady: false };
  const actual = sheet.getRange(1, 1, 1, headers.length).getValues()[0];
  const headersReady = headers.every(function(header, index) {
    return actual[index] === header;
  });
  return {
    name: name,
    exists: true,
    headersReady: headersReady,
    rows: Math.max(0, sheet.getLastRow() - 1)
  };
}

function toSet_(values) {
  const set = Object.create(null);
  values.forEach(function(value) {
    if (value) set[value] = true;
  });
  return {
    has: function(value) {
      return set[value] === true;
    },
    size: Object.keys(set).length
  };
}

function uniqueValues_(values) {
  const set = Object.create(null);
  const output = [];
  values.forEach(function(value) {
    if (!value || set[value]) return;
    set[value] = true;
    output.push(value);
  });
  return output;
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
