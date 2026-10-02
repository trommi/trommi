import XCTest
#if canImport(TrommiCore)
@testable import TrommiCore
#else
@testable import Trommi
#endif

/// A card built by hand, for the rules that depend on its options, text and attachments.
func makeCard(_ options: [String], id: String = "x", body: String = "", attachments: [AttachmentKind] = [], kind: CardKind = .decision,
              urgency: Urgency = .normal, keys: [String]? = nil, recommended: String? = nil) -> Card {
    Card(id: id, agent: "a", number: 1, kind: kind, status: .open, urgency: urgency, urgencyReason: "", title: "T", body: body,
         options: options.enumerated().map { CardOption(key: keys?[$0.offset] ?? "k\($0.offset)", label: $0.element, detail: "") },
         attachments: attachments.enumerated().map { Attachment(name: "f\($0.offset)", url: "/files/f\($0.offset)", kind: $0.element, size: nil) },
         choice: nil, note: "", summary: "", created: 0, decided: nil, recommended: recommended)
}

final class QuestionRuleTests: XCTestCase {
    // MARK: quick rule

    func testQuickRule() {
        XCTAssertTrue(makeCard(["Yes", "No"]).isQuick)
        XCTAssertFalse(makeCard(["Yes", "No", "Maybe"]).isQuick, "three options open the card")
        XCTAssertFalse(makeCard(["Yes"]).isQuick)
        XCTAssertTrue(makeCard([String(repeating: "a", count: 18), "No"]).isQuick)
        XCTAssertFalse(makeCard([String(repeating: "a", count: 19), "No"]).isQuick)
        XCTAssertTrue(makeCard(["Yes", "No"], body: String(repeating: "b", count: 240)).isQuick)
        XCTAssertFalse(makeCard(["Yes", "No"], body: String(repeating: "b", count: 241)).isQuick)
        XCTAssertTrue(makeCard(["Allow", "Deny", "Third"], body: String(repeating: "b", count: 999), kind: .permission).isQuick,
                      "permissions are always answered in the row")
    }

    func testQuickRuleAllowsPicturesButNothingElseAttached() {
        XCTAssertTrue(makeCard(["Yes", "No"], attachments: [.image, .image]).isQuick, "pictures are shown by the row")
        XCTAssertFalse(makeCard(["Yes", "No"], attachments: [.file]).isQuick)
        XCTAssertFalse(makeCard(["Yes", "No"], attachments: [.image, .video]).isQuick)
        XCTAssertFalse(makeCard(["Yes", "No"], attachments: [.audio]).isQuick)
    }

    func testQuickRuleCountsLikeJavaScript() {
        // An emoji is one Character but two UTF-16 units, which is what inbox.js counts.
        XCTAssertTrue(makeCard([String(repeating: "😀", count: 9), "No"]).isQuick)
        XCTAssertFalse(makeCard([String(repeating: "😀", count: 10), "No"]).isQuick)
    }

    func testQuickCardsOfTheFixture() throws {
        let state = try Fixture.multi()
        XCTAssertEqual(state.openCards.filter(\.isQuick).map(\.id), ["c-perm", "c-nav", "c-ship"])
    }

    // MARK: tiles

    func testYesNoTilesPutNoLeftAndYesRight() throws {
        let nav = try XCTUnwrap(try Fixture.multi().card("c-nav"))
        guard case .answer(let tiles) = nav.rowActions else { return XCTFail("a yes/no question is answered in the row") }
        XCTAssertEqual(tiles.map(\.option.key), ["keep", "delete"], "the option the agent leads with is the yes, on the right")
        XCTAssertEqual(tiles.map(\.label), ["Keep", "Delete"])
        XCTAssertEqual(tiles.map(\.sketch), [.no, .yes])
        XCTAssertEqual(tiles.map(\.isLead), [false, true])
        XCTAssertEqual(tiles.map(\.advised), [false, true])
    }

    func testBareYesNoShowsOnlyThumbs() throws {
        let ship = try XCTUnwrap(try Fixture.multi().card("c-ship"))
        guard case .answer(let tiles) = ship.rowActions else { return XCTFail("expected tiles") }
        XCTAssertEqual(tiles.map(\.option.label), ["No", "Yes"])
        XCTAssertEqual(tiles.map(\.label), [nil, nil], "a bare yes/no needs no words")
        XCTAssertEqual(tiles.map(\.sketch), [.no, .yes])
        XCTAssertEqual(tiles[1].spoken, "Yes, recommended by the agent")
        XCTAssertEqual(tiles[0].spoken, "No")
        XCTAssertTrue(makeCard(["OK", " ja "]).isBare)
        XCTAssertFalse(makeCard(["Yes", "Not now"]).isBare)
    }

    func testPermissionTilesPutDenyLeftAndAllowRight() throws {
        let permission = try XCTUnwrap(try Fixture.multi().card("c-perm"))
        guard case .answer(let tiles) = permission.rowActions else { return XCTFail("expected tiles") }
        XCTAssertEqual(tiles.map(\.option.key), ["deny", "allow"])
        XCTAssertEqual(tiles.map(\.label), ["Deny", "Allow"])
        XCTAssertEqual(tiles.map(\.sketch), [.no, .yes])
        // The order of the options as sent does not matter.
        let swapped = makeCard(["Erlauben", "Ablehnen"], kind: .permission, keys: ["allow", "deny"])
        guard case .answer(let other) = swapped.rowActions else { return XCTFail("expected tiles") }
        XCTAssertEqual(other.map(\.option.key), ["deny", "allow"])
        XCTAssertEqual(swapped.cardTiles.map(\.label), ["Deny", "Allow"], "the card names them the same on every permission")
    }

    func testEverythingElseIsLaterAndChoose() throws {
        let state = try Fixture.multi()
        XCTAssertEqual(state.card("c-migrate")?.rowActions, .laterChoose)
        XCTAssertEqual(state.card("c-theme")?.rowActions, .laterChoose)
        XCTAssertEqual(makeCard(["Yes", "No"], attachments: [.file]).rowActions, .laterChoose)
    }

    func testSecondOptionThatIsNoRefusalGetsTheOtherSketch() {
        guard case .answer(let tiles) = makeCard(["Postgres", "SQLite"]).rowActions else { return XCTFail("expected tiles") }
        XCTAssertEqual(tiles.map(\.option.label), ["SQLite", "Postgres"])
        XCTAssertEqual(tiles.map(\.sketch), [.other, .yes])
    }

    func testNegativeWords() {
        for label in ["No", "no, thanks", "Not now", "Don't", "Do not run it", "Later", "Deny", "Skip it", "Keep", "Cancel", "Only locally", "Stay",
                      "Nein", "Nicht jetzt", "Noch nicht", "Später", "Ablehnen", "Behalten", "Nur lokal", "Abbrechen", "Bei SQLite bleiben"] {
            XCTAssertTrue(AnswerWords.isNegative(label), label)
        }
        for label in ["Yes", "Nobody", "Notify me", "Delete", "Run it now", "Ja", "Beide", "Bei SQLite"] {
            XCTAssertFalse(AnswerWords.isNegative(label), label)
        }
    }

    func testCardTilesStackMoreThanTwoInTheAgentsOrder() throws {
        let migrate = try XCTUnwrap(try Fixture.multi().card("c-migrate"))
        XCTAssertFalse(migrate.answersAsPair)
        XCTAssertEqual(migrate.cardTiles.map(\.option.key), ["run-now", "tonight", "batch", "cancel"])
        XCTAssertEqual(migrate.cardTiles.map(\.advised), [false, true, false, false])
        XCTAssertEqual(migrate.cardTiles.map(\.isLead), [false, false, false, false], "a stack has no filled tile")
        XCTAssertTrue(migrate.cardTiles.allSatisfy { $0.sketch == .other && $0.label != nil })
    }

    // MARK: recommended option

    func testRecommendedOptionIsTheOneCircled() throws {
        let state = try Fixture.multi()
        let theme = try XCTUnwrap(state.card("c-theme"))
        XCTAssertEqual(theme.cardTiles.filter(\.advised).map(\.option.key), ["system"])
        XCTAssertTrue(try XCTUnwrap(state.card("c-next")).cardTiles.allSatisfy { !$0.advised }, "no advice, nothing circled")
        // The agent may advise the "no".
        guard case .answer(let tiles) = makeCard(["Delete", "Keep"], keys: ["delete", "keep"], recommended: "keep").rowActions else { return XCTFail("expected tiles") }
        XCTAssertEqual(tiles.map(\.advised), [true, false])
        XCTAssertEqual(tiles.map(\.isLead), [false, true], "advice does not change which tile is the yes")
    }

    // MARK: urgency

    func testUrgencyMarks() {
        XCTAssertEqual(makeCard(["a", "b"], urgency: .critical).urgencyMark, .tab("Blocking", .critical))
        XCTAssertEqual(makeCard(["a", "b"], urgency: .high).urgencyMark, .tab("Urgent", .high))
        XCTAssertEqual(makeCard(["a", "b"], urgency: .normal).urgencyMark, UrgencyMark.plain, "a normal question gets nothing")
        XCTAssertEqual(makeCard(["a", "b"], urgency: .low).urgencyMark, .whenever)
        XCTAssertEqual(makeCard(["a", "b"], kind: .permission, urgency: .critical).urgencyMark, .tab("Blocking · Permission", .critical))
        XCTAssertEqual(makeCard(["a", "b"], urgency: .low).urgencyWord, "Whenever")
        XCTAssertEqual(makeCard(["a", "b"]).urgencyWord, "")
        XCTAssertEqual(Urgency.allCases.map(\.label), ["Whenever", "Normal", "Urgent", "Blocking"])
    }

    func testExcerptAndPermissionTool() throws {
        let state = try Fixture.multi()
        XCTAssertEqual(state.card("c-migrate")?.excerpt,
                       "The deploy waits, every further step depends on it · The migration 2026_10_02_add_urgency adds a column and backfills 48,210 rows. Estimated time: 40 seconds, the table is locked meanwhile.")
        XCTAssertEqual(state.card("c-next")?.excerpt, "")
        XCTAssertEqual(Card.plain("# Title\n\n**bold** and `code`\n```\ngone\n```\nEnd"), "Title bold and code End")
        XCTAssertEqual(Card.plain("open ``` stays"), "open stays")
        XCTAssertEqual(state.card("c-perm")?.permissionTool, "Bash")
        XCTAssertEqual(state.card("c-theme")?.images.count, 2)
    }
}

final class InboxTests: XCTestCase {
    func testGroupsStarredFirstThenMostUrgent() throws {
        let inbox = try Fixture.multi().inbox(later: LaterList())
        XCTAssertEqual(inbox.groups.map(\.agent.id), ["api", "web-frontend", "docs", "infrastructure"])
        XCTAssertEqual(inbox.groups[0].cards.map(\.id), ["c-perm", "c-migrate"])
        XCTAssertEqual(inbox.groups[1].cards.map(\.id), ["c-phone", "c-theme", "c-nav", "c-next"])
        XCTAssertEqual(inbox.groups[1].countLabel, "4 questions")
        XCTAssertEqual(inbox.groups[2].countLabel, "1 question")
        XCTAssertEqual(inbox.sentence, "8 questions need you.")
        XCTAssertEqual(inbox.circled, 8)
        XCTAssertTrue(inbox.offersWalk)
        XCTAssertTrue(inbox.later.isEmpty)
    }

    func testAStarBeatsUrgency() throws {
        var state = try Fixture.multi()
        try state.star("api", false)
        try state.star("infrastructure", true)
        XCTAssertEqual(state.inbox(later: LaterList()).groups.map(\.agent.id), ["infrastructure", "api", "web-frontend", "docs"])
    }

    func testGroupsOfEqualUrgencyKeepSessionOrder() throws {
        let json = """
        {"agents": [{"id": "b", "name": "B"}, {"id": "a", "name": "A"}, {"id": "c", "name": "C"}],
         "cards": [{"id": "1", "agent": "a", "status": "open", "created": 1}, {"id": "2", "agent": "b", "status": "open", "created": 2},
                   {"id": "3", "agent": "c", "status": "done", "created": 3}]}
        """
        XCTAssertEqual(try BoardState.decode(json).inbox(later: LaterList()).groups.map(\.agent.id), ["b", "a"])
    }

    func testArchivedSessionsAreNotInTheInbox() throws {
        let state = try Fixture.multi()
        let inbox = state.inbox(later: LaterList())
        XCTAssertFalse(inbox.groups.contains { $0.agent.id == "old-spike" })
        XCTAssertFalse(inbox.fresh.contains { $0.id == "c-spike" })
        XCTAssertEqual(state.sessions.count, 5)
        XCTAssertEqual(state.archivedSessions.map(\.id), ["old-spike"])
    }

    func testSingleSessionBoard() throws {
        let state = try Fixture.single()
        let inbox = state.inbox(later: LaterList())
        XCTAssertEqual(inbox.groups.count, 1)
        XCTAssertEqual(inbox.groups[0].cards.count, 5)
        XCTAssertEqual(inbox.sentence, "5 questions need you.")
        XCTAssertFalse(state.severalSessions)
    }

    // MARK: Later

    func testLaterMovesAQuestionToOneGroupAtTheBottom() throws {
        let state = try Fixture.multi()
        var later = LaterList()
        later.putOff(try XCTUnwrap(state.card("c-theme")))
        later.putOff(try XCTUnwrap(state.card("c-migrate")))
        let inbox = state.inbox(later: later)
        XCTAssertEqual(inbox.later.map(\.card.id), ["c-theme", "c-migrate"], "in the order they were put off")
        XCTAssertEqual(inbox.later.map { $0.sender?.id }, ["web-frontend", "api"], "each row says who asked")
        XCTAssertEqual(inbox.groups.first { $0.agent.id == "api" }?.cards.map(\.id), ["c-perm"])
        XCTAssertEqual(inbox.groups.first { $0.agent.id == "web-frontend" }?.cards.map(\.id), ["c-phone", "c-nav", "c-next"])
        XCTAssertEqual(inbox.sentence, "6 questions need you.", "what was put off is not counted")
        XCTAssertEqual(inbox.laterCountLabel, "2 put off")
        XCTAssertEqual(state.freshCount(later: later), 6)

        later.fetchBack("c-theme")
        XCTAssertEqual(state.inbox(later: later).later.map(\.card.id), ["c-migrate"])
        XCTAssertEqual(state.inbox(later: later).groups.first { $0.agent.id == "web-frontend" }?.cards.map(\.id), ["c-phone", "c-theme", "c-nav", "c-next"])
    }

    func testPuttingOffTwiceMovesToTheEnd() throws {
        let state = try Fixture.multi()
        var later = LaterList()
        later.putOff(try XCTUnwrap(state.card("c-theme")))
        later.putOff(try XCTUnwrap(state.card("c-next")))
        later.putOff(try XCTUnwrap(state.card("c-theme")))
        XCTAssertEqual(later.ids, ["c-next", "c-theme"])
    }

    func testEverythingPutOff() throws {
        let json = #"{"cards": [{"id": "1", "status": "open", "options": []}]}"#
        let state = try BoardState.decode(json)
        var later = LaterList()
        later.putOff(try XCTUnwrap(state.card("1")))
        let inbox = state.inbox(later: later)
        XCTAssertNil(inbox.circled)
        XCTAssertEqual(inbox.sentence, "Nothing new. What you put off is below.")
        XCTAssertTrue(inbox.groups.isEmpty)
        XCTAssertFalse(inbox.isEmpty)
        XCTAssertEqual(state.inbox(later: LaterList()).sentence, "1 question needs you.")
        XCTAssertFalse(state.inbox(later: LaterList()).offersWalk)
    }

    func testLaterEntryGoesWhenAnsweredOrMoreUrgent() throws {
        var state = try Fixture.multi()
        var later = LaterList()
        later.putOff(try XCTUnwrap(state.card("c-theme")))   // normal
        later.putOff(try XCTUnwrap(state.card("c-next")))    // low
        later.putOff(try XCTUnwrap(state.card("c-nav")))     // normal
        XCTAssertFalse(later.prune(cards: state.cards), "nothing changed, nothing goes")

        try state.decide(cardID: "c-nav", key: "keep", note: "", now: 1)
        let at = try XCTUnwrap(state.cards.firstIndex { $0.id == "c-next" })
        state.cards[at].urgency = .high
        XCTAssertTrue(later.prune(cards: state.cards))
        XCTAssertEqual(later.ids, ["c-theme"], "answered and raised questions leave the list")

        let theme = try XCTUnwrap(state.cards.firstIndex { $0.id == "c-theme" })
        state.cards[theme].urgency = .low
        XCTAssertFalse(later.prune(cards: state.cards), "a question that became less urgent stays put off")
    }

    func testLaterListSurvivesStorage() throws {
        var later = LaterList()
        later.putOff(makeCard(["a", "b"], id: "one", urgency: .high))
        later.putOff(makeCard(["a", "b"], id: "two"))
        let back = LaterList.decoded(later.encoded())
        XCTAssertEqual(back, later)
        XCTAssertEqual(back.entries.map(\.rank), [2, 1])
        XCTAssertEqual(LaterList.decoded(nil), LaterList())
        XCTAssertEqual(LaterList.decoded(Data("broken".utf8)), LaterList())
    }

    func testInboxOfOneSession() throws {
        let state = try Fixture.multi()
        var later = LaterList()
        later.putOff(try XCTUnwrap(state.card("c-theme")))
        later.putOff(try XCTUnwrap(state.card("c-migrate")))
        let inbox = state.inbox(later: later, session: "web-frontend")
        XCTAssertEqual(inbox.fresh.map(\.id), ["c-phone", "c-nav", "c-next"])
        XCTAssertEqual(inbox.later.map(\.card.id), ["c-theme"], "only its own")
        XCTAssertNil(inbox.later[0].sender, "inside a session the row need not say who asked")
        XCTAssertFalse(inbox.offersWalk)
        XCTAssertEqual(state.inbox(later: later, session: "docs-review").emptyText, "This session has no question for you right now.")
        XCTAssertTrue(state.inbox(later: later, session: "docs-review").isEmpty)
    }

    // MARK: the store

    func testPendingAnswersAreShownUntilTheServerCatchesUp() throws {
        let server = try Fixture.multi()
        var store = BoardStore()
        store.receive(server)
        XCTAssertTrue(store.begin(cardID: "c-nav", key: "keep", note: ""))
        XCTAssertFalse(store.begin(cardID: "c-nav", key: "delete", note: ""), "one answer at a time per card")
        XCTAssertTrue(store.isPending("c-nav"))
        let shown = store.shown(now: 7)
        XCTAssertEqual(shown.card("c-nav")?.choice, "keep")
        XCTAssertFalse(shown.queue.contains("c-nav"))
        XCTAssertTrue(store.server.queue.contains("c-nav"), "the server's state is left alone")

        // The server refuses: the card is back.
        store.settle(cardID: "c-nav")
        XCTAssertEqual(store.shown(now: 8), server)

        // Once the server knows the answer, the pending one changes nothing more.
        XCTAssertTrue(store.begin(cardID: "c-nav", key: "keep", note: ""))
        var confirmed = server
        try confirmed.decide(cardID: "c-nav", key: "keep", note: "", now: 8)
        store.receive(confirmed)
        XCTAssertEqual(store.shown(now: 9), confirmed)

        // A pending answer for a card that vanished is ignored.
        XCTAssertEqual(server.applying([PendingDecision(cardID: "gone", key: "x", note: "")], now: 7), server)
    }

    func testStorePrunesTheLaterListWhenAStateArrives() throws {
        var state = try Fixture.multi()
        var store = BoardStore()
        store.receive(state)
        store.later.putOff(try XCTUnwrap(state.card("c-nav")))
        XCTAssertFalse(store.receive(state))
        try state.decide(cardID: "c-nav", key: "keep", note: "", now: 1)
        XCTAssertTrue(store.receive(state), "tells the app to store the list again")
        XCTAssertTrue(store.later.ids.isEmpty)
    }
}

final class LocalChangeTests: XCTestCase {
    func testDecideTakesTheCardOffTheStack() throws {
        var state = try Fixture.multi()
        try state.decide(cardID: "c-migrate", key: "tonight", note: "  quietly please ", now: 5)
        let card = try XCTUnwrap(state.card("c-migrate"))
        XCTAssertEqual(card.status, .decided)
        XCTAssertEqual(card.choice, "tonight")
        XCTAssertEqual(card.note, "quietly please")
        XCTAssertEqual(card.decided, 5)
        XCTAssertEqual(state.queue, ["c-perm", "c-phone", "c-theme", "c-nav", "c-ship", "c-next", "c-backup"])
        XCTAssertEqual(state.messages.last?.kind, "decided")
        XCTAssertEqual(state.messages.last?.text, "Tonight at 2")
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
        XCTAssertThrowsError(try state.decide(cardID: "c-nav", key: "maybe", note: "", now: 1)) { XCTAssertEqual($0 as? BoardError, .unknownOption) }
        XCTAssertEqual(state, try Fixture.multi(), "a refused answer changes nothing")
    }

    func testReopenPutsTheCardBack() throws {
        let original = try Fixture.multi()
        var state = original
        try state.decide(cardID: "c-nav", key: "delete", note: "away with it", now: 5)
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
        try state.addUserMessage("  Hello API \n", agent: "api", now: 9)
        XCTAssertEqual(state.conversation(of: "api").last?.text, "Hello API")
        XCTAssertEqual(state.conversation(of: "api").last?.from, .user)
        XCTAssertThrowsError(try state.addUserMessage("   ", agent: "api", now: 9)) { XCTAssertEqual($0 as? BoardError, .emptyMessage) }
        XCTAssertThrowsError(try state.addUserMessage("x", agent: "who", now: 9)) { XCTAssertEqual($0 as? BoardError, .unknownAgent) }
    }

    func testServerErrorsAreSaidTheAppsWay() {
        XCTAssertEqual(BoardError.translate("card already decided"), "This question was already answered.")
        XCTAssertEqual(BoardError.translate("no agent xyz"), "This session no longer exists.")
        XCTAssertEqual(BoardError.translate("forbidden"), "The server refused the request.")
        XCTAssertEqual(BoardError.translate("a session that is online cannot be archived"), "A session that is connected cannot be archived.")
        XCTAssertEqual(BoardError.translate("something new"), "something new")
    }

    func testWording() {
        let now = 1_800_000_000_000.0
        XCTAssertEqual(Wording.ago(now - 20_000, now: now), "just now")
        XCTAssertEqual(Wording.ago(now - 5 * 60_000, now: now), "5 min ago")
        XCTAssertEqual(Wording.ago(now - 59 * 60_000, now: now), "59 min ago")
        XCTAssertEqual(Wording.ago(now - 150 * 60_000, now: now), "3 h ago")
        let utc = try? XCTUnwrap(TimeZone(identifier: "UTC"))
        XCTAssertEqual(Wording.ago(1_790_920_558_695, now: now, timeZone: utc ?? .current), "2 Oct")
        XCTAssertEqual(Wording.clock(1_790_920_558_695, timeZone: utc ?? .current), "05:55")
        XCTAssertEqual(Wording.questions(1), "1 question")
        XCTAssertEqual(Wording.questions(4), "4 questions")
        XCTAssertEqual(Wording.items(1), "1 item")
        XCTAssertEqual(Wording.eventLabel("asked"), "New question")
        XCTAssertEqual(Wording.eventLabel("decided"), "Answered")
        XCTAssertEqual(Wording.eventLabel("reopened"), "Taken back")
        XCTAssertEqual(Wording.eventLabel("???"), "Board")
    }
}

final class FocusWalkTests: XCTestCase {
    private let queue = ["a", "b", "c", "d"]

    func testWalkStartsAtTheMostUrgentAndPutsLaterLast() {
        let walk = FocusWalk(start: nil, queue: queue, later: ["b"])
        XCTAssertEqual(walk.order, ["a", "c", "d", "b"])
        XCTAssertEqual(walk.current, "a")
        XCTAssertFalse(walk.single)
        XCTAssertEqual(walk.position, "1 of 4")
        XCTAssertFalse(walk.canGoBack)
        XCTAssertTrue(walk.canGoForward)
    }

    func testAnswerBringsTheNextOneIn() {
        var walk = FocusWalk(start: nil, queue: queue, later: [])
        walk.go(1)
        XCTAssertEqual(walk.current, "b")
        walk.noteAnswered()
        XCTAssertTrue(walk.sync(queue: ["a", "c", "d"], later: []))
        XCTAssertEqual(walk.current, "c", "the card that slid into its place")
        XCTAssertEqual(walk.position, "2 of 3")
        walk.go(1)
        walk.noteAnswered()
        walk.sync(queue: ["a", "c"], later: [])
        XCTAssertEqual(walk.current, "c", "the last card falls back to the one before")
        walk.sync(queue: [], later: [])
        XCTAssertTrue(walk.isDone)
        XCTAssertEqual(walk.position, "All answered")
        XCTAssertEqual(walk.doneText, "2 questions answered in this round. New ones show up here as soon as an agent wants to know something.")
    }

    func testBackAndNextStopAtTheEnds() {
        var walk = FocusWalk(start: nil, queue: ["a", "b"], later: [])
        XCTAssertFalse(walk.go(-1))
        XCTAssertTrue(walk.go(1))
        XCTAssertFalse(walk.go(1))
        XCTAssertEqual(walk.current, "b")
        XCTAssertTrue(walk.canGoBack)
        XCTAssertFalse(walk.canGoForward)
    }

    func testNewAndMoreUrgentCardsDoNotSwapTheOneInFront() {
        var walk = FocusWalk(start: nil, queue: ["a", "b"], later: [])
        walk.sync(queue: ["x", "a", "b"], later: [])
        XCTAssertEqual(walk.current, "a")
        XCTAssertEqual(walk.position, "2 of 3")
        XCTAssertTrue(walk.canGoBack)
    }

    func testSingleCardClosesOnTheAnswer() {
        var walk = FocusWalk(start: "c", queue: queue, later: [])
        XCTAssertTrue(walk.single)
        XCTAssertEqual(walk.current, "c")
        XCTAssertEqual(walk.position, "Question")
        XCTAssertFalse(walk.canGoBack)
        XCTAssertFalse(walk.canGoForward)
        XCTAssertFalse(walk.go(1))
        XCTAssertTrue(walk.sync(queue: ["b", "c", "d"], later: []), "other cards leaving does not close it")
        XCTAssertFalse(walk.sync(queue: ["b", "d"], later: []), "its own card left: the window closes")
    }

    func testOpeningOnACardThatIsNotOpenStartsTheWalk() {
        let walk = FocusWalk(start: "gone", queue: queue, later: [])
        XCTAssertFalse(walk.single)
        XCTAssertEqual(walk.current, "a")
    }

    func testUndoBringsTheCardBackInFront() {
        var walk = FocusWalk(start: nil, queue: queue, later: [])
        walk.noteAnswered()
        walk.sync(queue: ["b", "c", "d"], later: [])
        XCTAssertEqual(walk.current, "b")
        walk.sync(queue: queue, later: [])
        walk.noteUndone("a")
        XCTAssertEqual(walk.current, "a")
        XCTAssertEqual(walk.answered, 0)
        XCTAssertEqual(walk.doneText, "No open questions. New ones show up here as soon as an agent wants to know something.")
    }

    func testEmptyStack() {
        let walk = FocusWalk(start: nil, queue: [], later: [])
        XCTAssertTrue(walk.isDone)
        XCTAssertFalse(walk.canGoForward)
    }
}
