# Offsight Highlighter

A Manifest V3 Chrome extension that highlights inbound message text using the schema-v2 deterministic action registry in `highlighter/data/rules/opt_out_rules.json`.

## What it does

- Runs on the supported Operations web application at `https://ui.attentivemobile.com/concierge/*`.
- Targets inbound message copy with this default selector:

```css
div[class*="type-INBOUND"] p[class*="variant-caption"]
```

- Validates and loads all 214 built-in rules from `highlighter/data/rules/opt_out_rules.json`; startup fails if the registry does not contain exactly 214 rules.
- Colors each matching inbound message by its winning action: `opt_out`, `fuzzy_opt_out`, `tmt`, `txt`, `reply`, `close`, or a user-added keyword. Categories are always on; there is no per-category toggle.
- Classifies a message once as a whole. When a message has several paragraphs, the highest-priority match across all of them wins.
- Highlights escalation bullets in inbound and brand notes.
- Classifies replies to the Hot Topic frequency survey from the preceding brand prompt. Only the inbound reply is highlighted, and only when it is nothing but a choice (`4`/`four`/`never` is an opt-out; `1`/`2`/`3`/`same`/`weekly`/`monthly` is close). Any other reply is left to the regular rules.
- Shows the category label (for example "Opt out") when hovering over a highlighted message or escalation note.
- Lets users add custom keywords (at least 3 characters, up to 40, within Chrome's 8 KB sync-storage item limit) from the popup. Keywords match as case-insensitive substrings.
- Lets users export and import custom keyword backups as CSV.
- Watches the SPA DOM with a `MutationObserver`, so new conversation messages are highlighted without a page reload.
- Documents local data practices and operational telemetry in the published privacy policy.
- Records limited usage information as described in the published privacy policy. Each highlighted message is reported once per page session (re-renders do not resend it). A `Shift+D/N/B/C/E` press is reported when at least one message or note highlight is on the page. Full supported-page URLs are recorded for highlight, shortcut, and content-error events; message text, profile emails, field contents, and arbitrary keystrokes are not separately added to telemetry, though values embedded by the site in a full URL are included as part of that URL. URLs from other sites and unrelated browsing activity are never recorded.
- Provides a focused popup and options page for adding and editing custom keywords.
- Queues privacy-safe operational logs locally and uploads them to the Google Apps Script receiver when a packaged build contains a valid `/exec` URL and ingestion token.

## Package for Chrome Web Store

The committed production manifest has only the supported Operations and logging hosts. Build the Store ZIP with release credentials supplied through the process environment:

```powershell
$env:KEYWORD_HIGHLIGHTER_ENDPOINT_URL = "https://script.google.com/macros/s/DEPLOYMENT_ID/exec"
$env:KEYWORD_HIGHLIGHTER_API_KEY = "a-new-release-ingestion-token"
# Optional after the dashboard supplies the item's public key:
$env:KEYWORD_HIGHLIGHTER_STORE_PUBLIC_KEY = "BASE64_PUBLIC_KEY"
npm run package:store
```

The ZIP is written under ignored `dist/`. The shared ingestion token is extractable from the installed package and must be treated as abuse resistance, not user authentication. Rotate the previously exposed token before release.

For localhost QA, create a separate unpacked development package with `npm run package:dev`, then extract the resulting development ZIP and load that folder. The production package never includes localhost access. Set the same endpoint/token environment variables first if the development build should upload logs; otherwise it runs with uploads unconfigured.

Use `store-release/store-listing.md` as the finalized listing and reviewer-instructions source. Host `docs/index.html` at the public HTTPS URL entered in the Store privacy-policy field before submission.

## Local install

Use only the `highlighter` folder as the Chrome extension package. The tracked logging configuration contains safe placeholders, so a clean checkout can be loaded unpacked without additional generated files.

For local install:

1. Open Chrome or Edge.
2. Go to `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `highlighter` folder inside this project.
6. Open or refresh the supported Operations page at `https://ui.attentivemobile.com/concierge/*`.

The development package includes the prior local public key so its unpacked ID remains stable. The Store item supplies its own public key. If the IDs differ, export custom keywords from the local extension before switching and import the backup after Store installation.

## Custom keyword backups

Custom keywords are stored in Chrome sync storage under `amhSettings`.

Use the popup buttons:

- **Export** downloads a CSV file with a single `keyword` column.
- **Import** restores keywords from a CSV whose first row is exactly `keyword`. Older backups with a `keyword,hover text` header still import; the hover text column is ignored.

## Logging setup

The Apps Script receiver lives in `google-apps-script/Code.gs` and writes to these tabs in the same spreadsheet/API setup used by `workflowExtension`:

- `Events_keywordHighlighter`
- `Upload_Batches_keywordHighlighter`
- hidden `Event_ID_Index_keywordHighlighter`

Both `config.js` and `config.example.js` are tracked and contain placeholders only; `config.local.js` is the ignored file. The packaging script stages `config.js` (falling back to the example if it is missing), and Store builds inject the endpoint URL and ingestion token into that staged copy from the `KEYWORD_HIGHLIGHTER_ENDPOINT_URL` and `KEYWORD_HIGHLIGHTER_API_KEY` environment variables. Local source files are unchanged, and credentials never enter Git. Chrome extension service workers do not support dynamic imports, so `config.local.js` is not a runtime configuration mechanism. Use the deployed Apps Script `/exec` URL, not the Sheet ID or `/dev` URL.

## Tests

```sh
npm test
```

For coverage (Istanbul JSON in the ignored `coverage/` folder) and a health report that uses it:

```sh
npm run coverage
fallow health --coverage coverage/coverage-final.json
```

Without `--coverage`, fallow estimates test coverage and over-reports risk, because the tests load the content-side scripts through `vm` rather than imports. The content script, popup, and background worker run only in the browser and are not exercised by the test suite.

## Files

```text
keywordHighlighter/
|-- README.md
|-- package.json
|-- google-apps-script/
|   |-- Code.gs
|   `-- README.md
|-- docs/
|   |-- index.html
|   `-- store-assets/
|-- scripts/
|   `-- package-extension.ps1
|-- store-release/
|   |-- privacy-policy.md
|   `-- store-listing.md
|-- test/
|   `-- *.test.js
`-- highlighter/
    |-- manifest.json
    |-- background.js
    |-- content.css
    |-- content.js
    |-- options.css
    |-- options.html
    |-- options.js
    |-- popup.css
    |-- custom-keywords-init.js
    |-- popup.html
    |-- popup.js
    |-- settings.js
    |-- icons/
    |-- data/rules/
    |   `-- opt_out_rules.json
    |-- src/highlight/
    `-- src/logging/
```

## Notes

- The extension validates the complete packaged registry at startup and reports an initialization error if its schema or a rule is invalid.
- Match priority: real tapback reactions and emoji-only replies first, then Hot Topic replies, then category priority (`opt_out` < `fuzzy_opt_out` < `txt` < `tmt` < `reply` < `close` < user-added). Within the same priority, the earliest and then the longest match wins. A reaction only counts when the whole message is a tapback such as `Loved "…"`; any extra text is classified by the regular rules.
- `full_match`, `exact`, and `exact_set` rules require the complete selected target; `regex_search` and `bounded_phrase` rules may match within it.
- If the supported Operations application changes its DOM, update the selector in code rather than changing the custom-keyword editor.
