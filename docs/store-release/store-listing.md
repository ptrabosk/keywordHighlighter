# Chrome Web Store Submission

## Single purpose

Offsight Operations Rule Highlighter highlights deterministic rule matches in inbound messages and measures four disclosed response shortcuts when highlights are present so the publisher can evaluate the highlighter's usefulness.

## Privacy disclosure

When a rule keyword is highlighted, the extension records Shift+D, Shift+N, Shift+B, or Shift+C, including in editable fields, and uploads the normalized shortcut plus the logical highlight count. It never records message text, matched text, field contents, rule identity, or other keys. Shortcut events are retained for 90 days.

Declare website interaction and the canonical supported browsing surface in the Privacy tab. Link the hosted privacy policy and affirm Limited Use compliance. The policy must contain a real monitored privacy contact before submission.

## Permission justifications

- `storage`: synchronizes settings and queues bounded operational events before upload.
- `alarms`: schedules retrying queued uploads.
- `specific site url`: highlights inbound messages and observes the four disclosed shortcuts only when a rule highlight is rendered.
- `https://script.google.com/*` and `https://script.googleusercontent.com/*`: uploads sanitized events to the configured receiver over HTTPS and follows Apps Script redirects.
