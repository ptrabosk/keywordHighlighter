# Offisght Operations Rule Highlighter Privacy Policy

Last updated: August 14, 2026

Offisght Operations Rule Highlighter highlights rule matches in inbound message text and measures four response shortcuts to evaluate whether those highlights support the response workflow.

## Data collected

When at least one rule keyword is rendered as highlighted and the user presses Shift+D, Shift+N, Shift+B, or Shift+C, the extension records:

- the normalized shortcut;
- the number of rendered logical rule highlights, capped at 1,000;
- an event timestamp, random event and session identifiers, extension version, and the canonical supported page surface.

The extension does not record other keys, message text, matched text, rule names, selected text, field contents, or whether extra modifier keys were held. A qualifying shortcut is recorded even when focus is in a text field.

The extension also records privacy-limited operational events needed to diagnose initialization, rule loading, rendering, settings, storage, and upload failures. Error strings are sanitized before storage.

## Use, storage, and sharing

Events are used only to operate, secure, troubleshoot, and measure the effectiveness of the highlighter. They are queued in Chrome extension storage and sent over HTTPS to a Google Apps Script endpoint that writes to a restricted Google Sheet controlled by the extension publisher. Data is not sold, used for advertising, or shared with unrelated third parties.

Normal local events are retained for up to 7 days while awaiting upload. Uploaded shortcut events and their deduplication identifiers are automatically deleted after 90 days. Google may process data as the infrastructure provider under its applicable terms.

## Security and deletion requests

Uploads use HTTPS, strict field validation, daily ingestion quotas, and a rotatable ingestion token. The token limits casual abuse but is not used to identify users. Access to the receiving Sheet and Apps Script project is restricted to authorized maintainers.

Before publishing, the publisher must add a monitored contact method here for privacy questions and deletion requests, then host this exact policy at a stable public HTTPS URL.

The use of information received by this extension complies with the Chrome Web Store User Data Policy, including the Limited Use requirements.
