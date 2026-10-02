# Rich content worker log (js/richhtml.js, css/richhtml.css, server/richhtml.mjs, dev/richhtml-test.mjs)

Running notes, newest at the bottom. Nothing here is committed by the worker.

## What it is
An agent can send comparison tables and other layouts with a message or a question.
- **Markdown tables** in any text: already drawn by `rich()`; now also found right under a sentence (no blank
  line needed) and without outer pipes; columns of numbers right-aligned (`.num`), `:--:` in the rule obeyed.
- **HTML**: the field `html` on `reply`, `create_decision`, `revise_card`, `merge_cards` and on a block of
  `sections`, or a block fenced as ```` ```html ```` in any text. Shown at its place in a sandboxed frame.

## Decisions
- **Scripts: the agent's never run.** The frame has `sandbox="allow-scripts"` only so that the board's own
  small script can report the height. The frame's policy allows scripts only with a nonce made per frame
  (`script-src 'nonce-…'`), which agent HTML cannot know; handlers in tags never run under that policy. On top,
  the server strips scripts before storing and the client parses and strips again (DOMParser). A page that must
  run stays with `publish_asset`.
- **No network at all from the frame**: `default-src 'none'; style-src 'unsafe-inline'; img-src data:;
  font-src data:; base-uri 'none'; form-action 'none'`. The board's fonts are fetched once by the board page
  (the files it already uses) and handed in as data, about 180 KB per frame; without them the frame falls back
  to the system face.
- **No origin**: no `allow-same-origin`, so `parent.document`, `document.cookie`, `localStorage` all throw.
  No forms, no popups, no top navigation. A link never moves the frame: the script hands it to the board, which
  opens http(s) links in a new tab.
- **Height**: the frame's script posts `documentElement` height (ResizeObserver, also on `<details>` toggle);
  the board accepts it only from the frame it gave that name to. Capped at 70% of the window height, then inner
  scroll, a rule at the foot and "Open large" (a `<dialog>` with the same block in the same kind of frame).
  "Open large" also stands when the content is wider than its place (a wide table on a phone); otherwise it
  comes on hover. Heights are remembered per block, so a redrawn list does not jump.
- **Words beside it are required** (`text` / `body` / the section's `text`): shown above the layout, read aloud,
  and all that iOS and Linux show.
- **The field is folded into the text on the client** (`foldHtml` in store.js: text + a ```` ```html ```` block), so
  every place that draws with `rich()`/`richPlus` shows it without a line of its own: conversation, details,
  question window (body, sections, its conversation), history, versions. Nothing in focus.js was touched.
- Limit 200 KB per block (`BOARD_MAX_HTML_KB`), part of `questionSig` and of each entry in `card.versions`.

## Edits in shared files (all small)
- `js/ui.js`: import; `tidyLinks` starts from `withoutLayouts(text)`; in `rich()`: `langs`, the html branch,
  `spaceTables(chunk)`, `tidyTable(table, lines[1])`.
- `js/chat.js`: `richPlus` leaves html fences out of its language list (they are not code boxes).
- `js/store.js`: import; `normalize(foldHtml(data))` in `take`.
- `js/inbox.js`: import; `carries()` asks `richMark(card)` ("a table" / "a layout") instead of its own regex.
- `server/server.mjs`: import; one instruction sentence; `html` in the schemas of reply, the question fields and
  section items; `reply` example with a three-column table; `QUESTION_FIELDS`, `questionSig`, `parseSections`
  (fences keep their blank lines), `sectionsOf`, `questionFields`, `lengthHint` (a fenced block is not prose),
  `visualHint`, `reply`, `revise_card` (html kept / replaced / removed, in the version snapshot), `list_cards`,
  the three answers end with what was removed.
- `server/test.mjs`: one block before the last sessions close; `docs/question-contract.md`: section 6.
- `dev/fake-agent.mjs`: the API persona sends a markdown table and an HTML block, in a message and in a question.

## Verified (own trio on 8861, headless Chromium, `node dev/richhtml-test.mjs`: 42 checks)
Conversation and question window, 1440x900 and 400x860, light and dark; the frame's walls from the inside
(parent.document, top.location, cookie, storage, fetch, picture from an address, late script, handler, popup,
top navigation: all refused); hostile HTML handed to `rich()` uncleaned does nothing; height equals content;
grows when `<details>` opens; long table capped at 70vh; "Open large"; Escape closes only the big view; theme
change reaches the same frame without a reload; inbox rows name it and keep their height.
`server/test.mjs` passes with the new block (45 assertion statements).

## Not verified / open
- Real phone (touch scroll inside a capped frame), Safari and Firefox.
- The live hub needs a restart for the server part (field, cleaning, instructions); the client part is live as
  soon as the page is reloaded. Until the restart an `html` field is silently ignored by the old hub.
- iOS and Linux clients ignore `html`; they show the words.
- Fonts in the frame need the board page to reach the font files once; offline the frame uses the system face.
