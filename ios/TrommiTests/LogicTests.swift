import XCTest
#if canImport(TrommiCore)
@testable import TrommiCore
#else
@testable import Trommi
#endif

final class LogicTests: XCTestCase {
    private func card(_ options: [String], body: String = "", attachments: Int = 0, kind: CardKind = .decision) -> Card {
        Card(id: "x", agent: "a", number: 1, kind: kind, status: .open, urgency: .normal, urgencyReason: "", title: "T", body: body,
             options: options.enumerated().map { CardOption(key: "k\($0.offset)", label: $0.element, detail: "") },
             attachments: (0..<attachments).map { Attachment(name: "f\($0)", url: "/files/f\($0).png", kind: .image, size: nil) },
             choice: nil, note: "", summary: "", created: 0, decided: nil)
    }

    // MARK: quick rule

    func testQuickRule() {
        XCTAssertTrue(card(["Ja", "Nein"]).isQuick)
        XCTAssertFalse(card(["Ja", "Nein", "Vielleicht"]).isQuick, "three options open the card")
        XCTAssertFalse(card(["Ja"]).isQuick)
        XCTAssertFalse(card(["Ja", "Nein"], attachments: 1).isQuick, "an attachment has to be looked at first")
        XCTAssertTrue(card([String(repeating: "a", count: 18), "Nein"]).isQuick)
        XCTAssertFalse(card([String(repeating: "a", count: 19), "Nein"]).isQuick)
        XCTAssertTrue(card(["Ja", "Nein"], body: String(repeating: "b", count: 240)).isQuick)
        XCTAssertFalse(card(["Ja", "Nein"], body: String(repeating: "b", count: 241)).isQuick)
        XCTAssertTrue(card(["Erlauben", "Ablehnen", "Drittes"], body: String(repeating: "b", count: 999), kind: .permission).isQuick,
                      "approvals are always answered in the row")
    }

    func testQuickRuleCountsLikeJavaScript() {
        // An emoji is one Character but two UTF-16 units, which is what inbox.js counts.
        XCTAssertTrue(card([String(repeating: "😀", count: 9), "Nein"]).isQuick)
        XCTAssertFalse(card([String(repeating: "😀", count: 10), "Nein"]).isQuick)
    }

    func testQuickCardsOfTheFixture() throws {
        let state = try Fixture.multi()
        XCTAssertEqual(state.openCards.filter(\.isQuick).map(\.id), ["c-perm", "c-nav"])
    }

    func testPermissionButtonsPutAllowLast() throws {
        let permission = try XCTUnwrap(try Fixture.multi().card("c-perm"))
        XCTAssertEqual(permission.orderedOptions.map(\.label), ["Ablehnen", "Erlauben"])
        XCTAssertEqual(permission.leadKey, "allow")
        XCTAssertEqual(permission.tabLabel, "Freigabe")
        let decision = try XCTUnwrap(try Fixture.multi().card("c-nav"))
        XCTAssertEqual(decision.orderedOptions.map(\.label), ["Löschen", "Behalten"])
        XCTAssertEqual(decision.leadKey, "ja")
        XCTAssertEqual(decision.tabLabel, "Normal")
    }

    // MARK: inbox

    func testInboxGroupsMostUrgentSenderFirst() throws {
        let groups = try Fixture.multi().inboxGroups
        XCTAssertEqual(groups.map(\.agent.name), ["API", "Web-Frontend", "Infrastruktur"])
        XCTAssertEqual(groups[0].cards.map(\.id), ["c-perm", "c-migrate"])
        XCTAssertEqual(groups[1].cards.map(\.id), ["c-phone", "c-theme", "c-nav", "c-next"])
        XCTAssertEqual(groups[2].cards.map(\.id), ["c-backup"])
    }

    func testInboxGroupsOfEqualUrgencyKeepAgentOrder() throws {
        let json = """
        {"agents": [{"id": "b", "name": "B"}, {"id": "a", "name": "A"}, {"id": "c", "name": "C"}],
         "cards": [{"id": "1", "agent": "a", "status": "open", "created": 1}, {"id": "2", "agent": "b", "status": "open", "created": 2},
                   {"id": "3", "agent": "c", "status": "done", "created": 3}]}
        """
        XCTAssertEqual(try BoardState.decode(json).inboxGroups.map(\.agent.id), ["b", "a"])
    }

    func testSingleAgentInbox() throws {
        let state = try Fixture.single()
        XCTAssertEqual(state.inboxGroups.count, 1)
        XCTAssertEqual(state.inboxGroups[0].cards.count, 5)
        XCTAssertEqual(state.inboxLine, "5 Fragen warten auf dich.")
    }

    func testExcerpt() throws {
        let state = try Fixture.single()
        XCTAssertEqual(state.card("c-migrate")?.excerpt,
                       "Deploy wartet, alle weiteren Schritte hängen davon ab · Die Migration 2026_10_02_add_urgency fügt eine Spalte hinzu und füllt 48.210 Zeilen nach. Geschätzte Dauer: 40 Sekunden, währenddessen ist die Tabelle gesperrt.")
        XCTAssertEqual(state.card("c-next")?.excerpt, "")
        XCTAssertEqual(Card.plain("# Titel\n\n**fett** und `code`\n```\nweg\n```\nEnde"), "Titel fett und code Ende")
        XCTAssertEqual(Card.plain("offen ``` bleibt"), "offen bleibt")
    }

    // MARK: sessions

    func testAgentSummaries() throws {
        let state = try Fixture.multi()
        let api = state.summary(of: try XCTUnwrap(state.agent("api")))
        XCTAssertEqual(api.open, 2)
        XCTAssertEqual(api.light, .decision)
        XCTAssertEqual(api.subtitle, "wartet auf dich")
        XCTAssertEqual(api.tasks.map(\.taskID), ["deploy", "tests"])
        XCTAssertEqual(api.lastMessage?.id, "m11")
        let infra = state.summary(of: try XCTUnwrap(state.agent("infrastruktur")))
        XCTAssertEqual(infra.open, 1)
        XCTAssertEqual(infra.subtitle, "getrennt")
    }

    func testLightWithoutOpenCardsComesFromStatusLines() throws {
        let json = """
        {"agents": [{"id": "a", "name": "A", "online": true}, {"id": "b", "name": "B", "online": true}],
         "tasks": [{"agent": "a", "id": "x", "state": "done"}, {"agent": "a", "id": "y", "state": "working"}]}
        """
        let state = try BoardState.decode(json)
        XCTAssertEqual(state.summary(of: state.agents[0]).light, .working)
        XCTAssertEqual(state.summary(of: state.agents[0]).subtitle, "arbeitet")
        XCTAssertNil(state.summary(of: state.agents[1]).light)
        XCTAssertEqual(state.summary(of: state.agents[1]).subtitle, "verbunden")
    }

    func testAvatar() {
        XCTAssertEqual(Agent(id: "x", name: "web-frontend", cwd: "", online: true).initial, "W")
        XCTAssertEqual(Agent(id: "x", name: "…9lives", cwd: "", online: true).initial, "9")
        XCTAssertEqual(Agent(id: "x", name: "…", cwd: "", online: true).initial, "?")
        // hueOf('api') in agents.js: ((97*31 + 112)*31 + 105) % 8 = 96634 % 8 = 2
        XCTAssertEqual(Agent(id: "api", name: "", cwd: "", online: true).hue, 262)
        XCTAssertEqual(Agent(id: "", name: "", cwd: "", online: true).hue, 162)
    }

    func testAgo() {
        let now = 1_800_000_000_000.0
        XCTAssertEqual(Wording.ago(now - 20_000, now: now), "gerade eben")
        XCTAssertEqual(Wording.ago(now - 5 * 60_000, now: now), "vor 5 Min.")
        XCTAssertEqual(Wording.ago(now - 59 * 60_000, now: now), "vor 59 Min.")
        XCTAssertEqual(Wording.ago(now - 150 * 60_000, now: now), "vor 3 Std.")
        XCTAssertFalse(Wording.ago(now - 3 * 86_400_000, now: now).hasPrefix("vor"))
    }

    func testWording() {
        XCTAssertEqual(Wording.questions(1), "1 Frage")
        XCTAssertEqual(Wording.questions(4), "4 Fragen")
        XCTAssertEqual(Wording.attachments(1), "1 Anhang")
        XCTAssertEqual(Wording.attachments(2), "2 Anhänge")
        XCTAssertEqual(Wording.openDecisions(0), "alles entschieden")
        XCTAssertEqual(Wording.eventLabel("asked"), "Neue Frage")
        XCTAssertEqual(Wording.eventLabel("???"), "Board")
        XCTAssertEqual(Urgency.critical.label, "Blockiert")
    }

    // MARK: local changes

    func testDecideTakesTheCardOffTheStack() throws {
        var state = try Fixture.multi()
        try state.decide(cardID: "c-migrate", key: "tonight", note: "  bitte leise ", now: 5)
        let card = try XCTUnwrap(state.card("c-migrate"))
        XCTAssertEqual(card.status, .decided)
        XCTAssertEqual(card.choice, "tonight")
        XCTAssertEqual(card.note, "bitte leise")
        XCTAssertEqual(card.decided, 5)
        XCTAssertEqual(state.queue, ["c-perm", "c-phone", "c-theme", "c-nav", "c-next", "c-backup"])
        XCTAssertEqual(state.messages.last?.kind, "decided")
        XCTAssertEqual(state.messages.last?.text, "Heute Nacht um 02:00")
        let deploy = try XCTUnwrap(state.tasks.first { $0.taskID == "deploy" })
        XCTAssertEqual(deploy.state, .working, "the stream that waited on the card moves again")
        XCTAssertNil(deploy.cardID)
    }

    func testDecidePermissionIsDoneAtOnceWithoutEvent() throws {
        var state = try Fixture.multi()
        let before = state.messages.count
        try state.decide(cardID: "c-perm", key: "deny", note: "", now: 5)
        XCTAssertEqual(state.card("c-perm")?.status, .done)
        XCTAssertEqual(state.messages.count, before)
    }

    func testDecideRefusals() throws {
        var state = try Fixture.multi()
        XCTAssertThrowsError(try state.decide(cardID: "nope", key: "x", note: "", now: 1)) { XCTAssertEqual($0 as? BoardError, .unknownCard) }
        XCTAssertThrowsError(try state.decide(cardID: "c-db", key: "pg", note: "", now: 1)) { XCTAssertEqual($0 as? BoardError, .alreadyDecided) }
        XCTAssertThrowsError(try state.decide(cardID: "c-nav", key: "vielleicht", note: "", now: 1)) { XCTAssertEqual($0 as? BoardError, .unknownOption) }
        XCTAssertEqual(state, try Fixture.multi(), "a refused answer changes nothing")
    }

    func testReopenPutsTheCardBack() throws {
        let original = try Fixture.multi()
        var state = original
        try state.decide(cardID: "c-nav", key: "ja", note: "weg damit", now: 5)
        try state.reopen(cardID: "c-nav", now: 6)
        XCTAssertEqual(state.card("c-nav"), original.card("c-nav"))
        XCTAssertEqual(state.queue, original.queue)
        XCTAssertEqual(state.messages.last?.kind, "reopened")
    }

    func testReopenRefusals() throws {
        var state = try Fixture.multi()
        XCTAssertThrowsError(try state.reopen(cardID: "c-nav", now: 1)) { XCTAssertEqual($0 as? BoardError, .alreadyOpen) }
        XCTAssertThrowsError(try state.reopen(cardID: "nope", now: 1)) { XCTAssertEqual($0 as? BoardError, .unknownCard) }
        try state.decide(cardID: "c-perm", key: "allow", note: "", now: 1)
        XCTAssertThrowsError(try state.reopen(cardID: "c-perm", now: 2)) { XCTAssertEqual($0 as? BoardError, .notADecision) }
    }

    func testAddUserMessage() throws {
        var state = try Fixture.multi()
        try state.addUserMessage("  Hallo API \n", agent: "api", now: 9)
        XCTAssertEqual(state.conversation(of: "api").last?.text, "Hallo API")
        XCTAssertEqual(state.conversation(of: "api").last?.from, .user)
        XCTAssertThrowsError(try state.addUserMessage("   ", agent: "api", now: 9)) { XCTAssertEqual($0 as? BoardError, .emptyMessage) }
        XCTAssertThrowsError(try state.addUserMessage("x", agent: "wer", now: 9)) { XCTAssertEqual($0 as? BoardError, .unknownAgent) }
    }

    func testPendingAnswersAreShownUntilTheServerCatchesUp() throws {
        let server = try Fixture.multi()
        let pending = [PendingDecision(cardID: "c-nav", key: "nein", note: "")]
        let shown = server.applying(pending, now: 7)
        XCTAssertEqual(shown.card("c-nav")?.choice, "nein")
        XCTAssertFalse(shown.queue.contains("c-nav"))
        XCTAssertTrue(server.queue.contains("c-nav"), "the server's state is left alone")

        // Once the server knows the answer, the pending one changes nothing more.
        var confirmed = server
        try confirmed.decide(cardID: "c-nav", key: "nein", note: "", now: 8)
        XCTAssertEqual(confirmed.applying(pending, now: 9), confirmed)

        // A pending answer for a card that vanished is ignored.
        XCTAssertEqual(server.applying([PendingDecision(cardID: "weg", key: "x", note: "")], now: 7), server)
    }

    func testServerErrorsAreSaidInGerman() {
        XCTAssertEqual(BoardError.translate("card already decided"), "Die Karte wurde schon entschieden.")
        XCTAssertEqual(BoardError.translate("no agent xyz"), "Diesen Agenten gibt es nicht.")
        XCTAssertEqual(BoardError.translate("forbidden"), "Der Server hat die Anfrage abgelehnt.")
        XCTAssertEqual(BoardError.translate("etwas Neues"), "etwas Neues")
    }

    // MARK: focus order

    func testNextCardAfterDeciding() {
        let before = ["a", "b", "c"]
        XCTAssertEqual(FocusOrder.next(after: "a", before: before, after: ["b", "c"]), "b")
        XCTAssertEqual(FocusOrder.next(after: "b", before: before, after: ["a", "c"]), "c")
        XCTAssertEqual(FocusOrder.next(after: "c", before: before, after: ["a", "b"]), "b", "the last card falls back to the one before")
        XCTAssertNil(FocusOrder.next(after: "a", before: ["a"], after: []))
        XCTAssertEqual(FocusOrder.next(after: "a", before: before, after: ["c"]), "c", "cards that left meanwhile are skipped")
        XCTAssertEqual(FocusOrder.next(after: "x", before: before, after: ["n"]), "n")
    }
}
