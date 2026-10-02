# iOS: where round three stopped

Parked on 2 October 2026 at the user's request ("iOS to the back of the queue"), in the middle of the catch-up with the web client. Nothing is committed. This is the list a later round picks up from.

State of the tree: `Trommi/Core` and `Trommi/Net` compile on Linux; `swift test` runs 205 tests, 0 failures, 13 of them against a live `server.mjs` (skipped without `TROMMI_TEST_LINK`); `Trommi/App`, `Trommi/Views` and the UI tests pass `swiftc -parse`. No macOS build has ever run.

## Taken over (Core and Net, tested on Linux)

- **Card fields**: `revised`, `revisions`, `merged_from`, `merged_into`, `sections`, `option_notes`, `note_attachments`, `draft` (`Core/Models.swift`). Sections fall back to body and options when they are missing or do not match the options. `Card.blocks`, `looseAttachments`, `selfNote` ("replaces 3 questions · revised"), `numberLabel` ("Nr. 12") in `Core/Questions.swift`.
- **Rows**: the web's rule for a word under a thumb (`Card.fitsTile`), one wide "Choose" that unfolds in place or opens a page (`RowActions.choose(inline:count:)`, `needsWindow`), many short options as tags (`optionsAsTags`).
- **Answering**: `POST /decide` with `notes` per option and `revised` (the wording the human answered). A 409 for an older wording is `ClientError.stale`; `AppModel` puts the card back, shows the hub's sentence as a notice and keeps it in `refusals[cardID]`. Live-tested.
- **Optimistic answer and "Back"**: the row leaves at once; `AppModel.back` is the note ("Answered: Yes", "Moved to Later", "Asked to explain", "With the agent") for 4 seconds; `takeBack()` undoes it, also while the answer is still on its way. A taken-back card returns open with its answer as its draft.
- **Drafts**: `POST /draft`, `card.draft`, `DraftEditor` (adopt the hub's draft unless the human is typing; drop what names options that are gone), `AppModel.saveDraft` with a debounce. Live-tested.
- **Later vs. Back to agent**: `LaterList` entries carry `asked` like the web's localStorage triples; kept on the device; a card handed to its session returns when the session replies about it. `AppModel.later`, `explain`, `handBack`. Lists stored by the previous version still read.
- **Piles**: `InboxModel.later`, `handed`, `answered` (latest 40), `piles`, counts and the top card of a folded pile.
- **Links by number**: `DeepLink` (`?q=102`, `?q=next`, older links with an id), `BoardState.card(named:)`, `AppModel.handle(url:)` waits for the first state, `ServerLink.questionURL(number:)`.
- **Walk**: `FocusWalk.rail`, `go(to:)`, "N left", ticks for what was answered in the walk.
- **Drawings**: the 40 named drawings (`draw:<name>`), the crown, 20 icons. `tools/doodle-tables.mjs` writes `Core/DoodleTables.swift` from `client/web/js/ui.js`; `tools/doodle-fixtures.mjs` covers all 40 names; the seeds of the last round still match byte for byte. `Agent.drawingChoices`.
- **Live dictation, without the microphone**: `liveDictation()`, `sendDictationAudio`, `stopDictation` in both clients; named events in `SSEParser`; `LiveText` (words grow in the field, the final reading replaces them unless the human typed); `Resampler` and `PCM` (16-bit, 16 kHz); `AudioFeed`; `LiveDictation` runs a whole dictation and is tested against the board in memory. Against a real server only the refusal without a key is tested.
- **Pad**: `ServerLink.padURL` (signs in on the way), `AppModel.openPad()`.
- **Demo board** (`tools/demo-state.mjs`): a revised card, a sectioned card that replaces two and carries a draft, a note on an option, a card with seven short options.
- **CI** (`.github/workflows/ios.yml`): the fixture check also runs `doodle-tables.mjs`; both jobs seed the live board with `tools/live-seed.sh` (a sectioned, a revised and a merged card, made through `dev/session.mjs`); the workflow also starts on changes to `client/web/js/ui.js` and `dev/session.mjs`. Never executed.

## Half done

- **Views use the new model only where they had to**, so that they still fit Core: the undo bar is now the "Back" note (`BackBar`, same identifiers), "Later" on a row goes through `AppModel.later`, the "Later" group lists what was put off and what is with the agent together. Everything else looks as after round two.
- **Live dictation**: the Core half is done; the device half is missing. `App/Media.swift` still records a file and sends it to `/speech/transcribe`.
- **README "What it does"** describes the app as its views are, not as Core could drive it.

## Not started (all in `Trommi/Views` and `Trommi/App`)

- Inbox row: "Later" as a small tag on the bottom edge, one wide "Choose" that unfolds the row in place, options as tags, "Nr. 12" on the row.
- The three piles at the foot of the inbox, side by side, fanning open; an answered row with "Take back".
- Card page as a conversation with one composer and the buttons Send, Explain, Back to agent (a small reverse card), Later; sections with their options; a note per option; drafts wired to the page (`DraftEditor`, `saveDraft`); the hub's sentence after a 409 on the card (`refusals`); "replaces 3 questions".
- Walk: the rail, swiping between questions.
- VIP as a crown on the corner of the session mark (`Doodle.crown`); no tile behind session marks; the picker for the 40 drawings in the session sheet.
- Microphone for live dictation: `AVAudioEngine` with a tap that feeds `AudioFeed`.
- Opening the app by link: a URL scheme in `Info.plist` and `.onOpenURL` calling `AppModel.handle(url:)`; opening `linkTarget`.
- A bar entry for the pad (`AppModel.openPad()`).
- The design house rule (plain controls, hand-drawn only as accent) applied across the views.
- `BUILD-RISKS.md`: the line numbers in its table are those of round two; the views moved a few lines.

## Planned, not to be built yet

- An own Tinfoil key in the app's Keychain, to talk to Tinfoil directly instead of through the hub (the user's wish for later).
- The pad as a native view.

## Waits for others

- Nothing in the server contract is missing for what was taken over: `docs/question-contract.md` and the routes in `server/server.mjs` were enough. `client/web/js/focus.js` started to render sections, option notes and drafts while this round ran; it was not read as the reference for how they look, so the next round should start there.
