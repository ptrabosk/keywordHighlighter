# Attentive Rule Highlighter

A Manifest V3 Chrome extension that highlights inbound Attentive Concierge message text using regex rules from `highlighter/data/rules/consolidated_rules.json`.

## What it does

- Runs on `https://ui.attentivemobile.com/concierge/*`.
- Targets inbound message copy with this default selector:

```css
div[class*="type-INBOUND"] p[class*="variant-caption"]
```

- Loads and flattens every rule object that has `pattern` and `tag` in `highlighter/data/rules/consolidated_rules.json`.
- Highlights matches by tag/category: `opt_out`, `fuzzy_opt_out`, `tmt`, `txt`, `not_opt_out`, and custom keywords.
- Shows a hover tooltip with the category guidance and matched text.
- Lets users add custom keywords from the popup.
- Watches the SPA DOM with a `MutationObserver`, so new conversation messages are highlighted without a page reload.
- Provides a focused popup for custom keywords and an options page for advanced settings.
- Queues privacy-safe operational logs locally and uploads them to the Google Apps Script receiver when `highlighter/src/logging/config.local.js` contains a valid `/exec` URL and API key.

## Upload or install

Use only the `highlighter` folder as the Chrome extension package.

For local install:

1. Open Chrome or Edge.
2. Go to `chrome://extensions`.
3. Enable **Developer mode**.
4. Click **Load unpacked**.
5. Select the `highlighter` folder inside this project.
6. Open or refresh `https://ui.attentivemobile.com/concierge/*`.

## Logging setup

The Apps Script receiver lives in `google-apps-script/Code.gs` and writes to these tabs in the same spreadsheet/API setup used by `workflowExtension`:

- `Events_keywordHighlighter`
- `Upload_Batches_keywordHighlighter`
- hidden `Event_ID_Index_keywordHighlighter`

Committed logging config files contain placeholders only. Local runtime credentials belong in ignored `highlighter/src/logging/config.local.js`; copy `highlighter/src/logging/config.local.example.js` if needed and use the deployed Apps Script `/exec` URL, not the Sheet ID or `/dev` URL.

## Live Server QA site

The interactive QA site lives outside the upload folder at `test-site/index.html`. The root `test.html` is kept as a compatibility entry and redirects to the QA site.

To run it:

1. Start a local web server from the project root.
2. Open `test-site/index.html` through that local server.
3. Select one or more conversations and review the automated QA panel.
4. Hover highlighted text to verify the rule tooltip.

Example:

```powershell
python -m http.server 8000
```

Then open `http://localhost:8000/test-site/index.html`.

For VSCode Live Server, use either `http://127.0.0.1:5501/test-site/index.html` or `http://localhost:5501/test-site/index.html`. The extension manifest supports both localhost hosts across local ports.

## Tests

```sh
npm test
```

## Files

```text
keywordHighlighter/
|-- README.md
|-- package.json
|-- test.html
|-- google-apps-script/
|   |-- Code.gs
|   `-- README.md
|-- test/
|   `-- logging.test.js
|-- test-site/
|   |-- index.html
|   |-- test-site.css
|   `-- test-site.js
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
    |   `-- consolidated_rules.json
    `-- src/logging/
```

## Notes

- The root `test.html` redirects to the Live Server QA site.
- The extension skips invalid JavaScript regex patterns and logs them to the console.
- For overlapping matches, it keeps the earliest match, then the longest match, then the category priority.
- `not_opt_out` rules only highlight when the match is the whole inbound message body, ignoring surrounding whitespace and simple punctuation.
- If Attentive changes its DOM, update the selector in the options page rather than changing code.
