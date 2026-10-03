# Push: a notification on the phone when a card knocks

Card Nr. 175. The human is away from the board; a card knocks; the phone says so.

## What the platforms allow (checked 2026-10-03)

- **iPhone and iPad (Safari, iOS/iPadOS 16.4 and later):** Web Push works only for a web app that was put on the
  Home Screen (Share, "Add to Home Screen") and is opened from there. A normal Safari tab has no `PushManager`
  at all. It needs a web app manifest (`display: standalone`), a service worker, HTTPS, and the permission must
  be asked for inside a tap. The Home Screen app has its own storage: it is not signed in when first opened,
  the passkey signs it in once.
- **Desktop Chromium, Edge, Firefox, Safari on macOS; Chrome on Android:** work in a normal tab, with a service
  worker, HTTPS (or localhost) and the permission asked for on a click.
- **Every push must show a notification** (`userVisibleOnly`). Safari and Chromium take a subscription away
  from a site whose pushes show nothing. So there is no silent push, and no "take the notification back when
  the card was answered".
- **The hub is only on the tailnet; push still arrives.** The hub never has to be reachable from outside: it
  makes an *outbound* HTTPS request to the push service of the browser's maker (Apple `web.push.apple.com`,
  Google `fcm.googleapis.com`, Mozilla `updates.push.services.mozilla.com`), and that service delivers to the
  device over the connection the device keeps to it anyway. Checked here: a throwaway hub on this machine
  subscribed a headless Chromium and Google's push service accepted the hub's signed, encrypted request.
  Nothing is opened to the internet, no Funnel. The notification arrives with Tailscale off on the phone;
  *opening* the card from it needs the tailnet, as always.

## What the push service learns (privacy, plainly)

Apple (or Google, Mozilla) sees: that this hub, known to it by its VAPID public key and the contact address
`https://trommi.com` (`BOARD_PUSH_SUBJECT` changes it), sent a message to this device, when, and how urgent.
Because the subscription belongs to the web app, Apple also knows the board's address (the tailnet name).
It does **not** see the content: the message is encrypted on the hub for the one browser (RFC 8291,
`aes128gcm`; the keys are made in the browser and the private one never leaves it), and every message is
padded to the same 512 bytes, so its length says nothing either. The `Topic` header that lets a newer message
replace an older one for the same card is a hash of the card's id, not the id.

A notification is shown on the lock screen, so what it says is a setting per device. He chose the title as the
default (card Nr. 185); the discreet text is one switch away:

| Setting (per device, in the menu) | Default | The notification says |
|---|---|---|
| Show the card title | on | on: "Knock: <card title>", "Nr. 12: <card title>" · off: "Something knocks", "A new card" |
| New cards when I am away | on | on: a new card rings while no board is open (see below) · off: only knocks ring |

## What rings

A knock is what the board calls a knock everywhere (`isKnock` in `client/web/js/ui.js`): a card with urgency
`high` or `critical`, or a permission request. The hub looks at the stack after every change (`push.watch(state)`
in `commit()`), so every way a card can start knocking is covered by one rule and no tool needs to know about push:

- a new card filed as high or critical, or a permission request;
- `set_urgency` or `revise_card` raising an open card to high or critical;
- a knocking card coming back into the stack (from snooze, reopened, its session taken out of the archive).

One notification per card: the notification's `tag` is the card, so a later one replaces the earlier one on the
device, and a card that goes down and up again does not ring twice within a minute (`BOARD_PUSH_AGAIN_MS`).
What is already waiting when the hub starts does not ring. Knocks ring always, board open or not.

### A stopped session (cards Nr. 202/203)

The raised red hand means a SESSION is really stopped (`server/blocked.mjs`): disconnected for more than a minute
while a status line of its says "working" (`BOARD_OFFLINE_GRACE_MS`), an error its side reported (`error` in
`/agent/profile`, cleared by its next tool call or a new link), or connected and "working" with nothing from it for
15 minutes (`BOARD_SILENT_MS`). It rings once per stop, always, as "Stopped: <session>. <cause>" (discreet: "An
agent is stopped"), tag `agent-<id>`, opening the session; it rings again only after the session ran again. A stop
that is a card (an approval, a card marked blocking) shows the hand but rings only as that card's knock. Time alone
can start a stop, so the hub looks every 30 seconds (`BOARD_BLOCKED_TICK_MS`) and commits when the set changed.

### New cards, only when he is away (card Nr. 186)

A card that does not knock rings only when the human is away: no page of the board has had its live stream open
for 5 minutes (`BOARD_PUSH_AWAY_MS`). The hub counts the open streams of both boards (`/events` of the old page,
the Turbo stream of the new one; both are behind the login) and looks every 20 seconds. A phone whose screen is
locked drops its stream, so five minutes after he put it away he is away. All browsers share one login, so the
hub cannot tell them apart, and it cannot tell a tab he looks at from one left open on a desk: **a board left open
anywhere keeps new cards silent** (knocks still ring).

A burst comes as one: the first new card rings at once; whatever is filed within the next minute
(`BOARD_PUSH_BURST_MS`) rings together when that minute is over, as "3 new cards" (opens the Desk), or as the one
card if it is one. Cards answered or taken back in the meantime are not counted, and if he came back to the
board in that minute nothing rings.

## The parts

- `server/push.mjs`: everything on the hub. The VAPID key pair (ES256), made once, in `data/push-vapid.pem`
  (mode 0600, never logged, never shown; only the public key leaves the hub). The subscriptions in
  `data/push.json` (mode 0600; the address of a subscription is a secret too and is never logged). Encryption
  and signing with `node:crypto` alone (ECDH P-256, HKDF-SHA-256, AES-128-GCM; the JWT signed ES256): no package.
  A subscription the push service answers 404 or 410 for is removed.
- Routes (all behind the login; POST also behind the origin check):
  `GET /push/key` · `POST /push/subscribe { endpoint, keys: { p256dh, auth }, title, away }` (both default true; left out, they stay as they were) ·
  `POST /push/unsubscribe { endpoint }` · `POST /push/state { endpoint }` · `POST /push/test { endpoint }`.
  A subscription is accepted only for the hosts of the browsers' push services (`BOARD_PUSH_HOSTS` adds more),
  so the hub cannot be made to post to an address of someone's choosing.
- Open without the login, because a phone fetches them without the cookie and nothing in them is the board's:
  `/manifest.webmanifest`, `/sw.js`, `/icons/trommi-{180,192,512}.png`.
- `client/web/sw.js`: the service worker. `push` shows the notification, `notificationclick` opens or focuses
  the card's page `/q/<number>`. No `fetch` handler, no cache: it changes nothing about how the board loads.
- `client/web/js/push.js` (+ `css/push.css`): the switch "Push on this device". It imports nothing from the
  board's other modules and wires itself to `#push-toggle`; on `turbo:load` it does so again.
- `client/web/manifest.webmanifest`, `client/web/icons/`: name "Trommi", the bell on the green square.
  `node dev/icons.mjs` draws the PNGs from `icons/trommi.svg` with headless Chromium.
- Hooks in shared files, all small: `server/server.mjs` (load the module, `push.watch(state)` in `commit()`, the count of open streams,
  `push.route(...)` before the login check, start it when this process becomes the hub), `index.html` (the two
  `<link>`s and the button), `js/bar.js` (the bell before the word, `import('./push.js')`), `js/ui.js` (the bell sketch).

**For the Turbo layout** (`server/views/`): put into the head
`<link rel="manifest" href="/manifest.webmanifest">` and `<link rel="apple-touch-icon" href="/icons/trommi-180.png">`,
into the menu `<button type="button" id="push-toggle"></button>`, and load `<script type="module" src="/js/push.js"></script>`.
Nothing else is needed. The Content-Security-Policy, if the layout gets one, must allow `worker-src 'self'`,
`manifest-src 'self'` and `connect-src 'self'`; today's board page sends none, so nothing is in the way.

Switches: `BOARD_PUSH=0` turns it all off; `BOARD_PUSH_SUBJECT` (a `mailto:` or `https:` contact, sent to the push
service); `BOARD_PUSH_HOSTS`; `BOARD_PUSH_AGAIN_MS`; `BOARD_PUSH_AWAY_MS`; `BOARD_PUSH_BURST_MS`.

## Verified, and not

- `server/test.mjs`, section "push": against a push service played by the test, the subscription is stored, a
  knock sends exactly one request, the test decrypts it with the subscriber's keys and verifies the VAPID
  signature with the hub's public key, the card's title is the default and the discreet text a setting, a new card rings only after the last board page was closed, a 410 removes the subscription. The five minutes and the burst are tested on the module alone with a clock of the test's own.
- Headless Chromium against a hub of its own: the menu, the permission step, the service worker, the
  subscription, the settings, and "Send a test" accepted by Google's real push service. Headless Chromium does
  not receive pushes, so the notification itself was not seen.
- Not verified, needs the iPhone: that Apple's push service accepts the request, that the notification shows,
  and that a tap opens the card. The list to tick is in `client/web/designs/iphone-checks.html`.

## On the iPhone, once

1. Open the board in Safari, Share, "Add to Home Screen".
2. Open "Trommi" from the Home Screen and sign in with the passkey.
3. Menu (the arrow beside "Desk"), "Push on this device", allow. "Send a test" shows what arrives.
