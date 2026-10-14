# Offsight Highlighter — User Guide

Offsight Highlighter helps you spot messages that need attention in **Attentive’s concierge workspace** (`https://ui.attentivemobile.com/concierge/`). It automatically colors inbound customer messages using built-in rules, highlights escalation bullets in messages and brand notes, and lets you add your own keywords.

## Get started

1. Install the extension using your team’s link or package.
2. Pin **Offsight Highlighter** through Chrome’s Extensions (puzzle-piece) menu.
3. Open or refresh the Attentive concierge workspace and open a conversation.

There is no separate extension sign-in. You still need your normal access to Attentive. Built-in categories are always active; there is no per-category switch in the keyword editor. New messages are highlighted as they arrive.

## Read the highlights

Hover over a highlighted message to see its category label. Use the label as well as the color, especially when two categories look similar.

| Color | Hover label | What it flags |
| --- | --- | --- |
| Coral | OPT OUT | A match in the opt-out rules. |
| Peach | FUZZY | A match in the less explicit opt-out rules. |
| Teal | TMT or TXT | A match in the corresponding team action rules. |
| Green | REPLY | A match in the reply rules. |
| Gold | CLOSE | A match in the close rules. |
| Purple | User added | A custom keyword match. |

The extension chooses **one category for the whole inbound message**, including messages with several paragraphs. A built-in match can take priority over your custom keyword, so a message containing your keyword may show another color. The customer heading also shows a count of rendered highlights. Escalation bullets are emphasized separately and do not have a hover label.

Some matches use context. For example, a simple choice in response to a Hot Topic frequency survey can receive an opt-out or close highlight based on the preceding brand prompt.

Highlights are cues to review the conversation. They do not send replies, opt customers out, close conversations, or perform escalations. Follow your team’s procedures for the action indicated; TMT and TXT are team action labels, not buttons in this extension.

## Add and manage custom keywords

1. Click the extension icon to open **Custom Keywords**.
2. Enter a word or phrase and click **ADD KEYWORD**.
3. Use **Edit**, change the text, and click **SAVE KEYWORD** to update an entry. Use **Remove** to delete one.

You can also manage keywords by right-clicking the extension icon and opening **Options**.

Keywords match **without regard to capitalization** and can match inside longer words. Use specific phrases to avoid highlighting unrelated messages. Each keyword must have at least 3 characters; entries are limited to 128 characters, and the list holds up to 40 keywords. Chrome’s sync-storage limit can prevent a large list from saving.

Custom keywords use Chrome Sync storage and can follow you across browsers using the same synchronized Chrome profile. They are not shared team rules.

## Back up or restore keywords

- **Export** downloads a CSV backup with a single `keyword` column.
- **Import** loads a CSV whose first row is `keyword`. Older backups with `keyword,hover text` also work; the hover-text column is ignored.
- **Import replaces your current custom keyword list. Export first** if you want to keep it. Duplicate entries are combined; short entries and entries beyond the list limit may be skipped. Check the result message after importing.

Export before switching from an unpacked installation to a Store installation, because the new installation may have separate settings.

## Best practices and troubleshooting

- Read the full message and recent context before acting. An unhighlighted message may still need attention.
- Keep keywords focused on reusable action phrases; avoid customer names or sensitive details.
- **No highlights?** Check that the extension is enabled in Chrome and that you are on the supported concierge page, then refresh it. Other websites are not supported.
- **Keyword will not save?** Check its length, duplicates, and the displayed error. Remove unused entries if the list or storage is full.
- **Unexpected color?** Hover for the label; a higher-priority built-in rule may have won.

The extension processes message text locally. It sends limited operational diagnostics, including highlight counts, supported shortcut presses, and full supported-page URLs. Message text and custom keywords are not included in those diagnostics. See the [privacy policy](https://opsportal.online/keyword-highlighter/privacy) for details.
