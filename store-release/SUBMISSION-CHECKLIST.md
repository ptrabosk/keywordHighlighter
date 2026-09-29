# Store submission checklist

The repository contains the extension package source, finalized listing copy, reviewer instructions, illustrative screenshots, and the hosted-policy source at `docs/index.html`.

Before submitting the ZIP, the publisher must complete these account and deployment steps:

1. Confirm `https://ptrabosk.github.io/keywordHighlighter/` renders the current `docs/index.html` without authentication. Enter that URL in the Chrome Web Store Privacy tab.
2. Deploy `google-apps-script/Code.gs` as an Apps Script web app using the setup in its README. Confirm the `/exec` endpoint and Sheet access work.
3. Generate a new ingestion key, set the Apps Script property, and pass the same key through `KEYWORD_HIGHLIGHTER_API_KEY` only while running `npm run package:store`.
4. Set `KEYWORD_HIGHLIGHTER_ENDPOINT_URL` to the deployed `/exec` URL and verify that the Store ZIP contains no placeholders.
5. Use [`privacy-declarations.md`](privacy-declarations.md) to complete Chrome Web Store Privacy declarations for website content, personal communications, synchronized settings, non-account-attributed operational telemetry, Google service providers, retention, and Limited Use compliance.
6. Provide any Operations workspace access needed for review in the Chrome Web Store reviewer-instructions field.
7. Capture fresh popup and options screenshots from the final packaged build. The checked-in PNGs are illustrative and should be refreshed if the final build styling changes.
8. Upload the ZIP produced by `npm run package:store`, add the final screenshots, select the appropriate distribution, and submit for review.

The repository cannot create the publisher's Google deployment, provision Operations workspace access, or complete the Chrome Web Store dashboard on the publisher's behalf.
