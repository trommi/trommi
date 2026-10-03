# The server-rendered board (Hotwire Turbo)

Decided 3 October 2026: the board is rebuilt on Hotwire Turbo inside the existing hub. The old
single-page client loaded slowly and built every screen in the browser from one large state event.
Now the hub renders the pages; the browser gets HTML that is simply there.

This file is the brief for everyone who ports a page. Read sections 1 to 3 before writing code.

## 1. Architecture in one page

- **The hub renders HTML.** `server/turbo.mjs` holds the routes, the forms and the live stream;
  `server/views/*.mjs` hold the templates: plain functions that return strings. No framework, no
  build step, no new dependency.
- **Turbo in the browser** (`client/web/vendor/turbo.es2017-esm.js`, @hotwired/turbo 8.0.23, MIT,
  © 37signals LLC; fetched once with `npm pack @hotwired/turbo`, the unminified single ESM file,
  served compressed: about 40 kB on the wire). Drive for navigation, Frames where a part loads alone
  (a card's pictures), Streams for live changes.
- **One live stream per page**: `GET <base>/stream` is Server-Sent Events whose messages are
  `<turbo-stream>` elements. The layout puts `<turbo-stream-source id="live">` into every page.
  After every `commit()` of the hub, each open page gets the elements that changed and nothing else.
- **Forms and links do the work.** Every action is a `<form method="post">` or a link. With Turbo a
  form is answered with stream actions or a redirect; without scripts the same form is a plain post
  followed by a redirect. No client-side rendering of lists from JSON.
- **Stimulus controllers** for what must be client code: small ES modules in
  `client/web/t/controllers/`, loaded lazily for an element that asks for one
  (`data-controller="name"`). No build step: both libraries are single vendored files behind an import map.
- **Reused**: all of `client/web/css/*.css` (the markup the views emit is the markup those sheets
  style) and the hand-drawn marks (`client/web/js/pen.js`).
- **Unchanged**: auth (token cookie, passkeys), the Origin check on every non-GET, the agent API,
  `/events` and the old client, `/files`, the pad.

### Coexistence and the switch

The server-rendered pages live under a path prefix, `BASE` in `server/turbo.mjs`: `/t` today
(`/t/` the Desk, `/t/q/<n>` a card). Old and new share the hub's state, so both can be open.

- A path under `/t/` that is not ported yet is redirected to the old client's path (`/t/s/x` →
  `/s/x`), and `boot.js` lets the browser load such links whole (the hub names the ported paths in
  `<meta name="t-pages">`).
- **The flip**: set `BASE` to `''` (or start a hub with `BOARD_TURBO_BASE=`). The ported pages then
  answer at `/`, `/q/<n>`, … and everything not ported still falls through to the old client.
  Nothing else changes. The old client is deleted only at the end, on Christopher's word.

## 2. Conventions (follow these exactly)

### Escaping: one helper, `server/views/html.mjs`

```js
import { html, raw } from './html.mjs'
html`<p title="${card.title}">${card.body}</p>`   // every value is escaped (text and attributes)
```

- A template is always written with the `html` tag. Values are escaped unless they are the result
  of another `html` template or of `raw()`. Lists are joined; `null`, `undefined`, `false` are
  nothing.
- `raw()` is only for strings this code made itself: an SVG from the pen, a fixed attribute.
  **Board content never goes through `raw()`**: titles, texts, labels, names, file names, URLs.
- Text an agent wrote is rendered with `rich(text, { assets, extra })` from `views/text.mjs` (the
  light markdown: paragraphs, lists, bold, code, tables, links, `__underline__`, `☞` for the
  paragraph that matters). A block fenced as `html` (or a card's `html` field, passed as `extra`)
  is **not** put into the page: it becomes an inert holder with its source in an escaped attribute,
  and the controller `richhtml` shows it in the sandboxed frame of `js/richhtml.js`, as before.
- One line of plain words from a text: `plain(text, assets)`.

### A view and its model

- `boardModel(state, agents)` in `views/model.mjs` works out once per render what the views show
  (sessions with name, mark, hue; the stack in its fixed order: `fresh`, `revising`, `snoozed`,
  `done`; units for the sidebar; counts). A view function takes `(thing, model, base)` and returns
  `html`. A page module gets the model with `t.model()`.
- Views do not read the hub's state themselves and never change it.
- Every internal link is built from `base`: `` `${base}/s/${id}` ``. Add `data-nav` to an `<a>`
  that stands where the old client had a button (it takes the browser's link looks away,
  `css/links.css`).
- The board's words (Snooze, Whatever, Revise, …) are in `WORDS` in `views/text.mjs`.
- Pictures: `loading="lazy" decoding="async"`, with `width`/`height` where CSS gives them a size.

### Registering a page: `register(t)`

A page module exports `register(t)`; `server/turbo.mjs` gets **one import and one entry in
`PAGES`**. Everything else lives in the module's own file.

```js
// server/views/agents.mjs
export function register(t) {
  t.get(/^\/agents$/, ({ req, res, url, match }) => {
    const m = t.model()
    t.page(req, res, { model: m, title: 'Agents · Trommi', view: 'agents', main: agentsMain(m, t.BASE) })
  })
  t.post(/^\/sessions\/([\w-]+)\/rename$/, async ({ req, res, match, form }) => {
    …change the state through t.hub…                       // form: URLSearchParams of the body
    if (form.has('stay') && t.wantsStream(req)) return t.sendStream(req, res, t.stream('replace', `agent-line-${id}`, line))
    t.redirect(res, `${t.BASE}/agents`)
  })
  t.live('agents', {
    take: (model, clients) => ({ …pieces as html… }),      // what the open pages of this view hold now
    diff: (was, now, client, model) => '…stream actions…',  // for one page; '' when nothing changed
  })
}
```

- Patterns are matched against the path **without** `BASE`. A handler that returns `false` passes.
- `t.page(req, res, { title, view, main, model?, sidebar?, css?, stream?, says?, bodyAttrs? })`
  sends the whole page through `views/layout.mjs`. `view` names the page: it is `data-t-view` on
  the body and selects the live pieces. `css` picks a set of stylesheets (`CSS` in `layout.mjs`:
  add a set there if your page needs other sheets). `stream: '&key=value'` adds to the page's
  stream query (your `take`/`diff` read it as `client.params`); `stream: null` for no stream.
- What a page module may use of the hub is `t.hub` (the functions `server.mjs` hands in:
  `state()`, `agents()`, `addMessage`, `addEvent`, `commit`, `deliver`, `decide`, `trust`, `shred`,
  `snooze`, `closeInfo`, `reopen`, `readRaw`). If you need another hub function, add its name to
  the `turboRoutes({ … })` block in `server.mjs` (one word) instead of copying its body.
- A form with files (`multipart/form-data`): set `handler.raw = true` on the handler given to `t.post`; the
  router then leaves the body unread (`form` is `null`) and the handler reads it (`readMultipart` in
  `views/session.mjs`).
- Changing state always ends in the hub's `commit()`; that sends the streams. A form handler never
  writes to the stream itself.

### Forms: post → stream or redirect

- A form posts `application/x-www-form-urlencoded` to an address under `BASE` (the card forms:
  `POST <base>/cards/<id>/<way>`). Several buttons of one form go different ways with `formaction`;
  a button outside its form joins it with `form="<id>"` (a card page has one form with the note
  field, and every option is a button of it).
- The answer: a form that should leave the page where it is carries
  `<input type="hidden" name="stay" value="1">`. If Turbo sent it (`t.wantsStream(req)`), answer
  with stream actions (`t.sendStream`): only what belongs to the one who acted (the row gone, the
  passing note). Everyone, including that page, gets the real change from the live stream.
  Otherwise answer `303` to the page that should show (`t.redirect`).
- An answer that is not taken: with `stay`, a stream that replaces the element with itself plus the
  reason; otherwise the page again with status `422` and the reason on it. Nothing is saved.
- The toast at the top right ("Answered: … · Undo", `views/toast.mjs`), one for every page: `t.toast({ head, line,
  undo: { action, label, fields }, role, ms })` is the stream action (`prepend` into `#says-host`, newest on top, three
  at most); `t.says(card, way)` is a card's. Undo is a form to the take-back route with `stay=1&quiet=1`; U presses
  the newest. After a redirect, `?said=<card>:<way>` on any page's address shows it. `#says-host` is
  `data-turbo-permanent`, so a toast outlives a page change. A toast made by a controller: `t/lib/toast.js`.
- A sent memo is held by the hub for `BOARD_MEMO_HOLD_MS` (3000) before the session gets it; `POST /memos/<id>/unsend`
  (`/memo { id, unsend: true }`) brings it back within that time, after it the answer is 409 "too late". Held memos
  left by a stopped hub are delivered when it starts.
- No pop-ups: no `confirm()`, no modal veil.

### A card opened from a session: the way back

Every link from a session's page to a card has the session in its path: `<base>/s/<session>/q/<n>` (the
question's row, the quiet line of an answered one, "About …" over a message, a status line, the chip of a
passed card). No query parameter. The card route already matches that path
(`/^\/(?:s\/[^/]+\/)?q\/…/`); the session is its first path segment after `s/`. A card page reached that
way leads back to `<base>/s/<session>` (Close, the back link, and where an answer leads on) instead of the
Desk; reached as `<base>/q/<n>` it leads to the Desk as before. A picture's page under a session does the
same with `?from=<message id>`: back is `<base>/s/<session>#msg-<message id>`.

### Stream targets: names

Every element a stream changes has an `id`, named `<what>-<record id>`:

| target | element | actions used |
|---|---|---|
| `desk-state` | counts in the floating Desk | update |
| `agents` | the sidebar's rows | update |
| `agent-<session>` | one sidebar row | (inside `agents`) |
| `desk-head` | the Desk's heading | replace |
| `desk-list` | everything in `.inbox-groups` | update (only when the order changed) |
| `row-<card>` | one Desk row | replace, remove |
| `desk-stacks` | Later / Memos / Done | replace; a new row is put `before` it |
| `card-lead-<card>`, `card-body-<card>` | a card page's title and text | replace + remove |
| `card-answer-<card>` | its options or its answer | replace |
| `card-thread-<card>` | its feed | replace |
| `card-media-<card>` | its pictures (a `<turbo-frame>`) | frame navigation |
| `says-host` | the toasts (top right) | prepend |
| `msg-<message>` | one message, event line or question in a session's conversation | replace, remove; a new one is put `before` `log-end-<session>` |
| `session-who-<session>`, `session-now-<session>` | a session page's heading and the quiet line under it | replace |
| `session-filters-<session>`, `session-open-<session>` | "Questions only" with its count; the "N open" chip | replace |
| `session-status-<session>` | the status lines of running work | replace |
| `session-questions-<session>`, `session-files-<session>` | the two lists a filter shows | replace |
| `composer-<session>`, `session-error-<session>` | the composer and its error line (the form's own answer only) | replace |
| `earlier-<message>` | the messages before that one (a `<turbo-frame>`) | frame navigation |

- Build a stream action with `t.stream(action, target, content)`; `content` is `html`.
- A piece a human may be typing in is never replaced: keep fields outside the replaced elements
  (the card page's note field is outside lead, body, answer and thread).
- `take` returns rendered pieces; `diff` compares with `t.differs(a, b)` (it ignores relative
  times) and sends only what differs. Send the smallest element; replace a whole list only when its
  order changed.
- A page whose state is older than the hub's (it was rendered before a change, or the hub
  restarted) is told to `refresh` once when its stream connects; Turbo morphs it in place.
- The sidebar and the floating Desk are kept current on every page that shows them (the layout adds
  `bar=1` to the stream); a page module does not send them.

### Controllers (Stimulus)

Decided 3 October 2026 (card Nr. 189): the front end is Hotwire whole, Turbo **and Stimulus**, still without
a build step. Stimulus 3.2.2 (MIT, © Basecamp) is one vendored file, `client/web/vendor/stimulus.js`
(from `npm pack @hotwired/stimulus`, `dist/stimulus.js`). The layout carries an import map, so every module
writes `import { Controller } from '@hotwired/stimulus'` (and `'@hotwired/turbo'`).

- **The start** is `client/web/t/application.js`: it starts Turbo and the Stimulus application and loads
  controllers **lazily**. An element with `data-controller="name"` makes it fetch
  `/t/controllers/<name>_controller.js` once (a dash in the name is an underscore in the file name) and
  register its default export. **Adding a controller needs no line anywhere else.** It also works for
  elements that arrive later, by a stream, a frame or a Turbo visit.
- The few controllers every page has are registered in `application.js` itself, so they cost no request:
  `says` (the passing note), `folds` (the sidebar's mains), `piles` (the Desk's stacks), `fit` (a row's
  title). Put nothing else there.
- `data-island="name"` (`/t/islands/<name>.js`, `mount(element)`) **still works as a shim** while the
  islands are converted; an element that has `data-controller` gets no island. New code is a controller.

A controller, with everything one needs here:

```js
// client/web/t/controllers/stage_controller.js   <div data-controller="stage" data-stage-url-value="…">
import { Controller } from '@hotwired/stimulus'

export default class extends Controller {
  static targets = ['picture', 'count']            // <img data-stage-target="picture">  -> this.pictureTarget(s)
  static values = { url: String, at: { type: Number, default: 1 } }   // data-stage-at-value="2" -> this.atValue

  async connect() {                                // the element is in the page (also after a stream or a visit)
    this.onLoad = () => this.draw()
    document.addEventListener('turbo:load', this.onLoad)       // a turbo: event on the document: add here …
    const { zoomable } = await import('/t/lib/zoom.js')        // a heavy module: fetched on connect, not at start
    if (this.element.isConnected) this.zoom = zoomable(this.pictureTarget)
  }
  disconnect() { document.removeEventListener('turbo:load', this.onLoad); this.zoom?.destroy() }   // … and remove here

  next() { this.atValue++ }                        // <button data-action="click->stage#next">
  atValueChanged() { this.draw() }                 // runs when the value changes, and once at the start
  pictureTargetConnected(img) { /* a target arrived, e.g. put in by a stream */ }
  draw() { if (this.hasCountTarget) this.countTarget.textContent = this.atValue }
}
```

- **Actions in the markup**, not `addEventListener` in `connect()`: `data-action="click->stage#next"`,
  `input->card#typed`, `keydown.enter->card#send`, `turbo:frame-load->card#link` (Turbo's events bubble, so an
  action on the controller's element catches those of frames and forms inside it), `resize@window->stage#draw`.
  A parameter: `data-stage-id-param="x"` arrives as `event.params.id`.
- **State lives in the HTML** (values, classes, `hidden`), so a stream that replaces the element brings the
  right state along. What only this browser knows (an unfolded main, the fanned stack) is kept in
  `localStorage` or a module variable and applied in `connect()` or `<name>TargetConnected()`.
- A controller never draws the page and never fetches the board's state. It enhances what the hub rendered
  and talks to the hub through forms (`this.formTarget.requestSubmit(button)`), links, or the JSON routes of
  its own feature (the pad, memos, a draft).
- It may import modules of the old client that are free of page state (`/js/richhtml.js`, `/js/pen.js`). It
  must not import `store.js`, `app.js` or anything that opens `/events`.
- Heavy things (paper, pad, scribble canvas) are imported inside `connect()` and never block first paint.
- One controller per concern, named for what it is (`card`, `circles`, `composer`), several on one element
  when needed (`data-controller="card dropzone"`). Controllers talk to each other with events:
  `this.dispatch('drawn')` is heard as `data-action="circles:drawn->card#link"`.

Converting an island: `export function mount(node)` becomes `connect()` with `this.element`; listeners it
added to the element become `data-action` in the view; `node.dataset.x` it read becomes a value; whatever it
added to `document` or `window` is removed in `disconnect()`; the file moves to
`t/controllers/<name>_controller.js` and the view says `data-controller` instead of `data-island`.

### CSS

- The views emit the class names of the old client, so `css/*.css` styles them. Do not restyle.
- Rules only the new pages need go into `client/web/css/turbo.css`, in a block headed by a comment
  that names your page. Tokens only (`tokens.css`), no literal colours.
- No `:has()` rule whose subject is unqualified (`X:has(…) > *`): it restyles the document on every
  change. Check sheets you add to a set for such rules.
- A wrapper element breaks child selectors of the old sheets (`.focus-scroll > .focus-media`):
  give the real element the `id` instead of wrapping it.

### Hand-drawn marks: `client/web/js/pen.js`

`sketchSvg(name)`, `doodleSvg(mark)`, `crownSvg()`, `handSvg()`, `ringSvg()`, `tallySvg(n)`,
`paperSvg(n, key)`, `pointingHandSvg()`, `edgeQuirk(id)`, `hueFor(agent)`: SVG strings, seeded, the
same output on the hub and in the browser. Put them into a template with `raw()`. The stroke
tables are copied from `js/ui.js` by `node dev/pen-sync.mjs` (run it after a drawing changed there)
until the old client is retired; then `pen.js` is the only place.

### Tests and running

- `node server/turbo-test.mjs` (also run at the end of `node server/test.mjs`): its own hub on port
  8793. Add a block for your page: the HTML has the right elements, content is escaped, your forms
  change state (with and without `Accept: text/vnd.turbo-stream.html`), your stream sends the
  right actions.
- Your own hub: `BOARD_PORT=<free> BOARD_HOST=127.0.0.1 BOARD_DATA=<copy of data/> BOARD_TOKEN=x
  BOARD_HUB_ONLY=1 BOARD_PASSKEYS=off node server/server.mjs`, then `/t/?t=x`.
- Views are loaded when the hub starts: a changed view needs a restart of your hub. `application.js`,
  controllers and CSS are live on reload.
- `node --check` every server file before you leave it; the live hub may be restarted at any time.

## 3. Files

| file | what |
|---|---|
| `server/turbo.mjs` | toolkit `t`, `PAGES`, the Desk and card routes, card forms, the stream |
| `server/views/html.mjs` | `html`, `raw`, `esc`, `attrs` |
| `server/views/text.mjs` | words, `rich`, `plain`, tile rules, `ago` |
| `server/views/model.mjs` | `boardModel` |
| `server/views/layout.mjs` | `page()`: head, floating Desk and menu, sidebar, stream source |
| `server/views/sidebar.mjs` | sessions, crowns, badges, the Desk's counts |
| `server/views/desk.mjs` | rows, tiles, stacks, heading |
| `server/views/card.mjs` | the card page, its pictures, feed, the picture page |
| `server/views/session.mjs` | a session's page: conversation (latest 60, earlier by frame), composer, filters, files, picture page; its routes and live pieces |
| `client/web/t/controllers/composer_controller.js` | the composer: Enter sends, growing field, file chips, paste, drop anywhere on the page, the draft |
| `client/web/t/controllers/log_controller.js` | a conversation: "To the end" with the unread count, the "N open" chip, times in the browser's zone |
| `client/web/t/controllers/copy_controller.js` | a button that copies (a code block, a link); exports `copyText` |
| `client/web/t/controllers/share_controller.js` | "Share" on a published asset's card (the route `/asset/share`) |
| `server/turbo-session-test.mjs` | the session page's tests (called from `turbo-test.mjs`) |
| `client/web/t/application.js` | the start: Turbo, Stimulus, the lazy loader, the controllers of every page |
| `client/web/t/controllers/*_controller.js` | controllers, loaded lazily |
| `client/web/t/islands/*.js` | islands not converted yet (shim) |
| `client/web/t/boot.js` | the start of pages rendered before the hub's restart; goes when nothing loads it |
| `client/web/vendor/` | `turbo.es2017-esm.js` (8.0.23), `stimulus.js` (3.2.2), both MIT |
| `client/web/css/turbo.css` | the few new rules |
| `client/web/js/pen.js`, `dev/pen-sync.mjs` | the pen |
| `server/turbo-test.mjs` | tests |

Hooks in `server/server.mjs` (five small ones): the import, `turbo.changed()` at the end of
`commit()`, the `turboRoutes({ … })` block before `withoutToken`, `turbo.isPage()` in the sign-in
condition, `turbo.route()` before the `APP_PATH` line.

## 4. Routes today

All under `BASE` (`/t`), behind the login like every other route.

| method and path | what |
|---|---|
| `GET /` | the Desk. `?pile=later\|done` shows that stack fanned out whole, `?said=<card>:<way>` the passing note |
| `GET /q/<n>`, `GET /s/<session>/q/<n>` | a card's page (`<n>`: its number, or its id). `?pic=<i>` which picture stands large, `?walk=1` a step of "Next, please" |
| `GET /q/<n>/p/<i>` | picture `<i>` of the card, large, at its own address: the browser's Back closes it |
| `GET /walk` | redirects to the oldest open card (`?walk=1`), or to the Desk when none is left |
| `GET /stream?rev=…&view=…[&bar=1][&card=<id>]` | the live stream (SSE of `<turbo-stream>`) |
| `POST /cards/<id>/decide` | `key` (or `keys` several times), `note`, `revised` |
| `POST /cards/<id>/trust` | Whatever: leave it to the agent (`note`) |
| `POST /cards/<id>/snooze`, `/wake` | put off, fetch back |
| `POST /cards/<id>/revise`, `/what`, `/takeback` | hand back with `note`, ask to explain, take it back from the session |
| `POST /cards/<id>/shred`, `/reopen` | throw away unanswered, take an answer or a shredding back |
| `POST /cards/<id>/close` | acknowledge an info |
| `POST /cards/<id>/message` | `note`: words to the session about the card (an open card is handed back with them) |

Every form may carry `stay=1` (answer with a stream, stay on the page), `walk=1` (go on to the next
card), `quiet=1` (no passing note).

## 5. What the slice does, and what is missing for parity

**Works** (checked in headless Chromium at 1440x900 and 400x860, and by `server/turbo-test.mjs`):
the Desk with its rows in the hub's fixed order (session mark, title, text, pictures, what the card
carries, knock marker), tiles that answer with one tap, "Choose" as a real link to the card's page,
Snooze and Shred on the row, the heading with the count as the way into the walk, the stacks Later /
Memos / Done with Take back and Wake up, the sidebar with sessions, crowns, folded subs and badges,
the floating Desk with its counts and the Trommi menu (Agents, Help, Admin, Keys, theme, connection),
the passing note at the top left with Back, live updates (a card arrives, an answered one leaves,
counts, stacks, sidebar), and the card page (title, text, gallery, options as forms, "or" Whatever,
What?? and Revise, Snooze and Shred, the feed with live replies, the note that goes along with an
answer, several answers on a `multiple` card, the picture's own page, the way back).
The paper under the Desk is **absent** in the slice (package C mounts it as an island after first paint).

**Missing on the Desk**
- the paper and its two switches, the memo button and the yellow notes (package C)
- keys (J/K, Y/N, L, …), the keys sheet, jump (Ctrl K), the phone's long-press sheet with Revise,
  Whatever, What??, Copy (package D); Revise and Whatever are rendered on the row but hidden, as in
  the old client
- the copy button of a row (`cardclip`), the drawn advice marker (a plain underline stands in), the
  "2 new ↑" note and the knock strips at the list's edge, the row landing exactly where the answered
  one stood (`landOn`), the unfolded main's bracket in the sidebar, dragging sessions, archive
- the heading as index cards (card Nr. 166): its CSS has not landed in `app.css` yet; the view keeps
  the class names (`inbox-heading`, `inbox-walk`, `inbox-circled`), so it applies when it does
- small pictures: a row loads the full-size attachment as its thumbnail (lazy, but about 60 kB each);
  the hub has no thumbnails yet. This is most of the Desk's remaining bytes
- other desks (`state.desks`): the model shows the whole board as one desk

**Missing on the card page**
- drawing and pinning notes on the card (marks), notes on single options, attachments and dictation
  in the field, reading aloud, the saved draft (the note of a draft is shown; nothing is saved while typing)
- earlier versions of a revised card and the revision note; sections with their own pictures (the
  body is rendered whole)
- the picture stage's arrow to the option a picture belongs to; zoom inside the large picture
- a link that belongs to an option, shown in the feed and not in the tile (card Nr. 179): nothing
  renders it yet
- on a phone an info card's picture should stand low (about 140 px) so that Acknowledge is in the
  first screen (card Nr. 180): not done
- the walk's count ("2 of 5") and the flight of the card that leaves

## 6. Numbers

Measured on one machine against one hub with a copy of the live data (5 open cards, 153 cards,
1158 messages), cold cache, headless Chromium, `node dev/turbo-measure.mjs`. The old client already
had the performance worker's compression and ETags. "Rows there": when the first row (or option)
stands in the page; for the server-rendered pages that is first paint.

| page | requests | kB | scripts (kB) | first paint | rows there | main thread blocked | script time |
|---|---|---|---|---|---|---|---|
| Desk, old, desktop | 81 | 1311 | 31 (231) | 56 ms (empty) | 144 ms | 63 ms | 58 ms |
| **Desk, Turbo, desktop** | 32 | 1039 | 3 (49) | 84 ms | 84 ms | 0 ms | 4 ms |
| Card, old, desktop | 93 | 1955 | 33 (287) | 68 ms (empty) | 280 ms | 238 ms | 58 ms |
| **Card, Turbo, desktop** | 22 | 375 | 3 (49) | 60 ms | 60 ms | 0 ms | 6 ms |
| Desk, old, phone (CPU 4x slower, 40 ms round trip) | 70 | 518 | 31 (231) | 276 ms (empty) | 647 ms | 185 ms | 194 ms |
| **Desk, Turbo, phone** | 21 | 247 | 3 (49) | 216 ms | 216 ms | 0 ms | 12 ms |
| Card, old, phone | 93 | 1955 | 33 (287) | 264 ms (empty) | 1057 ms | 694 ms | 226 ms |
| **Card, Turbo, phone** | 22 | 375 | 3 (49) | 236 ms | 236 ms | 0 ms | 14 ms |

- The Desk's HTML is 90 kB (about 12 kB compressed). Most of the remaining bytes are the rows'
  pictures at full size and the web fonts.
- A change costs what it changes: a new card is one row (about 4 kB) plus heading, counts and
  stacks, where the old client got the whole state (about 790 kB, a sixth of it compressed) and
  rebuilt its lists.
- The old card page builds every open card (3942 DOM nodes); the new one is one card (188).

## 7. Migration order and work packages

Each package owns its files; shared files get one small block each (section 2).

| package | owns | size | notes |
|---|---|---|---|
| Lead: Desk, card page, layout, sidebar, stream core | `turbo.mjs`, `views/{layout,sidebar,desk,card,text,model,html}.mjs`, `boot.js`, `turbo.css` | done as a slice; parity list in section 5 | |
| A. Session page | `views/session.mjs`, `t/islands/composer.js` | large (the old `chat.js` is 1200 lines) | conversation (`msg-<id>`, appended by the stream, older messages by a frame), composer as a form, a session's questions (reuse `deskRow`), files, the picture's page. Scribble stays an island |
| B. Agents page | `views/agents.mjs` | medium | the ledger, rename, mark picker, crown and memo receiver, archive and fetch back, pairs. Forms post to `/sessions/<id>/…` (add `setProfile` and what `/session` does to `turboRoutes`) |
| C. Paper and memos | `t/islands/paper.js`, `t/islands/memo.js` | medium | the paper mounts after first paint on `<section data-island="paper">` in the Desk; select → send → flies away must survive unchanged: reuse `pad/` as it is. Memos: the yellow notes and the Memos stack (`data-pile-empty="memos"` is its place) |
| D. Keys, menu, phone sheets | `t/islands/keys.js`, `t/islands/menu.js`, `views/menu.mjs` | medium | keys act by pressing the forms' buttons (`.inbox-answer`, `.inbox-later`, …) and following links; the keys sheet lists the keys of the view in sight, without a veil, full table at `/help.html#keys`; `g` then `1`…`9` switches desks; jump; the long-press sheet of a row |
| E. Card page to parity | `views/card.mjs`, `t/islands/marks.js`, `t/islands/stage.js` | large | section 5; the old `focus.js` is 3300 lines, most of it marks and the stage |
| F. Thumbnails | hub | small | sized pictures for rows and thumbs (`/files/<name>?w=…` or stored small copies) |
| G. Tests in the browser | `dev/turbo-ui-test.mjs` | medium | the groups of `dev/ui-test.mjs` that still apply, against `/t/` |
| H. The flip and the clean-up | `BASE = ''`, then delete `client/web/js/*` that no island imports, `index.html`, `/events` | small, last, on his word | `pen.js` becomes the only home of the drawings; `ui.js` goes |

Order: A and B make the board usable without the old client; C and D bring back what he uses all
day; E and F are parity and speed; H is last.

Decisions of 3 October that belong to these packages: the passing note after an answer (done on the
Desk; D owns it for other pages), the pointing hand `☞` (done in `rich()`), an option's link in the
feed (E), the picture's own address (done), the keys sheet without a veil (D), desks by `g` + digit
(D). Dead and hidden parts of the old client (`docs/screens.md`) are not ported.

## 8. Risks

- **Two homes for the drawings** until the flip: `ui.js` and `pen.js`. `dev/pen-sync.mjs` copies the
  tables; forgetting it shows as a drawing that differs between old and new pages.
- **Markup is the contract with the CSS.** The old sheets were written against DOM built by scripts,
  some of it sized by script (`--answer-h`, `data-tall`, the advice marker). Where a sheet needs a
  measured value an island sets it after paint; prefer a CSS rule in `turbo.css` when one will do.
- **A stream replaces elements.** State the browser added (a fanned stack, an unfolded main) is put
  back by `boot.js` after every stream render; an island that keeps state on an element must do the
  same, or keep it outside the replaced element.
- **Order of stream and page.** A page rendered before a change learns of it through `refresh` when
  its stream connects. A form's own stream answer and the live stream may both remove the same row;
  that is harmless (a missing target is ignored).
- **Other workers edit the old client.** Class names the views rely on can change under them; the
  browser test (G) is what notices.
- **`changed()` renders for every open page on every commit.** Today that is the open rows, the
  stacks' first sheets and the sidebar: well under a millisecond per commit here. A page module whose
  `take` grows with the board (a whole conversation) must render only what its open pages show.

## 9. Thumbnails (package F)

**Decision: a tool that is already on the machine, started with `execFile`; no dependency.**
Node cannot decode or scale a picture. `vipsthumbnail` (libvips) is installed here and makes a variant in
0.1 to 0.3 s; ImageMagick's `magick` is the second choice; without either the hub serves the original, so
nothing breaks on a machine that has neither. A vendored pure-JS codec would be a large file for a slow
PNG decoder and no WebP encoder; `sharp` is a native dependency for something two lines of `execFile` do.

- **Route**: `GET /files/<name>?w=<width>`, in the same handler and behind the same login as `/files/`.
  Widths are 160, 320, 640, 1280; any other number is the nearest of these; what is no number gets the
  original. The answer is WebP (quality 82), ratio kept, never larger than the picture itself
  (`?w=1280` of a 400 px picture is the whole picture, only lighter), with
  `Cache-Control: private, max-age=604800, immutable` and an `ETag` (`If-None-Match` → 304).
- **The original instead** (same URL, the original's headers): no tool, the tool failed (logged once, not
  tried again until restart), a GIF (it may move), SVG and everything that is not PNG/JPEG/WebP by its first
  bytes, a picture above 100 megapixels, and a variant that would not be smaller than the original.
- **Cache**: `<data>/thumbs/<name>.<width>.webp`, created by the hub, written to a temporary name and
  renamed. A variant is made on its first request, at most three tools run at once, and requests for the
  same variant share one job. Variants of deleted files are removed when the hub starts. The folder may be
  deleted at any time; `deploy/backup.sh` leaves it out.
- **Safety**: the name must match `[\w-]+.(png|jpg|jpeg|webp|gif)` and exist among the stored files; the
  type comes from the file's first bytes, not its name, and is named to ImageMagick (`png:<path>`); no
  shell, fixed arguments, 30 s timeout. Encrypted assets (`/a/…`) never come here.
- **Sizes**: `imageSize(bytes)` in `server/thumbs.mjs` reads width and height of PNG, JPEG (with EXIF
  orientation), WebP and GIF from the header. New attachments and uploads carry `width` and `height` in
  their record; for older records the size is read from the file once and kept while the hub runs.
- **In a view**: `import { srcOf, thumb } from './picture.mjs'`.
  `html\`<img${srcOf(a, 56)} alt="" loading="lazy" decoding="async" width="56" height="42">\`` writes `src`
  and, where a dense screen needs another variant, `srcset` (1x/2x). The number is the width the picture is
  shown at in CSS pixels. `thumb(a, width)` returns `{ src, srcset, width, height }` for a view that also
  wants the picture's size at that width. Used: Desk rows (56), a card's stage (1280), its thumbs (64),
  a section's picture (640), pictures in the feed (320). The picture's own page keeps the original.
- **Measured** (copy of the live data, `dev/turbo-measure.mjs`, desktop, cold browser cache): the Desk's
  three row pictures 481 kB → 6 kB (page 927 → about 460 kB; the rest is fonts, scripts and CSS), card
  Nr. 182's four pictures 165 kB → 18 kB (page 414 → about 320 kB). First paint is unchanged (pictures
  load lazily after it); on the phone profile the row pictures were not loaded before either.
- **Tests**: `server/turbo-thumbs-test.mjs`, run by `server/turbo-test.mjs`.

## Kept for later
- **The clipboard look** (`client/web/css/clipboard.css`, tokens `--clip-*` in `css/tokens.css`, trial page `client/web/designs/clipopener.html`): too much for the Trommi menu (Christopher, 2026-10-03), shelved for a future user-settings page where it can be larger. Kept on disk, to be talked over again later.
