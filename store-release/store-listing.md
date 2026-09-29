# Chrome Web Store submission copy

## Product name

Offsight Highlighter

## Short description

Highlight configured rule matches in inbound Operations messages.

## Detailed description

Offsight Highlighter helps Operations teams spot configured action phrases in inbound messages on the supported Operations workspace.

The extension reads supported workspace content locally to find configured matches and render highlights. It does not upload or store message text, matched text, page URLs, or unrelated browsing activity.

Features:

- Highlights deterministic rule matches directly in inbound message cards.
- Shows rule guidance when you hover over a highlight.
- Lets users add custom keywords and hover guidance.
- Supports CSV export and import for custom keyword backups using `keyword` and `hover text` columns.
- Updates as new messages arrive in the single-page application.
- Runs only on `https://ui.attentivemobile.com/concierge/*`.

The extension does not request or inspect Chrome profile identity. Operational events are not associated with an email address or Google account identifier. Custom keywords and hover guidance are stored as extension settings and are not included in telemetry.

The extension sends only bounded operational information over HTTPS: random identifiers, timestamps, extension version, supported surface, sanitized diagnostics, and highlight counts. Message text, matched text, page URLs, field contents, rule names, and unrelated browsing activity are not collected. Events are deleted after 90 days. See the privacy policy for the complete data-use disclosure.

## Permission explanations

- `storage`: stores synchronized settings and queues bounded operational events before upload.
- `alarms`: schedules retry attempts for operational uploads.
- `https://ui.attentivemobile.com/concierge/*`: highlights inbound message content in the supported Operations workspace.
- `https://script.google.com/macros/s/*` and `https://script.googleusercontent.com/macros/*`: send sanitized operational events over HTTPS to the publisher's Apps Script receiver and follow its redirect.

## Privacy disclosure

The privacy policy contains the extension's complete data-use disclosure and is hosted at:

https://github.com/ptrabosk/keywordHighlighter/blob/main/docs/index.html

The publisher must also enter this same working URL in the Chrome Web Store Privacy tab and complete the data-use declarations and Limited Use certification before submission.

## Reviewer test instructions

1. Install the submitted ZIP in Chrome.
2. Open `https://ui.attentivemobile.com/concierge/` and open a conversation containing an inbound message.
3. Confirm that configured phrases are highlighted, hover guidance appears, and the customer highlight count updates.
4. Open the popup to add, remove, export, and import a custom keyword.
5. Open extension options to add, edit, remove, export, and import custom keywords.

The extension does not require a particular Chrome profile. Reviewers still need access to the supported Operations workspace; provide any required workspace credentials through the private Chrome Web Store reviewer instructions field, never in this repository.
