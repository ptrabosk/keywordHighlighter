# Attentive Rule Highlighter

A Manifest V3 Chrome extension that highlights inbound Attentive Concierge message text using deterministic action rules from `highlighter/data/rules/opt_out_deterministic_rules.json`.

## What it does

- Runs on `https://ui.attentivemobile.com/concierge/*`.
- Targets inbound message copy with this default selector:

```css
div[class*="type-INBOUND"] p[class*="variant-caption"]
```

- Loads and flattens every highlightable rule object from `highlighter/data/rules/opt_out_deterministic_rules.json`.
- Highlights matches by action/category: `opt_out`, `fuzzy_opt_out`, `tmt`, `txt`, `reply`, `no_action`, `close`, and user-added patterns.
- Shows hover tooltips from editable entries in `highlighter/data/rules/rule_hover_text.json`.
- Lets users add custom patterns and hover text from the popup.
- Lets users export and import custom keyword backups as JSON.
- Watches the SPA DOM with a `MutationObserver`, so new conversation messages are highlighted without a page reload.
- Records only Shift+D, Shift+N, Shift+B, and Shift+C when at least one rule highlight is rendered, along with the logical highlight count. Other keys and message text are never recorded.
- Provides a focused popup for custom keywords and an options page for advanced settings.
- Queues privacy-safe operational logs locally and uploads them to the Google Apps Script receiver when a packaged build contains a valid `/exec` URL and ingestion token.

## Package for Chrome Web Store

The committed production manifest has only the Concierge and logging hosts. Build the Store ZIP with release credentials supplied through the process environment:

```powershell
$env:KEYWORD_HIGHLIGHTER_ENDPOINT_URL = "https://script.google.com/macros/s/DEPLOYMENT_ID/exec"
$env:KEYWORD_HIGHLIGHTER_API_KEY = "a-new-release-ingestion-token"
# Optional after the dashboard supplies the item's public key:
$env:KEYWORD_HIGHLIGHTER_STORE_PUBLIC_KEY = "BASE64_PUBLIC_KEY"
npm run package:store
```

The ZIP is written under ignored `dist/`. The shared ingestion token is extractable from the installed package and must be treated as abuse resistance, not user authentication. Rotate the previously exposed token before release.

For localhost QA, create a separate unpacked development package with `npm run package:dev`, then extract the resulting development ZIP and load that folder. The production package never includes localhost access. Set the same endpoint/token environment variables first if the development build should upload logs; otherwise it runs with uploads unconfigured.

See `docs/store-release/store-listing.md` and `docs/store-release/privacy-policy.md` before submission.

## Local install

Use only the `highlighter` folder as the Chrome extension package.

For local install:

1. Open Chrome or Edge.
2. Go to `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `highlighter` folder inside this project.
6. Open or refresh `https://ui.attentivemobile.com/concierge/*`.

The development package includes the prior local public key so its unpacked ID remains stable. The Store item supplies its own public key. If the IDs differ, export custom keywords from the local extension before switching and import the backup after Store installation.

## Custom keyword backups

Custom keywords and their hover text are stored in Chrome sync storage under `amhSettings`.

Use the popup buttons:

- **Export** downloads a JSON backup with `customKeywords` and `customKeywordTextByPattern`.
- **Import** restores those values from a backup JSON file.

## Logging setup

The Apps Script receiver lives in `google-apps-script/Code.gs` and writes to these tabs in the same spreadsheet/API setup used by `workflowExtension`:

- `Events_keywordHighlighter`
- `Upload_Batches_keywordHighlighter`
- hidden `Event_ID_Index_keywordHighlighter`

Committed logging configuration contains placeholders only. The packaging script injects credentials directly into the staged, statically imported `config.js`; source files are unchanged. Chrome extension service workers do not support dynamic imports, so `config.local.js` is not a runtime configuration mechanism. Use the deployed Apps Script `/exec` URL, not the Sheet ID or `/dev` URL.

## Tests

```sh
npm test
```

## Files

```text
keywordHighlighter/
|-- README.md
|-- package.json
|-- google-apps-script/
|   |-- Code.gs
|   `-- README.md
|-- test/
|   `-- logging.test.js
`-- highlighter/
    |-- manifest.json
    |-- background.js
    |-- content.css
    |-- content.js
    |-- options.css
    |-- options.html
    |-- options.js
    |-- popup.css
    |-- popup.html
    |-- popup.js
    |-- settings-ui.js
    |-- settings.js
    |-- icons/
    |-- data/rules/
    |   |-- consolidated_rules.json
    |   |-- opt_out_deterministic_rules.json
    |   `-- rule_hover_text.json
    `-- src/logging/
```

## Notes

- The extension skips procedural/non-highlightable deterministic rules and invalid JavaScript regex patterns, then logs skipped regexes to the console.
- For overlapping matches, it keeps the earliest match, then the longest match, then the category priority.
- `close` and whole-message rules only highlight when the match is the whole inbound message body, ignoring surrounding whitespace and simple punctuation.
- If Attentive changes its DOM, update the selector in the options page rather than changing code.
