# Chrome Web Store privacy declarations

Use these declarations in the Chrome Web Store Developer Dashboard. Keep them synchronized with the hosted privacy policy and the packaged build.

## Privacy policy URL

`https://ptrabosk.github.io/keywordHighlighter/`

Confirm that this rendered HTTPS page opens without authentication immediately before submission.

## Data disclosures

Declare that the extension handles user data. Select only the categories the dashboard presents:

| Category | Declare | How it is handled | Purpose |
|---|---|---|---|
| Personally identifiable information — email address | No | The extension does not request, inspect, transmit, or store the user's Chrome profile email. | — |
| Website content | Yes, local only | Supported Operations page content is read locally to find configured rule matches and render highlights. Message text and matched text are not separately added to telemetry; any value embedded by the site in a collected full URL is included as part of that URL. | Core highlighting feature |
| Personal communications | Yes, local only | Inbound messages on the supported Operations page are read locally to find configured rule matches. Their contents are not transmitted or stored by the extension. | Core highlighting feature |
| User activity / usage data | Yes | Bounded operational events may include random event/session IDs, timestamps, extension version, supported surface, event status, highlight counts, the supported shortcut pressed (`Shift+D/N/B/C/E` only), and sanitized diagnostics. Arbitrary keystrokes and typed text are not recorded. | Operate, secure, troubleshoot, and measure reliability |
| User-generated content / settings | Yes, local/synchronized settings only | Custom keywords are stored in Chrome Sync storage. User-selected CSV imports are read locally and CSV exports are downloaded locally. These contents are not included in telemetry. | User-requested customization, synchronization, and backup/import/export |
| Web browsing activity / URLs | Yes | Highlight detections, supported shortcut presses, and content-script errors include the full current URL on `https://ui.attentivemobile.com/concierge/*`. The URL may contain conversation identifiers, query parameters, or fragments. No URLs from other sites or general browsing history are collected. | Diagnose highlighting behavior and failures on the supported workspace |
| Authentication information | No | The extension does not collect passwords, cookies, tokens, or login credentials. | — |

For each declared category, select the use that corresponds to providing or improving the extension's single purpose. Do not select advertising, advertising measurement, credit/lending, or sale to data brokers. If the dashboard asks whether data is sold, answer **No**. If it asks whether data is shared with third parties, answer **Yes** and identify Google as the provider of Chrome Sync for synchronized settings and Google Apps Script and Google Sheets for operational telemetry. Describe those transfers as necessary to provide, secure, troubleshoot, synchronize settings for, and measure the extension.

## Telemetry

Telemetry is described on this privacy policy page. The extension does not show a separate in-product telemetry disclosure or consent card.

## Retention and deletion

- Locally queued events: informational events are scheduled for deletion after 7 days, warnings after 14 days, and errors after 30 days; cleanup runs with scheduled upload maintenance and may occur sooner under storage pressure.
- Uploaded events, deduplication identifiers, and upload-batch audit records: automatically deleted after 90 days.
- Synchronized custom settings: retained until the user removes or resets them, subject to Chrome Sync settings and Google's applicable terms.
- Deletion requests: `privacy@attentive.com`.

## Limited Use certification text

The use of information received by this extension complies with the Chrome Web Store User Data Policy, including the Limited Use requirements. User data is used only to provide or improve the extension's single purpose of highlighting configured rule matches and related operational reliability. It is transferred only to Google Chrome Sync for synchronized settings and to Google Apps Script and Google Sheets for operational telemetry when necessary for that purpose, or when needed for security or legal compliance. It is never used or transferred for personalized, retargeted, or interest-based advertising, and it is not sold to data brokers or other information resellers. Human access is not permitted except with the user's express consent for specific support data, when required for security or abuse investigation, when required by law, or when data has been aggregated and anonymized for internal operations.

## Reviewer note

The extension reads supported page content, including inbound messages, locally because that is the user-facing highlighting feature. The receiver accepts the current supported-page URL only for highlight detections, supported shortcut presses, and errors; it has no fields for profile emails, message text, or matched text and rejects unknown fields. The extension sanitizes bounded diagnostic strings before sending them.
