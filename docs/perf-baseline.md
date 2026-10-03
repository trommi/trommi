# Performance baseline of the current client (2026-10-03)

Measured for the Turbo rebuild to compare against. All numbers are from headless Chromium driven over CDP
against a hub started from this tree on a copy of the live data of that day: 153 cards (15 open), 1130
messages, 21 sessions, first state 790 KB of JSON. Not measured: a real iPhone, Safari, the real Tailscale path.

Profiles:

- **desktop**: 1440x900, no CPU throttle.
- **phone**: 390x844, touch, CPU throttled 4x.
- **local**: no network emulation (hub on the same machine).
- **net**: Chromium's network emulation, 40 ms latency per request, 20 Mbit/s down. The test hub speaks
  HTTP/1.1 (6 connections); `tailscale serve` gives the browser HTTP/2, so the real path queues less than this.

Pages: the Desk `/`, a busy session `/s/trommi` (332 messages shown), a card page `/q/182` (9 pictures).

## What a load consists of

| | Desk | Session | Card page |
|---|---|---|---|
| requests | 79 | 78-96 | 103 |
| of these JS and CSS files | 52 | 52 | 55 |
| JS + CSS, uncompressed | 1.2 MB | 1.2 MB | 1.6 MB |
| first state over `/events` | 790 KB | 790 KB | 790 KB |
| all bytes, uncompressed | 3.0 MB | 3.6-7.2 MB | 5.1 MB |
| DOM nodes after load | 2 700 | 10 500 | 6 500 |

Before today the hub sent everything with `Cache-Control: no-store` and without compression: every reload
fetched all of it again, and every change on the board sent the whole 790 KB state to every open tab.
The module graph is found import by import: `index.html` names 6 modules, they import 17 more.

## Time until the content is there

"Content" is the first Desk row, the first message of the session, or the card of the card page. Milliseconds
after navigation start, one cold load each (runs differ by about 10%).

### phone, net (the profile closest to his phone)

| | before | after | where the rest goes |
|---|---|---|---|
| Desk: first paint (the empty shell) | 360 | 284 | |
| Desk: modules loaded, stream open | 775 | 510 | module graph, 52 files |
| Desk: state arrived | 1196 | 640 | 790 KB, now 209 KB gzip |
| Desk: rows there | **1347** | **804** | 160 ms parse + first render |
| Session: messages there | **2006** | **1434** | 770 ms of it is rendering 332 messages |
| Card page: card there | **1847** | **1231** | card module (focus.js, 150 KB CSS) is fetched after the state |
| bytes, Desk / session / card | 2.2 / 7.1 / 5.1 MB | 1.3 / 6.2 / 3.9 MB | pictures are not compressible and load eagerly |

### desktop, net

| | before | after |
|---|---|---|
| Desk: rows there | 1234 | 608 |
| Session: messages there | (not measured before) | 787 |
| Card page: card there | (not measured before) | 933 |

### local (no network): the main thread alone

| | desktop before | desktop after | phone 4x before | phone 4x after |
|---|---|---|---|---|
| Desk: rows there | 144 | 138 | 436 | 474 |
| Session: messages there | 431 | 324 | 981 | 1010 |
| Card page: card there | 487 | 347 | 796 | 797 |
| Session: main thread busy during load | 1035 | 583 | 2240 | 1701 |
| Session: style recalculation | 556 | 125 | 304 | 219 |
| Card page: style recalculation | 896 | 314 | 565 | 487 |

### one change on the board while a page is open (every reply, status line, answer)

| | before | after |
|---|---|---|
| bytes sent to every open tab | 790 KB | 209 KB (gzip) |
| main thread blocked, session page, desktop | 105 ms | 22-36 ms |
| main thread blocked, Desk, desktop | 18-27 ms | 13-24 ms |
| main thread blocked, session page, phone 4x | 39-49 ms | 38-47 ms |
| main thread blocked, Desk, phone 4x | 44-59 ms | 47-63 ms |

## Where the time goes (phone, net, Desk, before: 1347 ms)

| part | ms | share |
|---|---|---|
| network: HTML, 19 CSS files, fonts until first paint | 360 | 27% |
| network: module graph until the page runs and opens the stream | 415 | 31% |
| network: the first state (790 KB) | 420 | 31% |
| script: parse of the state and first render | 152 | 11% |
| later re-renders during load | 0 (one state, one render) | |

On the Desk the main thread is not the problem: 150-180 ms even throttled 4x. On a session page it is: the first
render of 332 messages takes 700-770 ms at 4x in one task (240 ms building nodes, about 250 ms in forced layout
in `visible()`/`settle()` of chat.js, 150 ms formatting times with `toLocaleString`), and the page then has
10 500 nodes. Top self time there: `visible` chat.js, `clock` and `fullTime` (ui.js, chat.js), `shown` inbox.js
(the Desk is rendered although it is hidden), `brackets` agents.js.

## Causes found, by cost

1. **Two CSS rules restyled the whole document after every DOM change.** `X:has(…) > *` (focus.css) and
   `X:has(…) … > :nth-child(6)` (ledger.css): a `:has()` rule whose subject is "any element" makes Chromium
   invalidate every element when anything is inserted anywhere. Measured: 20 ms per forced style recalculation on
   a session page at desktop speed, 0-2 ms without the two rules. A state event forces four to five of them
   (chat, sidebar, Desk and paper each write, then measure). Fixed by naming the subject (`> div`, a class).
   **Rule for new CSS: never end a `:has()` selector in `*`, a bare pseudo-class or a bare attribute selector.**
2. **No compression, no caching.** 3-7 MB per load, all of it again on every reload. Fixed in the hub: brotli/gzip
   for text, ETag + `no-cache` (a reload costs 304s), `/files/` pictures cacheable for a week, `/events` gzip.
3. **The whole state on every change** (790 KB, now 209 KB compressed), parsed and rendered by every view,
   hidden ones included. Not fixed; the rebuild replaces it with streams of what changed.
4. **Module waterfall.** 6 entry modules that import 17 more, found level by level. Eased with `modulepreload`
   hints for all of them. A bundle would save what is left of it: about 200 ms of the 800 ms on the phone
   profile over HTTP/1.1, less over the HTTP/2 that `tailscale serve` speaks. Not the main cost.
5. **A second app at start.** The Desk's paper is the pad's page in an iframe (pad.js 85 KB, 6 modules, its own
   element fetch and event stream); it was loaded on every page. Now only when the Desk is first in view.
6. **Pictures** of a session page load eagerly and at full size (3-6 MB). Not fixed.
7. Machine load: 17 headless Chromiums and 7 test hubs left behind by test runs were using more than a core
   (found by the coordinator). `dev/cdp.mjs` now guards every browser and hub it or the suites start.

## The "elements pop in or not" report

Loaded the Desk 20 times per size at varying CPU throttle (1x-6x) on the local path and 12 times per size on a
slow network profile (60 ms, 8 Mbit/s), comparing every id and class present and visible after settling, the
pad frame's state, and errors: **no difference between any two runs, no exception, no failed request.** A part
that is missing for good was not reproduced in Chromium. What is real is the order in which things arrive, each
its own step: the shell (first paint), the web fonts swapping in, the rows once the state is there, the
paper's drawings once the frame has loaded its own app, the pictures. On the slow path these steps were spread
over 1.3 s and longer. Not checked: Safari on the iPhone.

## How to measure again

The scripts are not in the repo; they are short CDP drivers on `dev/cdp.mjs`:
`Emulation.setCPUThrottlingRate`, `Network.emulateNetworkConditions { latency: 40, downloadThroughput: 20e6/8 }`,
an injected script that records `longtask` and `paint` entries, wraps `EventSource.onmessage` to time each state,
and a MutationObserver that notes when `#inbox .inbox-row`, `#chat .log .msg` and `.focus-card` first exist;
`Performance.getMetrics` for layout and style time; `Profiler.start/stop` for self time per function.
State changes were triggered with `POST /star` every 0.5 s.
