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

    private func board(_ device: Device, failing: String? = nil) async throws -> (AppModel, StubBoardClient) {
        let stub = StubBoardClient(state: try Fixture.multi(), clock: { 42 })
        if let failing { stub.failNext(failing) }
        let model = AppModel(hooks: device.hooks, clock: { 1000 })
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

    func testAnAnswerShowsAtOnceAndOffersUndo() async throws {
        let device = Device()
        let (model, stub) = try await board(device)
        let card = try XCTUnwrap(model.state.card("c-nav"))
        let reason = await model.decide(card, card.options[1])
        XCTAssertNil(reason)
        XCTAssertEqual(model.state.card("c-nav")?.choice, "keep")
        XCTAssertFalse(model.state.queue.contains("c-nav"))
        XCTAssertEqual(stub.current.card("c-nav")?.status, .decided)
        XCTAssertEqual(model.undo?.cardID, "c-nav")
        XCTAssertEqual(model.undo?.label, "Keep")
        XCTAssertEqual(device.feedback, [.decided])

        let undone = await model.reopen("c-nav")
        XCTAssertNil(undone)
        XCTAssertNil(model.undo)
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
        XCTAssertNil(model.undo)
        XCTAssertFalse(model.isPending("c-nav"))
        XCTAssertEqual(device.feedback, [.decided, .failed])
    }

    func testAPermissionOffersNoUndo() async throws {
        let (model, _) = try await board(Device())
        let card = try XCTUnwrap(model.state.card("c-perm"))
        _ = await model.decide(card, card.options[0])
        XCTAssertEqual(model.state.card("c-perm")?.status, .done)
        XCTAssertNil(model.undo)
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
        XCTAssertEqual(model.undo?.label, "Administration, Getting started")
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
}
