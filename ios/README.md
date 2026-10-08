# Trommi for iOS (spike)

A native iOS app in pure Swift, no JavaScriptCore. This folder holds the spike that proves the hard part:

| Folder | What |
| --- | --- |
| `TrommiCore/Sources/TrommiCore` | The crypto core of `shared/crypto/` (FORMAT.md) in Swift: canonical encoding, labels, Ed25519, X25519, AES-256-GCM, HKDF, HMAC, SHA-256 (swift-crypto, which is CryptoKit on Apple platforms), the membership log with every verifier rule, room key epochs, wraps, back links, invites and the emoji check code, hub sign-in, envelopes (seal, verify, open, chains, `seen`, pruned forms, binds), session grants, assets, the account KDF (Argon2id, vendored C reference implementation in `Sources/CArgon2`). |
| `TrommiCore/Sources/TrommiClient` | A human device on the hub: join by invite link, sign in, member list pinned to the room id, room and session keys (back links included), catch-up with full chain and signature verification, the open cards, answering a card, the device register. |
| `TrommiCore/Sources/trommi-swift` | The same as a command-line client. |
| `TrommiCore/Tests` | XCTest over every section of `shared/crypto/vectors.json` (byte for byte where the bytes are deterministic; Ed25519 signatures by verifying, CryptoKit signs with randomness), plus `Fixtures/extra-vectors.json` written by the JS core (`dev/ios-extra-vectors.mjs`: session grants, account KDF, the check emoji table) and RFC 9106 for Argon2id. |
| `TrommiApp` | The SwiftUI app (an xtool project): join with a pasted invite link, the six emoji, the open cards, tap an option to answer. |

The JS core is the reference: `dev/ios-parity.mjs` runs `trommi-swift` against a local hub with the JS core as the human and an agent, both directions.

## On this Linux machine (no sudo)

Swift 6.4.0 from swift.org (the `ubuntu26.04` build, signature checked) is unpacked in `~/.local/share/swift`; on Arch its runtime needs `libncurses.so.6`, a symlink to the system's `libncursesw.so.6` inside the toolchain (`usr/lib/swift/linux`). lldb from that toolchain does not start (it wants libedit and the narrow curses libraries); nothing here needs it.

```bash
. ~/.local/share/swift/env.sh                       # puts that toolchain on PATH
cd ios/TrommiCore
swift test                                          # 18 tests: every vector, session grants, Argon2id, account KDF
swift build && (cd ../.. && node dev/ios-parity.mjs)    # Swift <-> JS on a local hub, 7 checks
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

1. **Toolchain (sudo).** Omarchy menu → Install → Development → iOS (Swift + xtool), or in a terminal:

   ```bash
   omarchy-install-dev-env ios
   ```

   It installs `usbmuxd zip base-devel git libimobiledevice openssl poppler libheif` with pacman, `swift-bin` (Swift 6.4)
   from the AUR, builds xtool from source (about 7 minutes), installs rcodesign, ipsw and pymobiledevice3 in user paths,
   then stops at the SDK step. (The swift.org toolchain in `~/.local/share/swift` stays; the iOS builds use `swift-bin`.)

2. **iOS SDK (Apple ID, one download).** Sign in at https://developer.apple.com/download/all/?q=Xcode and download
   **Xcode 27** (`.xip`, matches Swift 6.4; no Mac needed). Then:

   ```bash
   XCODE_XIP=~/Downloads/Xcode_27.0.xip ~/.local/share/omarchy-apple-dev/install-toolchain.sh
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

   In the app: paste an invite link (from app.trommi.com: add a device), compare the six emoji, tap "They match" in the
   web app; the open cards appear, pull to refresh, tap an option to answer.

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

## Not in the spike (the MVP's list)

- Device key in the Keychain (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`), not a file in Application Support.
- Incremental sync (cursor, stored chains and grants) and the live stream (`GET stream`, SSE); the spike reads from
  envelope 0 on every refresh.
- The rest of the model: timelines (chat), registers (status lines, session names, desks), permission requests,
  decide again, notes, attachments, snapshots, alerts; freshness (R3) on live envelopes.
- Push (APNs: the hub sends Web Push only today), the account login (email + password: the KDF is here and tested,
  the flow `joinWithRecoveryCode` is not), recovery, the passphrase escrow (PBKDF2, not in swift-crypto's API).
