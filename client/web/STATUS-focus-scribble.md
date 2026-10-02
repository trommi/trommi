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

## Focus window, second round (conversation, tags, rail, gallery answers, composer, files, scratchpad, sections, notes, drafts)

All in `js/focus.js` and one block at the end of `css/focus.css`. Verified on demo boards (ports 8841 to 8844) in headless Chromium with real mouse, key, drag and file-input events; 1440x900 and 400x860, light and dark.

- **Conversation.** Left column = the question (the agent's opening message), then what was said about the card (`card_id` messages, in the classes of the session chat: `.msg`, `.bubble`, `richPlus`, `attachmentNodes` from chat.js), newest last. One composer in a row under both columns, as wide as the conversation (`--measure`). Enter sends plain chat (the card stays, is not put off, the walk does not move); Shift+Enter breaks the line; on touch-only devices Enter is a line break and the button sends.
- **One field.** No "Add a note?" input any more: `rec.note` is an accessor over the composer's text, `rec.noteNode` is the composer field. An answer tile takes text, attached files and a drawing along as its note; a line under the tiles says so while there is something to take.
- **Buttons.** In the field: paperclip, pencil, microphone (Speech worker's), Send. Beside it: `What??` (Explain; `EXPLAIN_LABEL`), `Back to agent` (`HAND_BACK_LABEL`, `handBack()`: sends what is typed, then `putOff(id, true, true)`), `Later` (plain `putOff(id)`). All three leave the card: next question in a walk, close for a single card. The Explain/Later buttons are the Keyboard worker's nodes, moved into the composer of the card in front by `paintChrome()`; the top bar keeps read-aloud and close.
- **Tags.** `TAGS_FROM = 7` options and every label up to `TAG_CHARS = 18` characters: `data-count="tags"`. Above `TAGS_WIDE_FROM = 16` the answer column widens (`data-opts="tags-wide"`). Details in the line under the tags for the tag under pointer or keyboard, and as tooltip. 40 tags end at y=621 of 900. Advice: `adviceLoop()` round the tag. The inbox's "Choose" row has its own option code (`unfoldNode` in inbox.js): not touched.
- **Rail.** One mark per question in walk order (tick = answered in this walk, dot tinted by urgency, hollow = put off, ring = in front, short stroke = has a draft), count at its foot, click jumps. Placement is one constant, `RAIL_PLACE` (`outside` | `gutter` | `top` | `bottom` | `below`); `?rail=<place>` in the address tries another. Narrow windows always get the thin row under the top bar. Sender gaps and marks only when the walk goes sender by sender (it follows urgency, so mostly it does not).
- **Gallery.** The enlarged picture keeps the answers beside it (under it when narrow): tags, Send for multi, What?? / Back to agent / Later. `pairPictures()`: every picture names exactly one option in its file name (key or label as a word), or as many pictures as options and at least three; otherwise nothing is paired. With `card.sections`, `block.picture` is the tie. Paired: "Take this one: <label>", the option marked, hovering or focusing an option turns to its picture.
- **Files.** Paperclip, drop on the composer, paste. Chips over the field until sent. `POST /message {attachments:[{name,data}]}` and `POST /decide {attachments}` (server: `storeUploads`, meta `files` and `image_path` for the agent; tests in server/test.mjs).
- **Scratchpad.** The pencil mounts scribble.js small in the composer (pen, eraser, undo). "Back to typing" keeps the drawing as a picture chip (with its strokes, so the chip opens it again); sending or answering with the pad open takes it along. A tap on an attached picture opens it to draw on.
- **Sections, option notes, drafts** (docs/question-contract.md): paragraphs tied to tiles (lit together, heading ticks or answers, advice on both, picture with its paragraph); a pencil on every tile, tag and paragraph opens a note line at the tile, sent as `notes`; ticks, notes and the composer's text are saved with `POST /draft` 400 ms after a change and adopted from `card.draft` when its `ts` is news and the human is not typing in that card.

Not done or not verified: option notes inside the enlarged-picture view; drawing on a picture the agent attached (only on one's own attachments); the note's attachments are stored on the card (`note_attachments`) but no view shows them after the answer; a real phone (touch, on-screen keyboard, real clipboard paste: paste was tested with a dispatched paste event carrying a file); `keys.js` has no entry for B (`focus.handback` is provided) and still says "explain".
- Later, changed by the user: the composer is ONE line in the conversation column (field with Send inside, then `What??` · `Back to agent` · `Snooze` at the same height); the answers keep the full height at the right. "Later" is `LATER_WORD = 'Snooze'` with the drawing `LATER_SKETCH = 'snooze'` (both exported from ui.js); the toast says "Snoozed".

## Third round (state at the end of this session)

- The walk is a stack of separate cards (one scrolling column; each card at most the window's height less a peek of the next, inner scroll). The card at the reading line is the one in front; it always lands at the same place (`LIST_TOP`), with only the newest strip in sight above it. Answered / trusted / read / snoozed / handed / asked / shredded cards become strips with Back (`addStrip`, `arrange`). No rail: `.focus-more` at the foot says "N more". A card opened alone stays one card and closes on its answer.
- Card layout: two columns (content left with its own scroll, options right, Send under the option list, Trust under that), composer line across the whole card. `ANSWERS_BESIDE_TITLE` (or `?head=1`) switches to the options floating beside the title; off by default.
- Composer: no Send. What is typed is saved as the card's draft 300 ms after a keystroke (`queueDraft`/`saveDraft`/`flushDraft`), the end of the field says "…" then "saved". Enter = Back to agent with the words (nothing on an empty field), Ctrl/Cmd+Enter = say it and stay, Shift+Enter = line break; on touch Enter is a line break. Back on the strip returns card and words. Attached files and drawings stay client-side until an action sends them.
- Buttons beside the field, wordless (`wayButton`): ??? (What??, sends `explain: true`, takes the field's words along), the reverse card (Back to agent, `handback: true`), z z z (Snooze), and apart from them Shred (`POST /shred`).
- Info cards (`kind: "info"`): two tiles, What?? and Acknowledge (`POST /close`), strip "Read".
- Under the title: `paintAssets` chips (pictures, pages and links incl. those in the conversation, files, tables, layouts, the version chip).
- Time machine: `viewVersion(rec, n)`, `rec.version`; `.focus-turn` lines in the conversation; "Presented again" on a rewording.
- Gallery: `pairPictures`; grid from four paired pictures; `tiePicture` marks the option, `linkPicture` draws one pen line from the picture to its option (ui.js `arrowStrokes`), only while both ends are in sight and the way is free; `attachment.page` gives "Open the page" and, in the enlarged view, "Live" (sandboxed frame).
- `mountFocus` re-fetches `focus.css` so an old page cannot run new code with an old stylesheet.

Not built: writing and scribbling anywhere on the card (anchored notes), the scribble overlay with a snapshot picture, option notes in the enlarged view, `note_attachments` shown after an answer.
- Pass order (`passOrder`): fixed when the walk starts; arrivals appended; snoozed and in-revision cards leave the pass and are counted at its end ("go through them" takes them in); a card back from its session is appended with "Presented again" / "Answered your question"; Back on a strip returns the card to its place. Hand-back is "Revise" (`HANDBACK_WORD`, `HANDBACK_STATE` in ui.js); taking it back calls `POST /handback {clear: true}`.
- Writing anywhere (`WRITE_ANYWHERE` in focus.js, off; `?marks=1` tries it; `js/focus-marks.js`): a click on the text begins a note there (anchor `text` with the paragraph's beginning, `option` by the tile's pencil, `card` for the title, empty space or key A), the pen (corner of the card, key D) scribbles over what scrolls; marks are in `card.draft.marks`; `carryMarks` turns them into the note text, the options' notes and one picture of the annotated card before any action. The picture is an SVG foreignObject snapshot of the left side at 2x with computed styles written in (web fonts fall back to the system's), with a plain re-rendering if the canvas is tainted.
- `WRITE_ANYWHERE` is on by default now (`?marks=0` gives the field back): no composer field; files are dropped or pasted on the card and wait as chips at its foot; the microphone is not on the card yet. Demo boards 8841 to 8848 are stopped.
- Fourth round: the opened question is the decision (text, pictures, options, Trust, Revise, wastebasket) and at its right "Discuss" (`aside.focus-discuss`: the card's thread, a field with paperclip, microphone and send; Enter says it and the card stays). Snooze is the inbox's sliding label (`.inbox-later.focus-snooze`) at the card's right edge. What?? is no button: key E puts the caret into Discuss and the next Enter asks with `explain`. The end of the stack and "all answered" are one drawn tick, one sentence, Close (plus the piles button when there are any). Notes on paragraphs and options and the pen stay; a general note is written in Discuss.
- Later the same round: Discuss is folded away by default (`setDiscuss`, `rec.discussOpen`, `data-discuss` on the card); the pen in the card's corner opens it (two thirds / one third, eased) and it opens by itself for a thread, a draft, Revise, What?? and key A. The scribble pen stands in the Discuss field's row. Options written into the text (sections) are not repeated as tiles. The ways out are one row of four equal wordless buttons (`rec.actionsNode`, `WAYS_PLACE`): reverse card (Revise), z z z (Snooze), the shrug (Whatever; lights the advised option), the wastebasket (Shred). Revise with nothing said first asks "What should change?" in Discuss; Enter sends, also empty. No Snooze tab at the edge any more.
- Decided after trying the side column: no Discuss column. The opened card is one scrolling column (the decision, under it what was said in time order, "N messages below" as a chip under the title), the field at the foot of that column, and at the right, fixed, the answers and the four symbols (Snooze, Revise, Whatever, Shred). Many pictures: one large picture with a one-row filmstrip; the grid is a toggle. `mountFocus().revise()` scrolls to the field and asks "What should change?".

## One view (merged card and gallery)
- A card with pictures begins with the picture large on the stage (counter, name, "All in a grid", "Open the page",
  steps at its sides, filmstrip); title, the quiet line "From X · third version · 39 min ago · N messages below",
  text and thread follow by scrolling; the field stays at the stage's foot. Right: white column, options, Send, the
  four ways out at its bottom. Copy, read aloud, close at the stage's top right (also in the window of one card).
- Picture and option are tied both ways: an option under the pointer shows its picture; the picture shown marks its
  option (data-match) and the pen arrow points at it (linkPicture). No tile that changes with the picture.
- Mini title (`.focus-up`) while the real title is out of sight; click or Home goes to the top.
- Walk: scrolling stack (`LIST_WALK`); a card that leaves is gone, a note at the top left says what happened, with
  Back. No strips.
- A card that is not open any more opens to read (`open(id)` with any status, `data-past`, "Take back").
- `gallery()` on the mountFocus object: the open card at its first picture, false (and closed) without pictures.
- Sectioned cards: a short plain block before a run of options is that group's heading (`optionGroups`); Send says
  which group has nothing picked (a hint, it does not block: the contract has no "one per group").
- Words go only into the foot field; a note on a paragraph starts from the pencil beside it; the pen draws only in
  its mode (Drawing · Clear drawing · Done, Esc). Strokes from before that mode are dropped from drafts.
- Not built yet: mounting the card inline in a Desk row (planned name: `openInline(host, cardId, { onClose })`).

## Hosts of the card, toolbar, walk page
- `openInline(host, cardId, { onClose })`, `closeInline()`, `isInline()` on the mountFocus object: the same card
  unfolded inside a host element; height follows content, buttons column sticky, page not locked.
- The walk (`.focus[data-list]`) is a page of its own: opaque ground, "Desk" back button top left, the note under it;
  `body[data-focus-page="walk"]` while it is open. End state names who is at work (`avatar` from agents.js).
- Snooze and Shred stand in the quiet row at the stage's top right; beside the answers only Revise and Whatever.
- Revise hands back at once (no "What should change?" stop). `revise(cardId?)` hands back without opening.
- Pass order: `oneTapFirst` (exported with `oneTap`): one-tap cards first, then the rest, server order within.
