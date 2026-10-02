# Trommi for iOS

Native app (SwiftUI, iOS 17+) for the Trommi server: an inbox with every open question of every session, sessions with their conversation, dictation and read-aloud. No third-party dependencies. The app's language is English.

## What it does

- **Inbox.** Questions grouped by sender, starred (VIP) sessions first. Every row has the same height and two square tiles at its trailing edge: thumb down and thumb up for a yes/no question (no on the left, yes on the right; a bare "Yes"/"No" or "Allow"/"Deny" shows only the thumbs), otherwise "Later" and "Choose". "Later" moves a question into one "Later" group at the very bottom; the list is kept on the device. "Choose" opens the card. The option the agent recommends is circled by hand. Urgency shows as "Blocking" or "Urgent"; a normal question shows nothing, one that can wait a small hourglass.
- **A question as a card.** One tap answers; two options are a pair of tiles, more are a stack; where several may be right the options are switches and "Send" sends them. A note can go with the answer. Instead of answering you can ask back: the question stays open and the agent's reply stands under it. "Go through them" walks all open questions one after the other.
- **Sessions.** Each session has a hand-scribbled mark generated from its id, the same one as on the web. Sessions laid together are one row; disconnected ones stand below; archived ones last. A session opens as one conversation in which its open questions stand as the same rows as in the inbox, with a "Questions only" filter (open ones, then the answered) and a "Files" list. Agent messages can carry collapsed details. Links in messages, including published pages (`/a/<id>#key`), open in an in-app browser.
- **About a session** (the info button): model, machine, folder, program, status lines; rename it, pick another mark, mark it VIP, lay it together with another session, archive it when it is disconnected.

## Generate the project and run it

On a Mac with Xcode 16 or newer:

```bash
cd client/ios
brew install xcodegen && xcodegen     # writes Trommi.xcodeproj from project.yml
open Trommi.xcodeproj                  # scheme "Trommi", pick a simulator, Cmd-R
```

For a real device enter your own team under "Signing & Capabilities". The project file is not checked in; run `xcodegen` again after every change to `project.yml` and whenever files are added.

On first launch paste the link from the server's `data/url.txt` (the line with the address in the network, not `localhost`), or scan it as a QR code, for example from `qrencode -t ansiutf8 "$(tail -1 data/url.txt)"`. "Look at the demo" shows the app without a server.

## Test

```bash
swift test                                   # Core, Net and the app model; also runs on Linux
xcodebuild test -project Trommi.xcodeproj -scheme Trommi \
  -destination 'platform=iOS Simulator,name=iPhone 17'   # unit and UI tests
```

Against a real server (the test changes its board, so demo data only), from the repository root:

```bash
dev/serve.sh 8851 120 &
cd client/ios && TROMMI_TEST_LINK='http://127.0.0.1:8851/?t=demo' swift test --filter LiveServerTests
```

The UI tests start the app with `-trommiStub 1`. A board in memory (`StubBoardClient`) then stands in for the server, fed with `Trommi/Resources/demo-state.json`. The same file is `TrommiTests/Fixtures/demo-state.json`; both are written by `node tools/demo-state.mjs`. `TrommiTests/Fixtures/doodles.json` is what the web's mark generator draws for a few seeds, written by `node tools/doodle-fixtures.mjs` from `client/web/js/ui.js`; CI checks that both generators still write what is checked in. `TrommiTests/Fixtures/state.json` is the unchanged output of `node dev/demo-state.mjs`.

How this runs automatically, and how the app gets onto a phone, is in [TESTING.md](TESTING.md).

## Layout

- `Trommi/Core/`: everything that needs neither SwiftUI nor UIKit. Models and tolerant decoding (`Models.swift`), the stack and local changes that mirror the server (`BoardLogic.swift`), rows, tiles and urgency (`Questions.swift`), the inbox and the Later list (`Inbox.swift`), sessions, groups and badges (`Sessions.swift`), the conversation, its filters and files (`Conversation.swift`), the card view's walk (`FocusWalk.swift`), the scribbled marks (`Doodle.swift`), and `AppModel`, the one object the views hang on. What only a device can do (Keychain, haptics, preferences, the app bundle) comes into `AppModel` through `AppHooks`.
- `Trommi/Net/`: `BoardClient` with the real connection (`LiveBoardClient`) and the board in memory (`StubBoardClient`). Foundation only.
- `Trommi/App/`: the entry point, `Runtime` (fills `AppHooks`, the in-app browser), Keychain, colours, pictures and sound.
- `Trommi/Views/`: the screens. They draw what Core computed and hold no rules of their own.
- `Package.swift`: offers `Core` and `Net` as the SwiftPM package `TrommiCore`, so they build and are tested without Xcode.
- `tools/`: the two fixture generators and the scripts CI uses to keep build logs readable.

## What is checked and what is not

Checked, on Linux with Swift 6.1.2:

- `Core` and `Net` compile; 157 tests pass (`swift test`), among them the rules for rows and tiles, the Later list, label, icon, archive and groups, the recommended option, several answers, asking back, the app model against the board in memory, and the marks stroke for stroke against the web's generator.
- 8 of these run `LiveBoardClient` against a real `server.mjs` with demo data: login, the cookie named after the port (`board_8851`) and the plain name, `Origin`, the event stream, answering, taking back, messages, asking back, `POST /session` (label, icon, group, archive refused while connected), `POST /star`, attachments, a wrong token. That ran with Linux's URLSession, not with iOS's.

Not checked, because there is no Xcode here:

- Everything under `Trommi/App/` and `Trommi/Views/` and the UI tests were never compiled, only checked for syntax (`swiftc -parse`). Expect compile errors on the first build; [BUILD-RISKS.md](BUILD-RISKS.md) lists the likely ones with a fallback each.
- `project.yml` and the workflows were never executed.
- Nobody has seen or heard the app: looks, handling, VoiceOver, Dynamic Type, camera, microphone, video, read-aloud.

## Known limits

- `Info.plist` allows plain HTTP to any address, because the server runs without TLS on the local network. The token then travels in the clear; over the internet use HTTPS or a VPN.
- Published pages (`/a/<id>#key`) are decrypted by the web viewer with WebCrypto, which only works over HTTPS or localhost. From a phone that means the board must be reached over HTTPS (for example `tailscale serve`).
- The server sends nothing on `/events` while nothing changes. A connection that died silently is only noticed when the app comes back to the foreground (it then reconnects). There are no updates in the background and no notifications.
- The row follows the specification this app was built to: "Later" and "Choose" as two tiles. The web client has since moved "Later" to a small arrow on every row and lets "Choose" unfold the options inside the list; the app does not do that yet.
- Laying sessions together is done in the session's info sheet, not by dragging rows onto each other. A group shows one member's conversation at a time, with a picker.
- Missing from the web client: the scribble canvas, starting sessions, the admin page, the help page, keyboard shortcuts.
