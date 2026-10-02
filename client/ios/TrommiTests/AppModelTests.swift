import XCTest
#if canImport(TrommiCore)
@testable import TrommiCore
#else
@testable import Trommi
#endif

/// The model the views hang on, driven against the board in memory.
@MainActor
final class AppModelTests: XCTestCase {
    /// What the model asked of the device.
    private final class Device {
        var feedback: [Feedback] = []
        var later: Data?
        var login: StoredLogin?
        var cleared = 0
        var clients: [Bool] = []

        var hooks: AppHooks {
            AppHooks(
                feedback: { self.feedback.append($0) },
                loadLogin: { self.login },
                saveLogin: { self.login = $0 },
                clearLogin: { self.cleared += 1 },
                loadLater: { self.later },
                saveLater: { self.later = $0 },
                demoData: { try? Fixture.data("demo-state") },
                clientChanged: { self.clients.append($0 != nil) }
            )
        }
    }

    /// The board's clock runs after the app's (1000), as a reply comes after the question it answers.
    private func board(_ device: Device, failing: String? = nil) async throws -> (AppModel, StubBoardClient) {
        let stub = StubBoardClient(state: try Fixture.multi(), clock: { 2000 })
        if let failing { stub.failNext(failing) }
        let model = AppModel(hooks: device.hooks, draftDelay: 0.02, clock: { 1000 })
        model.start(stub, address: "Test", first: nil, demo: false)
        try await until("the first state") { model.loaded }
        return (model, stub)
    }

    /// Lets the model's tasks run until the condition holds.
    private func until(_ what: String, _ done: () -> Bool, file: StaticString = #filePath, line: UInt = #line) async throws {
        for _ in 0..<400 {
            if done() { return }
            try await Task.sleep(nanoseconds: 5_000_000)
        }
        XCTFail("never happened: \(what)", file: file, line: line)
    }

    func testStartsOnTheFirstScreenAndLoadsTheBoard() async throws {
        let device = Device()
        let fresh = AppModel(hooks: device.hooks)
        XCTAssertEqual(fresh.phase, .onboarding)
        fresh.resume()
        XCTAssertEqual(fresh.phase, .onboarding, "nothing stored, nothing to resume")

        let (model, _) = try await board(device)
        XCTAssertEqual(model.phase, .board)
        XCTAssertEqual(model.connection, .online)
        XCTAssertEqual(model.state.queue.count, 9)
        XCTAssertEqual(model.serverAddress, "Test")
        XCTAssertEqual(device.clients, [true])
    }

    func testAnAnswerShowsAtOnceAndOffersTheWayBack() async throws {
        let device = Device()
        let (model, stub) = try await board(device)
        let card = try XCTUnwrap(model.state.card("c-nav"))
        let reason = await model.decide(card, card.options[1])
        XCTAssertNil(reason)
        XCTAssertEqual(model.state.card("c-nav")?.choice, "keep")
        XCTAssertFalse(model.state.queue.contains("c-nav"))
        XCTAssertEqual(stub.current.card("c-nav")?.status, .decided)
        XCTAssertEqual(model.back?.cardID, "c-nav")
        XCTAssertEqual(model.back?.head, "Answered: Keep")
        XCTAssertEqual(model.back?.title, card.title)
        XCTAssertEqual(model.back?.undo, .reopen)
        XCTAssertEqual(device.feedback, [.decided])

        let undone = await model.takeBack()
        XCTAssertEqual(undone, "c-nav", "the card that is back")
        XCTAssertNil(model.back)
        try await until("the question is back") { model.state.queue.contains("c-nav") }
        XCTAssertEqual(stub.current.card("c-nav")?.status, .open)
    }

    func testARefusedAnswerComesBackWithAReason() async throws {
        let device = Device()
        let (model, _) = try await board(device, failing: "decide")
        let card = try XCTUnwrap(model.state.card("c-nav"))
        let reason = await model.decide(card, card.options[0])
        XCTAssertEqual(reason, "Not saved: The server did not answer.")
        XCTAssertEqual(model.notice, reason)
        XCTAssertEqual(model.state.card("c-nav")?.status, .open, "the question is open again")
        XCTAssertTrue(model.state.queue.contains("c-nav"))
        XCTAssertNil(model.back, "nothing to take back")
        XCTAssertEqual(model.refusals["c-nav"], reason, "the card says why")
        XCTAssertFalse(model.isPending("c-nav"))
        XCTAssertEqual(device.feedback, [.decided, .failed])
    }

    func testAPermissionOffersNoWayBack() async throws {
        let (model, _) = try await board(Device())
        let card = try XCTUnwrap(model.state.card("c-perm"))
        _ = await model.decide(card, card.options[0])
        XCTAssertEqual(model.state.card("c-perm")?.status, .done)
        XCTAssertNil(model.back)
    }

    func testLaterIsKeptAndPruned() async throws {
        let device = Device()
        let (model, _) = try await board(device)
        let theme = try XCTUnwrap(model.state.card("c-theme"))
        model.putOff(theme)
        XCTAssertEqual(model.later.ids, ["c-theme"])
        XCTAssertEqual(LaterList.decoded(device.later).ids, ["c-theme"], "stored at once")
        XCTAssertEqual(model.state.inbox(later: model.later).later.map(\.card.id), ["c-theme"])

        // A new launch reads the list back.
        let (again, _) = try await board(device)
        XCTAssertEqual(again.later.ids, ["c-theme"])
        again.fetchBack("c-theme")
        XCTAssertTrue(again.later.ids.isEmpty)
        XCTAssertTrue(LaterList.decoded(device.later).ids.isEmpty)

        // Answered elsewhere: the entry goes when the server says so.
        model.putOff(theme)
        _ = await model.decide(theme, theme.options[0])
        try await until("the entry is gone") { model.later.ids.isEmpty }
        XCTAssertTrue(LaterList.decoded(device.later).ids.isEmpty)
    }

    func testTheDemoKeepsItsOwnLaterListAndNoLogin() async throws {
        let device = Device()
        var stored = LaterList()
        stored.putOff(makeCard(["a", "b"], id: "c-theme"))
        device.later = stored.encoded()
        let model = AppModel(hooks: device.hooks)
        model.startDemo()
        try await until("the demo board") { model.loaded }
        XCTAssertTrue(model.isDemo)
        XCTAssertTrue(model.later.ids.isEmpty, "the demo starts with nothing put off")
        model.putOff(try XCTUnwrap(model.state.card("c-nav")))
        XCTAssertEqual(LaterList.decoded(device.later).ids, ["c-theme"], "and leaves the real list alone")
        model.signOut()
        XCTAssertEqual(device.cleared, 0, "leaving the demo does not forget the server")
        XCTAssertEqual(model.phase, .onboarding)
        XCTAssertEqual(device.clients, [true, false])
    }

    func testSignOutForgetsTheServer() async throws {
        let device = Device()
        let (model, _) = try await board(device)
        model.signOut(message: "bye")
        XCTAssertEqual(device.cleared, 1)
        XCTAssertEqual(model.phase, .onboarding)
        XCTAssertEqual(model.onboardingMessage, "bye")
        XCTAssertEqual(model.state, .empty)
        XCTAssertFalse(model.loaded)
    }

    func testSessionChanges() async throws {
        let device = Device()
        let (model, stub) = try await board(device)
        let infra = try XCTUnwrap(model.state.agent("infrastructure"))
        let renamed = await model.rename(infra, name: "Ops", mark: "infrastructure:2")
        XCTAssertNil(renamed)
        try await until("the new name") { model.state.agent("infrastructure")?.displayName == "Ops" }
        XCTAssertEqual(model.state.agent("infrastructure")?.mark, "infrastructure:2")

        _ = await model.star(infra, true)
        try await until("the star") { model.state.agent("infrastructure")?.starred == true }

        _ = await model.pair("api", with: "web-frontend")
        try await until("the pair") { model.state.group(of: "api") != nil }
        XCTAssertEqual(model.state.group(of: "api")?.members.map(\.id), ["web-frontend", "api"])
        _ = await model.unpair("api")
        try await until("the pair split") { model.state.group(of: "api") == nil }
        XCTAssertNil(stub.current.agent("web-frontend")?.group)

        let refused = await model.archive(try XCTUnwrap(model.state.agent("api")), true)
        XCTAssertEqual(refused, "Not saved: A session that is connected cannot be archived.")
        XCTAssertEqual(model.notice, refused)
        _ = await model.archive(infra, true)
        try await until("the archive") { model.state.archivedSessions.contains { $0.id == "infrastructure" } }
        XCTAssertFalse(model.state.queue.contains("c-backup"))
    }

    func testLinksOpenInTheBrowserAndOnlyWebLinks() async throws {
        let (model, _) = try await board(Device())
        model.open(link: "https://example.org/a")
        XCTAssertEqual(model.browser?.url.absoluteString, "https://example.org/a")
        model.browser = nil
        model.open(link: "javascript:alert(1)")
        XCTAssertNil(model.browser)
        XCTAssertEqual(model.notice, "This link cannot be opened here.")
    }

    func testSeveralAnswersGoOutTogether() async throws {
        let (model, stub) = try await board(Device())
        let parts = try XCTUnwrap(model.state.card("c-parts"))
        let reason = await model.decide(parts, [parts.options[3], parts.options[0]])
        XCTAssertNil(reason)
        XCTAssertEqual(stub.current.card("c-parts")?.choices, ["start", "admin"])
        XCTAssertEqual(model.back?.head, "Answered: Administration, Getting started")
        let empty = await model.decide(try XCTUnwrap(model.state.card("c-nav")), [])
        XCTAssertEqual(empty, "Not saved: Choose at least one option.")
    }

    func testAskingBackKeepsTheQuestionOpen() async throws {
        let (model, stub) = try await board(Device())
        try await model.send("Why tonight?", to: "api", about: "c-migrate")
        XCTAssertEqual(stub.current.thread(of: "c-migrate").map(\.text), ["Why tonight?"])
        try await until("the question on screen") { model.state.threadAwaitsReply("c-migrate") }
        XCTAssertTrue(model.state.queue.contains("c-migrate"))
    }

    func testSendingAMessage() async throws {
        let (model, stub) = try await board(Device())
        try await model.send("Hello", to: "api")
        XCTAssertEqual(stub.current.conversation(of: "api").last?.text, "Hello")
        try await until("the message on screen") { model.state.conversation(of: "api").last?.text == "Hello" }
    }

    // MARK: back

    func testBackTakesAnAnswerBackEvenWhileItIsOnItsWay() async throws {
        let (model, stub) = try await board(Device())
        let card = try XCTUnwrap(model.state.card("c-next"))
        // The answer is not awaited: the row is gone and the note is up before the server has spoken.
        let answering = Task { await model.decide(card, card.options[1], note: "go", notes: ["live-log": "not yet"]) }
        try await until("the note") { model.back != nil }
        XCTAssertFalse(model.state.queue.contains("c-next"), "the row left at once")
        let back = await model.takeBack()
        _ = await answering.value
        XCTAssertEqual(back, "c-next")
        try await until("the question is open again") { model.state.card("c-next")?.status == .open && !model.isPending("c-next") }
        // It returns with what was ticked and written, as its draft.
        XCTAssertEqual(stub.current.card("c-next")?.draft?.keys, ["encryption"])
        XCTAssertEqual(stub.current.card("c-next")?.draft?.note, "go")
        XCTAssertEqual(stub.current.card("c-next")?.draft?.notes, ["live-log": "not yet"])
        XCTAssertNil(model.back)
        let nothing = await model.takeBack()
        XCTAssertNil(nothing, "nothing left to take back")
    }

    func testLaterSaysWhereTheQuestionWentAndBackFetchesIt() async throws {
        let device = Device()
        let (model, _) = try await board(device)
        let card = try XCTUnwrap(model.state.card("c-theme"))
        model.later(card)
        XCTAssertEqual(model.back?.head, "Moved to Later")
        XCTAssertEqual(model.back?.title, card.title)
        XCTAssertEqual(model.state.inbox(later: model.later).later.map(\.card.id), ["c-theme"])
        XCTAssertFalse(model.later.isHanded("c-theme"), "the agent hears nothing of a plain Later")
        let back = await model.takeBack()
        XCTAssertEqual(back, "c-theme")
        XCTAssertTrue(model.later.ids.isEmpty)
        XCTAssertTrue(LaterList.decoded(device.later).ids.isEmpty)

        // A second note replaces the first.
        model.later(card)
        model.later(try XCTUnwrap(model.state.card("c-nav")))
        XCTAssertEqual(model.back?.cardID, "c-nav")
        model.dismissBack()
        XCTAssertNil(model.back)
        XCTAssertEqual(model.later.ids, ["c-theme", "c-nav"], "letting the note go undoes nothing")
    }

    func testExplainHandsTheCardToItsAgentUntilTheReply() async throws {
        let device = Device()
        let (model, stub) = try await board(device)
        let card = try XCTUnwrap(model.state.card("c-migrate"))
        let failed = await model.explain(card)
        XCTAssertNil(failed)
        XCTAssertEqual(stub.current.thread(of: "c-migrate").map(\.text), [Wording.explainText])
        XCTAssertEqual(model.back?.head, "Asked to explain")
        XCTAssertEqual(model.back?.title, "It comes back with the answer.")
        XCTAssertTrue(model.later.isHanded("c-migrate"))
        XCTAssertEqual(LaterList.decoded(device.later).handed, ["c-migrate"], "kept on the device")
        try await until("the pile") { model.state.inbox(later: model.later).handed.map(\.card.id) == ["c-migrate"] }
        XCTAssertEqual(model.state.card("c-migrate")?.status, .open)

        // The session replies about the card: it is back in its sender's group by itself.
        try stub.reply("It adds one column.", agent: "api", about: "c-migrate")
        try await until("the card is back") { model.later.ids.isEmpty }
        XCTAssertTrue(model.state.inbox(later: model.later).fresh.contains { $0.id == "c-migrate" })
        XCTAssertTrue(LaterList.decoded(device.later).ids.isEmpty)
    }

    func testBackToAgentSendsWhatWasWrittenFirst() async throws {
        let (model, stub) = try await board(Device())
        let card = try XCTUnwrap(model.state.card("c-phone"))
        let failed = await model.handBack(card, text: "  Try it with tabs first.  ")
        XCTAssertNil(failed)
        XCTAssertEqual(stub.current.thread(of: "c-phone").map(\.text), ["Try it with tabs first."])
        XCTAssertEqual(model.back?.head, "With the agent")
        XCTAssertTrue(model.later.isHanded("c-phone"))
        let back = await model.takeBack()
        XCTAssertEqual(back, "c-phone")
        XCTAssertFalse(model.later.contains("c-phone"))

        // With nothing written, nothing is sent; the card still waits for the agent's word.
        let quiet = try XCTUnwrap(model.state.card("c-nav"))
        _ = await model.handBack(quiet)
        XCTAssertTrue(stub.current.thread(of: "c-nav").isEmpty)
        XCTAssertTrue(model.later.isHanded("c-nav"))

        // If the words do not arrive, the card stays where it is.
        stub.failNext("message")
        let other = try XCTUnwrap(model.state.card("c-next"))
        let reason = await model.handBack(other, text: "Hello?")
        XCTAssertEqual(reason, "Not handed over: The server did not answer.")
        XCTAssertFalse(model.later.contains("c-next"))
        stub.failNext("message")
        let unexplained = await model.explain(other)
        XCTAssertEqual(unexplained, "Not asked: The server did not answer.")
        XCTAssertFalse(model.later.contains("c-next"))
    }

    // MARK: a revised question

    func testAnAnswerToARevisedQuestionComesBackWithTheReason() async throws {
        let device = Device()
        let (model, stub) = try await board(device)
        // The human still looks at the old wording when the agent rewrites the card.
        let seen = try XCTUnwrap(model.state.card("c-nav"))
        try stub.revise(cardID: "c-nav", title: "Delete the old navigation and its tests?")
        let reason = await model.decide(seen, seen.options[0])
        XCTAssertEqual(reason, "Not saved: \(BoardError.revised.message)")
        XCTAssertEqual(model.notice, reason)
        XCTAssertEqual(model.refusals["c-nav"], reason)
        XCTAssertNil(model.back)
        XCTAssertEqual(stub.current.card("c-nav")?.status, .open, "nothing was sent")
        try await until("the card as it is now") { model.state.card("c-nav")?.title == "Delete the old navigation and its tests?" }
        XCTAssertEqual(model.state.card("c-nav")?.selfNote, "revised")
        XCTAssertEqual(model.state.conversation(of: "web-frontend").last?.kind, "revised")

        // Read again and answered once more: taken, and the reason is gone.
        let now = try XCTUnwrap(model.state.card("c-nav"))
        let again = await model.decide(now, now.options[0])
        XCTAssertNil(again)
        XCTAssertNil(model.refusals["c-nav"])
        XCTAssertEqual(stub.current.card("c-nav")?.choice, "delete")
    }

    // MARK: drafts

    func testADraftGoesOutAMomentAfterTheLastChange() async throws {
        let (model, stub) = try await board(Device())
        let card = try XCTUnwrap(model.state.card("c-next"))
        var editor = DraftEditor(card: card)
        editor.toggle("encryption", multiple: false)
        model.saveDraft(card, editor)
        editor.note = "after the release"
        editor.setNote("too early", on: "live-log")
        model.saveDraft(card, editor)
        XCTAssertTrue(model.hasUnsentDraft("c-next"))
        XCTAssertNil(stub.current.card("c-next")?.draft, "not yet: the next change may follow")
        try await until("the draft on the hub") { stub.current.card("c-next")?.draft != nil }
        XCTAssertEqual(stub.current.card("c-next")?.draft?.keys, ["encryption"])
        XCTAssertEqual(stub.current.card("c-next")?.draft?.note, "after the release")
        XCTAssertEqual(stub.current.card("c-next")?.draft?.notes, ["live-log": "too early"])
        try await until("the draft in the state") { model.state.card("c-next")?.draft != nil && !model.hasUnsentDraft("c-next") }

        // What the hub already holds is not sent again.
        model.saveDraft(try XCTUnwrap(model.state.card("c-next")), editor)
        XCTAssertFalse(model.hasUnsentDraft("c-next"))

        // "Later" loses nothing; an empty draft clears it.
        model.later(try XCTUnwrap(model.state.card("c-next")))
        XCTAssertEqual(model.state.card("c-next")?.draft?.note, "after the release")
        model.saveDraft(card, DraftEditor())
        try await until("the draft cleared") { stub.current.card("c-next")?.draft == nil }

        // An answer replaces a draft that was still waiting to go out.
        editor.note = "never sent"
        model.saveDraft(card, editor)
        _ = await model.decide(card, card.options[0])
        XCTAssertFalse(model.hasUnsentDraft("c-next"))
        XCTAssertNil(stub.current.card("c-next")?.draft)
        // Permissions keep none.
        model.saveDraft(try XCTUnwrap(model.state.card("c-perm")), editor)
        XCTAssertFalse(model.hasUnsentDraft("c-perm"))
    }

    // MARK: links

    func testALinkToAQuestionWaitsForTheBoard() async throws {
        let device = Device()
        let stub = StubBoardClient(state: try Fixture.multi(), clock: { 42 })
        let model = AppModel(hooks: device.hooks, clock: { 1000 })
        // Opened by a link before anything is loaded.
        XCTAssertTrue(model.handle(url: try XCTUnwrap(URL(string: "trommi://open?q=9"))))
        XCTAssertNil(model.linkTarget)
        model.start(stub, address: "Test", first: nil, demo: false)
        try await until("the link resolved") { model.linkTarget != nil }
        XCTAssertEqual(model.linkTarget, .card("c-nav"), "question Nr. 9")
        model.consumeLink()
        XCTAssertNil(model.linkTarget)

        XCTAssertTrue(model.handle(url: try XCTUnwrap(URL(string: "https://board.example/?q=next"))))
        XCTAssertEqual(model.linkTarget, .walk)
        model.consumeLink()
        XCTAssertTrue(model.handle(url: try XCTUnwrap(URL(string: "https://board.example/?q=4711"))))
        XCTAssertNil(model.linkTarget)
        XCTAssertEqual(model.notice, "This question does not exist on this board.")
        XCTAssertFalse(model.handle(url: try XCTUnwrap(URL(string: "https://board.example/agents"))), "no question named")

        // The demo has no server: no address to share, no pad.
        XCTAssertNil(model.link(to: try XCTUnwrap(model.state.card("c-nav"))))
        model.openPad()
        XCTAssertNil(model.browser)
        XCTAssertEqual(model.notice, "The pad lives on the server; the demo has none.")
    }
}
