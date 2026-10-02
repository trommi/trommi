import XCTest
#if canImport(TrommiCore)
@testable import TrommiCore
#else
@testable import Trommi
#endif

final class DecodingTests: XCTestCase {
    func testDemoStateDecodes() throws {
        let state = try Fixture.single()
        XCTAssertEqual(state.cards.count, 8)
        XCTAssertEqual(state.messages.count, 14)
        XCTAssertEqual(state.tasks.count, 4)
        XCTAssertEqual(state.queue, ["c-perm", "c-migrate", "c-phone", "c-theme", "c-next"])
        XCTAssertFalse(state.speech)
    }

    func testStateWithoutAgentsGetsOne() throws {
        let state = try Fixture.single()
        XCTAssertEqual(state.agents.map(\.id), ["main"])
        XCTAssertTrue(state.cards.allSatisfy { $0.agent == "main" })
        XCTAssertTrue(state.messages.allSatisfy { $0.agent == "main" })
        XCTAssertTrue(state.tasks.allSatisfy { $0.agent == "main" })
    }

    func testCardFields() throws {
        let card = try XCTUnwrap(try Fixture.single().card("c-migrate"))
        XCTAssertEqual(card.number, 7)
        XCTAssertEqual(card.kind, .decision)
        XCTAssertEqual(card.status, .open)
        XCTAssertEqual(card.urgency, .critical)
        XCTAssertEqual(card.urgencyReason, "Deploy wartet, alle weiteren Schritte hängen davon ab")
        XCTAssertEqual(card.options.map(\.key), ["run-now", "tonight", "batch", "cancel"])
        XCTAssertEqual(card.options[0].detail, "Kurze Sperre, Deploy läuft danach durch")
        XCTAssertNil(card.choice)
        XCTAssertNil(card.decided)
    }

    func testDecidedCard() throws {
        let card = try XCTUnwrap(try Fixture.single().card("c-db"))
        XCTAssertEqual(card.status, .decided)
        XCTAssertEqual(card.choice, "pg")
        XCTAssertEqual(card.choiceLabel, "Postgres")
        XCTAssertEqual(card.note, "mit Docker")
        XCTAssertNotNil(card.decided)
    }

    func testAttachmentKindFromOldImageFlag() throws {
        let card = try XCTUnwrap(try Fixture.single().card("c-theme"))
        XCTAssertEqual(card.attachments.map(\.name), ["thema-hell.png", "thema-dunkel.png"])
        XCTAssertEqual(card.attachments.map(\.kind), [.image, .image])
        XCTAssertEqual(card.attachments[0].url, "/files/thema-hell.png")
    }

    func testMessagesAndEvents() throws {
        let state = try Fixture.single()
        let asked = try XCTUnwrap(state.messages.first { $0.id == "m3" })
        XCTAssertEqual(asked.from, .event)
        XCTAssertEqual(asked.kind, "asked")
        XCTAssertEqual(asked.cardID, "c-db")
        let user = try XCTUnwrap(state.messages.first { $0.id == "m1" })
        XCTAssertEqual(user.from, .user)
        XCTAssertTrue(user.attachments.isEmpty)
    }

    func testMultiAgentFixture() throws {
        let state = try Fixture.multi()
        XCTAssertEqual(state.agents.map(\.id), ["web-frontend", "api", "infrastructure", "docs", "docs-review", "old-spike"])
        XCTAssertEqual(state.agents.map(\.online), [true, true, false, true, true, false])
        XCTAssertEqual(state.card("c-nav")?.agent, "web-frontend")
        XCTAssertEqual(state.messages.first { $0.id == "w1" }?.details.isEmpty, false)
        XCTAssertEqual(state.tasks.first { $0.taskID == "deploy" }?.cardID, "c-migrate")
        XCTAssertEqual(state.queue, ["c-perm", "c-migrate", "c-phone", "c-theme", "c-nav", "c-ship", "c-parts", "c-next", "c-backup"])
    }

    func testSessionFields() throws {
        let state = try Fixture.multi()
        let api = try XCTUnwrap(state.agent("api"))
        XCTAssertEqual(api.name, "api")
        XCTAssertEqual(api.label, "API")
        XCTAssertEqual(api.displayName, "API", "the human's own name is shown instead of the session's")
        XCTAssertEqual(api.model, "Claude Opus 5.5")
        XCTAssertEqual(api.host, "build-box")
        XCTAssertEqual(api.platform, "Linux x64")
        XCTAssertEqual(api.client, "claude-code 2.1.0")
        XCTAssertEqual(api.task, "Prepare migration and deploy")
        XCTAssertTrue(api.starred)
        XCTAssertFalse(api.archived)
        XCTAssertNil(api.group)
        XCTAssertEqual(api.mark, "api", "without an icon the mark comes from the id")
        XCTAssertNotNil(api.connected)
        let docs = try XCTUnwrap(state.agent("docs"))
        XCTAssertEqual(docs.displayName, "docs", "no label: the session's own name")
        XCTAssertEqual(docs.icon, "docs:3")
        XCTAssertEqual(docs.mark, "docs:3")
        XCTAssertEqual(docs.group, "g-docs")
        XCTAssertEqual(state.agent("old-spike")?.archived, true)
    }

    func testSessionFieldsOfAnOlderServerGetDefaults() throws {
        let state = try BoardState.decode(#"{"agents": [{"id": "a", "name": "A", "group": null, "label": "  ", "starred": 1, "archived": "nope"}]}"#)
        let a = try XCTUnwrap(state.agent("a"))
        XCTAssertEqual(a.displayName, "A", "a label of blanks is no label")
        XCTAssertNil(a.group)
        XCTAssertTrue(a.starred)
        XCTAssertFalse(a.archived)
        XCTAssertEqual(a.model, "")
        XCTAssertNil(a.seen)
    }

    func testRecommendedOption() throws {
        let state = try Fixture.multi()
        XCTAssertEqual(state.card("c-migrate")?.recommended, ["tonight"])
        XCTAssertEqual(state.card("c-next")?.recommended, [], "null means no advice")
        XCTAssertEqual(state.card("c-parts")?.recommended, ["start", "board"], "a list on a card that takes several answers")
        let json = #"{"cards": [{"id": "x", "status": "open", "recommended": "gone", "options": [{"key": "a", "label": "A"}, {"key": "b", "label": "B"}]},"#
            + #"{"id": "y", "status": "open", "recommended": 2, "options": [{"key": "1", "label": "One"}, {"key": 2, "label": "Two"}]}]}"#
        let odd = try BoardState.decode(json)
        XCTAssertEqual(odd.card("x")?.recommended, [], "advice that names no option is dropped")
        XCTAssertEqual(odd.card("y")?.recommended, ["2"])
    }

    func testMessageDetailsAndAsset() throws {
        let state = try Fixture.multi()
        let w1 = try XCTUnwrap(state.messages.first { $0.id == "w1" })
        XCTAssertTrue(w1.details.hasPrefix("What I tried:"))
        XCTAssertNil(w1.asset)
        let d1 = try XCTUnwrap(state.messages.first { $0.id == "d1" })
        XCTAssertEqual(d1.asset?.id, "q3n0XWb1kq0lYb6m3v8K2A")
        XCTAssertEqual(d1.asset?.type, "html")
        XCTAssertEqual(d1.asset?.title, "Handbook, draft")
        XCTAssertEqual(d1.asset?.gone, false)
        XCTAssertTrue(d1.asset?.url.hasPrefix("/a/q3n0XWb1kq0lYb6m3v8K2A#") ?? false)
        let gone = try BoardState.decode(#"{"messages": [{"id": "g", "from": "agent", "text": "**T** (withdrawn)", "asset": {"id": "abc", "type": "html", "title": "T", "gone": true}}, {"id": "h", "asset": "broken"}]}"#)
        XCTAssertEqual(gone.messages[0].asset?.gone, true)
        XCTAssertNil(gone.messages[1].asset)
    }

    func testMultipleAndChoices() throws {
        let state = try Fixture.multi()
        XCTAssertEqual(state.card("c-parts")?.multiple, true)
        XCTAssertEqual(state.card("c-nav")?.multiple, false)
        XCTAssertEqual(state.card("c-db")?.choices, ["pg"])
        let json = #"{"cards": [{"id": "old", "status": "decided", "choice": "a", "options": [{"key": "a", "label": "A"}]},"#
            + #"{"id": "new", "status": "decided", "multiple": true, "choice": "a", "choices": ["a", "b"], "options": [{"key": "a", "label": "A"}, {"key": "b", "label": "B"}]}]}"#
        let cards = try BoardState.decode(json)
        XCTAssertEqual(cards.card("old")?.choices, ["a"], "a server from before several answers: the one choice")
        XCTAssertEqual(cards.card("new")?.choices, ["a", "b"])
        XCTAssertEqual(cards.card("new")?.choiceLabel, "A, B")
    }

    func testMessagesAboutACard() throws {
        let state = try Fixture.multi()
        XCTAssertEqual(state.thread(of: "c-ship").map(\.id), ["d3", "d4"], "asked back, and the agent's reply")
        XCTAssertFalse(state.threadAwaitsReply("c-ship"))
        XCTAssertEqual(state.question(about: try XCTUnwrap(state.messages.first { $0.id == "d3" }))?.id, "c-ship")
        XCTAssertNil(state.question(about: try XCTUnwrap(state.messages.first { $0.id == "d2" })), "the marker of a card is no message about it")
        XCTAssertTrue(state.thread(of: "c-nav").isEmpty)
    }

    func testArchivedSessionsQuestionsAreNotInTheStack() throws {
        let state = try Fixture.multi()
        XCTAssertEqual(state.card("c-spike")?.status, .open)
        XCTAssertFalse(state.queue.contains("c-spike"))
        // Even when an older server still lists it.
        let json = #"{"agents": [{"id": "a", "name": "A"}, {"id": "b", "name": "B", "archived": true}], "queue": ["2", "1"],"#
            + #" "cards": [{"id": "1", "agent": "a", "status": "open"}, {"id": "2", "agent": "b", "status": "open"}]}"#
        XCTAssertEqual(try BoardState.decode(json).queue, ["1"])
    }

    func testEmptyObjectIsAnEmptyBoard() throws {
        let state = try BoardState.decode("{}")
        XCTAssertEqual(state.agents.count, 1)
        XCTAssertTrue(state.cards.isEmpty)
        XCTAssertTrue(state.queue.isEmpty)
        XCTAssertTrue(state.inbox(later: LaterList()).isEmpty)
        XCTAssertEqual(state.inbox(later: LaterList()).sentence, "Nothing needs you.")
    }

    func testNotAnObjectFails() {
        XCTAssertThrowsError(try BoardState.decode("[1,2]"))
        XCTAssertThrowsError(try BoardState.decode("not json"))
    }

    func testUnknownFieldsAndWrongTypesAreTolerated() throws {
        let json = """
        {"future": {"x": 1}, "speech": 1, "agents": [{"id": "a", "name": "A", "online": true, "extra": []}, {"name": "ohne id"}, 7],
         "cards": [
           {"id": "one", "agent": "a", "kind": "decision", "status": "open", "urgency": "sofort", "title": 5, "created": "1000",
            "options": [{"key": "y", "label": "Ja"}, {"label": "ohne key"}, "kaputt", {"key": 2}], "attachments": null, "new_field": true},
           {"id": 42, "kind": "permission", "status": "open", "urgency": "low", "options": []},
           {"title": "ohne id"},
           {"id": "one", "title": "doppelt"},
           "kaputt"
         ],
         "messages": [{"from": "agent", "text": "hallo"}, {"id": "x", "from": "alien", "text": "?"}, null],
         "tasks": [{"id": "t", "state": "working"}, {"id": "u", "state": "exploded"}, {"state": "done"}],
         "queue": ["gone", 42, "one", "one"]}
        """
        let state = try BoardState.decode(json)
        XCTAssertTrue(state.speech)
        XCTAssertEqual(state.agents.map(\.id), ["a"])
        XCTAssertEqual(state.cards.map(\.id), ["one", "42"])
        let one = try XCTUnwrap(state.card("one"))
        XCTAssertEqual(one.urgency, .normal, "an unknown urgency is normal")
        XCTAssertEqual(one.title, "5")
        XCTAssertEqual(one.created, 1000)
        XCTAssertEqual(one.options.map(\.key), ["y", "2"])
        XCTAssertEqual(one.options[1].label, "2", "a missing label falls back to the key")
        XCTAssertTrue(one.attachments.isEmpty)
        let permission = try XCTUnwrap(state.card("42"))
        XCTAssertEqual(permission.urgency, .critical, "approvals are always critical")
        XCTAssertEqual(permission.agent, "a", "a card without agent belongs to the first one")
        XCTAssertEqual(permission.number, 2, "a card without number gets its position")
        XCTAssertEqual(state.messages.count, 2)
        XCTAssertEqual(state.messages[1].from, .agent, "an unknown sender reads as the agent")
        XCTAssertEqual(state.tasks.map(\.taskID), ["t"])
        XCTAssertEqual(state.tasks[0].label, "t")
        XCTAssertEqual(state.queue, ["42", "one"], "unknown and repeated ids are dropped")
    }

    func testMissingQueueIsComputed() throws {
        let json = """
        {"cards": [
          {"id": "low", "status": "open", "urgency": "low", "created": 1},
          {"id": "old", "status": "open", "urgency": "high", "created": 2},
          {"id": "new", "status": "open", "urgency": "high", "created": 3},
          {"id": "perm", "kind": "permission", "status": "open", "created": 9},
          {"id": "crit", "status": "open", "urgency": "critical", "created": 5},
          {"id": "closed", "status": "done", "urgency": "critical", "created": 0}
        ]}
        """
        XCTAssertEqual(try BoardState.decode(json).queue, ["perm", "crit", "old", "new", "low"])
    }

    func testQueueIsCompletedWithForgottenOpenCards() throws {
        let json = """
        {"cards": [{"id": "a", "status": "open", "created": 1}, {"id": "b", "status": "open", "urgency": "high", "created": 2}], "queue": ["a"]}
        """
        XCTAssertEqual(try BoardState.decode(json).queue, ["a", "b"])
    }

    func testQueueOfMatchesTheServersOrderOnTheFixtures() throws {
        for state in [try Fixture.single(), try Fixture.multi()] {
            XCTAssertEqual(BoardState.queueOf(state.cards, agents: state.agents), state.queue)
        }
    }

    func testDuplicateMessageIdsStayDistinct() throws {
        let state = try BoardState.decode(#"{"messages": [{"id": "m", "text": "a"}, {"id": "m", "text": "b"}]}"#)
        XCTAssertEqual(Set(state.messages.map(\.id)).count, 2)
    }
}
