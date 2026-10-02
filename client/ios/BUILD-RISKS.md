# Build risks

The app has never been built on a Mac. This list says, per construct, where the first real build is most likely to stop and what to change if it does. Line numbers are those of 2 October 2026.

## What is certain and what is not

| Part | State |
| - | - |
| `Trommi/Core`, `Trommi/Net` (models, rules, `AppModel`, the server connection) | Compiled with Swift 6.1.2 on Linux in Swift 5 language mode, 157 tests pass, 8 of them against a live `server.mjs` |
| `TrommiTests` | Compiled and run on Linux as above; in Xcode they compile against the app module instead of the package |
| `Trommi/App`, `Trommi/Views` (21 files, about 3,450 lines) | Parsed only (`swiftc -parse`), never type-checked: SwiftUI, UIKit and AVFoundation do not exist on Linux |
| `TrommiUITests` | Parsed only |
| `project.yml`, the asset catalog, both workflows | Never executed |

Six pure-Swift patterns the views rely on were type-checked on Linux in a stand-in file, because they need no SwiftUI: an `@Observable` main-actor class with a `nonisolated init` held as a property default; mutating calls through an optional value in a property wrapper (`walk?.sync(...)`); `_index = State(initialValue:)` style initialisers; the hooks with `@MainActor` closure types filled in from a main-actor enum; comparing an optional string with a literal. They compile. That check says nothing about SwiftUI itself.

## Assumptions about the toolchain

- **Xcode 16 or newer** (the workflows use the runner image `macos-26`, Xcode 26). The views call the main-actor `AppModel` from plain methods of `View` structs, for example `QuestionRow.answer`, `Composer.send`, `FocusView.step`. That needs the SDK in which `View` itself is `@MainActor` (iOS 18 SDK, Xcode 16). With Xcode 15 these calls are errors. Fallback: put `@MainActor` on the view struct that the error names.
- **Swift 5 language mode** with minimal concurrency checking (`SWIFT_VERSION: "5.0"`, `SWIFT_STRICT_CONCURRENCY: minimal` in `project.yml`), the same mode `Package.swift` builds Core in. In Swift 6 mode many `Sendable` diagnostics would become errors.
- **Deployment target iOS 17**: `@Observable`, `.onChange(of:) { old, new in }`, `.defaultScrollAnchor`, `AVAudioApplication.requestRecordPermission()`.

## Constructs that may not compile

Ordered by how likely they are to fail. "Fallback" is the smallest change that keeps the feature.

| # | File and line | Construct | Doubt | Fallback |
| - | - | - | - | - |
| 1 | `Views/OnboardingView.swift:159-197` | `DataScannerViewController` (VisionKit) wrapped as `UIViewControllerRepresentable`, with a `@MainActor` coordinator as `DataScannerViewControllerDelegate` | The initialiser's argument list and the delegate's isolation are written from memory | Delete `LinkScanner`, `ScannerSheet` and the "Scan QR code" button (lines 47-51, 78-84); pasting the link still works |
| 2 | `App/Media.swift:137` | `await AVAudioApplication.requestRecordPermission()` | The async form of the iOS 17 API | `await withCheckedContinuation { c in AVAudioApplication.requestRecordPermission { c.resume(returning: $0) } }` |
| 3 | `App/Media.swift:59, 76-79, 101-107` | `PlaybackEnd`, an `NSObject` delegate whose closure starts `Task { @MainActor in self?.stop() }` | Capturing the weak main-actor `self` in a non-isolated closure | Mark `PlaybackEnd` `@MainActor` and its delegate method `nonisolated`, hopping with `Task { @MainActor in ... }` |
| 4 | `Views/MarkdownView.swift:58-63` | `part.swiftUI.font`, `part.swiftUI.backgroundColor` on `AttributedString` | The attribute scope spelling | Drop the three lines: bold and code then look like plain text |
| 5 | `Views/MarkdownView.swift:23-26` | `.environment(\.openURL, OpenURLAction { url in model.open(...); return .handled })` | Calling the main-actor model from the handler | Wrap the call: `Task { @MainActor in model.open(link: url.absoluteString) }` |
| 6 | `Views/AttachmentViews.swift:199-244` | `UIViewRepresentable` around `UIScrollView` with a `@MainActor` coordinator and `#selector(Coordinator.doubleTap(_:))` | Isolation of the nested coordinator class | Remove `@MainActor` from `Coordinator` (line 227) |
| 7 | `Views/AttachmentViews.swift:299` | `.onReceive(NotificationCenter.default.publisher(for: .AVPlayerItemDidPlayToEndTime))` | Needs Combine; `import Combine` is there | Remove the modifier: the play button then stays on "pause" at the end of an audio file |
| 8 | `Views/AttachmentViews.swift:349` | `.quickLookPreview($preview)` | Needs `import QuickLook`, which is there | Replace with `ShareLink(item: url)` shown when `preview` is set |
| 9 | `App/TrommiApp.swift:10-14` | `init()` that fills two `@State` properties with `State(initialValue:)`, the second from the first | `App.init` must be main-actor isolated for `Media()` and `Runtime.makeModel`; the struct is marked `@MainActor` | Make `media` and `model` `static let` on `Runtime` and read them in the property initialisers |
| 10 | `App/Runtime.swift:58-68` | Closures assigned to `@MainActor` closure-typed properties of `AppHooks`, capturing `UserDefaults` and `Media` | Type-checked on Linux with stand-in types; `Keychain` and `Haptics` are Apple-only | Add `@MainActor in` at the start of the closure the error names |
| 11 | `Views/FocusView.swift:24-25, 76, 88` | `walk?.sync(...)`, `walk?.noteUndone(...)`, `walk?.go(...)`: mutating calls through an optional `@State` | Type-checked on Linux with a stand-in property wrapper | `if var w = walk { w.sync(...); walk = w }`, as `stackChanged` (line 92) already does |
| 12 | `Views/FocusView.swift:40-59`, `Views/AttachmentViews.swift:147-165` | `ToolbarItemGroup(placement: .bottomBar)` with an `if` inside | Conditional content in a toolbar group | Move the two buttons into `.safeAreaInset(edge: .bottom)` |
| 13 | `Views/QuestionRow.swift:39` | `.dynamicTypeSize(...DynamicTypeSize.xxLarge)` | Range spelling | Delete the line (very large type then clips in the fixed-height row) |
| 14 | `Views/DoodleViews.swift:83-89` | `ForEach(Array(pair.members.enumerated()), id: \.offset) { index, place in let side = ...` | A `let` and two closure parameters inside `ForEach` | Move the body into a helper `func member(_ index: Int, _ place: Doodle.Placement) -> some View` |
| 15 | `Views/CardPage.swift:160` | `.accessibilityValue(several ? (on ? "chosen" : "not chosen") : "")` | Overload choice between `Text` and `String` | `.accessibilityValue(Text(...))` |
| 16 | `Views/ConversationScreen.swift:123-125` | `TimelineView(.periodic(from: Date(), by: 30))` around the whole log | Compiles in `Components.swift:20` in the same form, so this is about behaviour: the log is rebuilt every 30 seconds | Pass `Date()` once and keep the `TimelineView` only round "Agent is working" |
| 17 | `Views/SessionInfoSheet.swift:71-75` | `Section { ... } footer: { if !agent.online { Text(...) } }` | A conditional footer | Always show the text |
| 18 | `Views/MessageViews.swift:43-64` | `@ViewBuilder fileprivate func` in an extension that reads the struct's `private` environment property | Same-file access to `private` | Move the function into the struct |
| 19 | `App/Runtime.swift:36-47` | `Browser.open`: finds the key window through `UIApplication.shared.connectedScenes`, walks `presentedViewController` to the top and presents an `SFSafariViewController` | Plain UIKit, written from memory | `UIApplication.shared.open(url)`: the link then opens in Safari instead of inside the app |
| 20 | `Views/RootView.swift:9-13` | `.onChange(of: model.browser?.id)` on an optional `UUID` | Optional as the observed value | Observe `model.browser != nil` instead |
| 21 | `Core/AppModel.swift` in the app target | `import Observation`, `@Observable` on a `@MainActor` class, `@ObservationIgnored private let hooks` | Compiles on Linux; Apple's SDK may differ in macro details | None expected to be needed |
| 22 | `Net/LiveBoardClient.swift` | Delegate-based `URLSession` calls, `HTTPURLResponse.value(forHTTPHeaderField:)` | Compiled and tested only with Linux Foundation | The `core` step on macOS (`swift test`) fails before Xcode is even started, with the exact line |

## Things that compile but may misbehave

Nobody has seen the app. These are the places to look at first in the screenshots of the UI tests.

- **Fixed row height** (`Theme.rowHeight`, 96 points, `QuestionRow.swift:36`): a two-line title plus one line of text may be cut on small phones or with large type. The tiles are 64 points square.
- **The hand-drawn circle** round the recommended option (`AdviceCircle`, `DoodleViews.swift:118`): drawn outside the tile with a negative padding; neighbouring tiles may overlap it.
- **Marks** (`DoodleView`): the strokes are the web's, tested stroke for stroke; pen width and size are guesses.
- **Focus view closing on an answer** (`FocusView.stackChanged`): depends on `.onChange(of: model.state.queue)` firing while a `fullScreenCover` is up.
- **The in-app browser** is presented with UIKit from the topmost view controller (`Browser.open`), because a SwiftUI sheet on the root view cannot come up while a question covers the screen. Untried.
- **Options of a card with more than two answers** scroll in a box of at most 280 points (`CardPage.swift:100-110`).
- **Published pages** (`/a/<id>#key`) open in `SFSafariViewController`. The viewer decrypts with WebCrypto, which browsers only offer on HTTPS or localhost; over plain `http://192.168...` the page will say it cannot decrypt. With the board behind `tailscale serve` (HTTPS) it works.
- **UI tests** find elements by accessibility identifier. Identifiers on containers (`row-<id>`, `inbox-group-<id>`) rely on `.accessibilityElement(children: .contain)`; if a test cannot find one, that is the first thing to check.

## Project and CI

- `project.yml`: `sources` with `excludes: [Info.plist]`; `GENERATE_INFOPLIST_FILE` together with `INFOPLIST_FILE`; an asset catalog with one 1024-point icon and no other sizes. All standard, none of it run.
- Unit tests are hosted in the app and use `@testable import Trommi`; the same files use `@testable import TrommiCore` under SwiftPM.
- The simulator is picked by a Python one-liner from `simctl list -j`; it takes the newest iOS runtime's first iPhone.
- TestFlight: see the header of `.github/workflows/ios-testflight.yml` for what was checked against documentation and what was not.
