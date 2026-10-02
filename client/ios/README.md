# Trommi for iOS

Native app (SwiftUI, iOS 17+) for the Trommi server: an inbox with every open question of every session, sessions with their conversation, dictation and read-aloud. No third-party dependencies. The app's language is English.

The catch-up with the web client was parked half way on 2 October 2026: the part without UI knows the current server, the screens are mostly those of the round before. [STATUS.md](STATUS.md) lists what is taken over, what is half done and what is not started.

## What it does

- **Inbox.** Questions grouped by sender, starred (VIP) sessions first. Every row has the same height and two square tiles at its trailing edge: thumb down and thumb up for a yes/no question (no on the left, yes on the right; a bare "Yes"/"No" or "Allow"/"Deny" shows only the thumbs), otherwise "Later" and "Choose". "Later" moves a question into one "Later" group at the very bottom; the list is kept on the device. "Choose" opens the card. After an answer or a "Later" a note says what happened and offers "Back" for a few seconds. The option the agent recommends is circled by hand. Urgency shows as "Blocking" or "Urgent"; a normal question shows nothing, one that can wait a small hourglass.
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
swift test                                   # Core, Net, the app model and dictation; also runs on Linux
xcodebuild test -project Trommi.xcodeproj -scheme Trommi \
  -destination 'platform=iOS Simulator,name=iPhone 17'   # unit and UI tests
```

Against a real server (the test changes its board, so demo data only), from the repository root:

```bash
dev/serve.sh 8851 120 &
client/ios/tools/live-seed.sh 8851           # cards only an agent can make: sections, a revised one, a merged one
cd client/ios && TROMMI_TEST_LINK='http://127.0.0.1:8851/?t=demo' swift test --filter LiveServerTests
```

The UI tests start the app with `-trommiStub 1`. A board in memory (`StubBoardClient`) then stands in for the server, fed with `Trommi/Resources/demo-state.json`. The same file is `TrommiTests/Fixtures/demo-state.json`; both are written by `node tools/demo-state.mjs`. `TrommiTests/Fixtures/doodles.json` is what the web's mark generator draws for a few seeds, written by `node tools/doodle-fixtures.mjs` from `client/web/js/ui.js`. `Trommi/Core/DoodleTables.swift` holds the points of the named drawings and icons, written by `node tools/doodle-tables.mjs` from the same file. CI checks that all three generators still write what is checked in. `TrommiTests/Fixtures/state.json` is the unchanged output of `node dev/demo-state.mjs`.

How this runs automatically, and how the app gets onto a phone, is in [TESTING.md](TESTING.md).

## Layout

- `Trommi/Core/`: everything that needs neither SwiftUI nor UIKit. Models and tolerant decoding (`Models.swift`), the stack and local changes that mirror the server (`BoardLogic.swift`), rows, tiles and urgency (`Questions.swift`), the inbox, the Later list and the piles (`Inbox.swift`), sessions, groups and badges (`Sessions.swift`), the conversation, its filters and files (`Conversation.swift`), the card view's walk and its rail (`FocusWalk.swift`), what is ticked but not sent (`CardDraft.swift`), links to a question (`DeepLink.swift`), live dictation without the microphone (`Dictation.swift`), the scribbled marks (`Doodle.swift`, `DoodleTables.swift`), and `AppModel`, the one object the views hang on. What only a device can do (Keychain, haptics, preferences, the app bundle) comes into `AppModel` through `AppHooks`.
- `Trommi/Net/`: `BoardClient` with the real connection (`LiveBoardClient`) and the board in memory (`StubBoardClient`). Foundation only.
- `Trommi/App/`: the entry point, `Runtime` (fills `AppHooks`, the in-app browser), Keychain, colours, pictures and sound.
- `Trommi/Views/`: the screens. They draw what Core computed and hold no rules of their own.
- `Package.swift`: offers `Core` and `Net` as the SwiftPM package `TrommiCore`, so they build and are tested without Xcode.
- `tools/`: the fixture generators, the seed for the live tests (`live-seed.sh`) and the scripts CI uses to keep build logs readable.

## What is checked and what is not

Checked, on Linux with Swift 6.1.2:

- `Core` and `Net` compile; 205 tests pass (`swift test`), among them the rules for rows and tiles, the Later list and the piles, label, icon, archive and groups, the recommended option, several answers, notes on options, drafts, a revised question, sections, links by number, asking back, the app model against the board in memory, a whole live dictation against the board in memory, and the marks and the 40 named drawings stroke for stroke against the web's generator.
- 13 of these run `LiveBoardClient` against a real `server.mjs` with demo data: login, the cookie named after the port (`board_8851`) and the plain name, `Origin`, the event stream, answering, taking back, messages, asking back, `POST /session` (label, icon, group, archive refused while connected), `POST /star`, attachments, a wrong token, and since round three: notes per option, `POST /draft`, the 409 for an answer to an older wording, `sections`, `merged_from`, the refusal of `POST /speech/live` on a board without a key, `/pad`. That ran with Linux's URLSession, not with iOS's.
- Live dictation with a real key was not tested from here: the demo board has none, so only the refusal and the routes' error answers are covered against the server.

Not checked, because there is no Xcode here:

- Everything under `Trommi/App/` and `Trommi/Views/` and the UI tests were never compiled, only checked for syntax (`swiftc -parse`). Expect compile errors on the first build; [BUILD-RISKS.md](BUILD-RISKS.md) lists the likely ones with a fallback each.
- `project.yml` and the workflows were never executed.
- Nobody has seen or heard the app: looks, handling, VoiceOver, Dynamic Type, camera, microphone, video, read-aloud.

## Known limits

- `Info.plist` allows plain HTTP to any address, because the server runs without TLS on the local network. The token then travels in the clear; over the internet use HTTPS or a VPN.
- Published pages (`/a/<id>#key`) are decrypted by the web viewer with WebCrypto, which only works over HTTPS or localhost. From a phone that means the board must be reached over HTTPS (for example `tailscale serve`).
- The server sends nothing on `/events` while nothing changes. A connection that died silently is only noticed when the app comes back to the foreground (it then reconnects). There are no updates in the background and no notifications.
- The screens are behind the web client: rows with "Later" and "Choose" as two tiles, no piles at the foot of the inbox, the card page without the conversation composer, Explain and Back to agent, no notes per option, no rail. The rules for all of it are in Core and tested; see [STATUS.md](STATUS.md).
- Dictation records a file and sends it when you stop. Live dictation (words appear while you speak) is ready up to the microphone, which is not wired.
- Planned, not built: an own Tinfoil key in the app's Keychain, to talk to Tinfoil directly instead of through the hub.
- The pad of the web (`/pad`) has no entry in the app yet; it is meant to open in the in-app browser first and become native later.
- Laying sessions together is done in the session's info sheet, not by dragging rows onto each other. A group shows one member's conversation at a time, with a picker.
- Missing from the web client: the scribble canvas, starting sessions, the admin page, the help page, keyboard shortcuts.
