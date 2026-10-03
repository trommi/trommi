# Phone design: measured, fixed, what is left

3 October 2026, branch `trommi-board`, nothing committed. The whole phone design was brought up state by state on an
own board, measured in the page, and looked at as pictures. Sizes: 390x844, 430x932, 360x780, each light and dark;
"keyboard up" as a 420px high viewport. Touch events throughout (`Input.dispatchTouchEvent`).

## Result

- 50 findings: 45 fixed, 5 left (reasons below). All fixes are CSS, inside the phone breakpoint
  (`@media (max-width: 860px)`) or the card's narrow container (`@container focus (max-width: 699.98px)`); one small JS addition (`js/bar.js`, the tight bar, after card Nr. 158).
- The driver's final numbers: 92 states, 526 measurements (state x size x theme). **524 are at 0 overlaps, 0
  off-screen, 0 sideways scroll, 0 small targets, 0 clipped text, 0 covered controls.** The 2 that are not are the pad
  at 360px, light and dark (L5). Four things are let through by name; they are L1 to L4 under "Left". Table at the end.
- `node dev/ui-test.mjs`: both sizes after the fixes: 1225 checks passing, 0 failing, 3 pending (the three known "row layout" ones at desktop size). Wide screens are untouched.

## How it was measured

Driver: `pp/driver.mjs`, `pp/lib.js` (what is measured), `pp/states.mjs` (the states), `pp/board.mjs` (the board) in the
worker's scratchpad (`/tmp/claude-1000/-home-christopher-git-trommi/c56893b6-5f64-4577-b571-c16d3f7faa2e/scratchpad/pp/`; run `node board.mjs`, then `node driver.mjs --size 390x844 --theme light`). The board has three scripted sessions and one that files the awkward content: a session name
of 52 characters, German compounds of 46 characters in titles, options and text, a card with seven options, one with
five pictures, one with paragraphs as options, a table, code with a long line, an info card, asset links, 28 open
questions, later a second desk with a long name. Three-digit counts are written into the page (no board has 128
open questions at hand).

For every visible control (button, link, role=button, input, textarea, select, summary) the page reports:

| Check | Rule |
|---|---|
| overlap | two controls intersect by more than 2px in both directions and neither contains the other in the DOM. Not counted: a control lying whole inside a larger one (a badge on its row, an arrow on a picture), and a control that floats over the list the other one scrolls in (a pill over the conversation, the card's corner, a sticking field). Those two cases are checked by "covered" instead. |
| off-screen | a control or any box reaches past the left or right edge and is not inside a strip that scrolls sideways on purpose; inside a menu or sheet: anything that reaches past the layer's own edge. |
| sideways scroll | `scrollWidth > clientWidth` on the document, the body, and every scroll container except the ones meant to (session strip, code, tables, filmstrip, gallery). |
| small | the tap area is under 40x40. Sampled with `elementFromPoint` from the centre outwards, so `::before`/`::after` count. Whole pixels: a 40px box at a fractional position samples as 39, so 39 passes. An area that ends at the edge of its list or under something floating is not judged (scrolling frees it). Text links inside a sentence are listed apart. |
| clipped | text cut by `overflow: hidden` with neither ellipsis nor line clamp. |
| covered | `elementFromPoint` at the control's centre is something else, and still is after the control was scrolled to the middle of its list. `pointer-events: none` layers are no covers. |

## Before and after

![A card with a long word](qa-shots/phone-karte-langes-wort.png)

![A card with seven options](qa-shots/phone-karte-viele-optionen.png)

![The top bar](qa-shots/phone-leiste.png)

## Findings

"Cause" is the line that made it; the fix stands in the block "Phone polish" at the end of the named file.

| # | State | Size | What | Cause | Status |
|---|---|---|---|---|---|
| 1 | Opened card, walk | all | A long word or a long session name made the card 27px wider than the phone: title, "From …" line and reason ran off the right edge, the card scrolled sideways (417 > 390). Even a plain English title was cut ("Which of these seven rollout plans"), because the "From" line widened the column. | `css/focus.css:189` (`.focus-lead` grid, column `auto`) | fixed |
| 2 | Opened card | all | "From <session name>" never ends: no ellipsis. | `css/focus.css:1133` (`white-space: nowrap`, no width) | fixed (ellipsis) |
| 3 | Card with two tiles | all | A long option label ran over the neighbouring tile in 9px type (395 > 368). | `css/focus.css:857` (`overflow-wrap: normal`) with `js/focus.js:809` (shrinks to .62em, no further) | fixed (breaks inside its tile); the 9px size is left, see L3 |
| 4 | Card with five or more options | all | Tiles collapsed to 33px; labels and details lay over the next tile; "Only new contracts" was covered by its neighbour's label; tiles under 40px. | `css/focus.css:1219` (`min-height: 0` lets the grid row shrink under its words) | fixed |
| 5 | Card with paragraphs as options | all | A tap anywhere in an option's paragraph, also on its round pick button, opened "write a note" instead: the pencil's enlarged tap area covered the whole paragraph. | `css/focus.css:1297` (`.focus-opt-pen::after { inset: -6px }`) with the pencil unpositioned in `.focus-sec-head` (`css/focus.css:633`) | fixed |
| 6 | Card with pictures, scrolled | 360 to 430 | "Back to the top" pill lay 28px over Snooze and took its taps. | `css/focus.css:1264` (`max-width: calc(100% - 196px)`, the corner is 214px) | fixed |
| 7 | Any card, scrolled | all | The title scrolled through the corner icons (Snooze, Shred, Copy, Close): the corner's ground was 82% see-through. | `css/focus.css:1211` | fixed (solid ground on a phone) |
| 8 | Walk, first card | all | The field at the foot stood 52px above the lower edge; the answer tiles showed through under it, beside "N more". | `css/focus.css:1313` (`bottom: 52px`) on top of `css/focus.css:1284` (the stage already keeps 50px free) | fixed |
| 9 | Card, drawing on it | all | The tools, the field and Send did not fit: Send wrapped to a second line at the left. | `css/focus.css:1107` (the word "Drawing"), `:565` (wrap) | fixed (the word gives way while drawing; the black pen says it) |
| 10 | Top bar | all | The menu arrow lay 12px under the pad button (tap area 28px wide); with three-digit counts it was covered whole. | `css/app.css:1338-1340` (pad and memo placed from the right edge, outside the flow; the Desk box had no limit) | fixed: the box ends before them; counts that do not fit leave whole, last first |
| 11 | Top bar inside a session | all | The memo button sat 2px lower than the pad button. | `css/app.css:1332` (`top: 8px`) beats `css/quicksend.css:100` (`top: 6px`) | fixed |
| 12 | Session strip | all | Rows with a badge lay 4px over the next row. | `css/app.css:1528-1529` (entry 8px wider than its row, gap 4px) | fixed |
| 13 | Session strip | all | A long session name took the whole strip. | `css/app.css:1519` (`width: auto; flex: none`) | fixed (ellipsis at 56vw) |
| 14 | Desk menu with a long desk name | all | Field and lines were 37px wider than the menu and stood past its right edge; "0 open" wrapped. | `css/app.css:1437` (name `nowrap`, column not limited) | fixed |
| 15 | Desk, piles at the foot | all | Folded piles "Snoozed" and "Answered" overlapped by 2px (QA's finding). | `css/app.css:1086` (`margin-top: -12px`) with `css/phone-desk.css:27` (gap 10px) | fixed |
| 16 | Desk, long-press sheet | all | A long word in the sheet's title was cut at the edge without ellipsis. | `css/phone-desk.css:75` | fixed |
| 17 | Conversation, markdown table | all | A narrow column stood one syllable per line ("Jetz / t / ausf / ühr / en") instead of the table scrolling. | `css/app.css:190` (`.rich { overflow-wrap: anywhere }`) reaches `css/tokens.css:135` | fixed |
| 18 | Agents page, choose a drawing | 360, 390 | The eighth column of drawings was cut off by the sheet. | `css/app.css:1252` (`repeat(8, 38px)` = 346px) | fixed (as many columns as fit) |
| 19-45 | Tap targets under 40px (27 controls) | all | Got an unseen larger tap area or 40px, look unchanged: session badge in the strip 30px (`app.css:1527`), pad and memo 36px (`app.css:1338`), Copy on a row 24px and in the card's corner 32px (`cardclip.css:12`, `:10`), "Take back" 28px high (`app.css:803`), the two filters 36px (`app.css:1493`), "Copy" on code 30px (`app.css:212`), file chip 36px (`app.css:237`), "Details" 37px (`app.css:1211`), Snooze corner in a conversation 36px (`app.css:929`), attachment chip in the composer 32px (`app.css:412`), "Conversation" back 36px (`app.css:1185`), "N open" and "To the end" 34px (`app.css:1150`, `:1198`), "Open large" 26px (`richhtml.css:24`), "Close" on Keys 36px (`keys.css:70`), a drawing tile 38px (`app.css:1253`), "N more" 34px (`focus.css:673`), "Desk" back in the walk 36px (`focus.css:1270`), "back to the top" 34px (`focus.css:1180`), x on a file chip 24px (`focus.css:578`), "Done" 30px (`focus.css:1108`), "2 messages below" 19px (`focus.css:1133`), the note field 38px, the pencil on a tile 36px (`focus.css:1297`), pen tool 36px wide (`focus.css:1088`), "Send this region" and its x 38px (`scribble.css:117`, `:120`), "To the board" and the Help page's links 36px (`admin.css:132`, `help.css:124`, `:126`). | as named | fixed |

### Left

| # | State | What | Why left |
|---|---|---|---|
| L1 | Conversation | Two "ABOUT <card>" lines directly under each other share 10px of their tap padding (`css/app.css:165`). | Both lead to the same card, so a tap in the shared strip does the right thing either way. Seen only where a message that carries just a picture is followed by one about the same card. |
| L2 | Agents page | The drawing (38px) and the name (20px high) in a line are under 40px. | On a phone the whole line is the target (a tap opens the session; the rest is in its "…" sheet). A larger area of their own made QA's check of the line fail, so it was taken back. |
| L3 | Card with two tiles | A label whose longest word has more than 16 letters is set in 9px type (`js/focus.js:809`, floor .62em). It now breaks inside its tile, but it is small. | Changing the floor changes wide screens too; needs a look, not a phone fix. |
| L4 | Drawing on a card | The text field is 11 to 42px wide while the pen is in the hand. | The tools need the line; the field is back with "Done". |
| L5 | The pad at 360px | Its top row (back, undo/redo, zoom, "?") is wider than the screen: the "?" button stands half past the right edge (tap area 22px wide). Fine at 390 and 430. | `client/web/pad/pad.css` is the pad's own stylesheet, outside this worker's files (`.pad-icon-btn` is 44px, line 28; the row has no room to shrink). |

### Seen, not changed: needs a decision or belongs to someone else

- **Bare thumbs on a Desk row.** A question with two options that are not yes/no and too long for a label shows two
  thumbs without words on the Desk (`js/inbox.js:677-680`, `labelSize` returns `none`). Which thumb is which stands only
  in the opened card. Seen with the two long German options.
- **Top bar on a narrow phone: decided (card Nr. 158, "agents").** When the counts stop fitting, the Agents button
  leaves the bar first and the counts stay; Agents remains an entry of the Desk menu (tapped: it opens `/agents`).
  CSS cannot tell when the counts stop fitting, so `js/bar.js` (end of file) measures it and sets `data-tight` on
  the bar; the rules are in the "Phone polish" block of `css/app.css`. Measured with real counts: tight at 360px;
  not tight at 390px and 430px, where a knock count of 12 still fits with all three counts and the Agents button;
  tight at 390px with three-digit counts. Only if that is still not enough do the last counts leave whole.
  Top-bar states rerun at 360, 390, 430, light and dark: 0 findings. Picture: `qa-shots/phone-leiste-eng.png`.
- **Info card with a wide picture.** The picture frame keeps its height; a landscape picture stands in it with a white
  band above and below (about 60px each).
- **Passkey pages** (`/passkeys`, sign-in; `server/passkey.mjs`): nothing to fix at any size. They follow the system's
  light/dark setting, not the board's own theme switch.
- **The pad** (`client/web/pad/`, its own stylesheet): clean at 390 and 430; at 360 see L5.
- **Keyboard up** (420px high): field, Send and the three ways out stay on screen in the card, the walk, the session,
  the memo and the menu's jump field. The option tiles scroll in the 40 to 100px that are left. A note field opened
  under the tiles lies at the lower, faded edge of that list; a real phone scrolls a focused field into view by
  itself, the emulation does not, so this is on the list for the iPhone.

## What the emulation cannot show: try on the iPhone

1. Long press on a Desk card: the sheet comes, Safari's own callout (copy, look up, the magnifier) does not; lifting
   the finger does not tap what is under it.
2. On-screen keyboard: in a card, tap the field; field and Send stay above the keyboard, nothing jumps. Tap the pencil
   of an option: the note field comes into view by itself.
3. Safe areas: the top bar under the notch or island, "N more" and the composer above the home bar, the long-press
   sheet's last entry ("Copy") clear of the home bar, in portrait and landscape.
4. Rubber band: pull the Desk, a conversation and an opened card past their ends; the top bar and the field at the
   foot stay put, nothing shows through under the field in the walk.
5. Top bar with real counts: Desk box, arrow, pad, memo, Agents stand apart; the arrow opens the menu on the first tap.
6. A card with five or more options, and one with two long options: every tile holds its own words.
7. A card whose options are paragraphs: a tap on the round button picks, the pencil beside it writes a note.

## The driver's final numbers per state

After the fixes, on the board with two desks. "not run": a state named "-end" exists only where the content is longer than the screen at that size; the two-desks states ran at 390 and 360, light.

| State | controls (390) | 390 light | 390 dark | 430 light | 430 dark | 360 light | 360 dark |
|---|---|---|---|---|---|---|---|
| desks-bar | 10 | 0 | not run | not run | not run | 0 | not run |
| desks-menu | 11 | 0 | not run | not run | not run | 0 | not run |
| desks-other-bar | 5 | 0 | not run | not run | not run | 0 | not run |
| desks-other-desk | 15 | 0 | not run | not run | not run | 0 | not run |
| desk | 19 | 0 | 0 | 0 | 0 | 0 | 0 |
| desk-row-multi | 20 | 0 | 0 | 0 | 0 | 0 | 0 |
| desk-row-three | 22 | 0 | 0 | 0 | 0 | 0 | 0 |
| desk-row-sections | 20 | 0 | 0 | 0 | 0 | 0 | 0 |
| desk-row-info | 22 | 0 | 0 | 0 | 0 | 0 | 0 |
| desk-hold | 6 | 0 | 0 | 0 | 0 | 0 | 0 |
| desk-hold-info | 4 | 0 | 0 | 0 | 0 | 0 | 0 |
| desk-unfold-three | 23 | 0 | 0 | 0 | 0 | 0 | 0 |
| desk-unfold-multi | 20 | 0 | 0 | 0 | 0 | 0 | 0 |
| desk-back-note | 19 | 0 | 0 | 0 | 0 | 0 | 0 |
| desk-revise-note | 19 | 0 | 0 | 0 | 0 | 0 | 0 |
| desk-foot | 37 | 0 | 0 | 0 | 0 | 0 | 0 |
| desk-pile-snoozed | 20 | 0 | 0 | 0 | 0 | 0 | 0 |
| desk-pile-answered | 39 | 0 | 0 | 0 | 0 | 0 | 0 |
| desk-empty | 6 | 0 | 0 | 0 | 0 | 0 | 0 |
| top-bar | 10 | 0 | 0 | 0 | 0 | 0 | 0 |
| top-strip-end | 9 | 0 | 0 | 0 | 0 | 0 | 0 |
| top-menu | 11 | 0 | 0 | 0 | 0 | 0 | 0 |
| top-bar-128 | 11 | 0 | 0 | 0 | 0 | 0 | 0 |
| walk-first | 15 | 0 | 0 | 0 | 0 | 0 | 0 |
| walk-first-scrolled | 15 | 0 | 0 | 0 | 0 | 0 | 0 |
| walk-more | 25 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-long | 16 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-long-end | 16 | 0 | 0 | not run | not run | 0 | 0 |
| card-seven | 22 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-seven-opts-end | 20 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-pictures | 27 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-pictures-end | 24 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-multi | 21 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-multi-opts-end | 21 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-yesno | 16 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-three | 21 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-three-end | 21 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-three-opts-end | 21 | 0 | 0 | not run | not run | 0 | 0 |
| card-sections | 18 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-sections-end | 18 | 0 | 0 | not run | not run | 0 | 0 |
| card-table | 20 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-info | 11 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-info-end | 11 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-option-note | 16 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-chips | 24 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-revise | 20 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-what | 20 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-picture-zoom | 27 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-pen | 25 | 0 | 0 | 0 | 0 | 0 | 0 |
| session-foot | 20 | 0 | 0 | 0 | 0 | 0 | 0 |
| session-top | 19 | 0 | 0 | 0 | 0 | 0 | 0 |
| session-code | 19 | 0 | 0 | 0 | 0 | 0 | 0 |
| session-table | 21 | 0 | 0 | 0 | 0 | 0 | 0 |
| session-pictures | 22 | 0 | 0 | 0 | 0 | 0 | 0 |
| session-details | 23 | 0 | 0 | 0 | 0 | 0 | 0 |
| session-html | 21 | 0 | 0 | 0 | 0 | 0 | 0 |
| session-asset | 25 | 0 | 0 | 0 | 0 | 0 | 0 |
| session-question | 31 | 0 | 0 | 0 | 0 | 0 | 0 |
| session-questions-only | 22 | 0 | 0 | 0 | 0 | 0 | 0 |
| session-files | 26 | 0 | 0 | 0 | 0 | 0 | 0 |
| session-composer-full | 22 | 0 | 0 | 0 | 0 | 0 | 0 |
| session-share-panel | 25 | 0 | 0 | 0 | 0 | 0 | 0 |
| session-share-link | 28 | 0 | 0 | 0 | 0 | 0 | 0 |
| session-api-top | 25 | 0 | 0 | 0 | 0 | 0 | 0 |
| session-api-rich | 25 | 0 | 0 | 0 | 0 | 0 | 0 |
| scribble | 28 | 0 | 0 | 0 | 0 | 0 | 0 |
| scribble-drawn | 28 | 0 | 0 | 0 | 0 | 0 | 0 |
| scribble-style | 38 | 0 | 0 | 0 | 0 | 0 | 0 |
| scribble-region | 30 | 0 | 0 | 0 | 0 | 0 | 0 |
| kb-card | 15 | 0 | 0 | 0 | 0 | 0 | 0 |
| kb-card-seven | 16 | 0 | 0 | 0 | 0 | 0 | 0 |
| kb-walk | 10 | 0 | 0 | 0 | 0 | 0 | 0 |
| kb-session | 16 | 0 | 0 | 0 | 0 | 0 | 0 |
| kb-memo | 3 | 0 | 0 | 0 | 0 | 0 | 0 |
| kb-jump | 7 | 0 | 0 | 0 | 0 | 0 | 0 |
| kb-option-note | 14 | 0 | 0 | 0 | 0 | 0 | 0 |
| agents | 27 | 0 | 0 | 0 | 0 | 0 | 0 |
| agents-sheet | 7 | 0 | 0 | 0 | 0 | 0 | 0 |
| agents-mark-picker | 52 | 0 | 0 | 0 | 0 | 0 | 0 |
| agents-rename | 3 | 0 | 0 | 0 | 0 | 0 | 0 |
| keys-sheet | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| memo-no-crown | 3 | 0 | 0 | 0 | 0 | 0 | 0 |
| memo | 3 | 0 | 0 | 0 | 0 | 0 | 0 |
| memo-typed | 3 | 0 | 0 | 0 | 0 | 0 | 0 |
| pad | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| admin | 3 | 0 | 0 | 0 | 0 | 0 | 0 |
| admin-end | 3 | 0 | 0 | 0 | 0 | 0 | 0 |
| help | 8 | 0 | 0 | 0 | 0 | 0 | 0 |
| pad-page | 14 | 0 | 0 | 0 | 0 | small 1 | small 1 |
| passkeys | 3 | 0 | 0 | 0 | 0 | 0 | 0 |
| sign-in | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-table-end |  | not run | not run | not run | not run | 0 | 0 |

92 states, 526 measurements (state x size x theme), 2 with a finding. A cell is the sum of overlaps, off-screen, sideways scroll, small targets, clipped text and covered controls.

---

# 3 October 2026, evening: after the rebuild (card page, fixed order, stacks, paper under the Desk, memo note, real links)

A dozen workers rebuilt large parts during the afternoon, mostly looking at wide screens. The morning's driver was run
again over every state on an own board serving the current tree (copy in the scratchpad, `bp/`: `board.mjs` on port
8862, `driver.mjs`, `lib.js`, `states.mjs`, plus `flows.mjs`: the flows a person does, with real touches). The driver
now also collects console errors, uncaught exceptions and failed requests per state. Sizes 390x844, 430x932, 360x780,
light and dark, keyboard up as 390x420.

## Result

- 14 findings: 8 fixed here, 1 fixed by another worker while this ran, 5 forwarded (all in the paper's files or on
  server pages). Nothing committed.
- Final matrix: 87 states, 520 measurements. **410 are at 0.** The 110 that are not are two things in the paper
  worker's files: the two paper switches on the Desk are 38px (108 measurements, every Desk state) and the "?" of the
  pad page at 360px (2, known as L5).
- Console: no uncaught exception and no `console.error` in any state. Failed requests: `GET /favicon.ico` 404 on the
  pages without an icon link (`/pad/`, `/passkeys`, the sign-in page); the 403s of the admin page without its key and
  the 401 of the sign-in page are meant.
- `node dev/ui-test.mjs --size phone`: 652 passing, 0 failing, 0 pending (24 groups).
- Flows with touches, all as intended: a swipe across a Desk row opens and moves nothing; one finger scrolls the Desk
  (on a row and on free paper); long press opens the sheet (Snooze, Revise, Whatever, What??, Shred, Copy, 48px each,
  no text selected), a tap outside closes it; a tap on the title opens the card page (`/q/<n>`), Close returns;
  "Choose" unfolds the row in place and an option answers; on the card page option, Send (several), What??, Revise,
  Whatever, the field with Send, Snooze all reach the server and return to the Desk; the walk steps on and back to the
  Desk; the pen switch brings the paper to the front, a stroke is saved ("1 element · saved on the board"), the
  toolbar is in reach; the stacks fan out; the memo note sends; the session strip scrolls sideways.

## Before and after

![The picture on a card](qa-shots/phone-abend-kartenbild.png)

![The Desk ran sideways](qa-shots/phone-abend-stapel.png)

![The memo button with a kept draft](qa-shots/phone-abend-memo.png)

## Findings

| # | State | Size | What | Cause | Status |
|---|---|---|---|---|---|
| E1 | Desk | all | The Desk scrolled sideways (432 in 390): the third stack "Done" stood past the right edge. Failed `walk`, `choose`, `gallery` of ui-test at phone size. | `css/quicksend.css:116` (three columns of the fixed 124px for the memo pile: 416px in a 358px list) | fixed in `css/piles.css` (three stacks share the width: 110px each at 390, 100px at 360) |
| E2 | Top bar, any view | all | With a kept memo draft the memo button was a solid green disc. | the 40px tap area of the morning (`css/app.css`, `.topbar .quick-open::after`) and the memo's draft dot (`css/quicksend.css:20`, the same `::after`) | fixed: the tap area is `::before` |
| E3 | Card page with pictures | all | The picture on the stage was 34x72px, smaller than its thumbnail (failed `images`). | `css/focus.css:1454` (the part above the answers has a fixed height) with `:1528` (the picture takes what title, text, bar and thumbnails leave: 72px) | fixed, end of `css/focus.css`: that part is as high as it needs, the picture is 200 to 260px high (228 at 844), the page scrolls on to the lower options, the field stays at the screen's foot |
| E4 | Desk after Revise / What?? | all | The "In revision … Back" note lay on the lower knock strip. | `js/inbox.js` placed the strip only when the list changed size, not when the view gave the note its strip (`css/back.css:95`) | fixed (`js/inbox.js`, the observer also watches the view) |
| E5 | Question inside a conversation | all | The Snooze square was 28x40 and lay 10px over the title under it. | `css/app.css` (the morning's rule made the old tab 40px high; it is the 28px square of `.inbox-when` now) | fixed: 28px look, unseen 40px tap area |
| E6 | Card page | all | "From <session>" is a link 19px high. | `css/focus.css:1327` | fixed (40px, look unchanged) |
| E7 | Card with paragraphs as options | all | The tick-heading on the stage was 32px high. | `css/focus.css:1399` | fixed (40px on a phone) |
| E8 | Walk, text scrolled | all | The slim title pill lay 40px under the knock marker and took no taps there. | `css/focus.css:1268` (`max-width: calc(100% - 196px)`; with count and knock marker the corner is wider) | fixed: count and marker give way while the pill is there |
| E9 | Desk, pen in hand | all | The pad's toolbar stood 9px under the lower knock strip. | strip over the frame | fixed by another worker meanwhile (`css/app.css:1169`, the strip waits while the paper is in front) |

### Forwarded (files held by others)

| # | Owner | What | Where | Repro |
|---|---|---|---|---|
| F1 | paper | The two paper switches (pen, eye) are 38x38, under the 40px a finger needs. | `css/deskpad.css:30` (`min-width: 38px; height: 38px`) | phone, Desk, lower left |
| F2 | paper | The switch pill floats over the cards at the lower left and covers a row's session name, a thumb tile or a line of a fanned stack. | `css/deskpad.css:29`, `:42` | phone, Desk, scroll: whatever passes the lower left corner lies under it |
| F3 | paper | Pad page at 360px: "?" stands half past the right edge (tap area 22px). L5 of the morning, still there. | `client/web/pad/pad.css:28` | 360px wide, `/pad/` |
| F4 | paper / server | `GET /favicon.ico` 404: the pages have no icon link. | `client/web/pad/index.html`, `server/passkey.mjs` | open `/pad/` or `/passkeys`, network tab |
| F5 | memo | For the record: the third stack's rule sets three fixed columns; the width is now handled in `css/piles.css` (E1). Nothing to do unless the pile changes. | `css/quicksend.css:116` | |

### Needs a decision

- **Info card with a picture**: the picture is readable now, and "Acknowledge" is one short scroll below the first
  screen on a card with a long title and three paragraphs. Leave it (the picture wins), or give info cards a lower
  picture (about 140px) so Acknowledge stays in the first screen.
- **The paper switches on a phone** (F2): leave them floating at the lower left, or put them into the top bar where
  the pad button stood.
- **Free paper under the stacks**: below "Later / Memos / Done" follow one and a half screens of empty paper; on a
  phone the Desk seems not to end. Keep (room to draw), or half a screen on a phone.
- **The name on the outer pages**: Help says "How Trommi works", the passkey pages say "Trommi" (waits on his yes to
  the rename).

### Looked at, nothing to do

- "The row jumped by -3325px when it unfolded" (`choose` at desktop size, 2 of 4 runs elsewhere): not reproduced in
  10 unfolds (5 at 1440px, 5 at 390px) with every scroll call of the Desk logged; no scroll happened. It needs a card
  arriving at the same moment (the test files one just before).
- `choose` at phone size said twice "the page behind the window is not inert" (once the memo button, once the "Back"
  note) in runs of single groups; in the full run it passes. Both are layers of the body, not of the page behind.
- Keyboard up (390x420): in the emulation the card's field is cut at the lower edge or below it, because Chromium
  does not scroll a focused field into view when the viewport shrinks; iOS does. On the list for the iPhone.

## Only a real iPhone can show

1. Long press on a Desk row: the sheet comes, Safari's callout and the magnifier do not; lifting the finger taps nothing.
2. On-screen keyboard: card page (field and Send above the keyboard), an option's note field, the memo note, the
   menu's jump field, the session composer.
3. Notch and home bar: the top bar, the card's corner buttons, the field at the foot, the sheet's last entry, the pad's
   toolbar while drawing on the Desk, the knock strips at the Desk's upper and lower edge.
4. Rubber band: pull the Desk (with the paper under it), a card page and a conversation past their ends; the paper
   must not slide against the cards.
5. Drawing on the Desk with a finger: one finger scrolls when the pen is off, draws when it is on; two fingers do not
   zoom the whole page.
6. The speech buttons (read aloud on the card, dictation on the pad).
7. A card with a picture: the picture is readable, a tap on the magnifier opens it large, pinch works there.

## The driver's numbers per state (evening)

| State | controls (390) | 390 light | 390 dark | 430 light | 430 dark | 360 light | 360 dark |
|---|---|---|---|---|---|---|---|
| desk | 22 | small 2 | small 2 | small 2 | small 2 | small 2 | small 2 |
| desk-row-multi | 23 | small 2 | small 2 | small 2 | small 2 | small 2 | small 2 |
| desk-row-three | 23 | small 2 | small 2 | small 2 | small 2 | small 2 | small 2 |
| desk-row-sections | 23 | small 2 | small 2 | small 2 | small 2 | small 2 | small 2 |
| desk-row-info | 24 | small 2 | small 2 | small 2 | small 2 | small 2 | small 2 |
| desk-hold | 6 | 0 | 0 | 0 | 0 | 0 | 0 |
| desk-hold-info | 4 | 0 | 0 | 0 | 0 | 0 | 0 |
| desk-unfold-three | 25 | small 2 | small 2 | small 2 | small 2 | small 2 | small 2 |
| desk-unfold-multi | 23 | small 2 | small 2 | small 2 | small 2 | small 2 | small 2 |
| desk-back-note | 18 | small 2 | small 2 | small 2 | small 2 | small 2 | small 2 |
| desk-revise-note | 19 | small 2 | small 2 | small 2 | small 2 | small 2 | small 2 |
| desk-foot | 12 | small 2 | small 2 | small 2 | small 2 | small 2 | small 2 |
| desk-pile-later | 33 | small 2 | small 2 | small 2 | small 2 | small 2 | small 2 |
| desk-pile-memos | 24 | small 2 | small 2 | small 2 | small 2 | small 2 | small 2 |
| desk-pile-done | 33 | small 2 | small 2 | small 2 | small 2 | small 2 | small 2 |
| desk-empty | 7 | small 2 | small 2 | small 2 | small 2 | small 2 | small 2 |
| top-bar | 9 | 0 | 0 | 0 | 0 | 0 | 0 |
| top-strip-end | 8 | 0 | 0 | 0 | 0 | 0 | 0 |
| top-menu | 13 | 0 | 0 | 0 | 0 | 0 | 0 |
| top-bar-128 | 9 | 0 | 0 | 0 | 0 | 0 | 0 |
| top-tight | 9 | 0 | 0 | 0 | 0 | 0 | 0 |
| top-agents-by-menu | 26 | 0 | 0 | 0 | 0 | 0 | 0 |
| walk-first | 21 | 0 | 0 | 0 | 0 | 0 | 0 |
| walk-first-scrolled | 21 | 0 | 0 | 0 | 0 | 0 | 0 |
| walk-more | 22 | small 2 | small 2 | small 2 | small 2 | small 2 | small 2 |
| card-long | 19 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-long-end | 19 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-seven | 28 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-seven-end | 29 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-pictures | 24 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-multi | 26 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-multi-end | 26 | 0 | 0 | not run | not run | 0 | 0 |
| card-yesno | 19 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-three | 21 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-sections | 25 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-sections-end | 25 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-table | 22 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-table-end | 23 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-info | 13 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-option-note | 15 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-chips | 24 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-revise | 22 | small 2 | small 2 | small 2 | small 2 | small 2 | small 2 |
| card-what | 22 | small 2 | small 2 | small 2 | small 2 | small 2 | small 2 |
| card-picture-zoom | 24 | 0 | 0 | 0 | 0 | 0 | 0 |
| card-pen | 19 | 0 | 0 | 0 | 0 | 0 | 0 |
| session-foot | 20 | 0 | 0 | 0 | 0 | 0 | 0 |
| session-top | 19 | 0 | 0 | 0 | 0 | 0 | 0 |
| session-code | 19 | 0 | 0 | 0 | 0 | 0 | 0 |
| session-table | 21 | 0 | 0 | 0 | 0 | 0 | 0 |
| session-pictures | 22 | 0 | 0 | 0 | 0 | 0 | 0 |
| session-details | 23 | 0 | 0 | 0 | 0 | 0 | 0 |
| session-html | 21 | 0 | 0 | 0 | 0 | 0 | 0 |
| session-asset | 26 | 0 | 0 | 0 | 0 | 0 | 0 |
| session-question | 30 | 0 | 0 | 0 | 0 | 0 | 0 |
| session-questions-only | 21 | 0 | 0 | 0 | 0 | 0 | 0 |
| session-files | 25 | 0 | 0 | 0 | 0 | 0 | 0 |
| session-composer-full | 19 | 0 | 0 | 0 | 0 | 0 | 0 |
| session-share-panel | 25 | 0 | 0 | 0 | 0 | 0 | 0 |
| session-share-link | 27 | 0 | 0 | 0 | 0 | 0 | 0 |
| session-api-top | 26 | 0 | 0 | 0 | 0 | 0 | 0 |
| session-api-rich | 26 | 0 | 0 | 0 | 0 | 0 | 0 |
| scribble | 27 | 0 | 0 | 0 | 0 | 0 | 0 |
| scribble-drawn | 27 | 0 | 0 | 0 | 0 | 0 | 0 |
| scribble-style | 37 | 0 | 0 | 0 | 0 | 0 | 0 |
| scribble-region | 29 | 0 | 0 | 0 | 0 | 0 | 0 |
| kb-card | 10 | 0 | 0 | 0 | 0 | 0 | 0 |
| kb-card-seven | 16 | 0 | 0 | 0 | 0 | 0 | 0 |
| kb-walk | 12 | 0 | 0 | 0 | 0 | 0 | 0 |
| kb-session | 13 | 0 | 0 | 0 | 0 | 0 | 0 |
| kb-memo | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| kb-jump | 7 | 0 | 0 | 0 | 0 | 0 | 0 |
| kb-option-note | 11 | 0 | 0 | 0 | 0 | 0 | 0 |
| agents | 26 | 0 | 0 | 0 | 0 | 0 | 0 |
| agents-sheet | 6 | 0 | 0 | 0 | 0 | 0 | 0 |
| agents-mark-picker | 52 | 0 | 0 | 0 | 0 | 0 | 0 |
| agents-rename | 3 | 0 | 0 | 0 | 0 | 0 | 0 |
| keys-sheet | 1 | 0 | 0 | 0 | 0 | 0 | 0 |
| memo-no-crown | 5 | 0 | 0 | 0 | 0 | 0 | 0 |
| memo | 5 | 0 | 0 | 0 | 0 | 0 | 0 |
| memo-typed | 0 | 0 | 0 | 0 | 0 | 0 | 0 |
| pad | 22 | small 2 | small 2 | small 2 | small 2 | small 2 | small 2 |
| admin | 3 | 0 | 0 | 0 | 0 | 0 | 0 |
| admin-end | 3 | 0 | 0 | 0 | 0 | 0 | 0 |
| help | 8 | 0 | 0 | 0 | 0 | 0 | 0 |
| pad-page | 14 | 0 | 0 | 0 | 0 | small 1 | small 1 |
| passkeys | 3 | 0 | 0 | 0 | 0 | 0 | 0 |
| sign-in | 1 | 0 | 0 | 0 | 0 | 0 | 0 |

87 states, 520 measurements (state x size x theme), 110 with a finding. A cell is the sum of overlaps, off-screen, sideways scroll, small targets, clipped text and covered controls.
