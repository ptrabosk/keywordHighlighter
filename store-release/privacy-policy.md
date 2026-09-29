# Offsight Highlighter Privacy Policy

Last updated: September 29, 2026

Offsight Highlighter highlights configured rule matches on its supported work page and collects limited usage and diagnostic information needed to operate and improve the extension.

## Data collected

The extension does not request or inspect the user's Chrome profile identity. Operational events are not associated with an email address or other Google account identifier.

The extension collects limited operational information about the highlighting feature:

- the number of rendered rule highlights, capped at 1,000;
- an event timestamp, random event and session identifiers, extension version, and the supported page surface;
- the full URL of the supported Operations page when a highlight is detected, a supported shortcut is pressed, or a content-script error occurs; this URL may contain conversation identifiers, query parameters, or fragments;
- which supported shortcut was pressed (`Shift+D`, `Shift+N`, `Shift+B`, or `Shift+C`); the extension does not record arbitrary keystrokes or text typed by the user;
- bounded technical event fields such as event type, severity, result, duration, sanitized error code/message, and allowlisted numeric or status metadata.

The extension reads supported page content, including inbound messages that may be personal communications, locally to perform its highlighting feature. It does not separately add message text, matched text, profile emails, rule names, selected text, field contents, text entered into editable fields, or arbitrary keystrokes to telemetry. URL collection is limited to the supported Operations page and the operational events described above; any value that the supported site embeds in that URL is included as part of the full URL. The extension does not collect unrelated browsing activity.

Custom keywords and their hover guidance are stored in Chrome Sync storage so Chrome can synchronize them across browsers where the user is signed in and extension synchronization is enabled. They are not included in operational telemetry. CSV import reads a file selected by the user locally, and CSV export creates a local download; imported or exported keyword content is not sent to the publisher.

The extension may also collect privacy-limited technical diagnostics needed to diagnose initialization, rule loading, rendering, settings, storage, and upload failures. Error strings are sanitized before storage.

## Use, storage, and sharing

Information is used only to provide, secure, troubleshoot, and measure the performance and reliability of the extension's highlighting feature. Operational telemetry is queued in Chrome extension storage and sent over HTTPS to a Google Apps Script endpoint that writes to a restricted Google Sheet controlled by the extension publisher. Google provides Chrome Sync for synchronized settings and Google Apps Script and Google Sheets for operational telemetry. Data is not sold, used for advertising, or shared with unrelated third parties.

Locally queued informational events are scheduled for deletion after 7 days, warnings after 14 days, and errors after 30 days, and are removed by the next scheduled maintenance run. Storage-pressure cleanup may remove them sooner. Uploaded events, deduplication identifiers, and upload-batch audit records are automatically deleted after 90 days. Batch audit records contain the batch identifier, receipt time, event and acceptance counts, first and last event timestamps, extension version, processing result, and aggregate rejection reasons. Synchronized settings remain until the user removes or resets them, subject to the user's Chrome Sync settings and Google's applicable terms.

The complete data-use disclosure is provided on this privacy policy page.

## Security and deletion requests

Uploads use HTTPS, an allowlisted and bounded event schema, daily ingestion quotas, and restricted access to the receiving Sheet and Apps Script project. Unknown fields and URLs outside the supported Operations page are rejected, and the extension sanitizes bounded diagnostic strings before upload. The publisher does not permit people to read telemetry except when the user expressly authorizes support access to specific data, when needed for security or abuse investigation, when required by law, or when data has been aggregated and anonymized for internal operations.

For privacy questions and deletion requests, contact [privacy@attentive.com](mailto:privacy@attentive.com). Because operational telemetry contains no Chrome or Google account identifier, the publisher may need a supported-page URL or an event, session, or batch identifier to locate specific records and may be unable to associate other records with a requester.

The use of information received by this extension complies with the Chrome Web Store User Data Policy, including the Limited Use requirements. User data is used only to provide or improve the extension's single purpose, is transferred only when necessary for that purpose or for security or legal compliance, is never used or transferred for personalized advertising, and is not sold to data brokers or other information resellers.
