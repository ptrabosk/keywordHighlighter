import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import vm from "node:vm";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(__dirname, "../google-apps-script/Code.gs"), "utf8");

function loadReceiver(globals = {}) {
  const context = vm.createContext({
    console,
    Utilities: {
      newBlob: (value) => ({ getBytes: () => new TextEncoder().encode(value) })
    },
    ...globals
  });
  vm.runInContext(source, context, { filename: "Code.gs" });
  return context;
}

function validEvent(overrides = {}) {
  return {
    schemaVersion: 1,
    eventId: "event-1",
    sessionId: "session-1",
    timestamp: "2026-09-29T10:00:00.000Z",
    eventType: "highlight_detected",
    severity: "info",
    result: "success",
    extensionVersion: "1.1.0",
    surface: "content",
    uploadState: "pending",
    uploadAttempts: 0,
    ...overrides
  };
}

test("receiver validates shortcut metadata as an exact two-field contract", () => {
  const receiver = loadReceiver();
  assert.equal(receiver.isValidShortcutMetadata_({ shortcut: "Shift+D", highlightCount: 1 }), true);
  assert.equal(receiver.isValidShortcutMetadata_({ shortcut: "Shift+C", highlightCount: 1000 }), true);
  assert.equal(receiver.isValidShortcutMetadata_({ shortcut: "Shift+E", highlightCount: 2 }), true);
  assert.equal(receiver.isValidShortcutMetadata_({ shortcut: "Shift+A", highlightCount: 1 }), false);
  assert.equal(receiver.isValidShortcutMetadata_({ shortcut: "Shift+D", highlightCount: 0 }), false);
  assert.equal(receiver.isValidShortcutMetadata_({ shortcut: "Shift+D", highlightCount: 1, text: "no" }), false);
});

test("receiver stores supported-page URLs without profile data", () => {
  assert.match(source, /"Surface",\s*"Page URL",\s*"Rule Source"/);
  assert.match(source, /"Metadata JSON",\s*"Batch ID"/);
  assert.match(source, /function migrateEventsSheet_/);
  assert.match(source, /clearContent\(\)/);
  assert.match(source, /deleteColumn\(10\)/);
  assert.match(source, /insertColumnAfter\(8\)/);
  assert.match(source, /sheetSafe_\(event\.pageUrl \|\| ""\)/);
  assert.doesNotMatch(source, /event\.profileEmail/);
});

test("receiver accepts supported-page URLs only for highlights, shortcuts, and errors", () => {
  const receiver = loadReceiver();
  const pageUrl = "https://ui.attentivemobile.com/concierge/conversation/123?view=open#latest";

  assert.equal(receiver.validateEvent_(validEvent({ pageUrl })).valid, true);
  assert.equal(receiver.validateEvent_(validEvent({
    eventType: "highlight_shortcut_pressed",
    pageUrl,
    metadata: { shortcut: "Shift+D", highlightCount: 2 }
  })).valid, true);
  assert.equal(receiver.validateEvent_(validEvent({
    eventType: "render_failed",
    severity: "error",
    result: "failure",
    pageUrl
  })).valid, true);
  assert.equal(receiver.validateEvent_(validEvent({ pageUrl: "https://example.com/concierge/123" })).reason, "INVALID_PAGE_URL");
  assert.equal(receiver.validateEvent_(validEvent({ surface: "background", severity: "error", pageUrl })).reason, "INVALID_PAGE_URL_SURFACE");
  assert.equal(receiver.validateEvent_(validEvent({ eventType: "rules_loaded", pageUrl })).reason, "PAGE_URL_NOT_ALLOWED");
});

test("receiver enforces total and shortcut daily quotas independently", () => {
  const receiver = loadReceiver();
  const shortcut = { eventType: "highlight_shortcut_pressed" };
  const operational = { eventType: "rules_loaded" };

  const nearLimits = { day: "2026-08-14", total: 24999, shortcuts: 9999 };
  assert.equal(receiver.consumeQuota_(nearLimits, shortcut), true);
  assert.deepEqual(nearLimits, { day: "2026-08-14", total: 25000, shortcuts: 10000 });
  assert.equal(receiver.consumeQuota_(nearLimits, operational), false);

  const shortcutLimited = { day: "2026-08-14", total: 10000, shortcuts: 10000 };
  assert.equal(receiver.consumeQuota_(shortcutLimited, shortcut), false);
  assert.equal(receiver.consumeQuota_(shortcutLimited, operational), true);
});

test("retention row deletion groups contiguous rows and deletes from the bottom", () => {
  const receiver = loadReceiver();
  const calls = [];
  const sheet = { deleteRows: (start, count) => calls.push([start, count]) };
  receiver.deleteSheetRows_(sheet, [2, 3, 4, 8, 10, 11]);
  assert.deepEqual(calls, [[10, 2], [8, 1], [2, 3]]);
});

test("retention identifies expired event and upload-batch rows by date", () => {
  const receiver = loadReceiver();
  const cutoff = Date.parse("2026-06-01T00:00:00.000Z");
  const values = [
    ["2026-05-01T00:00:00.000Z"],
    ["2026-06-01T00:00:00.000Z"],
    ["2026-07-01T00:00:00.000Z"],
    ["invalid"]
  ];
  assert.deepEqual(Array.from(receiver.expiredSheetRows_(values, 0, cutoff)), [2]);
});

test("retention removes orphaned reservations and uses written time when present", () => {
  const receiver = loadReceiver();
  const cutoff = Date.parse("2026-06-01T00:00:00.000Z");
  const values = [
    ["reserved", "2026-05-01T00:00:00.000Z", "batch-1", ""],
    ["written", "2026-05-01T00:00:00.000Z", "batch-2", "2026-07-01T00:00:00.000Z"],
    ["written", "2026-04-01T00:00:00.000Z", "batch-3", "2026-05-02T00:00:00.000Z"]
  ];
  assert.deepEqual(Array.from(receiver.expiredIndexRows_(values, cutoff)), [2, 4]);
});

const plain = (value) => JSON.parse(JSON.stringify(value));

function fakeSheet() {
  const rows = [];
  const columns = () => rows.reduce((max, row) => Math.max(max, row.length), 0);
  return {
    rows,
    hideSheet() {},
    setNumberFormat() {},
    getMaxRows: () => 1000,
    getLastRow: () => rows.length,
    getLastColumn: columns,
    getRange(row, column, rowCount = 1, columnCount = 1) {
      return {
        getValues: () => Array.from({ length: rowCount }, (_, r) =>
          Array.from({ length: columnCount }, (_, c) => (rows[row - 1 + r] || [])[column - 1 + c] ?? "")),
        setValues: (values) => values.forEach((cells, r) => cells.forEach((value, c) => {
          rows[row - 1 + r] = rows[row - 1 + r] || [];
          rows[row - 1 + r][column - 1 + c] = value;
        })),
        setValue: (value) => {
          rows[row - 1] = rows[row - 1] || [];
          rows[row - 1][column - 1] = value;
        },
        setNumberFormat() {}
      };
    }
  };
}

function receiverWithSheets({ quota } = {}) {
  const sheets = {};
  const properties = {
    KEYWORD_HIGHLIGHTER_LOG_API_KEY: "secret",
    KEYWORD_HIGHLIGHTER_SPREADSHEET_ID: "sheet-id"
  };
  if (quota) properties.KEYWORD_HIGHLIGHTER_DAILY_QUOTA = JSON.stringify(quota);
  const triggers = [];
  const receiver = loadReceiver({
    LockService: { getScriptLock: () => ({ waitLock() {}, releaseLock() {} }) },
    PropertiesService: {
      getScriptProperties: () => ({
        getProperty: (key) => properties[key] ?? null,
        setProperty: (key, value) => { properties[key] = value; }
      })
    },
    SpreadsheetApp: {
      openById: () => ({
        getSheetByName: (name) => sheets[name] || null,
        insertSheet: (name) => (sheets[name] = fakeSheet())
      })
    },
    ScriptApp: {
      getProjectTriggers: () => [],
      newTrigger: () => ({ timeBased: () => ({ everyDays: () => ({ atHour: () => ({ create: () => triggers.push("created") }) }) }) })
    },
    ContentService: {
      MimeType: { JSON: "json" },
      createTextOutput: (text) => ({ text, setMimeType() { return this; } })
    }
  });
  return { receiver, sheets, properties, triggers };
}

function post(receiver, events, batchId = "batch-1") {
  const body = { apiKey: "secret", batchId, extensionVersion: "1.1.0", sentAt: "2026-10-04T10:00:00.000Z", reason: "alarm", events };
  return JSON.parse(receiver.doPost({ postData: { contents: JSON.stringify(body) } }).text);
}

test("doGet reports only the receiver version", () => {
  const { receiver } = receiverWithSheets();
  assert.deepEqual(JSON.parse(receiver.doGet().text), { success: true, receiverVersion: "1.7.0" });
});

test("API key comparison rejects wrong, missing and different-length keys", () => {
  const receiver = loadReceiver();
  assert.equal(receiver.constantTimeEquals_("secret", "secret"), true);
  assert.equal(receiver.constantTimeEquals_("secret", "secreT"), false);
  assert.equal(receiver.constantTimeEquals_("secret", "secret1"), false);
  assert.equal(receiver.constantTimeEquals_("", "secret"), false);
  assert.equal(receiver.constantTimeEquals_(undefined, "secret"), false);
});

test("sheetSafe_ escapes formula, tab and carriage-return prefixes", () => {
  const receiver = loadReceiver();
  for (const prefix of ["=", "+", "-", "@", "\t", "\r"]) {
    assert.equal(receiver.sheetSafe_(`${prefix}x`), `'${prefix}x`);
  }
  assert.equal(receiver.sheetSafe_("plain"), "plain");
  assert.equal(receiver.sheetSafe_(5), 5);
});

test("findRowsByIds_ matches IDs that Sheets coerced to numbers and ignores others", () => {
  const receiver = loadReceiver();
  const values = [["abc"], [12345], ["other"], ["abc"]];
  assert.deepEqual(plain(receiver.findRowsByIds_(values, ["abc", "12345", "missing"])), { abc: 2, 12345: 3 });
});

test("quota overflow is deferred: not accepted, not rejected, and not written", () => {
  const { receiver, sheets } = receiverWithSheets({ quota: { day: new Date().toISOString().slice(0, 10), total: 24999, shortcuts: 0 } });
  const first = validEvent({ eventId: "event-a" });
  const second = validEvent({ eventId: "event-b" });
  const response = post(receiver, [first, second]);

  assert.equal(response.success, true);
  assert.deepEqual(response.acceptedEventIds, ["event-a"]);
  assert.deepEqual(response.rejected, []);
  assert.deepEqual(response.deferred, [{ eventId: "event-b", reason: "RATE_LIMITED" }]);
  const written = sheets.Events_keywordHighlighter.rows.slice(1).map((row) => row[2]);
  assert.deepEqual(written, ["event-a"]);
  const batchRow = sheets.Upload_Batches_keywordHighlighter.rows[1];
  assert.equal(batchRow[8], "PARTIAL_SUCCESS");
  assert.equal(batchRow[9], '{"DEFERRED_RATE_LIMITED":1}');
});

test("a retried batch is idempotent and a bad key is refused", () => {
  const { receiver, sheets } = receiverWithSheets();
  const events = [validEvent({ eventId: "event-a" })];
  assert.deepEqual(post(receiver, events).acceptedEventIds, ["event-a"]);
  assert.deepEqual(post(receiver, events, "batch-2").acceptedEventIds, ["event-a"]);
  assert.equal(sheets.Events_keywordHighlighter.rows.length, 2);

  const denied = JSON.parse(receiver.doPost({ postData: { contents: JSON.stringify({ apiKey: "wrong", batchId: "b", extensionVersion: "1", sentAt: "2026-10-04T10:00:00.000Z", events: [] }) } }).text);
  assert.equal(denied.success, false);
  assert.equal(denied.errorCode, "UNAUTHORIZED");
});

test("the retention trigger is ensured on the first upload of a UTC day only", () => {
  const first = receiverWithSheets();
  post(first.receiver, [validEvent({ eventId: "event-a" })]);
  assert.equal(first.triggers.length, 1);

  const later = receiverWithSheets({ quota: { day: new Date().toISOString().slice(0, 10), total: 5, shortcuts: 0 } });
  post(later.receiver, [validEvent({ eventId: "event-b" })]);
  assert.equal(later.triggers.length, 0);
});
