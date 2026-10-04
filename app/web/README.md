# Trommi app

The Trommi app at **https://app.trommi.com**: a static, local-first single-page app. Every device makes its own keys, keeps the room in IndexedDB, decrypts and renders locally, and talks to the hub (`https://hub.trommi.com`, repo `trommi/trommi-hub`) only in sealed envelopes. No framework: plain ES modules and CSS, served as they are; the one build step joins the stylesheets into one file (see "The build"). Push to `main` deploys (Cloudflare Workers static assets, `wrangler.jsonc`, directory `public/`).

Its markup, CSS, pen drawings and controllers came from the old server-rendered Turbo board (taken over on 4 Oct 2026, trommi-hub commit f6b89b8; the old board was removed from the repository the same day). The copies here are the app's own source: edit them here.

## Running it

```bash
node dev/serve.mjs 8900                 # static server with the SPA fallback, the CSP of public/_headers and the build (in memory; --raw: without)
open http://127.0.0.1:8900/             # not logged in on this device: Create account or Log in
open http://127.0.0.1:8900/?mock=1      # the mock room: fixture cards of every kind, simulated agents, no hub
open http://127.0.0.1:8900/?mock=crazy  # a very big mock room (performance)
```

The hub is fixed, with no setting on screen. Hidden developer override: `?hub=<url>` (and `?found_code=<code>` for a founding token), kept for the tab session only (sessionStorage); default `https://hub.trommi.com`, on localhost `http://127.0.0.1:8890` (the dev hub: `HUB_PORT=8890 node hub/server.mjs` in trommi-hub, whose default port is 8790).

Tests (headless Chromium, `CHROMIUM` env or `chromium` on the path):

```bash
node dev/e2e.mjs [--app URL] [--hub URL] [--shots DIR] [--email E]   # create account + kit, agent invite, cards, picture, answer, undo, What??, 2nd device by QR, 3rd by email + password, 4th by Emergency Kit
node dev/look.mjs URL 1440,900 out.png [--dark] [--js '...']   # one screenshot, console errors
```

### The build

`dev/build.mjs` (no dependencies) makes one stylesheet of the ~25 `<link data-sheet>` lines of `public/index.html`, in their order, as `public/css/bundle.<hash>.css` (cached for good, `_headers`), and points `index.html` and the shell list of `sw.js` at it. The sheets in `public/css` stay the files to edit; the bundle is never committed. Cloudflare's build runs it on its checkout before the deploy (`WORKERS_CI=1` writes; elsewhere `node dev/build.mjs --write`, plain `node dev/build.mjs` only checks). `dev/serve.mjs` serves the same build from memory, so local runs and the e2e see what is deployed. Without the build the source shell works as it is.

Views switch sheets on and off (`layout.mjs` CSS, `js/app/sheets.mjs`): the hub linked only a page's own sheets, and some rules of one view's sheet would change another view. In the bundle each sheet a view may switch off is wrapped as `@supports (--sheet: name) { @media all { … } }`; `sheets.mjs` sets that `@media` to `not all`, which takes its rules out at the same place in the cascade, like a disabled `<link>`. A sheet that does not parse on its own (unbalanced braces, an unclosed comment or string) stops the build: in a bundle it would spill into the next sheet. Further build steps go into `build()` of `dev/build.mjs`.

Before a push: `dev/release.sh` (writes the shell's file list and version into `public/sw.js`). A release without it still reaches every device: the worker revalidates each file it serves (ETag) and, when one changed, fetches the shell again and offers "Neu laden".

## The account (what a person sees)

The UI says **account**, never "room" (inside, the core still founds and joins a room; one account = one room).

- **Create account:** email, a password of their own (at least 12 characters, the only rule) or one from **Generate**
  (five words of the EFF list, ≈64 bits, with Copy), the device's name. This device founds the room; the password is
  stretched with Argon2id in the browser (`vendor/account.mjs`, 64 MiB, ≈0.15 s desktop, ≈0.5–1.5 s phone) and never
  leaves it. One sentence, calm: "If you lose your password and your Emergency Kit, nobody (not even Trommi) can
  recover your data."
- **Emergency Kit:** offered once right after: twelve words to Download (a text file) or Print (only the kit prints).
  "Later" stores nothing; Settings → Account says calmly that no kit is made yet and makes one from the password
  whenever the person likes (a new kit replaces the old).
- **Log in** on a new device: email + password, or **Scan from a signed-in device** (the QR pairing with the six-digit
  check code, unchanged). The recovery words are never needed to log in. A wrong password and an unknown email give the
  same "Email or password is wrong."
- **Forgot password:** email + the kit's twelve words + a new password; the device logs in and the old password stops
  working. Without a kit: change the password on a device that is still logged in (Settings → Password).
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

## Architecture

```
public/
  index.html             the shell: all stylesheets (enabled per view; one bundle once built), fonts, one module: js/app/boot.mjs
  _headers               CSP and caching (Cloudflare; dev/serve.mjs reads it too)
  sw.js                  service worker: shell cache (versioned), /att/<id> (decrypted attachments), push
  css/  js/pen.js …      the board's look (taken over from the old board, now the app's own source)
  js/views/*.mjs         the board's view modules (trommi-hub server/views), synced, running in the page
  t/controllers t/lib    the board's Stimulus controllers, synced, running on js/app/stimulus.mjs
  vendor/                the client core: copied from the repository's core/ by dev/build.mjs (Cloudflare's build; dev/serve.mjs serves it from core/), not committed
  mock/                  fixture of the mock room (dev/make-fixture.mjs) and its pictures
  pad/                   the Scratchpad (Desk paper)
  js/app/
    boot.mjs             open the room (or the room screens), first paint from the local model, start the core
    board-state.mjs      THE SEAM: core model -> the state shape the views were written for (incremental)
    hub-facade.mjs       the views' "hub" actions (decide, message, editSession, memo, …) -> core human actions
    board.mjs            the hub's page routes, forms and live diffs (trommi-hub server/turbo.mjs) in the browser
    router.mjs           navigation (real URLs), forms, frames, body patching by parts, fetch() of old JSON routes
    layout.mjs           the frame around every view (topbar, menu, sidebar, sheets, memos)
    turbo.mjs            <turbo-stream> element (append/prepend/before/after/replace/update/remove/refresh), visit()
    stimulus.mjs         a small Stimulus stand-in (targets, values, actions, params, lazy registration)
    application.mjs      what every page has (toasts, folds, piles, times, menu, theme), from the board
    room.mjs             the account screens: Create account, Log in (email + password or QR), Emergency Kit, Forgot password; devices, pairing, Settings
    att.mjs              attachments: decrypted only when the browser asks for them
    mock-room.mjs        the core's API and model shape without hub or crypto, simulated agents
    mock-crazy.mjs       a generated very big room
```

### Data flow

1. `boot.mjs` opens the room from IndexedDB (`openRoom` of the core) — no network — and builds the board state (`board-state.mjs`) from `client.model`.
2. The page for the address is rendered at once (`router.visit` → `board.request` → a view module → `layout.mjs` parts). First paint does not wait for the hub.
3. `client.start()` signs in, catches up from the cursor and opens the stream. Every `change` of the core (sets of object ids, timeline keys, register keys) is collected for one animation frame, then `board-state` rebuilds only the cards the change names, and `board.live()` diffs the open page's live pieces (Desk rows, card face/answer/thread, session log, sidebar rows, the pill's counts, memos) and replaces only the elements that changed (`<turbo-stream>` actions, keyed by `row-<id>`, `agent-<id>`, `msg-<id>`, `card-lead-<id>` …).
4. A form (answer, Snooze, Revise, What??, Whatever, Shred, message, memo, session edit, desk, pairing) is answered by the board's handlers in the page: `hub-facade.mjs` calls the core (`answer`, `sendMessage`, `setRegisters`, …). The core shows the change at once (optimistic echo, `pending`) and seals, signs and sends it; the hub's copy replaces the echo.

### Addresses

`/` the Desk · `/desk/:id` switch desk · `/walk` Next · `/q/:nr` or `/c/:nr` a card (`?v=n` an older version, `/p/:n` a picture) · `/s/:session` a session (`/files`, `/files/:n`) · `/s/:session/q/:nr` a card from its session · `/agents` the Ledger · `/devices` the room's devices · `/pair/:invite_id` an invite · `/join#v1.<hub>.<room>.<secret>` joining (the secret never reaches a server and leaves the address bar once read).

### IndexedDB

The core owns the schema (trommi-hub `core/README.md`, "Storage adapter"): database `trommi`, keys prefixed `room/`; device keys as non-extractable CryptoKeys; records `card/<object_id>`, `session/<agent_device_id>`, `perm/<id>`, `memo/<id>`, `pub/<id>`, `reg/<key>`, `tlmeta/<timeline_key>`, `tl/<timeline_key>/<envelope_number>`, `sync` (cursor + chains, same transaction), `room`, `outbox`, `invite/<id>`; written incrementally (~200 ms batches). The app keeps only per-browser conveniences in localStorage: theme (`agent-board-theme`), rail (`trommi-rail`), open crowns (`trommi-crowns-open`), the desk in view (`trommi-desk`), the dev hub override is sessionStorage only. The mock room keeps nothing.

### Render strategy (performance)

- **Local first**: first paint from the in-memory model the core restored from IndexedDB; the network only adds what is new.
- **Patch only**: after a change, only elements whose markup changed are replaced; Desk rows are cached per card object (a card the change did not name keeps its row string), the sidebar per row, the body per part (a navigation keeps the topbar and sidebar if their markup is the same).
- **Windowed**: conversations are timelines loaded newest page first (50), older pages on "Earlier"; a session page loads its cards' threads lazily; Desk rows and log messages out of sight are skipped by layout and paint (`content-visibility: auto`).
- **Lazy decrypt**: attachments are rendered as `/att/<id>` with `loading="lazy"`; the service worker asks the page, which fetches and decrypts only that file, only when it is shown or opened.
- **No framework, one stylesheet**: modules load lazily (controllers on first use), the shell is cached by the service worker per release.
- **CSP**: `script-src 'self' 'wasm-unsafe-eval'` (WebAssembly for Argon2id only), no inline script, fonts self-hosted (`public/fonts`, OFL), all assets from the app origin, `connect-src` only the hub.

### The mock room

`?mock=1` runs the same app on `mock-room.mjs`: the core's API and model shape (change sets naming ids, optimistic echo with `local_id`/`pending`, windowed timeline reads), fed from `public/mock/fixture.json` (made by `dev/make-fixture.mjs` from a state export of today's board with its test cards), and agents that reply, rework a handed-back card and explain on What??. It is what the screen-by-screen comparison with the Turbo board uses.

## Working on the app: areas and their files

Several people (and agents) work on the app at once. Each area owns its files; the **integrator** owns the shell and the render core. Touch another area's file only after asking its owner; small fixes to a shared file go through the integrator. Every change: try it in the mock room (`?mock=1`) and against a hub, `node dev/e2e.mjs` must stay green, `node dev/look.mjs` at 1440x900 light and dark and 390x844 shows no console error; commit only your files, `git pull --rebase`, push when green (push = deploy).

| Area | Files |
| --- | --- |
| **Integrator** (shell, router, store glue, render core) | `public/index.html`, `public/sw.js`, `public/_headers`, `wrangler.jsonc`, `public/js/app/{boot,router,board,board-state,hub-facade,layout,turbo,stimulus,application,att,desk-window}.mjs`, `public/js/app/node-stubs/*`, `public/js/views/{html,model,text,sidebar,menu,keys,toast}.mjs`, `public/css/{tokens,app,turbo,logo,back,crowns,keys}.css`, `public/t/controllers/{keys,menu,rail,copy}_controller.js`, `public/t/lib/{keys,toast}.js`, `public/js/pen.js`, `dev/*`, `README.md` |
| **Desk, stacks, Next line** | `public/js/views/{desk,stacks,nextplease}.mjs`, `public/css/{piles,stamps,slip}.css`, `public/t/controllers/{desk,stack_search}_controller.js` |
| **Card page** (every decision flow: options, sections, pictures with marks, hand back, What??, Whatever, Shred, versions, info, permission) | `public/js/views/{card,picture}.mjs`, `public/css/{cardpage,cardclip,richhtml}.css`, `public/t/controllers/{card,circles,clip,pops,advice,richhtml}_controller.js`, `public/js/{focus-marks,richhtml,ui}.js`; the card routes in `board.mjs` (`registerCards`, `WAYS`) with the integrator |
| **Session, chat, files, assets, Ledger** | `public/js/views/{session,session-edit,agents}.mjs`, `public/css/{session,beside,ledger,links,speech,asset}.css`, `public/t/controllers/{composer,files,log,lean,say,share,assetthumb,title}_controller.js` |
| **Scratchpad, canvas, Desk paper** (E2E strokes + snapshots) | `public/pad/*`, `public/t/lib/{paper,clear}.js`, `public/t/controllers/paper_controller.js`, `public/css/{deskpad,scribble,clear,padlink}.css` |
| **Memos** | `public/js/views/memo.mjs`, `public/t/lib/memo.js`, `public/t/controllers/{memo,memos}_controller.js`, `public/css/quicksend.css` |
| **Account, pairing, devices, settings** (Create account, Log in, Emergency Kit, QR pairing, device list, storage usage, the reload notice's look) | `public/js/app/room.mjs`, `public/js/app/qr.mjs`, `public/css/room.css`, `public/t/controllers/room_controller.js` |
| **Phone layout** | `public/css/phone-desk.css`, `public/t/controllers/sheet_controller.js`, the `@media (max-width: …)` blocks of the area files in agreement with their owners |

The model the views get is `board-state.mjs` (core model → board state) and `views/model.mjs`; an area that needs a field the core has but the board state lacks asks the integrator. Hub actions go through `hub-facade.mjs` (integrator).

## Performance (measured 4 Oct 2026)

Headless Chromium; "phone" = 390x844 with the CPU 4x slower. Scripts: `dev/perf.mjs` (mock rooms), `dev/e2e.mjs` (real hub), trommi-hub `dev/e2e/app-perf.mjs` (the crazy room on a real hub).

| What | Desktop | Phone 4x |
| --- | --- | --- |
| Warm reload, app.trommi.com, to the Desk painted (service worker, cache-first) | 47–57 ms | 130–150 ms |
| Cold load, app.trommi.com (≈80 files, no build step) | 260–550 ms | ≈400 ms |
| Real room, warm reload from IndexedDB (e2e, 31 cards) | 16–63 ms | – |
| Card sent by an agent → row on the Desk (prod, live stream) | 85–130 ms | – |
| Answer → command at the agent (prod) | 170–250 ms | – |
| Crazy room (113k envelopes): first load of a new device | 29 s (was 367 s) | 86 s |
| Crazy room: Desk / huge session chat / switch session / card thread / answer / own send visible | 6 / 48 / 57 / 19 / 18 / 3 ms | 25 / 211 / 220 / 60 / – / 11 ms |
| Mock crazy room (300 open cards, 50k messages): patch after a change | 4–7 ms | 20–30 ms |

What made the difference: rows rendered only near the viewport (`desk-window.mjs`), patch-only updates keyed by id, no page patching while the core catches up (one whole render every 2.5 s and once when live), board state rebuilt only for what a change names, no `:has()` over the whole document, advice marks measured in one batch, the service worker serving every file from its cache and revalidating only `index.html`. Still over budget: opening and switching sessions on a 4x phone (≈200 ms), a new device's first load in a huge room (bound by the core's verify/decrypt of every envelope; the core's room snapshot is the way out).
