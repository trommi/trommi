# Trommi app

The Trommi app at **https://app.trommi.com**: a static, local-first single-page app. Every device makes its own keys, keeps the room in IndexedDB, decrypts and renders locally (the core in a Web Worker, the page with a copy of its model: `shared/README.md` "The core in a worker"), and talks to the hub (`https://hub.trommi.com`) only in sealed envelopes. No framework: plain ES modules and CSS, one file per view; deployed as one minified bundle that loads each view when it is first needed. Push to `main` deploys (Cloudflare Workers static assets, `wrangler.jsonc`, directory `public/`; its build step `dev/build.mjs` makes what is generated).

## Running it

```bash
node dev/serve.mjs 8900                 # the app from its sources, built in memory on every request (never stale, no service worker)
node dev/serve.mjs 8900 --bundle        # the same as deployed: the minified bundle, views loaded on demand
open http://127.0.0.1:8900/             # not logged in on this device: Create account or Log in
open http://127.0.0.1:8900/?mock=1      # the demo room: fixture cards of every kind, simulated agents, no hub
open http://127.0.0.1:8900/?mock=side   # the same room with a full sidebar: long names, every kind of count
```

A design change: edit the view's `.mjs` and `.css`, reload, push. Nothing to build or release; nothing generated is
committed (the deploy bundles it).

The hub is fixed, with no setting on screen. Hidden developer override: `?hub=<url>` (and `?found_code=<code>` for a founding token), kept for the tab session only (sessionStorage); default `https://hub.trommi.com`, on localhost `http://127.0.0.1:8890` (the dev hub: `HUB_PORT=8890 node hub/server.mjs`).

Checks:

```bash
node dev/check.mjs                      # the layout rules below (CI: Test workflow, job "App layout")
node dev/e2e.mjs [--app URL] [--hub URL] [--shots DIR] [--email E]   # end to end against a real hub, headless Chromium
node dev/look.mjs URL 1440,900 out.png [--dark] [--js '...']   # one screenshot, console errors
node dev/perf.mjs                       # the very big demo room (?mock=crazy), desktop and a slowed phone
```

## Layout

```
worker.js              http -> https, /connect (the connect script), the generated files at their public addresses
wrangler.jsonc  dev/   serve, build, check, verify, e2e, look, cdp, perf, make-fixture
public/
  index.html  sw.js  manifest.webmanifest  _headers  connect.sh  frame.html (the sandbox a published page runs in)
  help.html            help and "how it works", its own style and script inline
  app.mjs  app.css     start, router, the room in the page (board state, actions, the board's pages and live
                       pieces), frame, attachments, push, new versions; app.css: tokens, base layout, type, links, focus
  ui.mjs               what every view shares: html, the pen, words, toasts, the controllers (controller(name, class)),
                       rich text, agent layouts, keys, a card's row, a session's mark, the room's frame
  auth.mjs/.css        account screens, password, Emergency Kit, recovery, pairing, devices, settings, log out
  desk  card  session  sidebar  notes  media  agents  whiteboard   (.mjs + .css each)
  demo/                the demo room (demo.mjs, fixture.json, files/), also the "Demo" desk
  fonts/  icons/  drawings.json
  gen/                 generated at deploy time by dev/build.mjs, not in git: app/ (the bundle: app-<hash>.mjs and its
                       chunks), vendor/tools-reference.mjs (for the help page), bundle.<hash>.css, build.txt; connector.mjs(.sha256), plugins/ (connector/build.mjs),
                       served at /connector.mjs, /connector.mjs.sha256, /plugins/…
```

## Rules

1. A view imports only from `app.mjs` and `ui.mjs` (the core through `app.mjs`), never from another view. What two views
   need goes to `ui.mjs` (markup, controllers) or `app.mjs` (data, the room). `ui.mjs` imports nothing.
2. No crypto in the app: everything crypto, account and keys comes from the core (`gen/vendor`, via `app.mjs` `core()`,
   `account()`, `scribbleWire()`).
3. `gen/` is never edited by hand and never committed: the build makes it at deploy time.
4. A file is split only when it passes ~3000 lines.
5. Code is `.mjs` or strict TypeScript `.ts` (the core is `.ts`, `tsconfig.json` at the repository root). Importing a module does nothing; `app.mjs` boots the page (so Node tests can import it).
6. A view other than the Desk's (desk, sidebar, notes) is loaded on demand: `app.mjs` `LAZY` names the addresses each
   answers; the router loads it before the first such address, and all of them once the first page is idle. A view
   that adds a page adds its addresses there.
7. **No `<style>` elements and no inline scripts** in what a view renders: the CSP refuses them (`style-src 'self'`,
   no `'unsafe-inline'`). Styles go into the view's `.css` file (or a file of its own under `public/`, named in
   `dev/check.mjs`); a `style="…"` attribute is fine (`style-src-attr`: the views set `--hue` and the like per element).
   An inline `<style>` or `<script>` in `index.html` or `help.html` needs its hash in `_headers` (`dev/check.mjs` says which).

`dev/check.mjs` (CI) fails on a file outside this layout, a view that imports another view, crypto outside the core,
and an inline script or style whose hash is not in `_headers`; the e2e fails on any CSP violation.

### The build

`dev/build.mjs` runs in Cloudflare's build (`WORKERS_CI=1`) and makes `public/gen/app/` (esbuild, minified and split:
the entry `app-<hash>.mjs` with app, ui, desk, sidebar and notes, one chunk per lazy view, the core from the
repository's `shared/` as chunks of its own, the demo, `core-worker-<hash>.mjs`, the core's worker in one file
(the app learns its address from `__TROMMI_CORE_WORKER__`; the dev server starts `/gen/vendor/core-worker.mjs`), the
account screens' part of it, `core-worker-account-<hash>.mjs` (loaded only by them), and `core-start-<hash>.mjs`, which
`index.html` runs first, async and before its style sheets (so the worker is fetched beside them), to start the worker; every
name carries its content's hash, `_headers` keeps them immutable), `public/gen/vendor/tools-reference.mjs` (the connector's tools and events for the help page), one stylesheet `public/gen/bundle.<hash>.css` of the `<link>`s of `index.html` (in their
order: `app.css` first), `public/gen/build.txt` (the commit; the Web app deploy workflow waits until app.trommi.com
serves it), the script and the modulepreload list of `index.html` (the entry with `?v=<build>`, the page's side of the
core worker and the chunks a cold start imports), `VERSION` + `SHELL` of `sw.js`, and the connector's files `public/gen/connector.mjs`,
`connector.mjs.sha256` and `plugins/` (`connector/build.mjs`). The bundle and the connector need the repository's npm
packages (esbuild, the MCP SDK, zod): in Cloudflare's build `dev/build.mjs` runs `npm ci` at the repository root first.
In the repository `index.html` and `sw.js` are templates (empty preload block, `VERSION = "dev"`, `SHELL = []`).
`dev/serve.mjs` serves the build from memory: by default with the sources as modules of their own (no esbuild needed),
`--bundle` as deployed. `node dev/build.mjs` checks only and prints the cold start's size; `--write` writes into
`public/` (never commit that: it rewrites `index.html`, `sw.js` and `_headers` too).

**Integrity.** The bundle's `index.html` carries `integrity` (sha384) on the entry, `core-start` and every modulepreload,
and an import map with the integrity of every module of the page (chunks loaded later are checked too, where the
browser knows import-map integrity); its hash is added to the CSP of the generated `_headers`. The core worker loads
from this origin under the same CSP (workers take no integrity attribute).

### Verifying the build

**Cloudflare's build settings** (the Workers project `trommi-app`, Settings → Build): root directory `app/web`, build
command `node dev/build.mjs` (from `wrangler.jsonc`), deploy command `npx wrangler deploy`, Node from `.node-version`
(`26.8.2`; the same file at the repository root, and `engines` in `package.json`), watch paths `app/web/*`, `shared/*`,
`connector/*`, `package.json`, `package-lock.json`. The build runs `npm ci` at the repository root (so esbuild is the
exact version of `package-lock.json`), refuses to build with another Node or esbuild than the pinned ones, and names
both in `gen/manifest.json`. Its output does not depend on the directory it runs in (esbuild's `absWorkingDir` is the
repository) or on the time; the plugin's zip has fixed dates and order.

`gen/manifest.json` lists every file the app serves with its SHA-256; `gen/build.txt` names the commit and the
**build hash**, the SHA-256 of that manifest. The build is reproducible (content-named files, a zip with fixed dates,
no time stamps), so anyone can check that app.trommi.com serves exactly this source:

```bash
curl -s https://app.trommi.com/gen/build.txt          # commit: <c>, build: <hash>
git checkout <c> && npm ci
node app/web/dev/verify.mjs                           # or --app <url>: builds here, compares the manifests file by
                                                      # file, fetches every file and checks its bytes; exit 0 = verified
```

The service worker: a new deploy takes over at once and the page reloads (a field with unsent words: a quiet "Reload"
instead); files come network first, the cache only offline. On the dev server (`VERSION "dev"`) there is none.

## The Desk

- **Goals:** under the greeting, a desk's own short note (at most five lines), written in place with a click; empty
  only a faint "Goals…", nothing on All desks. Kept in the desk's register (`desk/<id>`, `goals`), so every device of
  his sees it; agents do not yet (they ignore human registers).
- **Rows:** every open card is one row in the hub's order, blocking first, then knocks; infos stand among them (What?? and
  ✓ instead of answers). A row: the session's drawing (a click selects it; Shift: a range), the urgency sign, the title,
  two lines of teaser (`card.teaser`, else the body), the pictures as a small fan, square answer tiles. A row that
  leaves glides out while the rows below move up (`app.mjs` `flipOut`, transform only).
- **Selection bar:** while rows are selected, Later (the pull-tag: the rows go down into Off the desk), Egal, Read (with
  infos), Shred; one POST `/cards/batch`, one toast with Undo.
- **With the agents:** answered cards whose session is still at it, one line each, below the open ones. A card answered
  with a final option (a small pen tick on its tile) never lies here: the answer settles it, it goes to "Off the desk"
  at once ("settled by your answer"), and Take back opens it again.
- **Foot:** "Off the desk" (a list of snoozed, done, shredded cards; a line opens its card, where Wake up and Take back
  are), Artifacts (one pile with the count: the newest pictures, else the newest pages; the page `/artifacts`: Media and
  Pages together, the newest first, the filter All · Media · Pages, a page's ⋯ with Share).
- **Note:** one drawn yellow note at the window's bottom-right; it unfolds there to write, takes attachments, sends to the crown (`sidebar.mjs` `cornerNote`).
- **Sidebar:** the Desk box, the sessions (a main with its helpers on a pen bracket, tallies, the red hand), "New agent" and
  the Trommi menu at its foot. One sidebar, two presentations (`sidebar.css` "A phone"): beside the page on a wide
  screen (foldable to a rail), a drawer up to 860px. There a slim top line holds the handle (three pen lines, a red dot
  while something knocks) and the name of the place in view (`sidebar.mjs` `phoneBar`); the handle or a finger from the
  left edge slides the drawer in over the dimmed page, a tap beside it, a push back, Esc or a choice closes it.

## The Scribble Board

Drawing is the back of the Desk: its top-right corner is a small dog-ear that lifts as the pointer comes near and
follows it freely when held; a tap, a pull past a third of the way, a fling or `P` turns the page to the
**Scribble Board** (`/scribble-board`; the same corner, Esc or `P` turns back; `ui.mjs` controller `curl`). Under the
lifted sheet lies the other page itself: the board is the frame's part `pad`, mounted once when the corner is first
approached and kept under the Desk (`app.mjs` `keepPad`); the Desk under the board is rendered from the model
(`peek`). The page is
the pad (`whiteboard.mjs` mountPad) as large as the main area; select or frame something and **Send to…** a session.
One drawing on it is a scribble.

What is drawn is the room's one scribble timeline (`ROOM_BOARD` in the core's `scribble.ts`, which is also the wire
format): one board per room, the same whatever desk is in view.

## The account (what a person sees)

The UI says **account**, never "room" (inside, the core still founds and joins a room; one account = one room).

- **Create account:** email, a password of their own (at least 12 characters, the only rule) or one from **Generate**
  (five words of the EFF list, ≈64 bits, with Copy), the device's name. This device founds the room; the password is
  stretched with Argon2id in the browser (`gen/vendor/account.mjs`, 64 MiB, ≈0.15 s desktop, ≈0.5–1.5 s phone) and never
  leaves it. One sentence, calm: "If you lose your password and your Emergency Kit, nobody (not even Trommi) can
  recover your data."
- **Emergency Kit:** offered once right after: twelve words to Download (a text file) or Print (only the kit prints).
  "Later" stores nothing; Settings → Account says calmly that no kit is made yet and makes one from the password
  whenever the person likes (a new kit replaces the old).
- **Log in** on a new device: email + password, or **Scan from a signed-in device** (the QR pairing; both devices show
  the same six emoji, the signed-in one asks "They match" / "They don't match"). The recovery words are never needed to log in. A wrong password and an unknown email give the
  same "Email or password is wrong."
- **Forgot password:** email + the kit's twelve words + a new password; the device logs in and the old password stops
  working. Without a kit: change the password on a device that is still logged in (Settings → Account).
- **Settings → Account:** the email (and "Confirm your email" with a six-digit code: the hub has no mail provider yet,
  the code goes to its log), Emergency Kit, Change password. Accounts from before email + password get "Add login"
  (needs the old recovery code); their recovery code still works at `/recover` (Forgot password → "An older account
  with a recovery code?").
- **Log out** (Trommi menu, and Settings → Account): asks once ("Log out of this device? You can log in again with
  email and password."; on the only device it adds that email and password or the Emergency Kit open the account). Then
  the device removes itself from the member list (a removal signed by itself, core `leaveRoom()`), the streams close,
  and every local trace of the app on this origin goes: IndexedDB, Cache Storage, localStorage, sessionStorage (the
  service worker stays and fills its cache again). The start page comes. Offline: the wipe still happens and the start
  page says the device stays under "Devices" until another device removes it.
- What the hub learns: the email in plaintext and which room it belongs to; nothing it could open (trommi-hub README,
  "Accounts").

## How it works

### Data flow

1. `app.mjs` boot opens the room from IndexedDB (`openRoom` of the core) — no network — and builds the board state (`BoardState`) from `client.model`.
2. The page for the address is rendered at once (`router.visit` → `board.request` → a view's route → `bodyParts`). First paint does not wait for the hub.
3. `client.start()` signs in, catches up from the cursor and opens the stream. Every `change` of the core (sets of object ids, timeline keys, register keys) is collected for one animation frame, then `board-state` rebuilds only the cards the change names, and `board.live()` diffs the open page's live pieces (Desk rows, card face/answer/thread, session log, sidebar rows, the pill's counts, notes) and replaces only the elements that changed (`<turbo-stream>` actions, keyed by `row-<id>`, `agent-<id>`, `msg-<id>`, `card-lead-<id>` …).
4. A form (answer, Snooze, Revise, What??, Whatever, Shred, message, note, session edit, desk, pairing) is answered by the views' handlers in the page: the actions (`hubFacade`) call the core (`answer`, `sendMessage`, `setRegisters`, …). The core shows the change at once (optimistic echo, `pending`) and seals, signs and sends it; the hub's copy replaces the echo.

### Addresses

`/` the Desk · `/desk/:id` switch desk · `/blitz` Blitz · `/artifacts` Artifacts (`?kind=media`, `?kind=pages`) · `/scribble-board` the Scribble Board · `/card/:nr` a card (`?v=n` an older version, `/picture/:n` a picture) · `/s/:session` a session (`/files`, `/files/:n`) · `/s/:session/card/:nr` a card from its session · `/settings` Settings: one list (Invite a Device with its code in place, `?pair=<invite>`; Invite Agent…; a row per page) · `/settings/sessions` the sessions by desk · `/settings/devices` the devices and Push · `/settings/account` the account · `/settings/theme` · `/settings/keys` · `/pair/:invite_id` an invite · `/join#v1.<hub>.<room>.<secret>` joining (the secret never reaches a server and leaves the address bar once read).

### IndexedDB

The core owns the schema (trommi-hub `shared/README.md`, "Storage adapter"): database `trommi`, keys prefixed `room/`; device keys as non-extractable CryptoKeys; records `card/<object_id>`, `session/<agent_device_id>`, `perm/<id>`, `note/<id>`, `pub/<id>`, `reg/<key>`, `tlmeta/<timeline_key>`, `tl/<timeline_key>/<envelope_number>`, `sync` (cursor + chains, same transaction), `room`, `outbox`, `invite/<id>`; written incrementally (~200 ms batches). The app keeps only per-browser conveniences in localStorage: theme (`agent-board-theme`), rail (`trommi-rail`), open crowns (`trommi-crowns-open`), the desk in view (`trommi-desk`), the dev hub override is sessionStorage only. The mock room keeps nothing.

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

`?mock=1` runs the same app on `demo/demo.mjs`: the core's API and model shape (change sets naming ids, optimistic echo with `local_id`/`pending`, windowed timeline reads), fed from `demo/fixture.json` (made by `dev/make-fixture.mjs`), and agents that reply, rework a handed-back card and explain on What??. `?mock=crazy` generates a very big room (`dev/perf.mjs`).

## Performance (measured 4 Oct 2026)

Headless Chromium; "phone" = 390x844 with the CPU 4x slower. Scripts: `dev/perf.mjs` (mock rooms), `dev/e2e.mjs` (real hub), trommi-hub `dev/load/app-perf.mjs` (the crazy room on a real hub).

| What | Desktop | Phone 4x |
| --- | --- | --- |
| Warm reload, app.trommi.com, to the Desk painted (service worker, cache-first) | 47–57 ms | 130–150 ms |
| Cold load, app.trommi.com (≈80 files, no build step; before the bundle) | 260–550 ms | ≈400 ms |
| Real room, warm reload from IndexedDB (e2e, 31 cards) | 16–63 ms | – |
| Card sent by an agent → row on the Desk (prod, live stream) | 85–130 ms | – |
| Answer → command at the agent (prod) | 170–250 ms | – |
| Crazy room (113k envelopes): first load of a new device | 29 s (was 367 s) | 86 s |
| Crazy room: Desk / huge session chat / switch session / card thread / answer / own send visible | 6 / 48 / 57 / 19 / 18 / 3 ms | 25 / 211 / 220 / 60 / – / 11 ms |
| Mock crazy room (300 open cards, 50k messages): patch after a change | 4–7 ms | 20–30 ms |

**8 October 2026 (the bundle and the board caches),** crazy room on a local hub, phone 4x, p95 (p50) before → after:
Desk 614 (547) → 68 (61) ms · answer a card 473 (231) → 160 (84) ms · open the huge session chat 357 (229) → 319 (206) ms
· warm reload to the Desk painted 2,706 (1,702) → 1,668 (1,304) ms · JS heap 163 → 83 MB. Switching sessions stays at
≈210 ms: the router waits up to 120 ms for the session's newest chat page from the hub (session.mjs firstPage). JS a
cold start fetches: 1,353 KB in 26 files (brotli 373 KB) → 483 KB in 7 files (brotli 141 KB); a cold start on a phone
(4x CPU, 150 ms RTT, 1.6 Mbps, brotli) to the start page 3.0 → 2.1 s, to the demo Desk 4.0 → 2.9 s.

**8 October 2026, the huge room (82,868 envelopes) and the budgets** (trommi-hub `dev/load/perf-budget.mjs`; numbers and causes in trommi-hub README "The huge room, per-change cost and the budgets"): phone 4x + slow 4G, warm start 1,156 → 844 ms, cold 2,855 → 2,296 ms, interactions p95 417 → 171 ms, one new message 12 requests / 95 KiB → 0 / 0.8 KiB.

What made the difference: rows rendered only near the viewport (`desk.mjs` startDeskWindow), patch-only updates keyed by id, no page patching while the core catches up (one whole render every 2.5 s and once when live), board state rebuilt only for what a change names, no `:has()` over the whole document, advice marks measured in one batch, the service worker serving every file from its cache and revalidating only `index.html`. Still over budget: opening and switching sessions on a 4x phone (≈200 ms), a new device's first load in a huge room (bound by the core's verify/decrypt of every envelope; the core's room snapshot is the way out).
