# Chrome Web Store Submission

## Single purpose

Attentive Rule Highlighter highlights deterministic rule matches in inbound Attentive Concierge messages and measures four disclosed response shortcuts when highlights are present so the publisher can evaluate the highlighter's usefulness.

## Privacy disclosure

When a rule keyword is highlighted, the extension records Shift+D, Shift+N, Shift+B, or Shift+C, including in editable fields, and uploads the normalized shortcut plus the logical highlight count. It never records message text, matched text, field contents, rule identity, or other keys. Shortcut events are retained for 90 days.

Declare website interaction and the canonical Concierge browsing surface in the Privacy tab. Link the hosted privacy policy and affirm Limited Use compliance. The policy must contain a real monitored privacy contact before submission.

## Permission justifications

- `storage`: synchronizes settings and queues bounded operational events before upload.
- `alarms`: schedules retrying queued uploads.
- `https://ui.attentivemobile.com/concierge/*`: highlights inbound Concierge messages and observes the four disclosed shortcuts only when a rule highlight is rendered.
- `https://script.google.com/*` and `https://script.googleusercontent.com/*`: uploads sanitized events to the configured receiver over HTTPS and follows Apps Script redirects.

## Reviewer instructions

1. Open a Concierge conversation containing an inbound message that matches a configured rule.
2. Confirm the match has an `.amh-highlight` visual treatment.
3. Press Shift+D, Shift+N, Shift+B, or Shift+C. Extra Ctrl, Alt, or Meta modifiers are allowed; holding a key records only the first keydown.
4. Confirm the host page still receives its keyboard action.
5. Open a conversation without a rendered rule highlight and confirm the same keys create no shortcut event.
6. The popup and options page both display the shortcut disclosure.

Provide reviewer credentials for Concierge separately in the dashboard if the test account is not publicly accessible.

## Release checklist

- Rotate the previously exposed ingestion token and update the Apps Script property.
- Run `setupLoggingSheets()` after deploying receiver version 1.2.0 so the daily retention trigger is installed.
- Build with `npm run package:store`; do not upload the repository or development ZIP.
- Upload the draft, copy its public key into `KEYWORD_HIGHLIGHTER_STORE_PUBLIC_KEY`, rebuild, and confirm the unpacked package ID equals the dashboard item ID.
- Set visibility to Unlisted and choose the intended regions.
- If the Store ID differs from the previous local ID, have users export custom keywords before switching, then import them into the Store installation.
- Verify the Privacy, Listing, Distribution, and Test instructions tabs before submission.
