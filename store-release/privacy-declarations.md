# Chrome Web Store privacy declarations

Use these declarations in the Chrome Web Store Developer Dashboard. Keep them synchronized with the hosted privacy policy and the packaged build.

## Privacy policy URL

`https://github.com/ptrabosk/keywordHighlighter/blob/main/docs/index.html`

Replace this with a stable public HTTPS URL under the publisher's control before submission if the GitHub repository or branch is not intended to be permanent.

## Data disclosures

Declare that the extension handles user data. Select only the categories the dashboard presents:

| Category | Declare | How it is handled | Purpose |
|---|---|---|---|
| Personally identifiable information — email address | No | The extension does not request, inspect, transmit, or store the user's Chrome profile email. | — |
| Website content | Yes, local only | Supported Operations page content is read locally to find configured rule matches and render highlights. Message text and matched text are not transmitted or stored by the extension. | Core highlighting feature |
| User activity / usage data | Yes | Bounded operational events may include random event/session IDs, timestamps, extension version, supported surface, event status, highlight counts, and sanitized diagnostics. | Operate, secure, troubleshoot, and measure reliability |
| User-generated content / settings | Yes, local/synchronized settings only | Custom keywords and hover guidance are stored as extension settings for the custom-keyword feature. They are not included in telemetry. | User-requested customization and backup/import/export |
| Web browsing activity / URLs | No | The extension does not collect or transmit page URLs, browsing history, or unrelated browsing activity. | — |
| Authentication information | No | The extension does not collect passwords, cookies, tokens, or login credentials. | — |

For each declared category, select the use that corresponds to providing or improving the extension's single purpose. Do not select advertising, advertising measurement, credit/lending, or sale to data brokers. If the dashboard asks whether data is sold, answer **No**. If it asks whether data is shared with third parties, answer **Yes, only Google Apps Script and Google Sheets as the publisher's infrastructure provider for operational telemetry**, and describe that transfer as necessary to provide, secure, troubleshoot, and measure the extension.

## Telemetry

Telemetry is described on this privacy policy page. The extension does not show a separate in-product telemetry disclosure or consent card.

## Retention and deletion

- Locally queued events: up to 7 days while awaiting upload.
- Uploaded events and deduplication identifiers: automatically deleted after 90 days.
- Deletion requests: `privacy@attentive.com`.

## Limited Use certification text

The use of information received by this extension complies with the Chrome Web Store User Data Policy, including the Limited Use requirements. User data is used only to provide or improve the extension's single purpose of highlighting configured rule matches and related operational reliability. It is transferred only to Google Apps Script and Google Sheets when necessary for that purpose, or when needed for security or legal compliance. It is never used or transferred for personalized, retargeted, or interest-based advertising, and it is not sold to data brokers or other information resellers. Human access is not permitted except with the user's express consent for specific support data, when required for security or abuse investigation, when required by law, or when data has been aggregated and anonymized for internal operations.

## Reviewer note

The extension reads supported page content locally because that is the user-facing highlighting feature. The optional receiver accepts only bounded allowlisted operational fields; it rejects page URLs, profile emails, message text, matched text, and unknown fields.
