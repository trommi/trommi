# Focus window and Scribble: worker log

Files: `js/focus.js`, `css/focus.css`, `focus-preview.html`, `js/scribble.js`, `css/scribble.css`, `scribble-preview.html`. Nothing is committed.

## Focus window (redesigned from the inbox row)

- Layout: the row grown large. Content left (tab, heavy title, reason, body, code, pictures, video, files), answer tiles in a column at the right edge, note under the tiles. Below 700 px of window width (and on phones) the tiles go to the bottom, note above them.
- Top bar: tab only for Blocking / Urgent / Permission, with the session in it ("API · Urgent"); otherwise the session's doodle and name; a scribbled hourglass for low. Then the age (first to go when tight), "Later", read aloud, close. The card number is only in tooltips.
- Tiles: two options are a pair of squares, no left, yes (the agent's first option, or "allow") right and filled, thumbs from `sketch()` in ui.js, the word under the thumb unless it is a bare yes/no. More options are a column. `card.recommended` gets `is-advised`: round the whole square for the pair, round the label words in a column (overrides in focus.css; the shared rule in tokens.css is untouched).
- `card.multiple`: options are tick boxes, a filled "Send" tile posts `{ card_id, keys, note }` to `/decide` (own fetch in focus.js).
- Later: `putOff()` from store.js, button in the top bar, key `l`. The walk moves on; a single-card window closes.
- Ask back: quiet "Ask back" under the content opens a field; `sendMessage(text, card.agent, card.id)`; the card stays open; messages with `card_id` (not events) show as a thread under the card, plus what was asked from here until the state shows it.
- After an answer: opened on one card it waits for the server and closes (the list offers Undo through `onDecided(card, option, keys)`); the walk does not wait: next card at once, request behind it, failed answer brings its card back with the reason, "Undo" (key `u`) for 10 s.
- Keys: `y`/`n` or right/left arrow on two-option cards, digits for options (toggle on `multiple`, Enter sends), `l`, `u`, `j`/`k` or Shift+arrows for next/previous, Esc.
- `open(cardId)` before the first state arrives (deep link) is remembered and becomes the single-card window once the card is there. Cards are looked up in `state.all`, the walk follows the scoped `state.queue`.
- Phone: back/next in a row of their own at the bottom; undo, hint and info stand between them, so nothing above moves.

Verified in the workbench by script and screenshot, light and dark, 1440x900, 900x700, 400x860, 320x640: arrows inside the viewport, on top, covering no tile; tiles at the same coordinates from card to card; keys, later, undo, failing answer, multi-select, ask back with reply, single-card close with `onDecided`. Also once inside the app on a demo board (walk, later, digit, undo, ask back).

## Scribble

- English strings; the send button says "Send this view". No caption anywhere (state, keys, draft).
- `renderView()`: a pane smaller than 48 px either way now sends the whole canvas instead of a sliver; export canvases are released after use.
- `onChange`: a restored local draft is no longer reported; a picture still decoding when the host loads another canvas is dropped instead of landing in the new one. Checked by script: one report each for draw, undo, redo, image add/move/delete, clear and its undo; none for pan, zoom, `load()`, `clear()`; a pending change is reported before `load()` replaces the doc; nothing mid-erase.
- Doc: unknown top-level keys survive `load()` and come back in every doc; `bounds()` and `renderPNG()` take a subset of elements.
- Broken thumbnail: not reproducible. `view` was a valid PNG in every state tried (normal, hidden pane, just shown, zero height, 3 px high, phone at 3x), in the workbench and on a demo board, where the thumbnail loaded (2000x1336 and 800x1238).

## For the UI colleague

- focus.js imports `sketch`, `doodle` from ui.js and `putOff`, `sendMessage(text, agent, cardId)` from store.js.
- `mountFocus({ onDecided })`: `onDecided(card, option, keys)`; for `multiple` cards `option` is `{ key: 'a,b', label: 'A, B' }`.
- Link to a card: call `focus.open(id)`; it may be called before the state has loaded.
- Server: the working copy already stores `card_id` on `/message`, takes `card_id` on `reply` and `keys` on `/decide`; the thread and multi-select rely on exactly that. Not tested end to end with a real agent reply or a real `multiple` card.
- Scribble: between mount and `load()` the canvas is live; a stroke drawn in that moment is replaced by the loaded doc.
