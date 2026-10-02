# QA: dark mode and phone width (2026-10-02, 12:45 to 13:15)

How the web app looks in dark and on a phone, on a demo hub of its own (port 8873, temp data, six
sessions: a joined pair, one crowned, three knocking, one working, one disconnected; cards of every
kind, answered, snoozed, in revision, shredded, a thread). Sizes: 1440x900 light and dark, 400x860
light and dark, 1000x760 light. Screenshots: `demo/audit/<scene>--<size>.png` (213 files; help and
admin in full length as `help-full--*`, `admin-full--*`).

The app changed under the audit several times (desk rows, the top pill, quick send became the memo,
the Focus window). The table describes the last state seen, about 13:10. Rows marked *gone* were seen
earlier and were repaired by their owner meanwhile.

Automatic checks on every shot: no page scrolls sideways, nothing lies outside the window, no script
error in the final pass (one at 12:47, `ledger.js:476 node.setAttribute(...) is not a function`, left
the Agents page empty for a few minutes; gone).

## Fixed (CSS only)

| Where | What | File |
|---|---|---|
| Joined view, 1200px and wider | The two round buttons at the top right lay on "Scribble" in the title line. The title now ends 120px before the edge. `joined--wide-dark.png` | `beside.css` (new rule at the end of the title block) |
| Agents page, phone | In a line of a pair the name touched the rule above ("Docs Writer", "with Web UI" under it). Such a line gets 8px above and below. `agents--phone-dark.png` | `ledger.css` (`.ledger-line:has(.ledger-with)`) |
| Help, phone | "To the board" was 12px high, the links of the contents 28px. Both are 36px now, nothing moved. `help--phone-dark.png` | `help.css` |
| Admin, phone | "To the board" was 12px high, now 36px. `admin--phone-dark.png` | `admin.css` |
| Read aloud, touch | The speaker (`.say`) is 26px. It now takes a tap from 38px around it; it looks the same. | `speech.css` |

Looked at and found in order, light and dark, wide and phone: help (whole page, with the diagram),
admin (locked and open), the sheet of keys, the mark of the keyboard row, the Ledger on a wide window
and at 1000px, the working ring in the sidebar and in the Ledger, the menu under the pill (centred,
not clipped any more), rich HTML and tables in a conversation, the Scratchpad.

## Focus window (owner: Focus; reported, not touched)

| Where | What | Proposed patch |
|---|---|---|
| End of the walk, dark. `walk-end--wide-dark.png` | "All answered. The next question shows up here." and its tick are dark on the dark veil: `.focus-list-end { color: var(--surface) }` (focus.css 727, 1014). | `color: #f2f5f3` there and for `.focus-list-end .sketch`, or a token `--on-overlay` that is light in both themes. |
| Walk on a phone, dark. `walk-end--phone-dark.png`, `walk--phone-dark.png` | The ground behind the cards is light grey in dark: `.focus[data-list] .focus-backdrop { background: color-mix(in srgb, var(--fg) 72%, var(--surface)) }` (focus.css 736); `--fg` is light in dark. | `:root[data-theme="dark"] .focus[data-list] .focus-backdrop { background: #0c100e; }` |
| End of the walk, all sizes. `walk-end--*.png` | Two end states at once: the list's end (`.focus-list-end`, "11 snoozed: go through them", "Close") above, and the sheet's `.focus-done` with a second "All answered" and a second "Close" below. | `.focus[data-list] .focus-sheet[data-state="done"] .focus-list-end { display: none; }`, or do not build the list end when the sheet is done. |
| Walk, all sizes. `walk--phone-light.png`, `walk--wide-light.png` | The pill "9 more" (`.focus-more`, `bottom: 10px`) lies on the composer of the card under it ("Write to", then the pill). | Reserve the room: `.focus[data-list] .focus-stage { padding-bottom: 56px }`, or put the pill at the right end. |
| Choose with pictures. `card-tags--phone-dark.png`, `card-tags--wide-light.png` | The counter stands twice ("1 / 4 phone-gespraech.png" above the picture and again beside the thumbnails, where it lies on the fourth thumbnail on a phone). On a phone the picture fills the screen, the question follows at half height and its text is not seen at all without scrolling. | Drop the caption beside the thumbnails (`.focus-figure` caption) when the head line shows it; on a phone cap the picture: `max-height: 34dvh`. |
| Every kind, all sizes. `card-sections--wide-dark.png`, `card-info--phone-dark.png`, `card-thread--phone-dark.png` | The scrolling text is cut hard at the composer, in the middle of a line or a picture: no fade, no hint that there is more. | On `.focus-scroll`: `mask-image: linear-gradient(#000 calc(100% - 28px), transparent)` while it is not at its end. |
| Advice mark, dark. `card-tags--phone-dark.png`, `card-stack--wide-dark.png` | The marker behind the advised label is brown-grey; "Teal" (beige on it) and "In Schritten ohne Sperre" (pink on it) are hard to read. | In dark draw the marker lighter and thinner: `:root[data-theme="dark"] .focus-opt.is-advised { --advice: color-mix(in srgb, var(--urg-high) 28%, transparent) }`. |
| Phone, every card. | The three controls at the top right (copy, read aloud, close) are 32px; the pen on an option (`.focus-opt-pen`) is 24px. | 36px, or a `::after { inset: -6px }` as on `.say`. |
| Chip "4 messages below". `card-thread--wide-dark.png` | Descenders cut ("messages"): `.focus-asset { height: 30px; font: … /1 }`. | `line-height: 1.3`. |
| Permission, wide (state of 12:50). `card-permission--wide-dark.png` | The copy button stood alone outside the column of the answers. | *gone* after the rebuild of the head. |
| `/q/<n>` of an answered or shredded card. `card-answered--*.png` | Opens the walk at its first card instead of that card. | Decide: open the card read-only, or go to its row in the pile. |

## Conversation (owner: Conversation; reported, not touched)

| Where | What | Proposed patch |
|---|---|---|
| Session, phone and 1000px. `session-api--phone-dark.png`, `session-api-top--phone-light.png` | "To the end" and "N open" float side by side on the last line of the conversation ("Und was kostet der asynchrone Export?" is half covered; at the top a card's title). | Give the log room under its last message: `.log-inner { padding-bottom: 56px }`, or stack the two pills at the right. |
| Session, phone. | The filters "Questions only" and "Files" are 32px high; the line "About …" over a message (`.msg-about`) is 18px. | `min-height: 36px`; for `.msg-about` `padding-block: 9px; margin-block: -9px`. |
| Card in a conversation, phone. `session-api-top--phone-light.png` | The speaker stands once beside the knock label and once alone in the upper left corner of a card without a label. | One place for it: the row of the clock (`.inbox-when`). |
| Joined view, phone. `joined--phone-dark.png` | The list of questions takes the upper half and is cut in the middle of a card; the conversation below shows three lines. Only one of the two conversations is there. | Below 861px: `.group-questions { max-height: 30dvh }` and a visible edge (shadow) where it scrolls; or a switch "Questions / Conversation" as a single session has. (beside.css, not changed: the rule was being edited.) |

## Web UI: desk, sidebar, menu, memo (owner: Web UI; reported, not touched)

| Where | What | Proposed patch |
|---|---|---|
| Desk row, phone. `desk--phone-dark.png` (second card) | A row without a knock label starts its title at the very top edge; the copy button and the clock lie on the end of the first line ("großen"). A row with a label has a free band there. | On a phone: `.inbox-row:not(:has(.inbox-tab)) .inbox-content { padding-top: 30px }` (`.inbox-tab` is the knock label; this gives every row the band a labelled row has). |
| Desk row, phone. | The one tab left at the corner (Snooze, `.inbox-tab-act`) is 26px, the copy button 24px, the badge in the strip (`.agent-badge`) 30px. | `::after { content: ""; position: absolute; inset: -6px }` on each. |
| Piles, phone. `desk-bottom--phone-dark.png` | "Snoozed", "Waiting", "Answered" (`.inbox-pile-head`) are 17px high and stand 8px apart. | `min-height: 40px` below 861px. |
| Top bar, phone, while disconnected. `desk--phone-dark.png` (13:09) | "Disconnected, reconnecting" (`.brand-open::after`) does not fit beside "Desk 2 · 9": it is cut at the right edge and pushes the Agents button onto a second line; the bar grows. | Below 861px shorten it: `content: "Offline"`, or show only the coloured logo. |
| Pill at the top centre, wide, scrolled. `desk-bottom--wide-dark.png` | The pill floats over the scrolling rows and covers their small print ("1 picture · a table"). | A band behind it: `#inbox { scroll-padding-top: 52px }` and a fading ground under the pill, or let the head of the page stay. |
| Sidebar, wide. `desk--wide-dark.png` | Since "Desk" moved into the pill the first session stands at the very top; the drawn frame of a pair is cut at the edge. | `#agents { padding-top: 12px }` above 860px. |
| Menu, phone. `menu--phone-dark.png` | The entries (Agents, Help, Admin, Keys) and "Jump to" are 32px high, the two switches 30px. | Below 861px `min-height: 40px`. |
| Deny tile, dark. `desk-bottom--wide-dark.png`, `desk--wide-dark.png` (12:55) | The thumb-down tile has the colour of its card: it reads as a loose icon, not as a button. | `:root[data-theme="dark"] .inbox-actions > button:not(.is-advised) { box-shadow: inset 0 0 0 1px var(--line-strong) }`. |
| Memo, wide, in a session. `quick-session--wide-light.png` | The open slip lies on the filters and on the answer tile of the first card. | Fine for a slip; if not, open it downwards from the button only as far as the title's line and push nothing. |
| Edge tabs on a phone covering the clock. | *gone*: one tab is left, the clock is free. | |
| Menu under the pill, misaligned and clipped. | *gone*: centred at 1440 and 1000. | |
| Floating buttons on "Scribble" at 861 to 1199px. | *gone* (title starts lower); at 1200px and wider fixed here, see above. | |
| Memo without styles in the bar (12:55). `back-note--mid-light.png` | Seen for a few minutes while quicksend.css was written. | *gone*. |

## Others

| Where | What | Owner | Proposed patch |
|---|---|---|---|
| The note "Snoozed … Back", wide. `back-note--wide-light.png` | When no pointer press places it (answer by key), it stands at the top left of the view, on the upper half of the headline "Next, please". The corner was free before the headline came. | Back (back.js places it by inline style) | In `pageHost()` use the lower left corner on a wide window too: `top = box.bottom - 78`. |
| Scribble of a session, dark. `session-scribble--phone-dark.png` | The paper stays light while everything round it is dark; the Scratchpad is dark in dark. | Scribble | Decide: paper is always light (then say so), or follow the theme as the pad does. |
| Scratchpad. `pad--wide-dark.png` | Set in the system's sans-serif, not in the app's type. | Pad | Load the same font faces in the pad's page. |

## Not checked

- Dictation while it records and reading aloud while it plays: the demo hub has no speech service. The
  buttons at rest were seen (a made-up key switched them on).
- The lightbox, the zoomed picture, notes and drawings on a card, the discussion column of the Focus window.
- Real touch gestures (swipe on a row, drag in the Ledger), a real phone's safe areas and its keyboard.
- Hover states, and the `prefers-color-scheme` of the system (the app's own switch was used).
- 1200 to 1300px wide: whether the wider pill ("Desk 2 · 9 · 3 working") meets the title of a session.

During the audit another process stopped the demo hub three times (SIGTERM to its `server.mjs`); a
wrapper started it again. Somebody stops hubs by name.
