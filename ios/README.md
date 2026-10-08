# Trommi for iOS

A native iOS app in pure Swift and SwiftUI, no JavaScriptCore and no web view for the board: the same board as app.trommi.com, verified and decrypted on the phone.

| Folder | What |
| --- | --- |
| `TrommiCore/Sources/TrommiCore` | The crypto core of `shared/crypto/` (FORMAT.md) in Swift: canonical encoding, labels, Ed25519, X25519, AES-256-GCM, HKDF, HMAC, SHA-256 (swift-crypto, which is CryptoKit on Apple platforms), the membership log with every verifier rule, room key epochs, wraps, back links, invites and the emoji check code, hub sign-in, envelopes (seal, verify, open, chains, `seen`, pruned forms, binds), session grants, assets, the account KDF (Argon2id, vendored C reference implementation in `Sources/CArgon2`). |
| `TrommiCore/Sources/TrommiClient` | A human device on the hub. `Board.swift`: the board model, a port of `shared/model.mjs` with every refusal rule (members, sessions, cards with versions and answers, permissions, notes, published objects, timelines, human and agent registers, alerts, the stack; what a newer client wrote is counted and kept, never applied as something else). `Room.swift`: join by invite link, log in with email and password, the catch-up from a cursor (verification off the main thread), the live stream (`SSE.swift`), every human action (message, answer, duck, read, shred, decide again, verdict, registers, notes, attachments, older pages), pairing a device and inviting an agent from the phone, removing devices (re-keying every session), log out, share links, canvases. `Desk.swift`: what the screens read (the web's `BoardState` and `boardModel`). `AccountClient.swift`: the account (status, password, Emergency Kit, email code, Forgot password). `Canvas.swift`: the Scribble Board's wire format. `Pen.swift`: the seeded scribbles and hues of the web's pen. |
| `TrommiCore/Sources/trommi-swift` | The same as a command-line client. |
| `TrommiCore/Tests` | XCTest over every section of `shared/crypto/vectors.json` (byte for byte where the bytes are deterministic; Ed25519 signatures by verifying, CryptoKit signs with randomness), plus `Fixtures/extra-vectors.json` written by the JS core (`dev/ios-extra-vectors.mjs`: session grants, account KDF, the check emoji table) and RFC 9106 for Argon2id. |
| `TrommiApp` | The SwiftUI app (an xtool project). Sign in: scan the QR code of "Pair a device", email and password, Forgot password. The Desk (rows in their session's tones, answer tiles, long-press ways, the selection bar, Blitz, the duck for all, with the agents, the end list), a card's page, the conversation (the app's core screen), the sidebar (a drawer on the iPhone, a column on the iPad), Off your mind, Media and Pages, the Scribble Board, the corner note, Settings (agents, devices with pairing, account). The web's drawings come from `Resources/pen.json` (`dev/ios-pen.mjs` draws them with the web's own pen), its fonts are bundled as static TTF (OFL, `Resources/Fonts/LICENSES.txt`), Liquid Glass for the chrome on iOS 26+. |

The JS core is the reference: `dev/ios-parity.mjs` runs `trommi-swift` against a local hub with the JS core as the human and an agent, both directions.

## On this Linux machine (no sudo)

Swift 6.4.0 from swift.org (the `ubuntu26.04` build, signature checked) is unpacked in `~/.local/share/swift`; on Arch its runtime needs `libncurses.so.6`, a symlink to the system's `libncursesw.so.6` inside the toolchain (`usr/lib/swift/linux`). lldb from that toolchain does not start (it wants libedit and the narrow curses libraries); nothing here needs it.

```bash
. ~/.local/share/swift/env.sh                       # puts that toolchain on PATH
cd ios/TrommiCore
swift test                                          # the vectors, session grants, Argon2id, compat, the board and the pen
swift build && (cd ../.. && node dev/ios-parity.mjs)    # Swift <-> JS on a local hub, 17 checks (see the file's head)
node dev/ios-pen.mjs                                # (from the repo root) pen.json, the pen vectors, Wordlist.swift
node dev/ios-reference-shots.mjs OUT                # the web's demo screens as reference pictures (a local dev server on :8900)
node dev/ios-extra-vectors.mjs                      # (from the repo root) regenerate Fixtures/extra-vectors.json
cp shared/crypto/vectors.json ios/TrommiCore/Tests/TrommiCoreTests/Fixtures/   # after vectors.json changed
```

## Try `trommi-swift` against your real room (app.trommi.com)

Joining is your act: the client never joins by itself, it needs a link you make, and nothing is added before you confirm
the six emoji in the app. The link is read from stdin and never printed; the device key goes to
`~/.local/share/trommi-swift/<room id>/device.key` (mode 0600).

```bash
. ~/.local/share/swift/env.sh
cd ~/.cache/trommi-work/ios/ios/TrommiCore && swift build -c release
.build/release/trommi-swift join --name "trommi-swift (desktop)"
#   paste the link from the app (add a device → copy link), Enter; compare the six emoji with the app, tap "They match"
.build/release/trommi-swift cards                   # catch up, verify everything, print the open cards
.build/release/trommi-swift answer <card id prefix> <option key>    # optional: answers for real, the agent gets it
```

To take it out again: remove the device in the app (it is listed as "trommi-swift (desktop)") and delete
`~/.local/share/trommi-swift/`.

## On the iPhone: what only you can do

The steps use [omarchy-apple-dev](https://github.com/joshuaswarren/omarchy-apple-dev) (Linux-only iOS builds with xtool;
verified there with Swift 6.4, xtool 1.20 and Xcode 27). Nothing of it is installed yet. Steps 1–3 need you (sudo, your
Apple ID, the phone in your hand); after that, building and shipping are commands an agent can run.

1. **Toolchain (sudo).** Omarchy's own `omarchy-install-dev-env` has no iOS entry on this machine, so clone the project and run its installer:

   ```bash
   git clone https://github.com/joshuaswarren/omarchy-apple-dev ~/.local/share/omarchy-apple-dev
   cd ~/.local/share/omarchy-apple-dev && ./install-toolchain.sh
   ```

   It installs `usbmuxd zip base-devel git libimobiledevice openssl poppler libheif` with pacman, `swift-bin` (Swift 6.4)
   from the AUR, builds xtool from source (about 7 minutes), installs rcodesign, ipsw and pymobiledevice3 in user paths,
   then stops at the SDK step and names the matching Xcode. (The swift.org toolchain in `~/.local/share/swift` stays; the iOS builds use `swift-bin`.)

2. **iOS SDK (Apple ID, one download).** Sign in at https://developer.apple.com/download/all/?q=Xcode and download
   **Xcode 27** (`.xip`, matches Swift 6.4; no Mac needed). Then:

   ```bash
   cd ~/.local/share/omarchy-apple-dev && XCODE_XIP=~/Downloads/<the Xcode .xip> ./install-toolchain.sh
   swift sdk list                                    # must print: darwin
   xtool auth                                        # sign in with your Apple ID (stored in ~/.local/share/xtool)
   ```

3. **iPhone over USB.** Plug it in with a data cable, unlock it, tap **Trust**. On iOS 16 and later also turn on
   Settings → Privacy & Security → **Developer Mode** (the phone restarts). Wireless deploy does not work from Linux on
   iOS 26; USB does.

4. **Bundle id.** `TrommiApp/xtool.yml` says `com.trommi.ios`. With a free Apple ID pick one that is yours alone (for
   example `com.<you>.trommi`); for TestFlight it must be the id of the app record (step 6).

5. **Run on the phone** (an agent can do this once 1–4 are done):

   ```bash
   cd ~/.cache/trommi-work/ios/ios/TrommiApp
   ulimit -n 65536
   xtool dev build                                   # xtool/TrommiApp.app
   ~/.local/share/omarchy-apple-dev/device-run.sh    # installs and starts it on the phone
   ```

   In the app: "Scan QR code" and scan the code of app.trommi.com → menu → Devices → "Pair a device", compare the six
   emoji, tap "They match" in the web app; or "Sign in with email". The open cards appear, pull to refresh, tap an
   option to answer. `xtool dev run` installs only; start the app by tapping its icon.

6. **TestFlight (paid Apple Developer account).** Once, in App Store Connect: Users and Access → Integrations → Team Keys →
   a key with the **App Manager** role; download the `.p8` (only once possible) to e.g.
   `~/.appstoreconnect/private_keys/`, note **Key ID** and **Issuer ID**. Apps → + → New App with the bundle id of
   step 4 (the API cannot create apps). Then:

   ```bash
   cd ~/.cache/trommi-work/ios/ios/TrommiApp
   ASC_KEY_PATH=~/.appstoreconnect/private_keys/AuthKey_XXXXXXXXXX.p8 ASC_ISSUER_ID=<issuer id> ASC_KEY_ID=XXXXXXXXXX \
     ~/.local/share/omarchy-apple-dev/ship.sh --upload
   ```

   `ship.sh` builds a release, signs (creates the distribution certificate and profile on its first run), validates
   offline, uploads; it never submits for review. Without `--upload` it proves the pipeline with a local test identity.

## Push (APNs)

`Sources/TrommiApp/Push.swift`: on the first start with a room the app asks for notifications, registers with Apple
and hands its device token to the hub of every room on the phone (`POST push_subscriptions { apns }`, README "Push"),
with a 32-byte key of its own (`push.key` next to the rooms). Apple sees a fixed text ("Eine neue Frage."); the hub's
message rides along sealed under that key. A push in the foreground shows as a banner; arriving or tapped, it refreshes
the board. No Notification Service Extension: the text says nothing, so nothing has to be decrypted before it shows.

- `TrommiApp.entitlements` (`entitlementsPath` in `xtool.yml`) says `aps-environment: development`. xtool reads it from
  the signed binary and turns on Push Notifications for the App ID (`XTL-70CB783D.com.trommi.ios` on the paid team)
  before it fetches the development profile; the app then gets sandbox tokens and says `environment: sandbox`
  (read from `embedded.mobileprovision`). A store build needs `production` there.
- The hub sends only when it has the team's APNs key (`APNS_*`, README "Push"); `APNS_TOPIC` must list the installed
  bundle id (`XTL-70CB783D.com.trommi.ios` for xtool builds). Without it the hub refuses the registration, and the app
  tries again the next time it comes to the front.

## Not there yet

- Device key in the Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`), not a file in Application Support.
- Stored state between launches (chains, cursor, the board): every launch catches up from envelope 0 (headers only for
  thread items, the bodies page in), and the snapshot boot of `snapshot.mjs`.
- Creating an account (founding a room) and the old recovery-code recovery: on the web.
- Freshness (R3) on envelopes of an older key epoch; drawing on a card (the web's pen tool), card versions as they were.
- A re-seal that fails after the device added itself is not retried (the JS core keeps `reseal_pending`).
- Screenshots of the phone from Linux need the RSD tunnel, which needs root (`sudo pymobiledevice3 remote tunneld`).
