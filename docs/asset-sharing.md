# Assets: audit, fixes, and sharing with third parties

3 October 2026, session "Server". What an asset link is today, what was weak, what was fixed, and what is prepared for handing a page to someone outside the board. Line numbers are those of this day.

> **In short.** Every asset already has a key of its own (AES-256-GCM, a fresh key and nonce per asset, the id as associated data); that part needed nothing. The key is behind the `#` of the link and never reaches a server through the link. The weak spots were around it: the hub is told the key of every asset it shows on the board, anyone who can reach the hub can fetch any ciphertext, an upload that was cut off was stored, and fetches were not limited. Sharing with someone outside is now a per-asset release with an address of its own, `/r/<id>#<key>`, off by default. Nothing is exposed to the internet; how a stranger reaches the link at all is the one open decision.

## 1. Audit

"holds" = does what it should; "weak" = works, with a gap; "missing" = not there. "fixed" says what step 2 did.

### Who can fetch what without a login

| Point | State | Where |
| --- | --- | --- |
| The viewer `/a/<id>` and its files `/a/-/…` are served without a login, the same page for every id (no oracle) | holds | `server/server.mjs:2820-2834` |
| The ciphertext `/a/<id>/blob` is served without a login for **every** asset, not per asset. Intended so far ("the link is the permission"), but it means there is no difference between "for me" and "for someone outside" | weak, by design. Prepared: `BOARD_ASSET_LOGIN=1` makes `/a/…/blob` want the login (`server.mjs:2802`, `:2832`); off, because the viewer fetches without the cookie (`client/web/js/asset.js:62`). See section 4 | |
| Id: 16 random bytes (128 bits) from `crypto.randomBytes`; unknown, revoked and expired all answer 404 | holds | `asset-envelope.mjs:48`, `:76` |
| Enumeration: not feasible at 128 bits; a 404 tells nothing beyond "not there" | holds | |
| Rate limit on these fetches | was missing, **fixed**: 300 a minute per caller (`BOARD_ASSET_RATE`), then 429; behind a proxy on this machine the caller is the first `X-Forwarded-For` | `server.mjs:2791` |
| Size: 64 MB per asset (`BOARD_MAX_ASSET_MB`), checked before encrypting and again on upload | holds | `asset-envelope.mjs:43`, `:64`; `server.mjs:659` |
| The hub's reach: only the tailnet (`tailscale serve`), bound to 127.0.0.1 | holds | not in code: the way the hub is started |

### Where the key travels and rests

| Point | State | Where |
| --- | --- | --- |
| Made beside the agent (channel process or `dev/session.mjs`), never by the hub | holds | `asset-envelope.mjs:75-98`, `dev/session.mjs` publish |
| **Announced on the board (not `silent`): the hub is told key, title, type and note.** It writes the whole link into a message | weak, known: the board has to show the link, and there is no room key yet to seal it under | `server.mjs:654-680` (`:678`) |
| So the hub can read today: every asset that is shown on the board (it holds ciphertext and key). It cannot read a `silent` asset: of that it knows id, size, owner, time | stated plainly | |
| The key of a shown asset rests in `pad.db` (the message's text and `asset.url`), is in every `/events` frame, in the admin export, and in what `list_assets` returns | weak, same cause | `server.mjs:678`, `:698`, `:2624` |
| Not in `state.assets` (`wrapped_key: null` is the place for the sealed key later), not in stderr, not in the admin log | holds (tested) | `server.mjs:670` |
| From a spoke to the hub the key rides in the `x-asset` header, over loopback only | holds | `server.mjs:2404`, `asset-envelope.mjs:101` |
| After a revoke or the cleanup, the message keeps the title and loses the key | holds | `server.mjs:686` |
| The way out: seal the asset key under the room key (`docs/krypto-konzept.md` sections 4 and 7). Until then, `silent: true` is how a key stays from the hub | missing, planned | |

### The viewer

| Point | State | Where |
| --- | --- | --- |
| The viewer runs on the board's origin. It loads only its own three files, has no inline code, and never puts decrypted content into its own page | holds | `server.mjs:2768` (CSP), `client/web/js/asset.js` |
| An HTML asset runs in `<iframe sandbox="allow-scripts">` on `/a/-/frame.html`, which carries `sandbox allow-scripts` in its own CSP as well: an origin of its own that is nobody's | holds | `asset.js:107-121`, `server.mjs:2774-2784` |
| From inside the frame: board cookie, localStorage, the parent's address and key, `/events`, `/agent/*` are all out of reach; no network (`default-src 'none'`), no popups, no downloads, no top navigation, forms go nowhere | holds. Probed in Chromium with a hostile page: every attempt blocked | section 3 |
| The frame cannot leave for another site either: the viewer's `frame-src 'self'` covers navigations of the frame | holds | `server.mjs:2768` |
| `window.location` inside the frame is `/a/-/frame.html`: no id, no key. `document.referrer` is empty | holds | |
| Headers: `nosniff`, `no-store`, `Referrer-Policy: no-referrer`, `X-Robots-Tag: noindex`, blob as `application/octet-stream` under `default-src 'none'; sandbox` | holds | `server.mjs:2803` |
| `Cross-Origin-Resource-Policy` and `Permissions-Policy` | were missing, **fixed** (`same-origin`; camera, microphone, location and the like off) | `server.mjs:2803-2808` |
| Downloads: always `application/octet-stream` with a cleaned file name, so nothing is opened under the board's address | holds | `asset.js:92-100` |
| An SVG image is shown in `<img>` (no script runs there). Opened in a tab of its own, the `blob:` document inherits the viewer's policy, which forbids inline script | holds, thinly. For the client: show SVG as a download, as the recipient's page does | `asset.js:23` |

### Links in the conversation and on cards (client, read only)

| Point | State | Where |
| --- | --- | --- |
| A link `…/a/<id>#<key>` becomes a card with title and type; the key is never printed | holds | `client/web/js/ui.js:17-37`, `:78` |
| Revoked or expired: the hub marks the message `gone`, the card says "no longer available" and is no link | holds | `server.mjs:686`, `ui.js:79` |
| A link the human pasted to an asset the board does not know (silent, or another board): a card "Published link" that opens the viewer | holds | `ui.js:33-36` |
| Wrong or missing key: without a 43-character key it is no asset card, just a link; the viewer then says "incomplete" or "the key does not fit" | holds | `ui.js:17`, `asset.js:28-35` |
| Public address versus localhost: the hub prints the link under every address it has; the card opens it under the page's own address, or keeps the https one from a plain-http page | holds | `server.mjs:651`, `ui.js:34-36` |
| Thumbnails fetch the blob without the cookie | holds today; must send the cookie before `BOARD_ASSET_LOGIN` can be switched on | `ui.js:59` |

### Integrity and misuse

| Point | State | Where |
| --- | --- | --- |
| Tampered blob: GCM refuses it, the viewer says "the key does not fit" | holds | `asset.js:76-83` |
| Swapped id, replay under another id: the id is associated data, so the blob opens only under its own address (tested) | holds | `asset-envelope.mjs:84` |
| An id that exists cannot be overwritten (`wx`, and the id must be fresh) | holds | `server.mjs:656`, `:663` |
| Truncated upload | was weak (anything over 32 bytes with the magic was stored), **fixed**: a whole blob has one of few lengths (the padding step); any other is refused | `server.mjs:659-661` |
| Type confusion: type and MIME are inside the encrypted header; only listed image, video and audio types are shown, everything else is a download; an `.html` published as `image` is a download | holds | `asset.js:22-26`, `:137` |
| Huge files: the viewer decrypts in memory, hence the 64 MB limit. A phone may still struggle near it | weak, accepted; chunked decryption is the plan for attachments | `asset-envelope.mjs:16-18` |

## 2. What was fixed

All in `server/`, each with a test in `server/test.mjs` ("assets: uploads that were cut off…"). The format is unchanged: every existing link opens as before.

- Truncated uploads are refused (`storeAsset`).
- Fetches of ciphertext are counted per caller, 429 beyond the limit.
- `Cross-Origin-Resource-Policy` and `Permissions-Policy` on everything under `/a/` and `/r/`.
- A release that ran out and is given again starts fresh (found while testing).

## 3. Sharing with someone outside

**A release is per asset and off by default.** A released asset has a second address:

```
<address>/r/<id>#<key>
```

| | |
| --- | --- |
| Release | `share_asset { id, release?, expires_hours?, keep? }` for the session that published it (`server.mjs:1057`, `:1601`); `POST /asset/share { id, release, expires_hours, keep }` for the page (`:3083`) |
| Answer of the route | `{ ok, released, share, path, urls }`. `path` is `/r/<id>`; `urls` is that path under every address of the board, the public one (`BOARD_PUBLIC_URL`) first, without the key: the page appends `#<key>` and offers `urls[0]`, so a link copied on localhost still carries the public address. Both are `null` / `[]` after a release was taken back. An unknown asset answers `404 { error: "no such asset", code: "no-asset" }`; a hub that does not know the route yet answers a 404 without `code` |
| Take back | `release: false`: the ciphertext under `/r/` is gone with the next request. The asset and its board link stay; `revoke_asset` ends both |
| Expiry | `expires_hours`; 0 or left out: no end. A release that ran out answers like one that never was |
| Kept | `keep: true` exempts the asset from the cleanup after 30 days |
| Opens | `asset.share = { at, expires, opens, opened, urls }` in the state (`urls`: the outside addresses without the key, same order as the route's `urls`, public first; worked out for each frame, not stored, so they are there after a reload); `opens` counts fetches of the ciphertext (whether it was decrypted only the recipient's browser knows). `list_assets` reports `released`, `release_expires`, `opens` |
| Admin log | `asset-released`, `asset-release-changed`, `asset-unreleased`, with the id, the end and the count; never key or title |
| From outside | not released, run out, revoked and never there are the same 404 |

**The recipient's page** (`server/share-viewer.mjs`, `shareRoute` at `server.mjs:2840`) is one page, one script, one stylesheet and the empty frame, all under `/r/-/`, plus `/r/<id>/blob`. It uses nothing of the board: no board script or stylesheet, no cookie (`credentials: 'omit'`), no storage. One line says what it is; it works on a phone; SVG is a download there. Because it is self-contained, the same five paths can later be served by another host that holds only ciphertext.

Checked in headless Chromium at 390 px with a page that tries everything: cookie, localStorage, the parent's and the top window's address, `window.open`, `fetch('/events')`, top navigation. All blocked; its own address is `/r/-/frame.html`, the referrer is empty.

**What the release does not do yet.** While `/a/<id>/blob` is open to everyone who can reach the hub, a link `/a/…#key` passed on by hand opens just the same. The release becomes the real gate when `/a/` wants the login (section 4).

### What the web client has to build (not done here)

- A **Share** control on an asset card (`chat.js` `assetCard`): `POST /asset/share { id }`, then show `location.origin + path + '#' + key` (the page holds the key in the link it already shows) with Copy; "Released · opened 3 times · until 6 Oct" from `state.assets[i].share`; "Stop sharing" sends `release: false`; an end (1 day, 1 week, none) as `expires_hours`.
- `asset.js:62` and `ui.js:59`: fetch with `credentials: 'same-origin'`, so that `BOARD_ASSET_LOGIN=1` can be switched on.
- `asset.js`: 429 as its own message ("too many requests"), today it says "the board did not answer".
- Optional: SVG as a download in the board's viewer too.

## 4. Proposed migration: the board link wants the login

Today every link opens without a login. Proposed: `/a/<id>/blob` is for the board (login), `/r/<id>/blob` for outsiders (released only). Then "not released" really means "nobody outside".

This would change behaviour: an `/a/` link opened in a browser that is not signed in would show the sign-in page's refusal instead of the asset. So it is a flag, off by default, and not switched on here. Order: the client sends the cookie (above), then `BOARD_ASSET_LOGIN=1`, then the 38 existing links keep working for him and stop working for anyone not signed in. Whoever needs one of them outside gets it released.

## 5. How a third party reaches a released asset

**Decided (card Nr. 154, his comment: "Das ist doch nur dev, später liegt das im Web!"):** no public door is built. Today's hub is the development setup; the hub will later be hosted on the web, and there `/r/<id>#<key>` is simply reachable. Until then a released link opens inside his tailnet only. The three options below are kept as the record of what was considered.

The hub is reachable only inside the tailnet. A released link therefore opens today for people on his tailnet and nobody else. Nothing public was enabled. Three ways, one recommendation:

| | How | For | Against |
| --- | --- | --- | --- |
| **A. A file to send** | The asset is exported as one HTML file that carries its ciphertext and the small viewer; the key travels as the `#` of the file's address or is typed in. Mailed or messaged like any attachment | Needs no server and no exposure at all; works today's way of sharing files | No taking back, no expiry, no count: once sent it is out. Mail filters dislike HTML attachments |
| **B. A small public door for `/r/` only** (recommended) | A second, tiny process serves the five `/r/` paths and nothing else, reading only released ciphertext; Tailscale Funnel points at that process, never at the hub | Take back, expiry and count work; the public side holds no key, no board code, no login; the hub itself stays private | His machine answers the internet on one port (for ciphertext only), and must be on for a link to open |
| **C. A hosted relay** | Released ciphertext is uploaded to a small hosted store that serves the same five paths | Works with his machine off; the host never has a key | A service to run and pay for; taking back means deleting there; the most to build |

What was recommended before the decision: **B**. It is the only one that keeps what a release promises (take back at once, an end, a count) without putting the hub on the internet, and section 3 was built so that the door is a few dozen lines. A is the fallback for one-off cases and could be added independently.
