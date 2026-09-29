# Offsight Highlighter Privacy Policy

Last updated: September 29, 2026

Offsight Highlighter highlights configured rule matches on its supported work page and collects limited usage and diagnostic information needed to operate and improve the extension.

## Data collected

The extension does not request or inspect the user's Chrome profile identity. Operational events are not associated with an email address or other Google account identifier.

The extension collects limited operational information about the highlighting feature:

- the number of rendered rule highlights, capped at 1,000;
- an event timestamp, random event and session identifiers, extension version, and the supported page surface;
- bounded technical event fields such as event type, severity, result, duration, sanitized error code/message, and allowlisted numeric or status metadata.

The extension reads supported page content locally to perform its highlighting feature, but does not transmit or store message text, matched text, page URLs, profile emails, rule names, selected text, field contents, text entered into editable fields, or unrelated browsing activity. Custom keywords and their hover guidance are user settings stored by Chrome for the extension's settings feature; they are not included in telemetry.

The extension may also collect privacy-limited technical diagnostics needed to diagnose initialization, rule loading, rendering, settings, storage, and upload failures. Error strings are sanitized before storage.

## Use, storage, and sharing

Information is used only to provide, secure, troubleshoot, and measure the performance and reliability of the extension's highlighting feature. It is queued in Chrome extension storage and sent over HTTPS to a Google Apps Script endpoint that writes to a restricted Google Sheet controlled by the extension publisher. Google Apps Script and Google Sheets are the only service providers receiving operational telemetry. Data is not sold, used for advertising, or shared with unrelated third parties.

Normal local events are retained for up to 7 days while awaiting upload. Uploaded events and their deduplication identifiers are automatically deleted after 90 days. Google may process data as the infrastructure provider under its applicable terms.

The complete data-use disclosure is provided on this privacy policy page.

## Security and deletion requests

Uploads use HTTPS, strict field validation, daily ingestion quotas, and restricted access to the receiving Sheet and Apps Script project. The publisher does not permit people to read telemetry except when the user expressly authorizes support access to specific data, when needed for security or abuse investigation, when required by law, or when data has been aggregated and anonymized for internal operations.

For privacy questions and deletion requests, contact [privacy@attentive.com](mailto:privacy@attentive.com). This policy must be hosted at a stable public HTTPS URL before publishing.

The use of information received by this extension complies with the Chrome Web Store User Data Policy, including the Limited Use requirements. User data is used only to provide or improve the extension's single purpose, is transferred only when necessary for that purpose or for security or legal compliance, is never used or transferred for personalized advertising, and is not sold to data brokers or other information resellers.
