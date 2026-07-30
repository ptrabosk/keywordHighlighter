# Keyword Highlighter Logging Receiver

This Apps Script receives privacy-safe operational logs from the Chrome extension and writes them to Google Sheets. The extension does not use Google OAuth.

## Setup

1. Create a Google Sheet.
2. Open **Extensions > Apps Script** from the sheet.
3. Add the contents of `Code.gs`.
4. In Apps Script, open **Project Settings > Script Properties** and add:
   - `KEYWORD_HIGHLIGHTER_LOG_API_KEY`: a locally generated shared key.
   - `KEYWORD_HIGHLIGHTER_SPREADSHEET_ID`: the ID from the Google Sheet URL.
5. Run `setupLoggingSheets()` once and approve spreadsheet access.
6. Deploy with **Deploy > New deployment > Web app**.
7. Set **Execute as** to **Me**.
8. Set **Who has access** to **Anyone**.
9. Copy the deployment `/exec` URL, not the `/dev` URL.
10. Put the `/exec` URL and matching local API key in `highlighter/src/logging/config.local.js` for the loadable extension folder. If needed, copy `highlighter/src/logging/config.local.example.js` to `highlighter/src/logging/config.local.js` first.

Google Workspace administrator policies may block anonymous web-app access. If that happens, the extension will keep logs queued locally and retry with backoff.

## Sheets

The script creates these tabs if missing:

- `Events_keywordHighlighter`
- `Upload_Batches_keywordHighlighter`
- hidden `Event_ID_Index_keywordHighlighter`

`Event_ID_Index_keywordHighlighter` is used for deduplication so retrying the same batch does not duplicate rows. It stores event ID reservation and write status under a script lock so interrupted uploads can be retried safely.
