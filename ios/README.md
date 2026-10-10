# Trommi for iOS

A native iOS app in Swift and SwiftUI, no web view for the board: the same board as app.trommi.com, verified and
decrypted on the phone. The protocol ([`spec/v1.md`](../spec/v1.md)) is not written a second time in Swift: the app
links [`trommi-core`](../core/README.md) (Rust, OpenMLS) as a static library and talks to it through one Swift
protocol. It is built, signed and shipped from Linux; no Mac is needed.

## Layout

| Folder | What |
| --- | --- |
| `TrommiClient/` | A Swift package: everything of the app that is not a view. Four targets, below. |
| `TrommiApp/` | The SwiftUI app and its three extensions (an [xtool](https://github.com/xtool-org/xtool) project). |
| `TrommiApp/AppStore/` | What a TestFlight build needs on top: icon, production entitlements, the ship script. |
| `../core/swift/` | The Rust core for Swift: `build.sh`, the Swift package `TrommiCoreRust` it fills, a proof app. |

Targets of `TrommiClient`:

| Target | What | Links the Rust core |
| --- | --- | --- |
| `TrommiClient` | The board model (`Board.swift`, `Desk.swift`), the device store, the hub client and live stream, the engine. `Core.swift` is the core as Swift sees it: the protocols `CoreTools` and `CoreDevice`, one call for one call of `core/README.md`. No crypto of its own; builds and tests on Linux without the library. | no |
| `TrommiCoreLive` | `LiveCore`: `CoreTools` on the real library (UniFFI module `TrommiCoreRust`). Its header lists which calls are real, which are stubbed (none) and what of the binding is not bound. | yes |
| `ShareInbox` | The Share Extension's sealed inbox in the App Group (local storage, Apple's CryptoKit). | no |
| `PushNotify` | What the Notification Service Extension and the Live Activity widget share with the app. | no |

The app and its extensions (`TrommiApp/Package.swift` products, `xtool.yml`):

| Binary | Bundle id | Uses | Links the Rust core |
| --- | --- | --- | --- |
| `TrommiApp` | `com.trommi.ios` | everything | yes (about 3 MB) |
| `TrommiShare.appex` | `com.trommi.ios.share` | `ShareInbox` | no |
| `TrommiNotify.appex` | `com.trommi.ios.notify` | `PushNotify` | only what opens one push (`NotifyCoreLive`); see "Who owns the state" |
| `TrommiLive.appex` | `com.trommi.ios.live` | `PushNotify` | no |

Each binary that links the core carries its own copy of it. Measured with the proof build of October 2026: the app
binary grew by 3.1 MB, an extension that linked it by 3.0 MB.

## Build from a clean checkout (Linux)

Needs: [rustup](https://rustup.rs) (the compiler and its targets are named in `rust-toolchain.toml` and installed on
first use), Swift 6.4, and for anything that runs on a phone the toolchain of "On an iPhone" below.

```bash
core/swift/build.sh                                 # the Rust core: lib/linux and lib/ios, UniFFI's Swift file and header
(cd tests/ios && swift test)                              # the model, the store, and LiveCore against the Linux library
(cd ios/TrommiApp && ulimit -n 65536 && xtool dev build --configuration release)   # xtool/TrommiApp.app
```

The tests are a package of their own in the repository's one tests folder, `tests/ios` (one folder per tested
target; SwiftPM takes no target outside its package, so `tests/ios/Package.swift` depends on `ios/TrommiClient` by
path). `swift test` is run there.

### The Rust core

`core/swift/build.sh` (`host`, `ios`, or both without an argument) writes into `core/swift/TrommiCoreRust/`:
`lib/<platform>/libtrommi_core_ffi.a`, `Sources/TrommiCoreFFI/include/TrommiCoreFFI.h` and
`Sources/TrommiCoreRust/TrommiCoreRust.swift`. All three are build output and ignored by git: **after a fresh
checkout, and after every change under `core/`, run it again** before `swift test` or `xtool dev build`. About two
minutes the first time, 20 seconds after.

With a hub binary of branch `v2-hub` the tests also run against the real hub:
`TROMMI_HUB_BIN=<path>/trommi-hub swift test --filter RealHubTests`.

- No Apple SDK and no Apple linker are needed for the library itself: a static library is an archive of object files,
  which `rustc` writes for `aarch64-apple-ios` on Linux.
- The package links it with a library search path per platform (`core/swift/TrommiCoreRust/Package.swift`), not an
  XCFramework: SwiftPM on Linux refuses an XCFramework, and `swift test` needs the Linux library. SwiftPM allows such a
  flag only in a package used by path; `ios/TrommiClient/Package.swift` names it as `../../core/swift/TrommiCoreRust`.
- The darwin SDK's toolset passes `-all_load` to every link, so the script takes rustc's copy of the compiler runtime's
  C and assembly helpers out of the iOS archive (Apple's `libclang_rt.ios.a` has the same symbols) and checks every
  removed symbol against Apple's file. Without the SDK installed, set `DARWIN_CLANG_RT=unchecked`.
- `core/swift/ProofApp` is the smallest app that links the core; `xtool dev build` there checks the iOS link alone.

## Who owns the state

The core's rule (`core/src/store.rs`): exactly one owner works on a stored device state; two would sign two
different items under one number.

- **The app alone owns the device.** The device's state (its key, the MLS groups, the chains, the outbox) lies in the
  app's own container (`Application Support/trommi/d-<random>/state`), not in the App Group, sealed under a key that
  is a Keychain item of the app alone. `DeviceStore` takes an exclusive lock on the folder before it reads and keeps
  it until the room is closed: a second opener, in this process or another, fails with `busy`. The revision is the
  check behind the lock.
- **Written whole, read with suspicion.** One sealed record per batch, flushed to the drive before the core is
  answered; a write whose outcome is unknown stops the store. On reading, every record is opened, only the end of
  the log may be incomplete, and a state below its **anchor** (a revision kept in the Keychain, moved forward by
  every batch that puts something into the outbox) does not load: an older state put back is refused. The folder is
  left out of backups.
- **Extensions never open it**, and cannot: no path, no key. They cannot sign, send, or follow a group.
  - **Share Extension:** writes what was shared into the sealed inbox in the App Group; the app takes it from there
    and sends it.
  - **Notification Service Extension:** gets, in one Keychain item whose access group is the App Group, the push key
    and the room's id, and nothing else. With the push key it opens the sealed part of a push (room, change number,
    urgency). It gets no content key: none ever leaves the core, so the extension opens no envelope and shows no
    title. Every member of the App Group (the three extensions) can read the item. A title in the notification
    needs a title the core seals separately, or a call of the binding that opens one envelope without the device.
  - **Live Activity widget:** shows two counts; it holds no key and reads no file.
- **Removed by another device.** The hub ends a removed device's access and names it `role: "removed"` at its next
  sign-in; that token reads only `GET /v2/groups/{room}/removal`, the room group's Commits up to the removing one.
  The device hands them to its core; only when the core says a Commit removed it (or it read that Commit in the
  changes before) is the room marked removed (`Room.removedAt`, kept in room.json), and the app forgets the room
  and says so on the start screen. A hub that says "removed" without such a Commit, and a bare `not-member`, change
  nothing: an envelope refused with `not-member` stays in the outbox unless the core's own group state has no leaf
  of this device there.
- **A sign-in whose room join got no answer** keeps its device (marked `join-unsure`, never swept) and asks the hub
  under the device's own key: a member's token resumes it as the room's device, `not-member` gives it up, no
  answer leaves it for the next sign-in, which resumes it instead of making a second device.
- **What is not covered:** a phone whose app container AND Keychain an attacker can write. The lock is held while
  the app is suspended; the folder is not a shared container, where iOS would end an app for that, but this is to
  be watched on a device.

## Not on Linux

- No simulator: nothing here runs the app. `swift test` runs the model and the core's binding on x86-64 Linux.
- That the app links for iOS is checked on Linux; how it looks and behaves is verified only on a device.
- The asset catalog is not compiled by xtool (the icon comes from a PNG; the TestFlight build compiles it with the
  SDK's `actool`).

## On an iPhone, built on Linux

The steps use [omarchy-apple-dev](https://github.com/joshuaswarren/omarchy-apple-dev) (Arch Linux; checked with Swift
6.4, xtool 1.20 and the SDK of Xcode 27). Steps 1 to 3 need a person (root rights, an Apple ID, the phone in hand);
after that, building and shipping are plain commands.

1. **Toolchain (needs root).**

   ```bash
   git clone https://github.com/joshuaswarren/omarchy-apple-dev ~/.local/share/omarchy-apple-dev
   cd ~/.local/share/omarchy-apple-dev && ./install-toolchain.sh
   ```

   It installs `usbmuxd zip base-devel git libimobiledevice openssl poppler libheif` with pacman, `swift-bin` (Swift 6.4)
   from the AUR, builds xtool from source (about 7 minutes), installs rcodesign, ipsw and pymobiledevice3 in user paths,
   then stops at the SDK step and names the matching Xcode.

2. **iOS SDK (Apple ID, one download).** Sign in at https://developer.apple.com/download/all/?q=Xcode and download
   **Xcode 27** (`.xip`, matches Swift 6.4; no Mac needed). Then:

   ```bash
   cd ~/.local/share/omarchy-apple-dev && XCODE_XIP=~/Downloads/<the Xcode .xip> ./install-toolchain.sh
   swift sdk list                                    # must print: darwin
   xtool auth                                        # sign in with the Apple ID (stored in ~/.local/share/xtool)
   ```

3. **iPhone over USB.** Plug it in with a data cable, unlock it, tap **Trust**. On iOS 16 and later also turn on
   Settings → Privacy & Security → **Developer Mode** (the phone restarts). Wireless deploy does not work from Linux on
   iOS 26; USB does.

4. **Bundle id.** `TrommiApp/xtool.yml` says `com.trommi.ios`. With a free Apple ID pick one that is yours alone (for
   example `com.<you>.trommi`); for TestFlight it must be the id of the app record (step 6).

5. **Run on the phone:**

   ```bash
   core/swift/build.sh ios
   cd ios/TrommiApp
   ulimit -n 65536
   xtool dev build                                   # xtool/TrommiApp.app
   ~/.local/share/omarchy-apple-dev/device-run.sh    # installs and starts it on the phone
   ```

   `xtool dev run` installs only; start the app by tapping its icon. Settings → **MLS proof** (the last row) runs the
   core's own check of itself on the phone and shows the result (`CoreProofScreen.swift`).

6. **TestFlight (paid Apple Developer account).** Once, in App Store Connect: Users and Access → Integrations → Team
   Keys → a key with the **Admin** role; download the `.p8` (only once possible), note **Key ID** and **Issuer ID**.
   Apps → + → New App with the bundle id of step 4 (the API cannot create apps). Then "TestFlight without CI" below.

## TestFlight without CI

`TrommiApp/AppStore/ship-local.sh [REF]` makes a TestFlight build on a Linux machine (REF defaults to `origin/main`,
fetched first; `--dry-run` stops at the signed, validated `.ipa`):

```bash
ios/TrommiApp/AppStore/ship-local.sh            # about 5 minutes to the upload, then App Store Connect's processing
```

- Built from a clean `git worktree` of REF in a temporary folder, never from the working tree; the script and `asc.py`
  next to it run from the checkout you start it in.
- Build number: the highest build App Store Connect has for the app, plus one (`asc.py next-build`); `BUILD_NUMBER`
  overrides it. Version: `MARKETING_VERSION` in `AppStore/project.yml`.
- Build: first **`core/swift/build.sh ios`** in that worktree (a clean worktree has no library; Rust's build folder is
  kept between runs in `CARGO_TARGET_DIR`, default `~/.cache/trommi-ship/target`), then
  `xtool dev build --configuration release`, then the app icon from `AppStore/Assets.xcassets` (the SDK's Linux
  `actool`), `ITSAppUsesNonExemptEncryption` (`ITS_NON_EXEMPT_ENCRYPTION`; "Export compliance" below), and
  omarchy-apple-dev's `tools/asc.py stamp` and `frameworks` (DT* keys from
  `~/.cache/xtool/darwin-iPhoneOS<version>.xtoolsdk.version.plist`, for the app and every `PlugIns/*.appex`).
- Signing: an Apple Distribution certificate and an App Store profile each for `com.trommi.ios`,
  `com.trommi.ios.share`, `.notify` and `.live` (with `APP_GROUPS=group.com.trommi.ios`), created through the API with
  the Admin key (remade on each run, so a capability change is picked up); the distribution key stays in the folder
  `ASC_IDENTITY_DIR` names (0600). Entitlements: the profile's plus `AppStore/TrommiApp.entitlements`
  (`aps-environment: production`, the App Group, `applinks:app.trommi.com` and `webcredentials:app.trommi.com`,
  communication notifications: left out
  with a warning while the portal has not granted them) and, for each extension, `AppStore/<name>.entitlements`
  (the App Group), each checked against its profile; `rcodesign`, the extensions first.
- Offline validation (`asc.py validate`), upload with the Build Uploads API (`asc.py upload`), then this folder's
  `asc.py wait`, `internal … Intern`, and `notes`: "Neu in Build N (sha):" and the subjects of the commits under
  `ios/` since the commit the previous build's What to Test names; `NOTES` overrides it.
- Needs: cargo (rustup), xtool, `swift-bin` with the darwin SDK, `rcodesign`, `~/pymobile3-venv` (omarchy-apple-dev's
  installer), and the Admin key; `ASC_KEY_ID` and `ASC_ISSUER_ID` are required, from the environment or the env file
  the script's header names.

## TestFlight from CI

`TrommiApp/AppStore/project.yml` describes the same app for Xcode (generated with XcodeGen, not checked in): an app
target `Trommi` that links the package's `TrommiApp` library, with the app icon, the production entitlements and the
Info.plist keys xtool adds; one extension target each. Linux builds do not use it.

**The Xcode path** (the repository's `.github/workflows/deploy_ios.yml` with `.github/scripts/ios_testflight.sh` on a
Mac runner, uploaded to TestFlight). The archive is signed ad hoc (`.github/scripts/ios_archive.sh`: identity "-", no
profile, no key, so no certificate is made per run); only the export signs, with the cloud-managed Apple
Distribution certificate through the App Store Connect key. The IPA's entitlements are then checked against the four
`.entitlements` files (`ios_entitlements.py`). What it needs from this folder:

- `core/swift/build.sh` on the runner before anything is built: `ios` for the archive (the package links
  `lib/ios/libtrommi_core_ffi.a` by a search path; a device archive needs no XCFramework), `host` for
  `swift test` in `tests/ios` on the Mac (it links `lib/macos`). The simulator library is chosen with
  `TROMMI_IOS_SIMULATOR=1`; one checkout builds for the device OR the simulator, not both at once.
- The package's sources build for macOS as well (ActivityKit and the Keychain parts are for iOS only), so the Mac
  job can run the same tests as Linux.
- Not verified from here: this text was written on Linux. Whether XcodeGen's project, the archive and the upload go
  through is what the first run on the runner shows; that the archive carries `PrivacyInfo.xcprivacy` at the bundle's
  root (`project.yml` lists it) is to be checked on its output.

`AppStore/asc.py` holds the App Store Connect API steps (the bundle ids with their
capabilities, the app record check, waiting for the processed build, the group and its tester, "What to Test").
Internal testers must be users of the team under the address they sign in with; when the API refuses the tester (409
"Tester(s) cannot be assigned"), add them once in App Store Connect → TestFlight → Intern → Testers → +. Cloud-managed
distribution signing refuses App Manager keys: the key needs the Admin role.

## Export compliance

The app uses standard algorithms only (MLS, HPKE, X25519, Ed25519, ChaCha20-Poly1305, AES-GCM, Argon2id in the Rust
core) and is not distributed in France, so it is exempt: `ITSAppUsesNonExemptEncryption` is `NO` in
`TrommiApp/Info.plist`, CI and the ship script write the same, and no export compliance code is written or looked up
(`IOS_NON_EXEMPT_ENCRYPTION=YES` with `asc.py export-code` stays for a later change). If France is added later, the
French encryption declaration is needed.

## Privacy manifest

`TrommiApp/Sources/TrommiApp/Resources/PrivacyInfo.xcprivacy`, copied to the root of the app bundle (`xtool.yml`
`resources:`; not a SwiftPM resource, which would land inside `TrommiApp_TrommiApp.bundle`).

- No tracking, no tracking domains.
- Collected: the account's e-mail address, linked to the person, for app functionality (the hub stores it to sign the
  person in). Everything else the app sends is encrypted so that the hub cannot read it.
- Required reason APIs: UserDefaults `CA92.1` (the app's own settings); file timestamps `C617.1` (files in the app's
  own containers: the Share inbox's sweep, the record store's sizes, and `fstat`, which the Rust standard library
  imports); system boot time `35F9.1` (elapsed time: the cold start in the log, the performance log).
- An extension that uses such an API carries its own manifest at its own root.

When the code starts or stops using one of these, change the manifest with it. To see what a built binary imports:
`llvm-nm -u xtool/TrommiApp.app/TrommiApp | grep -E '_(f?stat|lstat|statfs|mach_absolute_time)$'`.

## Account

`Account.swift` speaks the account routes of the hub (`spec/hub-api.md` "The account", `spec/v1.md` 8.8). Every key
and every sealed copy is the core's; the client names routes and moves bytes.

**How an account is named.** Every account has an account id, a UUID the hub mints; it is public and printed on the
Emergency Kit. An account may have an e-mail: a password needs one (its keys are derived from it), a passkey does
not. Log-in and recovery name the account in ONE field, `account`: an e-mail if it contains `@`, else the id.

**What the client sends.**

| Step | Request |
| --- | --- |
| Create account, password | `POST /v2/rooms` with `account: { email, password: { auth_key, sealed_copy, kdf }, kit: { auth_key, sealed_copy } }`, then `GET /v2/account` for the id |
| Create account, passkey | `POST /v2/account/passkey/challenge` (no token) → `{ challenge, account, user_handle }`, then `POST /v2/rooms` with `account: { email?, kit: { auth_key, sealed_copy }, passkey: { attestation_object, client_data_json, sealed_copy, transports } }` |
| Log in, password | `POST /v2/account/login` `{ account, auth_key }` (`account` is the e-mail: an id is refused on the device, `needs-email`) |
| Log in, passkey | `POST /v2/account/passkey/challenge`, then `POST /v2/account/passkey/login` `{ credential_id, authenticator_data, client_data_json, signature, user_handle? }` |
| Forgot password | `POST /v2/account/recover` `{ account, auth_key }` (e-mail or id), then, named by e-mail, `PUT /v2/account/password` `{ auth_key, sealed_copy, kdf, revision }` |
| New password, new kit | `PUT /v2/account/password`, `PUT /v2/account/kit` `{ auth_key, sealed_copy, revision }` |
| New recovery code (8.6) | `GET /v2/account`, then `POST /v2/rooms/{room}/recovery-code` `{ commit: { epoch, commit, group_info, sealed_key }, recovery_link, account: { kit: { auth_key, sealed_copy }, password: { sealed_copy } } }` (with a passkey: `passkey: { credential_id, sealed_copy }`), through the outbox |
| Every device lost (8.7) | `POST /v2/account/recover`, then as the recovery key: `POST /v2/rooms/{room}/recovery`, the room and `GET /v2/groups/{group}/chains/{sender}` of every device that goes, `POST …/recovery/{id}/commits` per part, `POST …/recovery/{id}/finish` `{ recovery_link, account: { kit, password: { auth_key, sealed_copy, kdf } } }` (an account without e-mail: `passkey`, a registration on `POST /v2/account/passkeys/challenge`); `DELETE …/recovery/{id}` if it fails or is not confirmed |
| An e-mail for an account without one | `PUT /v2/account/email` `{ email, kit: { auth_key, sealed_copy }, revision }` (`Room.setEmail`; no screen yet) |
| Add passkey | `POST /v2/account/passkeys/challenge`, `POST /v2/account/passkeys` |
| Log Out | `DELETE /v2/push`, `DELETE /v2/token`, then the device forgets the room |

The kit's keys are derived from the e-mail if the account has one, else from the account id (`kit_form` in the hub's
answers; never sent). So the kit of an account with an e-mail opens with the e-mail only, and the id in the field
opens the kit of an account without one. A refusal that names a wait (`retry_after` in the body or the `retry-after`
header) is shown with it: "Too many tries. Wait 40 seconds."

**What the client keeps.** Nothing of the account is stored on the device: the id, the e-mail and the kit's form are
asked of the hub when a screen needs them (`Room.accountStatus`). The password, the kit's words and the recovery
code live for the length of one call. The kit's words are shown once (`KitScreen.swift`). One exception, for as
long as it takes: a sign-in with the code that could not join every session group keeps the code in the app's
Keychain (`join-<folder>`) until the next sync has joined them, and deletes it then (`Room.finishCodeJoin`).

**Signing in on a new device** (8.4, `Room.joinWithRecoveryCode`) is two steps. Until the hub accepted the join of
the room group, a failure leaves nothing on the device. From then on the device is kept whatever happens:
`room.json` is written at once, the session groups are joined after it, and what is left of them (the hub did not
answer, the app was ended) is finished by the next sync. The room is checked in steps, never whole in one call
(`ServedByHub` in `LiveRecovery.swift`): the GroupInfos first (founding, anchor, the current one of the room group
and of every live session group), then the Commits of all those logs, page by page and only up to the epoch each
current GroupInfo names, handed to the core in slices of at most 256 Commits and 16 MiB in the hub's order across
the groups (`codeCheckStart`, `codeCheckSlice`, `joinRoomChecked`; a session: `sessionCheckStart`,
`sessionCheckSlice`, `joinSessionChecked`). A check lives in the core's memory only: a relaunch starts it again.

**A new recovery code** (8.6, `Room.replaceRecoveryCode`; Settings → Account → "New Recovery Code…", and offered
when a device is removed under Devices). The password opens the code in force; the core makes the new code and the
room Commit; the request carries a new Emergency Kit and the code sealed again under the password. The hub applies
all of it or nothing and removes every other way in (passkeys), which are added again. The new kit is shown in the
Emergency Kit group; the old one opens nothing any more. If the hub does not answer within 20 seconds the request
stays in the outbox, no kit is shown, and the person makes a new kit with the password afterwards.

**When every device is lost** (8.7, `Room.recoverAccount`; "New password" → "All my devices are lost", after a
confirmation that names it). The kit's words open the code; the new device opens a recovery at the hub, checks the
room in steps as a sign-in does (twice: once for the plan, `recoveryPlanStart`, and once for the device,
`codeCheckStart` before `recoverChecked`), reads the chains of the devices that go (handed to the core as ONE list rising by change number across
devices and groups, never chain after chain), and posts the joins, the removals and the new code; the hub publishes
all of it at once or nothing. The account gets a new kit and the new password; the kit's page comes next, as after
"Create account". An account without an e-mail needs a new passkey for this, so it waits for passkeys to be switched
on. Not covered: if the hub published and none of four tries got its answer, the device forgets itself although it
is in the room; the new password then logs in as on any new device, and Settings makes a new kit.

**The Emergency Kit** carries the twelve words, the account id as text, and a QR code with
`https://app.trommi.com/#k1.<hub address, base64url>.<account id, 32 hex digits>` (`kitQRText`): an address of the
web app that opens its recovery screen with hub and id filled in. It is in the fragment, so it reaches no server,
and it never holds the words. The app itself does not open such a link yet.

### Passkeys: on when the domain names the app

`Passkeys.available` is read from `https://app.trommi.com/.well-known/apple-app-site-association` at every start
(`Passkeys.probe`): passkeys are on once its `webcredentials` names this app ("<team id>.<bundle id>"), and the last
answer is kept for starts without a network. `Passkeys.forcedOn` is the one constant that switches them on whatever
the file says. On, Create account shows "Create with passkey" first with the e-mail marked optional and the password
as the second way, and Log in shows "Log in with passkey" first, with no field (the passkey names its account).

- An account made with a passkey alone has no e-mail and no password. Its account id comes with the tokenless
  `POST /v2/account/passkey/challenge` (`{ challenge, account, user_handle }`); the passkey's user id is the id's
  16 bytes, its prf output is asked for at registration, and the Emergency Kit is made under the id
  (`kitKeysFor(.id)`).
- Such an account uses a passkey where another asks for the password: the kit's page after a relaunch, Settings →
  Account → "Make with Passkey", "New Recovery Code…" and "Add Passkey" (`Passkeys.unlock`: one of the account's
  passkeys, used once here for its prf output).
- The entitlement `com.apple.developer.associated-domains` holds `webcredentials:app.trommi.com` in both
  `TrommiApp.entitlements` and `AppStore/TrommiApp.entitlements`.
- The hub takes `https://app.trommi.com` as a passkey origin (its default when `HUB_ORIGINS` is not set).
- Only a real phone tests the passkey sheet, the prf output and the association; the flows around them are tested
  on Linux with a stand-in authenticator (tests/ios AccountTests).

### For the website: the association file

`https://app.trommi.com/.well-known/apple-app-site-association` must be served as `application/json`, without a
redirect, with exactly this content. `<TEAM_ID>` is the Apple team's prefix and `<XTOOL_ID>` the prefix of the
development builds; both are in the file the web app serves today (`app/web/public/apple-app-site-association.json`)
and stay as they are there. The `applinks` part is today's, unchanged; `webcredentials` is new.

```json
{
  "applinks": {
    "details": [
      {
        "appIDs": ["<TEAM_ID>.com.trommi.ios", "<TEAM_ID>.XTL-<XTOOL_ID>.com.trommi.ios"],
        "components": [
          { "/": "/card/*", "comment": "a card, by its Nr. or id" },
          { "/": "/s/*", "comment": "a session, a card of it, its files" },
          { "/": "/settings", "comment": "Settings" },
          { "/": "/settings/*", "comment": "Settings: sessions, devices, account" }
        ]
      }
    ]
  },
  "webcredentials": {
    "apps": ["<TEAM_ID>.com.trommi.ios", "<TEAM_ID>.XTL-<XTOOL_ID>.com.trommi.ios"]
  }
}
```

`webcredentials` is what lets the app use passkeys (and saved passwords) of `app.trommi.com`. The Emergency Kit's
link (`/#k1.…`) is deliberately not among the `applinks` components: the app does not open it yet, so it stays with
the browser. Apple's servers fetch the file and keep it for about a day; a new install reads it from them.

## Keyboard and tab bar

As Messages, Mail and Notes do on iOS 26: no control of our own for the keyboard, the system's behaviour not fought.

- **All screens:** the keyboard goes away by dragging the content down (`.scrollDismissesKeyboard(.interactively)`)
  or by a tap in the content. The tab bar hides while the keyboard is up and comes back after.
- **Tab bar (iPhone):** our own glass pill at the bottom (`TabPill` in `Shell.swift`, a safe area inset), not the
  system tab bar: Chat · Desk · Note as pen drawings (about 26 pt, the line 2.4 pt). The page he is on has full ink on
  a raised lens, the others are a little muted; while the note is open the lens is on Note, closed it is back on the
  page under it. Shown on the two lists only (no pushed screen).
- **Top of the lists (iPhone):** no navigation bar. The place pill (the menu) floats at the top left, the Desk's duck
  and Blitz at the top right, each a glass capsule on the content (`topPills`, a `safeAreaBar`); no band or hairline,
  the content fades out under them and the status bar (`scrollEdgeEffectStyle(.soft)`, top and bottom).
- **Top of a chat and of a card's page:** the same row (`pushedPills`): a round glass back button, in a chat the
  session's name as a glass pill in the middle (drawing, crown, name, chevron: the menu of the other sessions), "⋯" at
  the right. No navigation bar there either; the swipe from the left edge still goes back (`PopGesture`).
- **A card's pictures, videos and files** (`CardGallery.swift`; the rules are `Gallery` in TrommiClient, under
  `swift test`, the same as the web's `cardMedia`): one stage of a fixed size per card (4:3 of the content width on the
  phone, 16:10 from 600 pt, at most 52 % / 70 % of the page's height), the same for every picture and video, so nothing
  moves when another one is shown or a picture comes late. A picture is fitted in and centred, never larger than itself;
  one more than 1.25 times as tall as wide stands at its width, its top first, and is scrolled inside the stage. A swipe
  turns to the next; a tap opens the picture large (`PicturesView`), and back from there the stage stands on the picture
  he was on. A video plays in place (a tap plays and pauses), the corner button opens it large. No line with the file's
  name: the words an agent gave a picture are a pill at the stage's lower left, the page behind it a chip at the lower
  right. Under the stage one strip: the pictures and videos small, then the other files as tiles (a tap: the file's
  sheet), and "2 / 5" in a place of its own at its end. Files only: the strip without a stage. While a picture is
  fetched and decrypted the stage says "Opening the picture…", and when it does not come why.
- **Chat:** no tab bar inside a chat (Messages, WhatsApp); it returns on the list. The composer (attach, send) is
  always at the bottom, a bottom bar (`safeAreaBar`): a tap in it brings the keyboard, it rides on the keyboard and
  reserves its height, so the last message scrolls clear of it. A tap in the conversation hides the keyboard. The Chat
  tab always opens on the list (a tap on it pops an open chat). A chat opens at the newest message and stays there
  while it is at the end: when a message comes in, a picture loads, the keyboard rises or the composer grows
  (`SessionScreen`: `onScrollGeometryChange`); only his own scrolling takes it away, and earlier pages load by
  themselves only after he has scrolled. What is attached lies inside the field above the text line, as in Messages
  (`PendingFiles`, the same in a card's "Ask … something"): a picture as itself (140 pt tall at most), a video as its
  first frame with a play sign, any other file as a small tile with its kind and name, each with a round × at its
  corner; the field grows and the chat's bottom inset with it.
- **Chat list:** a row as in Messages (`ChatRow` in `ChatList.swift`): the session's drawing in a round tinted field
  (crown and working dot as badges on it), its name and the time of what was said last, two lines at most of what was
  said last (`ChatTeaser` in `TrommiClient`: his own words with "You: ", a question's title, else the task), and at
  the right only what needs him (count of open questions, the raised hand, a dot for unread). A main's helpers stay
  folded, as in the web's sidebar (`UnitStack` in `TrommiClient/Desk.swift`: the stopped ones first and marked): four
  small drawings and "+N" at the end of the teaser's line; a tap there unfolds them as smaller set-in rows; which are
  open is kept on the phone. The main's row counts its helpers in. Desks are quiet section heads.
- **Note:** a full page of yellow paper over the list he came from (`NotePanel` in `Shell.swift`), edge to edge, up
  under the status bar and on behind the tab pill, which stays and is lit on Note. From the top: a handle, the
  words, the pictures (each with a thin outline), and one row just above the tab pill: paperclip and bin at the left,
  "To: …" as a glass pill directly left of the envelope (a long name is cut in its middle); send is the web's envelope
  with the crown as its seal (`NoteEnvelope`), half faded while there is nothing to send. Sending, throwing away
  and every other way out put the keyboard away. A tap on Note or another tab, or a drag down on the handle,
  leaves it; the draft stays on the note. With the keyboard up the tab pill hides and the row sits on the keyboard:
  the text area shrinks and scrolls (the pictures and the row never give way), and what the keyboard's own frame
  still covers of the page (`UIResponder.keyboardWillChangeFrameNotification`; the content's keyboard inset ended a
  little below the keyboard's top edge) is kept free at its bottom. On the iPad the note is a sheet from the Desk's
  corner button.
- **Desk:** one text field, the desk's goals under the greeting (`DeskGoals.swift`): a checklist of at most 20 lines
  of 200 characters (`GOALS_LINES`, `cleanGoals` in `TrommiClient/Desk.swift`); the first five are shown, more are
  folded behind "+N more" (`goalsFold`; open or not kept per desk), empty a faint "Goals…", nothing on All desks. A tap
  writes in place; the keyboard going away keeps it, an emptied field clears it. Otherwise the keyboard only appears
  in sheets (New Desk, Rename), which the system handles.
- **Settings:** forms with the system's keyboard handling; a drag dismisses it.

## Push (APNs)

`Sources/TrommiApp/Push.swift`: on the first start with a room the app asks for notifications, registers with Apple
and hands its device token and a push key of its own to the hub. Apple sees a fixed text ("A new question."); the
hub's message rides along sealed under that key. A push in the foreground shows as a banner; arriving, it refreshes
the board; a tap refreshes the board and follows nothing the push carries (a path in it would be the hub's word,
and could come from a push the extension never saw).

**The notification** (`Sources/TrommiNotify`, the Notification Service Extension; the pushes carry
`mutable-content: 1`). The extension opens the hub's sealed message with the push key and shows the fixed text,
threaded by room. It shows no title of a card: it holds no content key ("Who owns the state", "Not there yet").
Anything that does not open leaves the fixed text as it came. An extension has 24 MB of memory: it never opens the
device and never follows a group.

**Live Activity** (`Sources/TrommiLive`, a WidgetKit extension; `LiveActivities.swift`): "2 agents working · 3
questions waiting" on the lock screen and in the Dynamic Island, with the drawing of the crowned session of the desk
on screen. The hub starts it with a push-to-start push when agents begin to work, updates it with the two counts, and
ends it when none works. The app only hands over tokens: its push-to-start token to every room's hub with a random
tag per room, and each running activity's token to the hub whose tag its attributes carry; iOS wakes the app in the
background for that. Push off (Settings · Devices) removes them and ends what runs; signing out ends it too. Past the
push's stale date the widget dims the counts and says "Not up to date". `NSSupportsLiveActivities` is in `Info.plist`.

**Universal links** (`Links.swift`): `https://app.trommi.com/card/<Nr. or id>`, `/s/<session>`,
`/s/<session>/card/<ref>`, `/settings` and `/settings/<sessions|devices|account|theme>` open in the app when it is
installed (`com.apple.developer.associated-domains: applinks:app.trommi.com`; the web app serves
`/.well-known/apple-app-site-association` for `NL9YA3V25N.com.trommi.ios` and `NL9YA3V25N.XTL-70CB783D.com.trommi.ios`).
A long press offers "Open in Safari" as usual. A link that names a card the board does not have yet waits up to 20 s.

- `TrommiApp.entitlements` (`entitlementsPath` in `xtool.yml`) says `aps-environment: development` (the TestFlight
  builds use `AppStore/TrommiApp.entitlements`, `production`). xtool reads it from the signed binary and turns on Push
  Notifications for the App ID (`XTL-70CB783D.com.trommi.ios` on the paid team) before it fetches the development
  profile; the app then gets sandbox tokens and says `environment: sandbox` (read from `embedded.mobileprovision`).
- The hub sends only when it has the team's APNs key; its topic list must name the installed bundle id
  (`XTL-70CB783D.com.trommi.ios` for xtool builds). Without it the hub refuses the registration, and the app tries
  again the next time it comes to the front.
- App ids (registered through the API with the Admin key): `com.trommi.ios` (Push Notifications, App Groups,
  Associated Domains), `com.trommi.ios.notify` and `com.trommi.ios.live` (App Groups), and the same with
  `XTL-70CB783D.` for xtool's development builds.
- **Once, in the developer portal** (the API cannot): Identifiers → `com.trommi.ios` → Capabilities → **Communication
  Notifications** → Save; and for each of `com.trommi.ios.notify`, `com.trommi.ios.live`,
  `XTL-70CB783D.com.trommi.ios.notify`, `XTL-70CB783D.com.trommi.ios.live`: App Groups → Configure → tick
  `group.com.trommi.ios` → Save (as for the Share Extension below).

## Share Extension

Trommi in the iOS share sheet (`Sources/TrommiShare`, xtool.yml `extensions:`, AppStore/project.yml target
`TrommiShareExtension`). Its sheet is the note itself, compact, on the note's yellow paper: what was shared as
thumbnails (a cross takes one out), a text field, the chip **To: <desk> · <crowned session> ▾** (the desk picked last
in the sheet, else the one the app's note went to last) and two ways: **Send** (to that crown as a note) and **Keep in
Note** (into the one note; nothing is sent). After Send it says "Wird gesendet, sobald Trommi öffnet", or "Geht an …"
when the running app took the share at once.

- The extension holds no room, no device key, no board: it links only `ShareInbox`, well inside an extension's memory.
  It seals what was shared into the App Group container `group.com.trommi.ios` (`items/<id>-<n>.sealed` first, the
  manifest `requests/<id>.sealed` last) and rings the app (Darwin notification `com.trommi.ios.share-inbox`). Pictures
  are made JPEG of at most 2400 px through ImageIO thumbnails (never decoded whole), other files are taken up to
  32 MB, at most 20 things per share.
- Every file is AES-256-GCM (CryptoKit) under the inbox key, 32 random bytes in the Keychain with the App Group as
  access group (`kSecAttrAccessibleAfterFirstUnlockThisDeviceOnly`; the app makes it, the extension only reads it).
  The additional data binds each file to its role and name. Nothing lies in plaintext outside the app.
- The app (`ShareImport.swift`) writes a sealed snapshot of the desks and their crowned sessions (names, ids, hues,
  the drawings as small PNGs: the extension has no pen) on each change of the board, and imports on coming to the
  front (after the catch-up) and at once on the ring. A send is taken out of the inbox before it is sealed, so it is
  never repeated; if it fails, or the session is gone, what was shared goes into the note instead.
- Not sent from the extension: "Who owns the state".
- The App Group id per build: `group.com.trommi.ios` in the entitlements. xtool signed in with the API key keeps it
  as written; signed in with an Apple ID it registers `group.XTL-<team>.com.trommi.ios` and rewrites the entitlement.
  The code tries both (`ShareGroup`).
- **Once, in the developer portal** (the API can turn the App Groups capability on, but cannot create a group or
  assign one): Certificates, Identifiers & Profiles → Identifiers → App Groups → + → `group.com.trommi.ios`. Then for
  each of `XTL-70CB783D.com.trommi.ios`, `XTL-70CB783D.com.trommi.ios.share` (xtool's development ids; xtool registers
  the `.share` one on its first `xtool dev run`) and `com.trommi.ios`, `com.trommi.ios.share` (TestFlight; `asc.py
  prepare` registers them): App Groups → Configure → tick the group → Save. Until then an install fails with an
  entitlements error, because the profile does not carry the group the app asks for.

## Drop onto the app

Anything dropped onto the app goes onto the note (`NoteDrop.swift`, `.onDrop` on the shell): pictures, videos and other
files become its attachments, links and text its words. While something hovers, the app shows a hand-drawn dashed
outline and one line of glass ("Drop onto the note"); on the drop the note opens (the yellow page on the iPhone, the
corner sheet on the iPad's Desk). The note on screen takes the drop into what is being written; without one open it
goes onto the stored note, as a share does (`ShareImport.addToNote`).

- What a thing becomes is `ShareIntake` (`ShareInbox`, under `swift test`), the same rules as the Share Extension: a
  picture → JPEG of at most 2400 px; a link (not a file URL) → its address as a line of text; any other data or a file
  URL → a file with its name and type; plain text → words, a lone http(s) address as a link.
- The share sheet's limits: 20 things per drop, 32 MB per file, 20 000 characters of text. What is left out is named
  in a toast.
- Not in the demo and not signed out (the drop is refused). A text field under the finger takes dropped text itself,
  as every iOS text field does. Sheets other than the note are not drop targets.

## The demo and the drawings

`DemoMode.swift` shows the web demo's room from `Resources/Demo`, a link to the repository's `demo/data/`
(`demo/README.md`), which SwiftPM copies into the app in every build. The web's drawings come from
`Resources/pen.json`; its fonts are bundled as static TTF (OFL, `Resources/Fonts/LICENSES.txt`). Liquid Glass for the
chrome; the minimum is iOS 27.

## Not there yet

`TrommiCoreLive` binds every call of `Core.swift` to the core (`core/swift`, v2-bindings 33a943d). Its header
(`LiveCore.swift`) lists what is bound and what of the binding is left out. What the app still cannot do:

- **The notification title.** A content key never leaves the core, and the binding opens an envelope only on the
  device that holds the group (`receiveEnvelope`), whose store the app owns. The Notification Service Extension
  therefore opens the push itself (room, change, urgency) and shows the fixed text.
- **Content from before a device came by link** is read once the group's past is learned (`RoomPast.swift`: the
  founding GroupInfo and the Commits of the group's log, read page by page, go to the core in slices of at most
  256 Commits and 16 MiB (`learnStart`, `learnSlice`, `learnFinish`; `PastWalk.swift`), then the changes are read
  back in the hub's order; what is left to do is noted in `room.json`, so an interrupted run goes on at the next sync). The old
  items open when the inviting device's key handover arrived; until then they take their places without bodies.
  Not done: the read back fetches the room's changes from the start again (once per learned past), and the board
  is rebuilt from them rather than patched.
- **Replacing the recovery code** (8.6) and **recovery when every device is lost** (8.7) have their callers and
  screens ("Account"). Both are tested with the real core against `PocketHub` behind the hub's routes
  (`PocketRoutes.swift`), which checks nothing; neither has met a real hub. With a passkey as the way in, 8.6 has
  the engine's call (`WayIn.passkey`) and no screen.
- **Against a real hub** the engine was last run before this binding: `RealHubTests` (founding, signing in with
  the password, a Commit, the whole recovery) are skipped without `TROMMI_HUB_BIN`, and joining by link through
  `Room` has no test against a hub yet. Without a hub, the core's side of these paths is tested on the real core
  (`PocketHub` keeps the hub's order), the engine's on a core that seals nothing (`FakeCore`), and the engine with
  the real core on `PocketHub` behind the hub's routes (`RoomPastTests`, `RoomRecoveryTests`).
- The Scribble Board still merges with the reducer of the Swift model (`Canvas.swift`); the core's reducer and its
  check of a loaded board (`boardReduce`, `boardLoad`) are bound, and nothing calls them yet.
- Passkeys switch on by themselves once the web app's association file names the app; no passkey ceremony has run on a phone yet ("Account").
- The first archive on the Mac runner ("TestFlight from CI") is unproven; licence notices for the Rust crates inside the app bundle
  (`THIRD-PARTY.md` lists them); the memory of the Notification Service Extension with the core linked, measured on
  a phone.
