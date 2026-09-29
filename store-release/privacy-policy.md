# Offsight Highlighter Privacy Policy

Last updated: September 28, 2026

Offsight Highlighter highlights configured rule matches on its supported work page and collects limited usage and diagnostic information needed to operate the extension.

## Data collected

The extension first checks the signed-in Chrome profile locally. It enables its features only when the profile email has the exact `attentivemobile.com` domain; the email is used only for this authorization decision and is not uploaded or stored by the extension. The extension requests the `identity.email` permission for this local check.

The extension may collect limited usage information associated with highlighted messages only after the user makes an affirmative choice in the extension UI:

- the number of rendered rule highlights, capped at 1,000;
- an event timestamp, random event and session identifiers, extension version, and the supported page surface.

The extension does not collect message text, matched text, page URLs, profile emails, rule names, selected text, field contents, text entered into editable fields, or unrelated browsing activity.

The extension may also collect privacy-limited technical diagnostics needed to diagnose initialization, rule loading, rendering, settings, storage, and upload failures. Error strings are sanitized before storage.

## Use, storage, and sharing

Information is used only to operate, secure, troubleshoot, and evaluate the extension. It is queued in Chrome extension storage and sent over HTTPS to a Google Apps Script endpoint that writes to a restricted Google Sheet controlled by the extension publisher. Data is not sold, used for advertising, or shared with unrelated third parties.

Normal local events are retained for up to 7 days while awaiting upload. Uploaded events and their deduplication identifiers are automatically deleted after 90 days. Google may process data as the infrastructure provider under its applicable terms.

If the user declines or later disables usage and diagnostic sharing, highlighting continues for an authorized account, no new telemetry is queued, and locally queued telemetry is deleted.

## Security and deletion requests

Uploads use HTTPS, strict field validation, daily ingestion quotas, and restricted access to the receiving Sheet and Apps Script project.

For privacy questions and deletion requests, contact [privacy@attentive.com](mailto:privacy@attentive.com). This policy must be hosted at a stable public HTTPS URL before publishing.

The use of information received by this extension complies with the Chrome Web Store User Data Policy, including the Limited Use requirements.
