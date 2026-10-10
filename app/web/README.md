# The Trommi web app

The app at **https://app.trommi.com**: a static, local-first single-page app. Every device makes its own keys, keeps
the room in IndexedDB, decrypts and renders locally (the client core in a Web Worker, the page with a copy of its
model: [`core/README.md`](core/README.md)), and talks to the hub only in sealed envelopes. No framework: plain ES
modules and CSS, one file per view; deployed as one minified bundle that loads each view when it is first needed
(Cloudflare Workers static assets: `wrangler.jsonc`, directory `public/`, build step `dev/build.mjs`).

## Running it

With Node 26 (`.node-version`) and `npm ci` once in `app/web/` (its `package.json`), from the repository root:

```bash
node app/web/dev/serve.mjs 8900            # the app from its sources, built in memory on every request (never stale, no service worker)
node app/web/dev/serve.mjs 8900 --bundle   # the same as deployed: the minified bundle, views loaded on demand
```

- `http://127.0.0.1:8900/` on a device without an account: Create account or Log in.
- `http://127.0.0.1:8900/?mock=1` the demo room: the same app on a mock of the core, no hub, nothing sent. The room is
  the repository's [`demo/`](../../demo/README.md), for now an empty one. `?mock=0` leaves the demo.
- `http://127.0.0.1:8900/screens?mock=1` every listed screen and state of the demo side by side, desktop and phone.
- `http://127.0.0.1:8900/?mock=1&onboard=create` one account screen drawn by the demo (`auth.mjs` `demoFlow`).

A change to a view: edit its `.mjs` and `.css`, reload. Nothing generated is committed; the deploy bundles it.

### Developer switches

Not shown anywhere in the app; all are kept for the tab only (sessionStorage).

| Switch | What |
| --- | --- |
| `?hub=<url>` | another hub than the default, for self-hosting and local work. Default: `https://hub.trommi.com`; on localhost `http://127.0.0.1:8890`. The deployed app's CSP (`public/_headers`, `connect-src`) names only the default hub: an app served for another hub names that hub there. The dev server also lets `http://127.0.0.1:*` and `http://localhost:*` through |
| `?found_code=<code>` | a founding token, for a hub that asks for one when an account is created |
| `?core=page` | run the client core in the page instead of its worker (for debugging) |
| `?mock=<name>` | the demo room. `1` is the room as it is; `crazy` generates a very big room (`dev/perf.mjs`); `side`, `quiet`, `fresh`, `first`, `many`, `foot`, `reads`, `link` are variants built from the room's own sessions and cards, so on the empty room they show it as it is |
| `?state=<name>`, `?onboard=<name>` | demo only: the click a state of `/screens` needs, an account screen |

## Checks

```bash
(cd app/web && npm test)                   # types, the layout rules below, the demo data, crypto and core tests
node app/web/dev/check.mjs                 # the layout rules alone
node app/web/dev/build.mjs                 # the build, in memory: prints the cold start's size, writes nothing
node app/web/dev/look.mjs URL 1440,900 out.png [--dark] [--js '...']   # one screenshot, console errors (needs Chromium)
node app/web/dev/perf.mjs                  # the very big demo room (?mock=crazy), desktop and a slowed phone (needs Chromium)
```

End to end against a real hub, in headless Chromium: `dev/e2e.mjs`, `dev/e2e-mobile.mjs`, `dev/e2e-passkey.mjs`, and
`dev/card-drawing.mjs` against a demo room with cards. The hub and a demo room with content are not in this
repository yet; these scripts wait for them.

## Layout

```
worker.js              http -> https, the universal links' file
wrangler.jsonc  THIRD-PARTY.md   fonts, Argon2, the QR reader, the word list: whose they are
core/                  the client core (TypeScript): the room, sync, crypto, storage, the worker. core/README.md
dev/                   serve, build, check, verify; look, perf and the browser tests (cdp.mjs drives Chromium)
public/
  index.html  sw.js  manifest.webmanifest  _headers  robots.txt  frame.html (the sandbox a published page runs in)
  help.html            help and "how it works", its own style and script inline
  app.mjs  app.css     start, router, the room in the page (board state, actions, the pages and their live
                       pieces), frame, attachments, push, new versions; app.css: tokens, base layout, type, links, focus
  ui.mjs               what every view shares: html, the pen, words, toasts, the controllers (controller(name, class)),
                       rich text, agent layouts, keys, a card's row, a session's mark, the room's frame
  auth.mjs/.css        account screens, passkeys, password, Emergency Kit, recovery, pairing, devices, settings, log out
  desk  card  session  sidebar  notes  media  agents  whiteboard   (.mjs + .css each)
  paths.mjs            the addresses of before (/s/…, /a/…) and their new form; shared by app.mjs and worker.js
  demo/                the demo room's code (demo.mjs, screens.css); its data is the repository's demo/data/, which
                       the build copies here as fixture.json and files/ (not in git)
  fonts/  icons/  drawings.json
  apple-app-site-association.json   the iOS app's universal links, served at /.well-known/apple-app-site-association
  gen/                 generated by dev/build.mjs, not in git: app/ (the bundle: app-<hash>.mjs and its chunks),
                       vendor/tools-reference.mjs (for the help page), bundle.<hash>.css, build.txt, manifest.json
```

**Inviting an agent.** The invite page (`auth.mjs` `clipboard()`) shows three commands to copy: once per machine
`curl -fsSL https://raw.githubusercontent.com/trommi/trommi/main/install.sh | sh` (the connector's signed release,
`connector/README.md`), once per program `trommi-connector setup claude` (or `setup codex`), once per folder
`trommi-connector connect '<link>'` with the invite's link. The iOS app and the website show the same three. The app
serves no connector binaries. Two of the connector's files feed the help
page's list of tools: `connector/tools.json` and `connector/prompt.md`.

## Rules

1. A view imports only from `app.mjs` and `ui.mjs` (the core through `app.mjs`), never from another view. What two views
   need goes to `ui.mjs` (markup, controllers) or `app.mjs` (data, the room). `ui.mjs` imports nothing.
2. No crypto in the app: everything crypto, account and keys comes from the core (`gen/vendor`, via `app.mjs` `core()`,
   `account()`, `scribbleWire()`).
3. `gen/` is never edited by hand and never committed: the build makes it.
4. A file is split only when it passes about 3000 lines.
5. The views are `.mjs`, the core is strict TypeScript (`app/web/tsconfig.json`). Importing a module
   does nothing; `app.mjs` boots the page.
6. A view other than the Desk's (desk, sidebar, notes) is loaded on demand: `app.mjs` `LAZY` names the addresses each
   answers; the router loads it before the first such address, and all of them once the first page is idle. A view
   that adds a page adds its addresses there.
7. **No `<style>` elements and no inline scripts** in what a view renders: the CSP refuses them (`style-src 'self'`,
   no `'unsafe-inline'`). Styles go into the view's `.css` file (or a file of its own under `public/`, named in
   `dev/check.mjs`); a `style="…"` attribute is fine (`style-src-attr`: the views set `--hue` and the like per element).
   An inline `<style>` or `<script>` in `index.html` or `help.html` needs its hash in `_headers` (`dev/check.mjs` says which).

`dev/check.mjs` fails on a file outside this layout, a view that imports another view, crypto outside the core, an
inline script or style whose hash is not in `_headers`, and broken demo data.

## The build

`dev/build.mjs` makes everything generated, at deploy time:

- `public/gen/app/` (esbuild, minified and split): the entry `app-<hash>.mjs` with app, ui, desk, sidebar and notes,
  one chunk per lazy view, the core as chunks of its own, the demo, the core's worker in one file
  (`core-worker-<hash>.mjs`), the account screens' part of it (`core-worker-account-<hash>.mjs`, loaded only by them)
  and `core-start-<hash>.mjs`, which `index.html` runs first to start the worker. Beside them lies the Rust core,
  `trommi-core-<hash>.wasm`, as `core/wasm/build.sh` made it (`core/wasm/pkg/`; the build runs that script only when
  its output is missing or older than the core's sources); the binding's scripts are inside the worker. Every name
  carries its content's hash; `_headers` keeps them immutable.
- `public/gen/vendor/tools-reference.mjs`: the connector's tools and events, for the help page.
- `public/gen/bundle.<hash>.css`: the `<link>`s of `index.html` as one stylesheet, in their order.
- `public/gen/build.txt` and `public/gen/manifest.json`: the commit, every served file with its SHA-256, the build hash.
- in `index.html` the scripts and the modulepreload list, in `sw.js` `VERSION` and `SHELL`, in `_headers` the hash of
  the import map. In the repository these three are templates (empty preload block, `VERSION = "dev"`, `SHELL = []`).
- `public/demo/fixture.json` and `public/demo/files/`: the demo room, checked first.

`node dev/build.mjs` checks only and prints the cold start's size; `--write` writes into `public/` (never commit that:
it rewrites `index.html`, `sw.js` and `_headers` too). In Cloudflare's build (`WORKERS_CI=1`) it runs `npm ci` in
`app/web/` first, writes, and refuses another Node, esbuild, Rust or wasm-bindgen than the pinned ones
(`.node-version`, `app/web/package-lock.json`, `rust-toolchain.toml`, `core/wasm/Cargo.toml`). `dev/serve.mjs` serves the
build from memory: by default the sources as modules of their own, with `--bundle` as deployed.

**Integrity.** The bundle's `index.html` carries `integrity` (sha384) on the entry, `core-start` and every
modulepreload, and an import map with the integrity of every module of the page; its hash is added to the CSP of the
generated `_headers`. The core worker loads from this origin under the same CSP (workers take no integrity attribute);
the Rust core's scripts are inside it, and its `.wasm` is fetched with the SHA-256 the build computed
(`fetch(url, { integrity })`), so the browser hands the worker nothing but those bytes.

**Deploying.** Cloudflare Workers: root directory `app/web`, build command `node dev/build.mjs` (`wrangler.jsonc`),
deploy command `npx wrangler deploy`, Node from `.node-version`. The build reads `app/web/`, `demo/data/`,
`connector/tools.json`, `connector/prompt.md`, `core/` (through `core/wasm/pkg/`), `Cargo.toml`, `Cargo.lock`,
`rust-toolchain.toml` and `.node-version` (`package.json` and `package-lock.json` are in `app/web/`): a change to any of them is a new build.

### Verifying the build

`gen/manifest.json` lists every file the app serves with its SHA-256; `gen/build.txt` names the commit and the **build
hash**, the SHA-256 of that manifest. The build is reproducible (content-named files, no time stamps, the toolchain
pinned and named in the manifest: Node, esbuild, Rust and wasm-bindgen; its output does not depend on the directory it
runs in), so anyone can check that a server serves exactly this source:

```bash
curl -s https://app.trommi.com/gen/build.txt          # commit: <c>, build: <hash>
git checkout <c> && (cd app/web && npm ci)
node app/web/dev/verify.mjs                           # or --app <url>: builds here, compares the manifests file by
                                                      # file, fetches every file and checks its bytes; exit 0 = verified
```

The service worker: a new deploy takes over at once and the page reloads (a field with unsent words: a quiet "Reload"
instead); files come network first, the cache only offline. On the dev server (`VERSION "dev"`) there is none.

## The Desk

- **Goals:** under the greeting, a desk's own checklist (at most 20 lines of 200 characters: `GOALS_LINES`,
  `GOALS_LINE_MAX`, `cleanGoals` in `app.mjs`), written in place with a click; empty only a faint "Goals…", nothing on
  All desks. The Desk shows the first five lines (`GOALS_SHOWN`) and folds the rest behind "+N more", which opens them
  in place ("Show less" folds them again; open or not is kept per desk in `localStorage` `trommi-goals-open`), so a
  long list never pushes the cards off the screen. A line that starts with an emoji or a tick box has its sign in a
  column of its own: the words of such lines start under each other. The field grows with its words to twelve rows,
  then it scrolls. Leaving the field always keeps what was written: on `blur`, and also on a press outside it, when the
  page is hidden or left, and when the field is found to be no longer the active element (a document without focus, a
  background tab, sends no `blur`). Kept in the desk's register (`desk/<id>`, `goals`), so every device of the account sees
  it; the agents on the desk are told them.
- **Rows:** every open card is one row in the hub's order, blocking first, then knocks; infos stand among them (What?? and
  ✓ instead of answers). A row: the session's drawing as a stamp before the title, the urgency sign, the title, square
  answer tiles; under the pointer the teaser and, at the left, a ring that selects it (Shift: a range). Rows of one session
  that follow each other stand in one run, held by a pen curly bracket at the far left (two or more). A row that leaves
  glides out while the rows below move up (`app.mjs` `flipOut`, transform only).
- **Tips:** one tip in the app's look for every element that says something under the pointer (`app.mjs` "tips",
  `app.css` `.tip`): `data-tip`, and any `title` (taken over when the pointer comes, so the browser's own tooltip never
  shows). A row's title says its number, session and whole title.
- **Selection bar:** while rows are selected, Later (the pull-tag: the rows go down into Off your mind), Egal, Read (with
  infos), Shred; one POST `/cards/batch`, one toast with Undo.
- **With the agents:** answered cards whose session is still at it, one line each, below the open ones. A card answered
  with a final option (a small pen tick on its tile) never lies here: the answer settles it, it goes to "Off the desk"
  at once ("settled by your answer"), and Take back opens it again.
- **Foot:** Off your mind (the end list: what is with the agents, then snoozed, done, shredded cards, five lines; "Show
  more" at the right end of its heading opens `/stacks/off`, the whole list with a search), Artifacts (the newest four;
  its heading "Artifacts N" is the link that opens `/artifacts`: Media and Pages together, the newest first, the filter
  All · Media · Pages, compact tiles in a soft frame with Open and, on a page, Share as small icons; 25 tiles made at once,
  the rest as they come near).
- **Note:** one drawn yellow note at the window's bottom-right; it unfolds there to write, takes attachments, sends to the crown (on All Desks: to a desk's crowned session, chosen where several desks have one); a square sheet on a wide window (`sidebar.mjs` `cornerNote`).
- **Sidebar:** the Desk box, the sessions (a main with its helpers on a pen bracket, tallies, the red hand), "New agent" and
  the Trommi menu at its foot. One sidebar, two presentations (`sidebar.css` "A phone"): beside the page on a wide
  screen (foldable to a rail), a drawer up to 860px that a finger from the left edge slides in over the dimmed page (a
  tap beside it, a push back, Esc or a choice closes it). A phone's top line is the pill (the desk's drawing and name;
  it opens the menu, `sidebar.mjs` `phoneBar`), in a chat the way back to the chats; at its foot a glass capsule Chat ·
  Desk · Note (`tabBar`).

## The Scribble Board

Drawing is the back of the Desk: its top-right corner is a small dog-ear that lifts as the pointer comes near and
follows it freely when held; a tap, a pull past a third of the way, a fling or `P` turns the page to the
**Scribble Board** (`/scribble-board`; the same corner, Esc or `P` turns back; `ui.mjs` controller `curl`). Under the
lifted sheet lies the other page itself: the board is the frame's part `pad`, mounted once when the corner is first
approached and kept under the Desk (`app.mjs` `keepPad`); the Desk under the board is rendered from the model
(`peek`). The page is
the pad (`whiteboard.mjs` mountPad) as large as the main area; select or frame something and **Send to…** a session.
One drawing on it is a scribble.

What is drawn is the board of the desk in view (`boardOf` in `whiteboard.mjs`; the ids are the core's `scribble.ts`
`deskBoard(desk id)`, `ALL_BOARD` and `MAIN_BOARD`, which is also the wire format): one board per desk, one for
"All desks", and a room without desks draws on the `main` desk's. On "All desks" the page shows All's own board, and
at its left a column of small cards, one per desk: the desk's drawing and name, its board as a live thumbnail and how
much is on it (`whiteboardDesks`, controller `whiteboard` `thumbs`: each card's board is opened with `openCanvas` and
painted small); a click opens that desk's board (`/scribble-board?desk=<id>` switches the desk and stays on the
board). On a desk the page shows that desk's board with one quiet line at the top left: back to All desks, and the
desk's name. A room with one desk or none shows neither.

**Parking the corner note (wide windows).** On the Scribble Board the yellow corner note can be dragged onto the board
(`sidebar.mjs` controller `corner-note` `park`, event `trommi:park-note`, taken by `whiteboard.mjs`): closed, the
corner's sticky is dragged; open, the sheet is taken by its paper (its edge, its foot, the grip "onto the board"),
never by its words. Where it is dropped it stays as a `sticky` with its words; its pictures are laid under it as
pictures of the board (decrypted here and uploaded as the board's own attachments), and both leave the corner's note.
Files that are no pictures stay with the note.

**The board's controls.** One row at the foot: undo and redo at its head, a hairline, the tools, the
picture clip, and beside it the cut-out drawing. The zoom (out, 100 %, in, fit) is a small capsule at the top right,
beside the turned corner. Light or dark is not the board's: on a wide window the switch stands at the sidebar's foot
beside the fold button (`sidebar.mjs` `SIDE_FOOT`, `.side-theme`; above it on the rail); a phone, which has no sidebar foot, keeps it in the menu. The board has no "?" button: `?` opens its shortcuts.

## The account

The app says **account**, never "room" (inside, the core founds and joins a room; one account is one room).

- **Create account:** an email and a passkey, or a password (at least 12 characters, the only rule; **Generate** gives
  five words of the EFF list). This device founds the room. A password is stretched with Argon2id in the core worker
  and never leaves the device; a passkey unlocks through its `prf` extension. The hub never sees either.
- **Emergency Kit:** twelve words, made with the account and shown right after (Show, Download, Print). With the kit
  a forgotten password is replaced or a new passkey made; without it or a way in, nobody can recover the account.
- **Log in** on a new device: the passkey, email and password, or **Scan a code** from a signed-in device (both show
  the same six emoji, the signed-in one confirms).
- **Log out:** the device removes itself from the member list, and every local trace of the app on this origin goes
  (IndexedDB, Cache Storage, localStorage, sessionStorage).
- What the hub learns: the email in plaintext and which room it belongs to; nothing it could open.

## How it works

### Data flow

1. `app.mjs` boot opens the room from IndexedDB (`openRoom` of the core) — no network — and builds the board state (`BoardState`) from `client.model`.
2. The page for the address is rendered at once (`router.visit` → `board.request` → a view's route → `bodyParts`). First paint does not wait for the hub.
3. `client.start()` signs in, catches up from the cursor and opens the stream. Every `change` of the core (sets of object ids, timeline keys, register keys) is collected for one animation frame, then `board-state` rebuilds only the cards the change names, and `board.live()` diffs the open page's live pieces (Desk rows, card face/answer/thread, session log, sidebar rows, the pill's counts, notes) and replaces only the elements that changed (`<turbo-stream>` actions, keyed by `row-<id>`, `agent-<id>`, `msg-<id>`, `card-lead-<id>` …).
4. A form (answer, Snooze, Revise, What??, Whatever, Shred, message, note, session edit, desk, pairing) is answered by the views' handlers in the page: the actions (`hubFacade`) call the core (`answer`, `sendMessage`, `setRegisters`, …). The core shows the change at once (optimistic echo, `pending`) and seals, signs and sends it; the hub's copy replaces the echo.

### Addresses

`/` the Desk · `/desk/:id` switch desk · `/blitz` Blitz · `/artifacts` Artifacts (`?kind=media`, `?kind=pages`) · `/scribble-board` the Scribble Board · `/card/:nr` a card (`?v=n` an older version, `/picture/:n` a picture) · `/chat/:session` a session (`/files`, `/files/:n`, `/artifact/:id` one of its Artifacts) · `/chat/:session/card/:nr` a card from its session · `/chats` the list of chats · `/artifact/:share` a Share link's page · `/settings` Settings: one list (Invite a Device with its code in place, `?pair=<invite>`; Invite Agent…; a row per page) · `/settings/sessions` the sessions by desk · `/settings/devices` the devices and Push · `/settings/account` the account · `/settings/theme` · `/settings/keys` · `/pair/:invite_id` an invite · `/join#v1.<hub>.<room>.<secret>` joining (the secret never reaches a server and leaves the address bar once read). The addresses of before, `/s/…` and `/a/…`, move to `/chat/…` and `/artifact/…` (a 301 of `worker.js`, and the router in the page: `public/paths.mjs`).

### IndexedDB

The core owns the schema (`core/README.md`, "Storage adapter"): database `trommi`, keys prefixed `room/`; device keys as non-extractable CryptoKeys; records `card/<object_id>`, `session/<session_id>`, `perm/<id>`, `note/<id>`, `pub/<id>`, `reg/<key>`, `tlmeta/<timeline_key>`, `tl/<timeline_key>/<envelope_number>`, `sync` (cursor + chains, same transaction), `room`, `outbox`, `invite/<id>`; written incrementally (~200 ms batches). The app keeps only per-browser conveniences in localStorage: theme (`trommi-theme`), rail (`trommi-rail`), open crowns (`trommi-crowns-open`), the desk in view (`trommi-desk`); the developer switches below are sessionStorage only. The mock room keeps nothing.

### Render strategy (performance)

- **Local first**: first paint from the in-memory model the core restored from IndexedDB; the network only adds what is new.
- **Patch only**: after a change, only elements whose markup changed are replaced; Desk rows are cached per card object (a card the change did not name keeps its row string), the sidebar per row, the body per part (a navigation keeps the topbar and sidebar if their markup is the same).
- **Windowed**: conversations are timelines loaded newest page first (50), older pages on "Earlier"; a session page loads its cards' threads lazily; Desk rows and log messages out of sight are skipped by layout and paint (`content-visibility: auto`).
- **Lazy decrypt**: attachments are rendered as `/att/<id>` with `loading="lazy"`; the service worker asks the page, which fetches and decrypts only that file, only when it is shown or opened.
- **No framework, one stylesheet, a small first load**: one minified bundle; a cold start fetches the entry, the page's
  side of the core worker and their shared chunks (preloaded at once) and the core worker, every other view comes when it is first needed or once the page is idle;
  one stylesheet bundle.
- **CSP**: `script-src 'self' 'wasm-unsafe-eval'` (WebAssembly for Argon2id only) plus the hashes of the two inline scripts (the theme before first paint, the help page) and of the bundle's import map; `style-src 'self'` plus the hash of the help page's style, no `'unsafe-inline'` for style elements (style attributes only, `style-src-attr`: the views set `--hue` and the like per element); fonts self-hosted (`public/fonts`, OFL), all assets from the app origin, `connect-src` only the hub. `dev/check.mjs` checks the hashes; the e2e fails on any CSP violation.

### The demo room

`?mock=1` runs the same app on `public/demo/demo.mjs`: the core's API and model shape (change sets naming ids,
optimistic echo, windowed timeline reads) without a hub and without crypto, fed from `/demo/fixture.json`, with agents
that reply, rework a handed-back card and explain on What??. The demo's code and data are fetched only when the demo
is opened. The data and the list of `/screens` are the repository's [`demo/`](../../demo/README.md).
