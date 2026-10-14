# Store submission checklist

The repository contains the extension package source, finalized listing copy, reviewer instructions, illustrative screenshots, and the hosted-policy source at `docs/index.html`.

Before submitting the ZIP, the publisher must complete these account and deployment steps:

1. Confirm `https://opsportal.online/keyword-highlighter/privacy` renders the current `docs/index.html` (the copy in the offsight-operations collector, `services/webhook-app/keyword-highlighter/privacy.html`, must stay identical) without authentication. Enter that URL in the Chrome Web Store Privacy tab.
2. Confirm the Offsight Operations collector is deployed (see `docs/keyword-highlighter.md` in the offsight-operations repository) and that `https://opsportal.online/keyword-highlighter/logs` answers an extension request. The extension carries no ingestion secret.
3. Run `npm run package:store` and verify the ZIP's `src/logging/config.js` names `https://opsportal.online/keyword-highlighter/logs` and the manifest's only network host besides Attentive is `https://opsportal.online/keyword-highlighter/*`.
4. Use [`privacy-declarations.md`](privacy-declarations.md) to complete Chrome Web Store Privacy declarations for website content, personal communications, supported-page URLs/web activity, synchronized settings, non-account-attributed operational telemetry, service providers (Chrome Sync, hosting, Cloudflare), retention, and Limited Use compliance.
5. Provide any Operations workspace access needed for review in the Chrome Web Store reviewer-instructions field.
6. Capture fresh popup and options screenshots from the final packaged build. The checked-in PNGs are illustrative and should be refreshed if the final build styling changes.
7. Upload the ZIP produced by `npm run package:store`, add the final screenshots, select the appropriate distribution, and submit for review.

The repository cannot deploy the publisher's collector, provision Operations workspace access, or complete the Chrome Web Store dashboard on the publisher's behalf.
