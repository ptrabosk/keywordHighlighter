# Chrome Web Store submission copy

## Product name

Offsight Highlighter

## Short description

Highlight configured rule matches in inbound Operations messages.

## Detailed description

Offsight Highlighter helps Operations teams spot configured action phrases in inbound messages on the supported Operations workspace.

Features:

- Highlights deterministic rule matches directly in inbound message cards.
- Shows rule guidance when you hover over a highlight.
- Lets authorized users add custom keywords and hover guidance.
- Supports JSON export and import for custom keyword backups.
- Updates as new messages arrive in the single-page application.
- Runs only on `https://ui.attentivemobile.com/concierge/*`.

The extension is limited to exact `@attentivemobile.com` Chrome profile accounts. It checks the profile email locally and does not upload or store that email.

Usage and diagnostic events are optional. If enabled, only bounded operational information is sent over HTTPS: random identifiers, timestamps, extension version, supported surface, sanitized diagnostics, and highlight counts. Message text, matched text, page URLs, field contents, rule names, and unrelated browsing activity are not collected. Events are deleted after 90 days. Users can decline or disable this sharing in the extension UI; highlighting remains available for authorized users.

## Permission explanations

- `storage`: stores synchronized settings and, only with user consent, queues bounded operational events before upload.
- `alarms`: schedules retry attempts for consented operational uploads.
- `identity.email`: performs the local organization-account check. The email is not uploaded.
- `https://ui.attentivemobile.com/concierge/*`: highlights inbound message content in the supported Operations workspace.
- `https://script.google.com/macros/s/*` and `https://script.googleusercontent.com/macros/*`: send consented, sanitized operational events over HTTPS to the publisher's Apps Script receiver and follow its redirect.

## Privacy disclosure

The extension's first-run UI explains local profile authorization and optional telemetry before the user can use popup or options controls. The privacy policy is hosted at:

https://github.com/ptrabosk/keywordHighlighter/blob/main/docs/index.html

The publisher must also enter this same working URL in the Chrome Web Store Privacy tab and complete the data-use declarations and Limited Use certification before submission.

## Reviewer test instructions

1. Install the submitted ZIP in Chrome.
2. Open the extension popup and choose either usage-diagnostics option. Choosing “Use without usage diagnostics” is sufficient to test highlighting without telemetry.
3. Use a Chrome profile whose primary email is an exact `@attentivemobile.com` address.
4. Open `https://ui.attentivemobile.com/concierge/` and open a conversation containing an inbound message.
5. Confirm that configured phrases are highlighted, hover guidance appears, and the customer highlight count updates.
6. Open the popup to add, remove, export, and import a custom keyword.
7. Open extension options to add, edit, remove, export, and import custom keywords.

The extension requires an authorized test account and access to the supported Operations workspace. Provide those credentials through the private Chrome Web Store reviewer instructions field, never in this repository.
