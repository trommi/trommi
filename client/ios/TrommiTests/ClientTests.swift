import XCTest
#if canImport(TrommiCore)
@testable import TrommiCore
#else
@testable import Trommi
#endif

final class StubClientTests: XCTestCase {
    private func stub() throws -> StubBoardClient { StubBoardClient(state: try Fixture.multi(), clock: { 42 }) }

    func testFirstStateArrivesAtOnce() async throws {
        let client = try stub()
        var iterator = client.events().makeAsyncIterator()
        let first = try await iterator.next()
        XCTAssertEqual(first, try Fixture.multi())
    }

    func testDecideAndReopenReachEveryListener() async throws {
        let client = try stub()
        var a = client.events().makeAsyncIterator()
        var b = client.events().makeAsyncIterator()
        _ = try await a.next()
        _ = try await b.next()
        try await client.decide(cardID: "c-nav", key: "delete", note: "")
        let afterA = try await a.next()
        let afterB = try await b.next()
        XCTAssertEqual(afterA?.card("c-nav")?.status, .decided)
        XCTAssertEqual(afterA, afterB)
        try await client.reopen(cardID: "c-nav")
        let reopened = try await a.next()
        XCTAssertEqual(reopened?.card("c-nav")?.status, .open)
        XCTAssertEqual(reopened?.queue, try Fixture.multi().queue)
    }

    func testMessageIsAppended() async throws {
        let client = try stub()
        try await client.sendMessage("Hello", agent: "api")
        XCTAssertEqual(client.current.conversation(of: "api").last?.text, "Hello")
    }

    func testRefusalsCarryAReadableReason() async throws {
        let client = try stub()
        do {
            try await client.decide(cardID: "c-db", key: "pg", note: "")
            XCTFail("a decided card must not be decided again")
        } catch {
            XCTAssertEqual(readable(error), "This question was already answered.")
        }
    }

    func testFailNextFailsOnce() async throws {
        let client = try stub()
        client.failNext("decide")
        do {
            try await client.decide(cardID: "c-nav", key: "delete", note: "")
            XCTFail("expected the injected failure")
        } catch {
            XCTAssertEqual(readable(error), "The server did not answer.")
        }
        XCTAssertEqual(client.current.card("c-nav")?.status, .open)
        try await client.decide(cardID: "c-nav", key: "delete", note: "")
        XCTAssertEqual(client.current.card("c-nav")?.status, .decided)
    }

    func testSessionChangesReachEveryListener() async throws {
        let client = try stub()
        var states = client.events().makeAsyncIterator()
        _ = try await states.next()
        try await client.editSession(agent: "infrastructure", changes: SessionChanges(label: " Ops ", icon: "infrastructure:4"))
        let renamed = try await states.next()
        XCTAssertEqual(renamed?.agent("infrastructure")?.displayName, "Ops")
        XCTAssertEqual(renamed?.agent("infrastructure")?.mark, "infrastructure:4")
        try await client.star(agent: "infrastructure", starred: true)
        let starred = try await states.next()
        XCTAssertEqual(starred?.agent("infrastructure")?.starred, true)
        try await client.editSession(agent: "infrastructure", changes: SessionChanges(archived: true))
        let archived = try await states.next()
        XCTAssertEqual(archived?.sessions.contains { $0.id == "infrastructure" }, false)
        XCTAssertEqual(archived?.queue.contains("c-backup"), false, "its question waits with it")
        do {
            try await client.editSession(agent: "api", changes: SessionChanges(archived: true))
            XCTFail("a connected session must not be archived")
        } catch {
            XCTAssertEqual(readable(error), "A session that is connected cannot be archived.")
        }
    }

    func testRebasedMovesEveryTimeAlike() throws {
        let state = try Fixture.multi()
        let moved = state.rebased(latest: 1_000_000)
        XCTAssertEqual(moved.messages.map(\.ts).max(), 1_000_000)
        XCTAssertEqual(moved.queue, state.queue)
        let a = try XCTUnwrap(state.card("c-db")), b = try XCTUnwrap(moved.card("c-db"))
        XCTAssertEqual((a.decided ?? 0) - a.created, (b.decided ?? 0) - b.created, accuracy: 0.5)
        XCTAssertEqual(BoardState.empty.rebased(latest: 5), .empty)
    }
}

/// Talks to a real server.mjs. Skipped unless TROMMI_TEST_LINK holds a login
/// link, e.g. after `dev/serve.sh 8801`:
///   TROMMI_TEST_LINK='http://127.0.0.1:8801/?t=demo' swift test --filter LiveServerTests
/// The board behind the link is changed by the test, so point it at demo data only.
final class LiveServerTests: XCTestCase {
    private func link() throws -> ServerLink {
        guard let text = ProcessInfo.processInfo.environment["TROMMI_TEST_LINK"], !text.isEmpty else {
            throw XCTSkip("TROMMI_TEST_LINK is not set")
        }
        return try ServerLink.parse(text)
    }

    func testLoginReadsTheCookie() async throws {
        let link = try link()
        let cookie = try await LiveBoardClient.login(link)
        XCTAssertEqual(cookie.value, link.token)
        // The server names the cookie after its port, so two boards on one machine keep their logins apart.
        let port = try XCTUnwrap(link.baseURL.port)
        XCTAssertEqual(cookie.name, "board_\(port)")
    }

    func testThePlainCookieNameStillCounts() async throws {
        let link = try link()
        let client = LiveBoardClient(link: link, cookie: SessionCookie.fallback(token: link.token))
        for try await state in client.events() {
            XCTAssertFalse(state.agents.isEmpty)
            break
        }
    }

    /// POST /session and POST /star as the web client sends them. The demo board has one session, and it is connected.
    func testSessionLabelIconGroupAndStarRoundTrip() async throws {
        let (client, first) = try await LiveBoardClient.connect(try link())
        let agent = try XCTUnwrap(first.agents.first, "the demo board has a session")
        var states = client.events().makeAsyncIterator()
        _ = try await states.next()
        func wait(_ what: String, until done: (Agent) -> Bool) async throws -> Agent {
            for _ in 0..<20 {
                guard let state = try await states.next() else { break }
                if let now = state.agent(agent.id), done(now) { return now }
            }
            XCTFail("never saw: \(what)")
            throw ClientError.badAnswer
        }

        try await client.editSession(agent: agent.id, changes: SessionChanges(label: "  My session  ", icon: "\(agent.id):5"))
        let named = try await wait("the label") { $0.label == "My session" }
        XCTAssertEqual(named.displayName, "My session")
        XCTAssertEqual(named.name, agent.name, "the session's own name stays")
        XCTAssertEqual(named.mark, "\(agent.id):5")

        try await client.editSession(agent: agent.id, changes: SessionChanges(group: .set("g-test")))
        let grouped = try await wait("the group") { $0.group == "g-test" }
        XCTAssertEqual(grouped.label, "My session", "a change of group leaves the label alone")
        try await client.editSession(agent: agent.id, changes: SessionChanges(group: .remove))
        _ = try await wait("the group gone") { $0.group == nil }

        try await client.star(agent: agent.id, starred: true)
        _ = try await wait("the star") { $0.starred }
        try await client.star(agent: agent.id, starred: false)
        _ = try await wait("the star gone") { !$0.starred }

        if agent.online {
            do {
                try await client.editSession(agent: agent.id, changes: SessionChanges(archived: true))
                XCTFail("a connected session must not be archived")
            } catch {
                XCTAssertEqual(readable(error), "A session that is connected cannot be archived.")
            }
        }
        // Back to what the session calls itself, so the next run starts from the same board.
        try await client.editSession(agent: agent.id, changes: agent.edit(name: agent.name, mark: agent.id))
        let reset = try await wait("the label cleared") { $0.label.isEmpty && $0.icon.isEmpty }
        XCTAssertEqual(reset.displayName, agent.name)

        do {
            try await client.star(agent: "nobody-here", starred: true)
            XCTFail("an unknown session must be refused")
        } catch {
            XCTAssertEqual(readable(error), "This session no longer exists.")
        }
    }

    /// What the server sends about a session and its cards arrives in the model.
    func testLiveStateCarriesTheNewFields() async throws {
        let (_, first) = try await LiveBoardClient.connect(try link())
        let agent = try XCTUnwrap(first.agents.first)
        XCTAssertFalse(agent.host.isEmpty, "the hub names its machine")
        XCTAssertFalse(agent.platform.isEmpty)
        XCTAssertNotNil(agent.connected)
        XCTAssertFalse(agent.archived)
        XCTAssertEqual(first.queue, BoardState.queueOf(first.cards, agents: first.agents), "the app orders the stack like the server")
        XCTAssertFalse(first.inbox(later: LaterList()).groups.isEmpty)
    }

    func testWrongTokenIsRefused() async throws {
        var link = try link()
        link.token = "wrong"
        do {
            _ = try await LiveBoardClient.login(link)
            XCTFail("a wrong token must not log in")
        } catch {
            XCTAssertEqual(error as? ClientError, .unauthorized)
        }
    }

    func testWrongCookieEndsTheEventStream() async throws {
        let client = LiveBoardClient(link: try link(), cookie: SessionCookie(name: "board", value: "wrong"))
        do {
            for try await _ in client.events() { XCTFail("no state without the cookie") }
            XCTFail("the stream must end with an error")
        } catch {
            XCTAssertEqual(error as? ClientError, .unauthorized)
        }
    }

    func testDecideReopenAndMessageRoundTrip() async throws {
        let (client, first) = try await LiveBoardClient.connect(try link())
        let card = try XCTUnwrap(first.openCards.first { $0.kind == .decision }, "the demo board has open decisions")
        let agent = card.agent
        var states = client.events().makeAsyncIterator()
        _ = try await states.next()

        func wait(_ what: String, until done: (BoardState) -> Bool) async throws -> BoardState {
            for _ in 0..<20 {
                guard let state = try await states.next() else { break }
                if done(state) { return state }
            }
            XCTFail("never saw: \(what)")
            throw ClientError.badAnswer
        }

        try await client.decide(cardID: card.id, key: card.options[0].key, note: "from the test")
        let decided = try await wait("the decision") { $0.card(card.id)?.status == .decided }
        XCTAssertEqual(decided.card(card.id)?.choice, card.options[0].key)
        XCTAssertEqual(decided.card(card.id)?.note, "from the test")
        XCTAssertFalse(decided.queue.contains(card.id))

        // What the app shows while it waits is what the server then sends.
        XCTAssertEqual(decided.card(card.id)?.choices, [card.options[0].key])
        var predicted = first
        try predicted.decide(cardID: card.id, key: card.options[0].key, note: "from the test", now: 0)
        XCTAssertEqual(predicted.queue, decided.queue)

        do {
            try await client.decide(cardID: card.id, key: card.options[0].key, note: "")
            XCTFail("deciding twice must fail")
        } catch {
            XCTAssertEqual(readable(error), "This question was already answered.")
        }

        try await client.reopen(cardID: card.id)
        let reopened = try await wait("the take-back") { $0.card(card.id)?.status == .open }
        XCTAssertEqual(reopened.queue, first.queue)

        let text = "Hello from the Swift test \(Int(Date().timeIntervalSince1970))"
        try await client.sendMessage(text, agent: agent)
        let sent = try await wait("the message") { $0.messages.last?.text == text }
        XCTAssertEqual(sent.messages.last?.from, .user)
        XCTAssertEqual(sent.messages.last?.agent, agent)
        XCTAssertNil(sent.messages.last?.cardID)

        // Asking back about an open card: the message names the card, and the card stays open.
        try await client.sendMessage("Why? \(text)", agent: agent, about: card.id)
        let asked = try await wait("the question back") { $0.messages.last?.text == "Why? \(text)" }
        XCTAssertEqual(asked.messages.last?.cardID, card.id)
        XCTAssertEqual(asked.card(card.id)?.status, .open)
        XCTAssertEqual(asked.thread(of: card.id).last?.from, .user)

        // Several keys on a card that takes one answer are refused.
        do {
            try await client.decide(cardID: card.id, answer: .several([card.options[0].key]), note: "")
            XCTFail("keys on a card with one answer must fail")
        } catch {
            XCTAssertEqual(readable(error), "This question takes one answer.")
        }
    }

    func testAttachmentBytesAndMissingFile() async throws {
        let (client, first) = try await LiveBoardClient.connect(try link())
        let attachment = try XCTUnwrap(first.cards.flatMap(\.attachments).first, "the demo board has attachments")
        let bytes = try await client.data(path: attachment.url)
        XCTAssertEqual(Array(bytes.prefix(4)), [0x89, 0x50, 0x4E, 0x47], "a PNG")
        do {
            _ = try await client.data(path: "/files/does-not-exist.png")
            XCTFail("expected 404")
        } catch {
            XCTAssertEqual(error as? ClientError, .notFound)
        }
    }
}
