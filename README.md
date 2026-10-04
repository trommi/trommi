# Trommi app

The Trommi app at **https://app.trommi.com**: a static, local-first single-page app. Every device makes its own keys, keeps the room in IndexedDB, decrypts and renders locally, and talks to the hub (`https://hub.trommi.com`, repo `trommi/trommi-hub`) only in sealed envelopes. No build step, no framework: plain ES modules and CSS, served as they are. Push to `main` deploys (Cloudflare Workers static assets, `wrangler.jsonc`, directory `public/`).

It looks and works like today's board on the PC (the server-rendered Turbo board in trommi-hub): the same markup, the same CSS, the same pen drawings, the same controllers. They were taken over with `dev/sync-board.sh` (trommi-hub commit f6b89b8, 4 Oct 2026) and the app renders the board's own view modules in the page. **Since then the copies in this repo are the app's own source**: edit them here. `dev/sync-board.sh` overwrites them; run it only to pull a later change of the PC board in on purpose, and review the diff before committing.

## Running it

```bash
node dev/serve.mjs 8900                 # static server with the SPA fallback and the CSP of public/_headers
open http://127.0.0.1:8900/             # no room on this device: found one, or open an invite link
open http://127.0.0.1:8900/?mock=1      # the mock room: fixture cards of every kind, simulated agents, no hub
open http://127.0.0.1:8900/?mock=crazy  # a very big mock room (performance)
```

The hub: `?hub=<url>` (remembered in localStorage `trommi-hub`), default `https://hub.trommi.com`, on localhost `http://127.0.0.1:8890` (the dev hub: `node hub/server.mjs` in trommi-hub).

Tests (headless Chromium, `CHROMIUM` env or `chromium` on the path):

```bash
node dev/e2e.mjs [--app URL] [--hub URL] [--shots DIR]   # found, agent invite, cards, picture, answer, undo, What??, 2nd device with check code
node dev/look.mjs URL 1440,900 out.png [--dark] [--js '...']   # one screenshot, console errors
```

Before a push: `dev/release.sh` (writes the shell's file list and version into `public/sw.js`). A release without it still reaches every device: the worker revalidates each file it serves (ETag) and, when one changed, fetches the shell again and offers "Neu laden".

## Architecture

```
public/
  index.html             the shell: all stylesheets (enabled per view), fonts, one module: js/app/boot.mjs
  _headers               CSP and caching (Cloudflare; dev/serve.mjs reads it too)
  sw.js                  service worker: shell cache (versioned), /att/<id> (decrypted attachments), push
  css/  js/pen.js …      the board's look, synced from trommi-hub (dev/sync-board.sh)
  js/views/*.mjs         the board's view modules (trommi-hub server/views), synced, running in the page
  t/controllers t/lib    the board's Stimulus controllers, synced, running on js/app/stimulus.mjs
  vendor/                the client core (trommi-hub client/core + crypto/zcrypto.mjs), written by its dev/sync-app.sh
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
    room.mjs             found (recovery code once, confirmed), join (/join#…, check code), devices, pairing
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

The core owns the schema (trommi-hub `client/core/README.md`, "Storage adapter"): database `trommi`, keys prefixed `room/`; device keys as non-extractable CryptoKeys; records `card/<object_id>`, `session/<agent_device_id>`, `perm/<id>`, `memo/<id>`, `pub/<id>`, `reg/<key>`, `tlmeta/<timeline_key>`, `tl/<timeline_key>/<envelope_number>`, `sync` (cursor + chains, same transaction), `room`, `outbox`, `invite/<id>`; written incrementally (~200 ms batches). The app keeps only per-browser conveniences in localStorage: theme (`agent-board-theme`), rail (`trommi-rail`), open crowns (`trommi-crowns-open`), the desk in view (`trommi-desk`), the hub (`trommi-hub`). The mock room keeps nothing.

### Render strategy (performance)

- **Local first**: first paint from the in-memory model the core restored from IndexedDB; the network only adds what is new.
- **Patch only**: after a change, only elements whose markup changed are replaced; Desk rows are cached per card object (a card the change did not name keeps its row string), the sidebar per row, the body per part (a navigation keeps the topbar and sidebar if their markup is the same).
- **Windowed**: conversations are timelines loaded newest page first (50), older pages on "Earlier"; a session page loads its cards' threads lazily; Desk rows and log messages out of sight are skipped by layout and paint (`content-visibility: auto`).
- **Lazy decrypt**: attachments are rendered as `/att/<id>` with `loading="lazy"`; the service worker asks the page, which fetches and decrypts only that file, only when it is shown or opened.
- **No framework, no build**: modules load lazily (controllers on first use), the shell is cached by the service worker per release.
- **CSP**: `script-src 'self'`, no inline script, fonts self-hosted (`public/fonts`, OFL), all assets from the app origin, `connect-src` only the hub.

### The mock room

`?mock=1` runs the same app on `mock-room.mjs`: the core's API and model shape (change sets naming ids, optimistic echo with `local_id`/`pending`, windowed timeline reads), fed from `public/mock/fixture.json` (made by `dev/make-fixture.mjs` from a state export of today's board with its test cards), and agents that reply, rework a handed-back card and explain on What??. It is what the screen-by-screen comparison with the Turbo board uses.

## Working on the app: areas and their files

Several people (and agents) work on the app at once. Each area owns its files; the **integrator** owns the shell and the render core. Touch another area's file only after asking its owner; small fixes to a shared file go through the integrator. Every change: try it in the mock room (`?mock=1`) and against a hub, `node dev/e2e.mjs` must stay green, `node dev/look.mjs` at 1440x900 light and dark and 390x844 shows no console error; commit only your files, `git pull --rebase`, push when green (push = deploy).

| Area | Files |
| --- | --- |
| **Integrator** (shell, router, store glue, render core) | `public/index.html`, `public/sw.js`, `public/_headers`, `wrangler.jsonc`, `public/js/app/{boot,router,board,board-state,hub-facade,layout,turbo,stimulus,application,att,desk-window}.mjs`, `public/js/app/node-stubs/*`, `public/js/views/{html,model,text,sidebar,menu,keys,toast}.mjs`, `public/css/{tokens,app,turbo,logo,back,crowns,keys}.css`, `public/t/controllers/{keys,menu,rail,copy,fixtures}_controller.js`, `public/t/lib/{keys,toast}.js`, `public/js/pen.js`, `dev/*`, `README.md` |
| **Desk, stacks, Next line** | `public/js/views/{desk,stacks,nextplease,gutter-hover}.mjs`, `public/css/{piles,stamps,slip}.css`, `public/t/controllers/{desk,stack_search,pointto}_controller.js` |
| **Card page** (every decision flow: options, sections, pictures with marks, hand back, What??, Whatever, Shred, versions, info, permission) | `public/js/views/{card,picture}.mjs`, `public/css/{cardpage,cardclip,richhtml}.css`, `public/t/controllers/{card,circles,clip,pops,advice,richhtml}_controller.js`, `public/t/islands/richhtml.js`, `public/js/{focus-marks,richhtml,ui}.js`; the card routes in `board.mjs` (`registerCards`, `WAYS`) with the integrator |
| **Session, chat, files, assets, Ledger** | `public/js/views/{session,session-edit,agents}.mjs`, `public/css/{session,beside,ledger,links,speech,asset}.css`, `public/t/controllers/{composer,files,log,lean,say,share,assetthumb,title}_controller.js` |
| **Scratchpad, canvas, Desk paper** (E2E strokes + snapshots) | `public/pad/*`, `public/t/lib/{paper,clear}.js`, `public/t/controllers/paper_controller.js`, `public/css/{deskpad,scribble,clear,padlink}.css` |
| **Memos** | `public/js/views/memo.mjs`, `public/t/lib/memo.js`, `public/t/controllers/{memo,memos}_controller.js`, `public/css/quicksend.css` |
| **Pairing, devices, settings** (QR "Gerät koppeln", "Mit Passwort anmelden", device list, storage usage, the reload notice's look) | `public/js/app/room.mjs`, `public/js/app/qr.mjs`, `public/css/room.css`, `public/t/controllers/room_controller.js` |
| **Phone layout** | `public/css/phone-desk.css`, `public/t/controllers/sheet_controller.js`, the `@media (max-width: …)` blocks of the area files in agreement with their owners |

The model the views get is `board-state.mjs` (core model → board state) and `views/model.mjs`; an area that needs a field the core has but the board state lacks asks the integrator. Hub actions go through `hub-facade.mjs` (integrator).
