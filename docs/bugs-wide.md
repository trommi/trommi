# Bugs on wide screens (sweep of 3 October 2026, evening)

Bug-fixer 1. Every view at 1440x900, 1280x720 and 1024x768, light and dark, sidebar open and folded, on a board of
its own running the current tree (`node dev/ui-test.mjs --keep --size desktop`): six sessions, two subs under a
main, a second desk, fake decisions, a pair, memos, two published assets (one shared and stopped again).

Method: one sweep script (22 views and states x 3 sizes x 2 themes x 2 rail states) that collects console errors and
warnings, uncaught exceptions, failed requests, horizontal page scroll, text clipped without an ellipsis, controls
covered by another layer (`elementFromPoint`), overlapping controls, and every `a[data-nav]` address on a cold load.
Then the flows by hand through the DevTools protocol with real pointer and key events: answer and take back, snooze
and the Later stack, the card page (option, What??, Revise with and without words, Whatever, Shred and back), "Next,
please" to its last card, Back and Forward, Ctrl+click, the jump field, desks, crown groups, a session (send,
attach, filters, Scribble with region send), memo, sharing an asset, the Agents page with laying together.

Clean in the sweep: no console error or warning, no exception, no failed script, style or image, no horizontal
page scroll, no text clipped without an ellipsis, all 59 link addresses load cold. (`/admin.html` answers 403 on its
API without the admin key: expected.)

Counts: **19 reported, 15 fixed, 3 forwarded, 1 not reproduced, 1 withdrawn (my mistake).** One thing needs his decision (at the end).

## The table

| # | View | Size | What was wrong | Cause | State |
|---|---|---|---|---|---|
| 1 | Agents | all, worst at 1024 | The two selects of a line (main agent, desk) lay on the model, on "last seen" and at 1024 on the question and its "+N" | `css/ledger.css:28` gave the last column 132px for icons plus two selects of up to 136px | **fixed**: the column is as wide as what stands in it (`css/ledger.css:127`); up to 1500px the model gives way; up to 1360px each select is a small drawn button (crown, desk), its list says the rest. Options read "No main" / "↳ API" (`js/ledger.js:258`) |
| 2 | Agents, a session laid together | all | The chip "with Long Named Session …" ran out of the name column over the state | text node inside an inline-flex chip cannot be cut (`js/ledger.js:179`) | **fixed**: names in `.ledger-with-names` with an ellipsis (`css/ledger.css:68`), full names in the tooltip |
| 3 | Sidebar | all | A crowned first row stood at 86px, a plain one at 80px | `css/crowns.css:8` (`margin-top: 6px` for the crown's room) | **fixed** (`css/crowns.css:42`): measured 80 either way |
| 4 | Sessions laid together | all | First card 39px under the band, a single session 16px | `css/beside.css:62` (24px padding) plus the empty list head's 16px | **fixed** (`css/beside.css:87`): first card at 80px at 1440 and 1024 |
| 5 | Desk, pen in hand | all | The lower knock strip lay on the pad's toolbar at the window's foot | strip is fixed at the list's edge, the toolbar came today (`css/app.css:1154`) | **fixed** (`css/app.css:1169`): the lower strip waits while the paper is in front |
| 6 | Desk | 1024 | The lower knock strip ran under the pen and eye switches | strip is as wide as the list, the switches stand at the lower left (`js/inbox.js:903`) | **fixed** (`js/inbox.js:907`): the strip begins beside the switches where they would meet |
| 7 | Desk | all | No key hid the cards | missing | **fixed**: `W` (also `G` then `X`), on the Desk only, listed in the key sheet (`js/keys.js:30`, `js/app.js:703`) |
| 8 | Menu, jump "Scratchpad" | all | The entry clicked the hidden `#pad-open` | `js/bar.js:132` | **fixed**: calls `openPad()` (`js/bar.js:133`); verified: pen in hand, Esc puts it down, nothing stays faint |
| 9 | Tab title | all, several desks | "(6 knocks) Desk · Desk · Trommi" | `js/app.js:539` adds the desk's name, and the first desk is named "Desk" | **fixed** |
| 10 | Desk before the first state | all | Read "Desk is clear." until the state arrived | `js/inbox.js:1010` painted the empty state from the placeholder state | **fixed** (`js/inbox.js:1018`): nothing is said before `isLoaded()`; checked with `/#skeleton` |
| 11 | Desk row, Revise | all | Tooltip and label said "say what should change", the click hands back at once | `js/inbox.js:560` (label) against `js/app.js:330` (behaviour) | **fixed**: label and tooltip say "hand it back to the session, it returns reworked" (`js/inbox.js:561`); behaviour unchanged, `B` verified |
| 12 | Menu, jump field | all | The field's own clear cross lay on the "Ctrl K" cap once something was typed | native search cancel button (`css/app.css:1682`) | **fixed** (`css/app.css:1683`) |
| 13 | `js/app.js` | - | A stray worker note ("NOT applied: the permission system refused…") | `js/app.js:51-53` | **fixed**: removed |
| 14 | Session heading | all | The crown a main session's drawing wears was cut by the window's top edge (its top at -6px) | `css/app.css:597` puts it a quarter above the drawing, and the heading begins at 8px | **fixed** (follow-up, `css/session.css:42`): the crown sits on the drawing's corner, its top on the 8px line at 1440, 1280, 1024, sidebar open and folded; the heading did not move |
| 15 | Card page, a card with several answers | 1024 | An option label of three lines is cut at the top and bottom of its tile; the sixth option is half under the fade | `css/focus.css` (options column with `data-many`) | **forwarded: card page worker** |
| 16 | "Next, please" of a session, last card, several answers | 1440 | After Send the answered card stays on the page, unticked, Send greyed; no end state; `U` does not take the answer back (the hub has it as decided) | `js/focus.js` (end of a pass in a session's walk) | **forwarded: card page worker** |
| 17 | Card page from a session | all | The way back reads "← Long …": the session's name is cut to four letters | `css/focus.css` (back button width) | **forwarded: card page worker** |
| 18 | Memo | all | ~~After "Tear off and send" nothing says that it went~~ | - | **withdrawn**: my check looked for the wrong element. The note exists (`js/quicksend.js:304`, `.quick-note`): "Sent to <name>. Open the conversation", bottom right, five seconds, after the slip has flown off. Nothing changed; `ui-test --only quick` checks exactly this wording |
| 20 | Desk, cards hidden (eye switch) | all | A click on a knock strip did nothing visible: the cards stayed hidden | hidden rows count as out of sight (`js/inbox.js:1187`), so the strip found no row | **fixed** (follow-up, `js/inbox.js:874`): the click brings the cards back first (`toggleCards(false)`), then goes to the knocking card |
| 19 | Session, 1024 | 1024 | "The N open chip can lie on the last bubble" (spacing critic) | - | **not reproduced**: at the end of the stream the last bubble ends 14px above the chip at 900, 1024, 1280 and 1440 (`css/app.css:1243` keeps 60px). While scrolling, the chip and "To the end" float over the column by design |

Also checked and fine: with the pointer tool, no faint state stays after Escape (`data-paper-front` goes); with the
eye switch (cards hidden) no pop-up or empty box is left, only the paper, the two switches and the knock strips (the
paper worker's stated intent).

## Not changed, by choice

- **The hidden footnav buttons.** Every "go to the Desk / Agents" still clicks `#nav-inbox` / `#nav-roster`
  (`display: none`), whose listeners in `js/app.js:482-483` do the step. Replacing them with `go('/')` is not the
  same step (`go()` does nothing on an equal address and takes the scroll position from the history entry instead
  of going to the top), so it was not done blind. Call sites: `js/app.js:706`, `:707`; `js/bar.js:37`, `:73`, `:75`,
  `:131`, `:132`, `:251`, `:274`; `js/quicksend.js:251`; `js/padlink.js:314`.
- **Dead CSS** (`.padlink-open` rules in `css/app.css`, `css/quicksend.css:5`): left, they cause no visible fault
  and the cleaning pass waits for his word.
- Nothing in `server/`, `dev/`, `focus.*`, `pad/*`, `padlink.*`, `deskpad.css`, `quicksend.*`, `session.css`.

## His decisions

1. **Agents page, narrow windows:** up to 1360px the desk and main-agent selects are small drawn buttons (the state
   is in the tooltip and the list). Options: keep; or show them as words only on the line under the pointer; or move
   both into a "…" menu per line.

(Decided since by the coordinator and built: a knock strip brings hidden cards back first, row 20.)

## Tests on the final tree

- `node dev/keys-test.mjs`: 205 passed, 0 failed (with five new checks: `W`, `W` again, `G X`, a strip brings hidden
  cards back, the cards are back before the walk).
- `node dev/ui-test.mjs --size desktop --only quick,inbox,session,pad` after the follow-ups: 157 passing, 0 failing, 2 pending; the full
  desktop run before them: 685 passing, 0 failing, 3 pending.
