# Trommi for iOS

A native iOS app in pure Swift and SwiftUI, no JavaScriptCore and no web view for the board: the same board as app.trommi.com, verified and decrypted on the phone.

| Folder | What |
| --- | --- |
| `TrommiCore/Sources/TrommiCore` | The crypto core of `shared/crypto/` (FORMAT.md) in Swift: canonical encoding, labels, Ed25519, X25519, AES-256-GCM, HKDF, HMAC, SHA-256 (swift-crypto, which is CryptoKit on Apple platforms), the membership log with every verifier rule, room key epochs, wraps, back links, invites and the emoji check code, hub sign-in, envelopes (seal, verify, open, chains, `seen`, pruned forms, binds), session grants, assets, the account KDF (Argon2id, vendored C reference implementation in `Sources/CArgon2`). |
| `TrommiCore/Sources/TrommiClient` | A human device on the hub. `Board.swift`: the board model, a port of `shared/model.mjs` with every refusal rule (members, sessions, cards with versions and answers, permissions, notes, published objects, timelines, human and agent registers, alerts, the stack; what a newer client wrote is counted and kept, never applied as something else). `Room.swift`: join by invite link, log in with email and password, the catch-up from a cursor (verification off the main thread), the live stream (`SSE.swift`), every human action (message, answer, duck, read, shred, decide again, verdict, registers, notes, attachments, older pages), pairing a device and inviting an agent from the phone, removing devices (re-keying every session), log out, share links, canvases. `Desk.swift`: what the screens read (the web's `BoardState` and `boardModel`). `AccountClient.swift`: the account (status, password, Emergency Kit, email code, Forgot password). `Canvas.swift`: the Scribble Board's wire format. `Pen.swift`: the seeded scribbles and hues of the web's pen. |
| `TrommiCore/Sources/trommi-swift` | The same as a command-line client. |
| `TrommiCore/Tests` | XCTest over every section of `shared/crypto/vectors.json` (byte for byte where the bytes are deterministic; Ed25519 signatures by verifying, CryptoKit signs with randomness), plus `Fixtures/extra-vectors.json` written by the JS core (`dev/ios-extra-vectors.mjs`: session grants, account KDF, the check emoji table) and RFC 9106 for Argon2id. |
| `TrommiApp` | The SwiftUI app (an xtool project). Sign in: scan the QR code of "Pair a device", email and password, Forgot password. The Desk (rows in their session's tones, answer tiles, long-press ways, the selection bar, Blitz, the duck for all, with the agents, the end list), a card's page, the conversation (the app's core screen), the sidebar (a drawer on the iPhone, a column on the iPad), Off your mind (one list: being worked on, then done), Artifacts (Media and Pages, filter All · Media · Pages), the Scribble Board, the corner note, Settings (one list: Invite a Device, Invite Agent…, Sessions, Devices with Push, Account, Theme), the demo (`DemoMode.swift`: the web demo's room from `Resources/Demo`, a copy of `app/web/public/demo/fixture.json`, its files and `dev/interop/fixtures/screens.json`; Demo on the sign-in screen and in the pill menu; `TROMMI_SCREEN=<id>` opens one state at launch). The web's drawings come from `Resources/pen.json` (`dev/ios-pen.mjs` draws them with the web's own pen), its fonts are bundled as static TTF (OFL, `Resources/Fonts/LICENSES.txt`), Liquid Glass for the chrome on iOS 26+. |

The JS core is the reference: `dev/interop/` (README "Interop") drives the JS core and `trommi-swift driver` against each other on a local hub, every pair of directions, and reports the feature parity.

## On this Linux machine (no sudo)

Swift 6.4.0 from swift.org (the `ubuntu26.04` build, signature checked) is unpacked in `~/.local/share/swift`; on Arch its runtime needs `libncurses.so.6`, a symlink to the system's `libncursesw.so.6` inside the toolchain (`usr/lib/swift/linux`). lldb from that toolchain does not start (it wants libedit and the narrow curses libraries); nothing here needs it.

```bash
. ~/.local/share/swift/env.sh                       # puts that toolchain on PATH
cd ios/TrommiCore
swift test                                          # the vectors, session grants, Argon2id, compat, the board and the pen
swift build && (cd ../.. && npm run interop)           # Swift <-> JS on a local hub (dev/interop/run.mjs), then npm run interop:parity
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

## Keyboard and tab bar

As Messages, Mail and Notes do on iOS 26: no control of our own for the keyboard, the system's behaviour not fought.

- **All screens:** the keyboard goes away by dragging the content down (`.scrollDismissesKeyboard(.interactively)`)
  or by a tap in the content. The system tab bar hides while the keyboard is up and comes back after.
- **Chat:** the composer is a bottom bar (`safeAreaBar`, a safe area inset before iOS 26). It rides on the keyboard
  and reserves its height, so the last message scrolls clear of it. Folded, it is a round glass pencil beside the
  tab bar; a tap opens the field with the keyboard. With nothing written it folds back once the keyboard is gone, but
  never while the photo picker, the camera or the file importer is open. A tap in the conversation hides the keyboard.
- **Note:** a panel inside the page, above the tab bar, not a sheet (a sheet covered the bar). The page stays
  visible behind it, dimmed. The keyboard lifts the panel as it lifts the page. Drag the handle down or tap beside the
  panel to close it; the draft stays on the note.
- **Desk:** no text field; the keyboard only appears in sheets (New Desk, Rename), which the system handles.
- **Settings:** forms with the system's keyboard handling; a drag dismisses it.

## TestFlight from CI

`.github/workflows/ios-beta.yml` builds main when started by hand (`gh workflow run ios-beta.yml`, or Actions → iOS beta
→ Run workflow; no push trigger, macOS minutes count ten times) with the official Xcode 27 on a GitHub macOS runner (`runs-on: xcode-27`, a GitHub preview image), uploads it to App Store
Connect and hands it to the internal TestFlight group **Intern**; the deployment shows as the environment `ios-beta`.

- `TrommiApp/AppStore/project.yml`: the Xcode project, generated in CI with XcodeGen (not checked in): an app target
  `Trommi` that links the package's `TrommiApp` library (as xtool's stub does), with the app icon
  (`Assets.xcassets`, the web's maskable bell at 1024 px), `aps-environment: production`
  (`AppStore/TrommiApp.entitlements`) and the Info.plist keys xtool adds. Version: `MARKETING_VERSION` there; build
  number: the workflow's run number. Linux builds (`xtool dev`, `ship.sh`) do not use this folder.
- `TrommiApp/AppStore/asc.py`: the App Store Connect API steps (standard library and `openssl`): the bundle id with
  Push Notifications, the app record check, waiting for the processed build, the group and its tester, the build's
  TestFlight "What to Test" (the commit subject).
- Internal testers must be users of the team under the address they sign in with; when the API refuses the tester
  (409 "Tester(s) cannot be assigned"), add them once in App Store Connect → TestFlight → Intern → Testers → +.
- Signing: automatic, through the API key (`-allowProvisioningUpdates -authenticationKey…`); export
  `app-store-connect`, `destination: upload`, `testFlightInternalTestingOnly`.
- Environment `ios-beta`: secret `ASC_KEY` (the `.p8` of a team key with the Admin role: cloud-managed distribution
  signing refuses App Manager keys), variables `ASC_KEY_ID`, `ASC_ISSUER_ID`, `APPLE_TEAM_ID`;
  optional `ITS_NON_EXEMPT_ENCRYPTION` (`YES` or `NO`, written into every build as `ITSAppUsesNonExemptEncryption`;
  unset, each build shows "Missing Compliance" until it is answered in App Store Connect) and `TESTFLIGHT_TESTER`.
- Once, by a person: the app record (App Store Connect → Apps → + → New App: iOS, name Trommi, bundle id
  `com.trommi.ios`, SKU `trommi-ios`); the export compliance answer (the app encrypts end to end with AES-256-GCM,
  X25519 and Ed25519 through CryptoKit; whether that is exempt is a legal answer, not a build setting).

## TestFlight without CI

`TrommiApp/AppStore/ship-local.sh [REF]` makes the same TestFlight build on this Linux machine, without GitHub Actions
(REF defaults to `origin/main`, fetched first; `--dry-run` stops at the signed, validated `.ipa`):

```bash
ios/TrommiApp/AppStore/ship-local.sh            # about 5 minutes to the upload, then App Store Connect's processing
```

- Built from a clean `git worktree` of REF in a temporary folder, never from the working tree; the script and `asc.py`
  next to it run from the checkout you start it in.
- Build number: the highest build App Store Connect has for the app, plus one (`asc.py next-build`); `BUILD_NUMBER`
  overrides it. Version: `MARKETING_VERSION` in `AppStore/project.yml`.
- Build: `xtool dev build --configuration release`, then the app icon from `AppStore/Assets.xcassets` (the SDK's Linux
  `actool`), `ITSAppUsesNonExemptEncryption` (`ITS_NON_EXEMPT_ENCRYPTION`, default `NO`), and omarchy-apple-dev's
  `tools/asc.py stamp` and `frameworks` (DT* keys, Xcode 27.1 `27A9275` from
  `~/.cache/xtool/darwin-iPhoneOS27.1.xtoolsdk.version.plist`). App extensions are dropped.
- Signing: an Apple Distribution certificate and an App Store profile (`omarchy-apple-dev com.trommi.ios …`), created
  through the API with the Admin key on the first run; the distribution key stays in
  `~/.appstoreconnect/private_keys/distribution/key.pem` (0600). Entitlements: the profile's plus
  `AppStore/TrommiApp.entitlements` (`aps-environment: production`), each checked against the profile; `rcodesign`.
- Offline validation (`asc.py validate`, 40 checks), upload with the Build Uploads API (`asc.py upload`), then this
  folder's `asc.py wait`, `internal … Intern`, and `notes`: "Neu in Build N (sha):" and the subjects of the commits
  under `ios/` since the commit the previous build's What to Test names (`asc.py last-sha`); `NOTES` overrides it.
- Needs: xtool, `swift-bin` with the darwin SDK, `rcodesign`, `~/pymobile3-venv` (omarchy-apple-dev's installer), and the
  Admin key `~/.appstoreconnect/private_keys/AuthKey_<ASC_KEY_ID>.p8` (`ASC_KEY_ID`, `ASC_ISSUER_ID` default to the team's).

## Push (APNs)

`Sources/TrommiApp/Push.swift`: on the first start with a room the app asks for notifications, registers with Apple
and hands its device token to the hub of every room on the phone (`POST push_subscriptions { apns }`, README "Push"),
with a 32-byte key of its own (`push.key` next to the rooms). Apple sees a fixed text ("Eine neue Frage."); the hub's
message rides along sealed under that key. A push in the foreground shows as a banner; arriving or tapped, it refreshes
the board. No Notification Service Extension: the text says nothing, so nothing has to be decrypted before it shows.

- `TrommiApp.entitlements` (`entitlementsPath` in `xtool.yml`) says `aps-environment: development` (the TestFlight builds use `AppStore/TrommiApp.entitlements`, `production`). xtool reads it from
  the signed binary and turns on Push Notifications for the App ID (`XTL-70CB783D.com.trommi.ios` on the paid team)
  before it fetches the development profile; the app then gets sandbox tokens and says `environment: sandbox`
  (read from `embedded.mobileprovision`).
- The hub sends only when it has the team's APNs key (`APNS_*`, README "Push"); `APNS_TOPIC` must list the installed
  bundle id (`XTL-70CB783D.com.trommi.ios` for xtool builds). Without it the hub refuses the registration, and the app
  tries again the next time it comes to the front.

## Share Extension

Trommi in the iOS share sheet (`Sources/TrommiShare`, bundle id `com.trommi.ios.share`, xtool.yml `extensions:`,
AppStore/project.yml target `TrommiShareExtension`). Its sheet has two ways: **Add to Note** (the default: pictures,
screenshots, files, links and text become attachments and lines of the one note; nothing is sent) and **Send to Agent…**
(the sessions as a tree, desks → crowned session → helpers, an optional line, Send).

- The extension holds no room, no device key, no board: it links only `ShareInbox` (TrommiCore), well inside an
  extension's memory. It seals what was shared into the App Group container `group.com.trommi.ios` ("Trommi Share":
  `items/<id>-<n>.sealed` first, the manifest `requests/<id>.sealed` last) and rings the app (Darwin notification
  `com.trommi.ios.share-inbox`). Pictures are made JPEG of at most 2400 px through ImageIO thumbnails (never decoded
  whole), other files are taken up to 32 MB, at most 20 things per share.
- Every file is AES-256-GCM under the inbox key, 32 random bytes in the Keychain with the App Group as access group
  (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`; the app makes it, the extension only reads it). The additional
  data binds each file to its role and name. Nothing lies in plaintext outside the app; the device keys stay in the
  app's own Keychain group.
- The app (`ShareImport.swift`) writes a sealed snapshot of desks and sessions (names, ids, desk, parent, crown) on each
  change of the board, and imports on coming to the front (after the catch-up) and at once on the ring: files are
  encrypted and uploaded as the note's own, then into the note (`saveNote`), or one message to the session
  (`sendMessage`). A send is taken out of the inbox before it is sealed, so it is never repeated; if it fails, or the
  session is gone, what was shared goes into the note instead.
- Not sent from the extension: it would need the device key and the sync engine, and two processes sealing with one
  device key fork its envelope chain (`chain-behind`). So "Send to Agent…" says "Sends as soon as Trommi opens".
- The App Group id per build: `group.com.trommi.ios` in the entitlements. xtool signed in with the API key (this
  machine) keeps it as written; signed in with an Apple ID it registers `group.XTL-<team>.com.trommi.ios` and rewrites
  the entitlement. The code tries both (`ShareGroup`).
- **Once, in the developer portal** (the App Store Connect API can turn the App Groups capability on, but cannot create a
  group or assign one): Certificates, Identifiers & Profiles → Identifiers → App Groups → + → `group.com.trommi.ios`.
  Then for each of `XTL-70CB783D.com.trommi.ios`, `XTL-70CB783D.com.trommi.ios.share` (xtool's development ids; xtool
  registers the `.share` one on its first `xtool dev run`, or make it there with Identifiers → +) and `com.trommi.ios`, `com.trommi.ios.share` (TestFlight;
  `asc.py prepare` registers them): App Groups → Configure → tick the group → Save. Until then an install fails with an
  entitlements error, because the profile does not carry the group the app asks for.

## Not there yet

- Device key in the Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`), not a file in Application Support.
- Stored state between launches (chains, cursor, the board): every launch catches up from envelope 0 (headers only for
  thread items, the bodies page in), and the snapshot boot of `snapshot.mjs`.
- Creating an account (founding a room) and the old recovery-code recovery: on the web.
- Freshness (R3) on envelopes of an older key epoch; drawing on a card (the web's pen tool), card versions as they were.
- A re-seal that fails after the device added itself is not retried (the JS core keeps `reseal_pending`).
- Screenshots of the phone from Linux: `pymobiledevice3 developer dvt screenshot` works over its userspace tunnel without root (`npm run interop:screens -- --iphone-current`).
