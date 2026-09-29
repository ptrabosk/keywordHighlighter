# Chrome Web Store submission copy

## Product name

Offsight Highlighter

## Short description

Highlight configured rule matches in inbound Operations messages.

## Detailed description

Offsight Highlighter helps Operations teams spot configured action phrases in inbound messages on the supported Operations workspace.

The extension reads supported workspace content, including inbound messages, locally to find configured matches and render highlights. It does not upload or store message text or matched text. For debugging, highlight detections, supported shortcut presses, and content-script errors include the full URL of the current supported Operations page; URLs from other sites and general browsing history are not collected.

Features:

- Highlights deterministic rule matches directly in inbound message cards.
- Shows rule guidance when you hover over a highlight.
- Lets users add custom keywords and hover guidance.
- Supports CSV export and import for custom keyword backups using `keyword` and `hover text` columns.
- Updates as new messages arrive in the single-page application.
- Runs only on `https://ui.attentivemobile.com/concierge/*`.

The extension does not request or inspect Chrome profile identity. Operational events are not associated with an email address or Google account identifier. Custom keywords and hover guidance use Chrome Sync storage so they can follow the user across synchronized Chrome browsers; they are not included in telemetry. CSV imports and exports are processed locally.

The extension sends only bounded operational information over HTTPS: random identifiers, timestamps, extension version, supported surface, the current supported-page URL for highlight/shortcut/error events, sanitized diagnostics, highlight counts, and which supported shortcut (`Shift+D/N/B/C`) was pressed. It does not separately add arbitrary keystrokes, typed text, message text, matched text, field contents, or rule names to telemetry; any value embedded by the supported site in the full URL is included as part of that URL. URLs from other sites and unrelated browsing activity are not collected. Uploaded telemetry and related batch and deduplication records are deleted after 90 days. See the privacy policy for the complete data-use disclosure.

## Permission explanations

- `storage`: stores synchronized settings and queues bounded operational events before upload.
- `alarms`: schedules retry attempts for operational uploads.
- `https://ui.attentivemobile.com/concierge/*`: highlights inbound message content in the supported Operations workspace.
- `https://script.google.com/macros/s/*` and `https://script.googleusercontent.com/macros/*`: send sanitized operational events over HTTPS to the publisher's Apps Script receiver and follow its redirect.

## Privacy disclosure

The privacy policy contains the extension's complete data-use disclosure and is hosted at:

https://ptrabosk.github.io/keywordHighlighter/

The publisher must also enter this same working URL in the Chrome Web Store Privacy tab and complete the data-use declarations and Limited Use certification before submission.

## Reviewer test instructions

1. Install the submitted ZIP in Chrome.
2. Open `https://ui.attentivemobile.com/concierge/` and open a conversation containing an inbound message.
3. Confirm that configured phrases are highlighted, hover guidance appears, and the customer highlight count updates.
4. Open the popup to add, remove, export, and import a custom keyword.
5. Open extension options to add, edit, remove, export, and import custom keywords.

The extension does not require a particular Chrome profile. Reviewers still need access to the supported Operations workspace; provide any required workspace credentials through the private Chrome Web Store reviewer instructions field, never in this repository.
