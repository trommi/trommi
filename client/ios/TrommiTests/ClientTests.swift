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

    func testAnAnswerToAnOlderWordingIsStale() async throws {
        let client = try stub()
        let seen = try XCTUnwrap(client.current.card("c-nav"))
        try client.revise(cardID: "c-nav", body: "Nothing uses it, and its tests go too.")
        XCTAssertEqual(client.current.card("c-nav")?.revised, 42)
        XCTAssertEqual(client.current.card("c-nav")?.revisions, 1)
        do {
            try await client.decide(cardID: "c-nav", answer: .one("delete"), note: "", notes: [:], revised: seen.revised)
            XCTFail("an answer to the old wording must be refused")
        } catch {
            XCTAssertEqual(error as? ClientError, .stale(BoardError.revised.message), "its own case, so the app can show the card as it is now")
        }
        XCTAssertEqual(client.current.card("c-nav")?.status, .open)
        try await client.decide(cardID: "c-nav", answer: .one("delete"), note: "", notes: ["keep": "no"], revised: 42)
        XCTAssertEqual(client.current.card("c-nav")?.optionNotes, ["keep": "no"])
        XCTAssertThrowsError(try client.revise(cardID: "c-nav", title: "Too late")) { XCTAssertEqual(readable($0), "This question was already answered.") }
    }

    func testDraftsReachEveryListenerAndARevisionTrimsThem() async throws {
        let client = try stub()
        var states = client.events().makeAsyncIterator()
        _ = try await states.next()
        try await client.saveDraft(cardID: "c-next", keys: ["live-log", "encryption"], note: "soon ", notes: ["several-agents": " later "])
        let drafted = try await states.next()
        XCTAssertEqual(drafted?.card("c-next")?.draft, CardDraft(keys: ["encryption", "live-log"], note: "soon ", notes: ["several-agents": "later"], ts: 42))
        // The agent drops an option: what the draft said about it goes with it.
        try client.revise(cardID: "c-next", options: [CardOption(key: "encryption", label: "Encryption", detail: ""), CardOption(key: "other", label: "Something else", detail: "")])
        let revised = try await states.next()
        XCTAssertEqual(revised?.card("c-next")?.draft?.keys, ["encryption"])
        XCTAssertEqual(revised?.card("c-next")?.draft?.notes, [:])
        client.failNext("draft")
        do {
            try await client.saveDraft(cardID: "c-next", keys: [], note: "", notes: [:])
            XCTFail("expected the injected failure")
        } catch {
            XCTAssertEqual(readable(error), "The server did not answer.")
        }
        do {
            try await client.saveDraft(cardID: "c-db", keys: ["pg"], note: "", notes: [:])
            XCTFail("a decided card keeps no draft")
        } catch {
            XCTAssertEqual(readable(error), "This question was already answered.")
        }
    }

    func testRefusalsOfTheServerAsErrors() {
        func refusal(_ status: Int, _ body: String) -> ClientError { LiveBoardClient.refusal(status: status, body: Data(body.utf8)) }
        XCTAssertEqual(refusal(409, #"{"error":"the agent revised this question while you were answering; nothing was sent, read it again and answer once more"}"#),
                       .stale(BoardError.revised.message))
        XCTAssertEqual(refusal(409, #"{"error":"card already decided"}"#), .server("This question was already answered."), "another 409 is an ordinary refusal")
        XCTAssertEqual(refusal(409, #"{"error":"a session that is online cannot be archived"}"#), .server("A session that is connected cannot be archived."))
        XCTAssertEqual(refusal(400, #"{"error":"notes names an unknown option: \"x\""}"#), .server("This option does not exist."))
        XCTAssertEqual(refusal(503, #"{"error":"Speech is not set up (TINFOIL_API_KEY or data/tinfoil.key is missing)"}"#), .server("Speech is not set up (TINFOIL_API_KEY or data/tinfoil.key is missing)"))
        XCTAssertEqual(refusal(404, #"{"error":"not found"}"#), .notFound)
        XCTAssertEqual(refusal(404, "<html>"), .notFound)
        XCTAssertEqual(refusal(404, #"{"error":"This dictation has ended"}"#), .server("This dictation has ended"))
        XCTAssertEqual(refusal(401, ""), .unauthorized)
        XCTAssertEqual(refusal(500, "oops"), .server("error 500"))
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

    // The tests below meet cards only an agent can make. tools/live-seed.sh puts them on the
    // board; without it they are skipped.

    private func seeded(_ title: String, in state: BoardState) throws -> Card {
        guard let card = state.cards.last(where: { $0.title == "iOS fixture: \(title)" }) else {
            throw XCTSkip("the board has no card \"iOS fixture: \(title)\"; run client/ios/tools/live-seed.sh <port> first")
        }
        return card
    }

    private func next(_ states: inout AsyncThrowingStream<BoardState, Error>.Iterator, _ what: String, until done: (BoardState) -> Bool) async throws -> BoardState {
        for _ in 0..<30 {
            guard let state = try await states.next() else { break }
            if done(state) { return state }
        }
        XCTFail("never saw: \(what)")
        throw ClientError.badAnswer
    }

    /// POST /decide with notes on single options, POST /reopen turning the answer into a draft, POST /draft.
    func testOptionNotesAndDraftsRoundTrip() async throws {
        let (client, first) = try await LiveBoardClient.connect(try link())
        let card = try seeded("plain", in: first)
        if card.status != .open { try await client.reopen(cardID: card.id) }
        var states = client.events().makeAsyncIterator()
        _ = try await states.next()

        try await client.decide(cardID: card.id, answer: .one("b"), note: " general ", notes: ["a": " but not before Monday ", "c": "not this, too expensive", "b": "  "], revised: card.revised)
        let decided = try await next(&states, "the decision") { $0.card(card.id)?.status == .decided }
        let answered = try XCTUnwrap(decided.card(card.id))
        XCTAssertEqual(answered.choice, "b")
        XCTAssertEqual(answered.note, "general")
        XCTAssertEqual(answered.optionNotes, ["a": "but not before Monday", "c": "not this, too expensive"], "notes on options that were not chosen are kept; an empty one is dropped")
        XCTAssertNil(answered.draft)
        XCTAssertEqual(decided.messages.last { $0.kind == "decided" && $0.cardID == card.id }?.text, "Berta · Anton: but not before Monday · Cesar: not this, too expensive")
        // What the app showed while it waited is what the server sent.
        var predicted = first
        if predicted.card(card.id)?.status != .open { try predicted.reopen(cardID: card.id, now: 0) }
        try predicted.decide(cardID: card.id, answer: .one("b"), note: " general ", notes: ["a": " but not before Monday ", "c": "not this, too expensive", "b": "  "], now: 0)
        XCTAssertEqual(predicted.card(card.id)?.optionNotes, answered.optionNotes)
        XCTAssertEqual(predicted.messages.last?.text, "Berta · Anton: but not before Monday · Cesar: not this, too expensive")

        // A draft on a card that is no longer open: 409.
        do {
            try await client.saveDraft(cardID: card.id, keys: ["a"], note: "", notes: [:])
            XCTFail("a decided card keeps no draft")
        } catch {
            XCTAssertEqual(readable(error), "This question was already answered.")
        }

        // Taking the answer back makes it the draft: nothing ticked or written is lost.
        try await client.reopen(cardID: card.id)
        let reopened = try await next(&states, "the take-back") { $0.card(card.id)?.status == .open }
        let draft = try XCTUnwrap(reopened.card(card.id)?.draft)
        XCTAssertEqual(draft.keys, ["b"])
        XCTAssertEqual(draft.note, "general")
        XCTAssertEqual(draft.notes, ["a": "but not before Monday", "c": "not this, too expensive"])
        XCTAssertEqual(reopened.card(card.id)?.optionNotes, [:])

        // The whole draft replaces the one before; keys come back in the order of the options, the note as typed.
        try await client.saveDraft(cardID: card.id, keys: ["c", "a", "gone"], note: "typed ", notes: ["b": " x ", "gone": "y"])
        let drafted = try await next(&states, "the new draft") { $0.card(card.id)?.draft?.note == "typed " }
        XCTAssertEqual(drafted.card(card.id)?.draft?.keys, ["a", "c"])
        XCTAssertEqual(drafted.card(card.id)?.draft?.notes, ["b": "x"])
        XCTAssertGreaterThan(drafted.card(card.id)?.draft?.ts ?? 0, draft.ts - 1)
        var editor = DraftEditor(card: try XCTUnwrap(drafted.card(card.id)))
        XCTAssertEqual(editor.keys, ["a", "c"])
        XCTAssertTrue(editor.matches(drafted.card(card.id)?.draft, card: card))
        editor.sync(card: card, typing: false)

        // An empty draft clears it.
        try await client.saveDraft(cardID: card.id, keys: [], note: "", notes: [:])
        let cleared = try await next(&states, "the draft cleared") { $0.card(card.id)?.draft == nil }
        XCTAssertEqual(cleared.card(card.id)?.status, .open)

        // Refusals: a note on an option the card does not have, a note that is too long, a card that does not exist.
        do {
            try await client.decide(cardID: card.id, answer: .one("a"), note: "", notes: ["nope": "x"], revised: card.revised)
            XCTFail("a note on an unknown option must be refused")
        } catch {
            XCTAssertEqual(readable(error), "This option does not exist.")
        }
        do {
            try await client.saveDraft(cardID: card.id, keys: [], note: "", notes: ["a": String(repeating: "x", count: 2001)])
            XCTFail("a note over 2000 characters must be refused")
        } catch {
            XCTAssertTrue(readable(error).contains("longer than 2000"), readable(error))
        }
        do {
            try await client.saveDraft(cardID: "no-such-card", keys: [], note: "x", notes: [:])
            XCTFail("an unknown card must be refused")
        } catch {
            XCTAssertEqual(readable(error), "This question no longer exists.")
        }
    }

    /// An answer names the wording it was given to; the hub refuses one given to an older wording with 409.
    func testAStaleAnswerToARevisedCardIsRefused() async throws {
        let (client, first) = try await LiveBoardClient.connect(try link())
        let card = try seeded("revised", in: first)
        if card.status != .open { try await client.reopen(cardID: card.id) }
        let stamp = try XCTUnwrap(card.revised, "the seed revised this card")
        XCTAssertEqual(card.revisions, 1)
        XCTAssertEqual(card.body, "Second wording.")
        XCTAssertEqual(card.selfNote, "revised")
        XCTAssertEqual(first.messages.last { $0.kind == "revised" && $0.cardID == card.id }?.text, "Said it more clearly")
        // The hub takes no answer in the first moments after a rewrite: nobody could have read it.
        let age = Date().timeIntervalSince1970 * 1000 - stamp
        if age < 2000 { try await Task.sleep(nanoseconds: UInt64((2000 - max(0, age)) * 1_000_000)) }

        for old in [stamp - 1, nil] as [Double?] {
            do {
                try await client.decide(cardID: card.id, answer: .one("a"), note: "", notes: [:], revised: old)
                XCTFail("an answer to an older wording must be refused")
            } catch {
                XCTAssertEqual(error as? ClientError, .stale(BoardError.revised.message))
            }
        }
        var states = client.events().makeAsyncIterator()
        let still = try await states.next()
        XCTAssertEqual(still?.card(card.id)?.status, .open, "nothing was sent")

        // The wording the board holds now is taken.
        try await client.decide(cardID: card.id, answer: .one("a"), note: "", notes: [:], revised: stamp)
        _ = try await next(&states, "the decision") { $0.card(card.id)?.status == .decided }
        try await client.reopen(cardID: card.id)
        _ = try await next(&states, "the take-back") { $0.card(card.id)?.status == .open }
        try await client.saveDraft(cardID: card.id, keys: [], note: "", notes: [:])
    }

    /// card.sections, merged_from and merged_into as the hub sends them.
    func testSectionsAndMergedCardsArrive() async throws {
        let (client, first) = try await LiveBoardClient.connect(try link())
        let sectioned = try seeded("sectioned", in: first)
        let sections = try XCTUnwrap(sectioned.sections)
        XCTAssertEqual(sections.map(\.key), [nil, "limit", "async", "page"])
        XCTAssertEqual(sections.compactMap(\.key), sectioned.options.map(\.key), "the flagged blocks are the options, in order")
        XCTAssertEqual(sections.filter(\.isOption).map(\.label), sectioned.options.map(\.label))
        XCTAssertEqual(sections.map(\.recommended), [false, true, false, false])
        XCTAssertEqual(sectioned.recommended, ["limit"], "the hub keeps the advice in step")
        XCTAssertEqual(sections[3].text, "")
        XCTAssertTrue(sectioned.multiple)
        XCTAssertTrue(sectioned.body.contains("**Raise the limit**: 60 instead of 30 seconds."), "the body is the same text for old clients")
        XCTAssertEqual(sectioned.blocks?.count, 4)

        let merged = try seeded("merged", in: first)
        XCTAssertEqual(merged.mergedFrom.map(\.title), ["iOS fixture: part one", "iOS fixture: part two"])
        XCTAssertEqual(merged.selfNote, "replaces 2 questions")
        for old in merged.mergedFrom {
            let gone = try XCTUnwrap(first.card(old.id))
            XCTAssertEqual(gone.status, .done)
            XCTAssertEqual(gone.mergedInto, merged.id)
            XCTAssertEqual(gone.number, old.number)
            XCTAssertFalse(first.queue.contains(old.id))
            XCTAssertNil(gone.choice, "merged away, not answered: it is not among the answered ones")
        }
        XCTAssertFalse(first.inbox(later: LaterList()).answered.contains { $0.card.mergedInto != nil })
        // A link names a question by its number.
        XCTAssertEqual(first.card(named: String(merged.number))?.id, merged.id)
        XCTAssertEqual(client.link.questionURL(number: merged.number)?.query, "q=\(merged.number)")

        // Several answers with a note on one that was not ticked, then back.
        if sectioned.status == .open {
            var states = client.events().makeAsyncIterator()
            _ = try await states.next()
            try await client.decide(cardID: sectioned.id, answer: .several(["page", "limit"]), note: "", notes: ["async": "next quarter"], revised: sectioned.revised)
            let decided = try await next(&states, "the decision") { $0.card(sectioned.id)?.status == .decided }
            XCTAssertEqual(decided.card(sectioned.id)?.choices, ["limit", "page"])
            XCTAssertEqual(decided.card(sectioned.id)?.optionNotes, ["async": "next quarter"])
            XCTAssertNotNil(decided.card(sectioned.id)?.sections, "the blocks stay on the answered card")
            try await client.reopen(cardID: sectioned.id)
            let back = try await next(&states, "the take-back") { $0.card(sectioned.id)?.status == .open }
            XCTAssertEqual(back.card(sectioned.id)?.draft?.keys, ["limit", "page"])
            try await client.saveDraft(cardID: sectioned.id, keys: [], note: "", notes: [:])
        }
    }

    /// POST /speech/live. A demo board has no key for the speech service: the refusal must arrive as
    /// a sentence. With a key, the stream opens with "ready" and ends with "final" after /stop.
    func testLiveDictationOpensOrIsRefusedInWords() async throws {
        let (client, first) = try await LiveBoardClient.connect(try link())
        var events: [DictationEvent] = []
        do {
            for try await event in client.liveDictation() {
                events.append(event)
                if case .ready(let id, let rate, _) = event {
                    XCTAssertEqual(rate, PCM.rate)
                    try await client.sendDictationAudio(id: id, pcm: PCM.bytes([Float](repeating: 0, count: 1600)))
                    try await client.stopDictation(id: id)
                }
            }
            XCTAssertTrue(first.speech, "a board without a key must refuse")
            guard case .ready = events.first else { return XCTFail("the stream starts with ready: \(events)") }
            guard case .final = events.last else { return XCTFail("and ends with final: \(events)") }
        } catch {
            XCTAssertFalse(first.speech)
            XCTAssertEqual(readable(error), "Speech is not set up (TINFOIL_API_KEY or data/tinfoil.key is missing)")
            XCTAssertTrue(events.isEmpty)
        }
        // Sound for a dictation that does not exist is refused in words; stopping one is harmless.
        do {
            try await client.sendDictationAudio(id: "no-such-dictation", pcm: Data([0, 0]))
            XCTFail("expected a refusal")
        } catch {
            XCTAssertEqual(readable(error), "This dictation has ended")
        }
        try await client.stopDictation(id: "no-such-dictation")
    }

    /// The pad exists on the web under /pad; the app opens it in its browser, signed in through the link.
    func testThePadIsServed() async throws {
        let (client, _) = try await LiveBoardClient.connect(try link())
        let page = try await client.data(path: "/pad")
        XCTAssertTrue(String(decoding: page.prefix(200), as: UTF8.self).lowercased().contains("<!doctype html"))
        XCTAssertEqual(client.link.padURL?.path, "/pad")
        XCTAssertEqual(client.link.padURL?.query, "t=\(client.link.token)")
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
