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
        XCTAssertEqual(state.agents.map(\.name), ["Web-Frontend", "API", "Infrastruktur"])
        XCTAssertEqual(state.agents.map(\.online), [true, true, false])
        XCTAssertEqual(state.card("c-nav")?.agent, "web-frontend")
        XCTAssertEqual(state.messages.first { $0.id == "w1" }?.details.isEmpty, false)
        XCTAssertEqual(state.tasks.first { $0.taskID == "deploy" }?.cardID, "c-migrate")
    }

    func testEmptyObjectIsAnEmptyBoard() throws {
        let state = try BoardState.decode("{}")
        XCTAssertEqual(state.agents.count, 1)
        XCTAssertTrue(state.cards.isEmpty)
        XCTAssertTrue(state.queue.isEmpty)
        XCTAssertTrue(state.inboxGroups.isEmpty)
        XCTAssertEqual(state.inboxLine, "Nichts wartet auf dich.")
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
            XCTAssertEqual(BoardState.queueOf(state.cards), state.queue)
        }
    }

    func testDuplicateMessageIdsStayDistinct() throws {
        let state = try BoardState.decode(#"{"messages": [{"id": "m", "text": "a"}, {"id": "m", "text": "b"}]}"#)
        XCTAssertEqual(Set(state.messages.map(\.id)).count, 2)
    }
}
