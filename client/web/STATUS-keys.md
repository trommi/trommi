# Keyboard worker log

Files of this work: `js/keys.js`, `css/keys.css`, `js/back.js`, `css/back.css`, `dev/keys-test.mjs`;
edits in `js/inbox.js`, `js/app.js`, `js/focus.js`, `index.html` (two stylesheet links), `server/server.mjs` (one
sentence of the channel instructions). Nothing here was committed by the worker.

## How it is built
- `js/keys.js` is the one keydown listener. `LAYOUT` is the key table (scope, keys, words, flags). A view registers
  what it can do with `provide(scope, { active, actions, has })`. The "?" sheet and the notice after "g" are drawn
  from the same table. Rules: no chords with Ctrl/Alt/Cmd; nothing while typing (only Esc); nothing under a
  `dialog[open]`, `[data-owns-keys]` or the pad (`body[data-pad]`); Enter and Space stay with a focused button;
  a held key repeats only for moves. `native: true` entries are listed, handled in place (composer, canvas) and
  reserve their key. `always: true` works under the modal Focus scope too (pad, "?"). An action that returns a
  function is told when the key is let go (hold-to-talk).
- Scopes: `app` (app.js), `list` (every mountInbox list), `focus` (focus.js, modal), `conversation` and `session`
  (app.js), `writing` and `scribble` (listed only).
- `js/back.js`: `say(host, { head, title, back })` is the one note for "what just happened + Back" (top left of the
  page or of the Focus window; on a phone a strip at the lower edge that the view gives up). `backNow()` is the key.
- inbox.js: the mark (frame, scribbled arrow, key caps on the row's controls via `hint()`), own `reveal()`,
  leave motions (a ghost of the row that left), the "Answered" rows with "Take back", keys to reach the piles.

## Found and fixed on the way
- With the focus on a row, a rebuild of the list scrolled the inbox to its top (Chromium lays out the emptied
  list when the focused node is moved out). render() lets go of the focus before rows move.
- `scrollBy` while a smooth scroll still runs adds up; reveal() now scrolls to a place, and jumps are instant.
- `g 1…9` never matched (range with a first key).
- QA 1: Back/Forward lost places; the subscriber's `writeAddress(false)` now waits for the step to finish.
- QA 2: the note covered controls on a phone; it now stands in a strip below the view.
- QA 3: a row's error line was clipped and read "Failed to fetch".

## Test
`node dev/keys-test.mjs [PORT] [OUT_DIR]` (own hub, three sessions, 13 questions; real key and mouse events;
checks the board's state). Last run: 173 passed, 0 failed. `node dev/ui-test.mjs`: 736 passing, 3 failing
(choose: the suite's own helper throws; help: the link moved into the logo's menu), 7 pending.

## Open
- `v` (dictation) is bound in the Focus window and in a session; in a session it does nothing until the composer
  gets `dictationMic(draft)` (chat.js still uses the older `mountDictation`). Not tried with a real microphone.
- The session's own view keeps its older "Answered" list (history.js, "Answer again"); the new rows with
  "Take back" are in the inbox.
- Touch: nothing here was tried on a real phone.
