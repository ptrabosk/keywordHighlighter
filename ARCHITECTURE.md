# Architecture

The Offisght Operations Rule Highlighter is a Manifest V3 extension scoped to the supported Operations web application. Its content script loads deterministic rules, wraps matching inbound text in `.amh-highlight` spans, and observes the single-page application for changes. Popup and options pages manage synchronized settings and custom keywords.

Shortcut telemetry is owned by `src/highlight/shortcutTelemetry.js` and the content script. The helper recognizes only four trusted Shift combinations and counts rendered logical rule highlights. The content script sends a sanitized event only when that count is positive. It does not prevent or alter the host page's keyboard handling.

The background service worker owns the local event queue, retry policy, and HTTPS uploads. The logging sanitizer is the client-side data boundary: only the approved operational event allowlist is queued, session lifecycle events are retained, shortcut events can contain only a normalized shortcut and a bounded highlight count, and other diagnostics use a bounded metadata allowlist. Google Apps Script is the server-side boundary. It authenticates with a rotatable shared ingestion token, validates the same event contract, applies daily quotas under a script lock, writes accepted rows to Google Sheets without Page Host, and deletes shortcut rows plus their deduplication IDs after 90 days.

Production and development permissions are separated at packaging time. `highlighter/manifest.json` is the Store-safe source manifest. `scripts/package-extension.ps1` produces a deterministic Store ZIP with release configuration or a localhost-capable development ZIP with the previous local public key.
