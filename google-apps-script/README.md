# Keyword Highlighter Logging Receiver

This Apps Script receives privacy-safe operational logs from the Chrome extension and writes them to Google Sheets. The extension does not use Google OAuth.

## Setup

1. Create a Google Sheet.
2. Open **Extensions > Apps Script** from the sheet.
3. Add the contents of `Code.gs`.
4. In Apps Script, open **Project Settings > Script Properties** and add:
   - `KEYWORD_HIGHLIGHTER_LOG_API_KEY`: a locally generated shared key.
   - `KEYWORD_HIGHLIGHTER_SPREADSHEET_ID`: the ID from the Google Sheet URL.
5. Run `setupLoggingSheets()` once and approve spreadsheet and trigger access. This also installs the daily shortcut-retention job.
6. Deploy with **Deploy > New deployment > Web app**.
7. Set **Execute as** to **Me**.
8. Set **Who has access** to **Anyone**.
9. Copy the deployment `/exec` URL, not the `/dev` URL.
10. Provide the `/exec` URL and matching token through the packaging environment variables documented in the root README. Packaging injects them only into the staged ZIP.

The shared key is embedded in a deployed extension and can be extracted by an installer. It is abuse resistance, not user authentication. Rotate any previously committed key before deployment and rotate again if abuse is suspected.

Google Workspace administrator policies may block anonymous web-app access. If that happens, the extension will keep logs queued locally and retry with backoff.

## Sheets

The script creates these tabs if missing:

- `Events_keywordHighlighter`
- `Upload_Batches_keywordHighlighter`
- hidden `Event_ID_Index_keywordHighlighter`

`Events_keywordHighlighter` uses this header order:

`Received At`, `Event Timestamp`, `Event ID`, `Session ID`, `Event Type`, `Severity`, `Result`, `Surface`, `Page URL`, `Profile Email`, `Rule Source`, `Duration Ms`, `Extension Version`, `Error Code`, `Error Message`, `Metadata JSON`, `Batch ID`.

Only session lifecycle, popup/rules activity, highlight, failure, shortcut, and upload-failure events are accepted. `Page Host` is intentionally not stored; troubleshooting context is carried by the sanitized page URL, profile email, and bounded metadata.

`Event_ID_Index_keywordHighlighter` is used for deduplication so retrying the same batch does not duplicate rows. It stores event ID reservation and write status under a script lock so interrupted uploads can be retried safely.

The receiver accepts at most 25,000 new events and 10,000 new shortcut events per UTC day. Events beyond either limit are rejected as `RATE_LIMITED`. Duplicate retries of already-written events remain idempotent and do not consume quota.

`purgeExpiredShortcutEvents()` runs daily and removes shortcut rows and their deduplication IDs after 90 days. Other event retention is unchanged. Run the function manually after deployment to verify its authorization and inspect the execution log.
