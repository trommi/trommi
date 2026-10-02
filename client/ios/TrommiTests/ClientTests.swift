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
        try await client.decide(cardID: "c-nav", key: "ja", note: "")
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
        try await client.sendMessage("Hallo", agent: "api")
        XCTAssertEqual(client.current.conversation(of: "api").last?.text, "Hallo")
    }

    func testRefusalsCarryAGermanReason() async throws {
        let client = try stub()
        do {
            try await client.decide(cardID: "c-db", key: "pg", note: "")
            XCTFail("a decided card must not be decided again")
        } catch {
            XCTAssertEqual(readable(error), "Die Karte wurde schon entschieden.")
        }
    }

    func testFailNextFailsOnce() async throws {
        let client = try stub()
        client.failNext("decide")
        do {
            try await client.decide(cardID: "c-nav", key: "ja", note: "")
            XCTFail("expected the injected failure")
        } catch {
            XCTAssertEqual(readable(error), "Der Server hat nicht geantwortet.")
        }
        XCTAssertEqual(client.current.card("c-nav")?.status, .open)
        try await client.decide(cardID: "c-nav", key: "ja", note: "")
        XCTAssertEqual(client.current.card("c-nav")?.status, .decided)
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
        XCTAssertTrue(cookie.name.hasPrefix("board"))
    }

    func testWrongTokenIsRefused() async throws {
        var link = try link()
        link.token = "falsch"
        do {
            _ = try await LiveBoardClient.login(link)
            XCTFail("a wrong token must not log in")
        } catch {
            XCTAssertEqual(error as? ClientError, .unauthorized)
        }
    }

    func testWrongCookieEndsTheEventStream() async throws {
        let client = LiveBoardClient(link: try link(), cookie: SessionCookie(name: "board", value: "falsch"))
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

        try await client.decide(cardID: card.id, key: card.options[0].key, note: "aus dem Test")
        let decided = try await wait("the decision") { $0.card(card.id)?.status == .decided }
        XCTAssertEqual(decided.card(card.id)?.choice, card.options[0].key)
        XCTAssertEqual(decided.card(card.id)?.note, "aus dem Test")
        XCTAssertFalse(decided.queue.contains(card.id))

        // What the app shows while it waits is what the server then sends.
        var predicted = first
        try predicted.decide(cardID: card.id, key: card.options[0].key, note: "aus dem Test", now: 0)
        XCTAssertEqual(predicted.queue, decided.queue)

        do {
            try await client.decide(cardID: card.id, key: card.options[0].key, note: "")
            XCTFail("deciding twice must fail")
        } catch {
            XCTAssertEqual(readable(error), "Die Karte wurde schon entschieden.")
        }

        try await client.reopen(cardID: card.id)
        let reopened = try await wait("the take-back") { $0.card(card.id)?.status == .open }
        XCTAssertEqual(reopened.queue, first.queue)

        let text = "Hallo vom Swift-Test \(Int(Date().timeIntervalSince1970))"
        try await client.sendMessage(text, agent: agent)
        let sent = try await wait("the message") { $0.messages.last?.text == text }
        XCTAssertEqual(sent.messages.last?.from, .user)
        XCTAssertEqual(sent.messages.last?.agent, agent)
    }

    func testAttachmentBytesAndMissingFile() async throws {
        let (client, first) = try await LiveBoardClient.connect(try link())
        let attachment = try XCTUnwrap(first.cards.flatMap(\.attachments).first, "the demo board has attachments")
        let bytes = try await client.data(path: attachment.url)
        XCTAssertEqual(Array(bytes.prefix(4)), [0x89, 0x50, 0x4E, 0x47], "a PNG")
        do {
            _ = try await client.data(path: "/files/gibt-es-nicht.png")
            XCTFail("expected 404")
        } catch {
            XCTAssertEqual(error as? ClientError, .notFound)
        }
    }
}
