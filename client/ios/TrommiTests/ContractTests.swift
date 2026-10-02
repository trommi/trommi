import XCTest
#if canImport(TrommiCore)
@testable import TrommiCore
#else
@testable import Trommi
#endif

/// What the hub puts into a card since the agents can revise and merge questions, hand
/// them in as sections, and since the human can write on single options and leave a
/// draft (docs/question-contract.md). The JSON below is what server.mjs sent for cards
/// made by tools/live-seed.sh, shortened.
final class ContractDecodingTests: XCTestCase {
    private func card(_ json: String) throws -> Card {
        try XCTUnwrap(try BoardState.decode(#"{"cards":[\#(json)]}"#).cards.first)
    }

    private let sectioned = #"""
    {"id":"57fbee1d","agent":"ios-fixture","number":9,"kind":"decision","status":"open","title":"Sectioned",
     "body":"Three parts.\n\n**Raise the limit**: 60 instead of 30 seconds.\n\n**Export in the background**: The file arrives by mail.\n\n**Paginate the export**",
     "options":[{"key":"limit","label":"Raise the limit","detail":""},{"key":"async","label":"Export in the background","detail":""},{"key":"page","label":"Paginate the export","detail":""}],
     "attachments":[{"name":"sketch.png","url":"/files/sketch.png","kind":"image"},{"name":"loose.png","url":"/files/loose.png","kind":"image"}],
     "multiple":true,"recommended":["limit"],
     "sections":[{"text":"Three parts."},
       {"key":"limit","label":"Raise the limit","text":"60 instead of 30 seconds.","recommended":true},
       {"key":"async","label":"Export in the background","text":"The file arrives by mail.","recommended":false,"picture":0},
       {"key":"page","label":"Paginate the export","text":"","recommended":false,"picture":7}]}
    """#

    func testSectionsAreBlocksTiedToOptions() throws {
        let card = try card(sectioned)
        let sections = try XCTUnwrap(card.sections)
        XCTAssertEqual(sections.map(\.key), [nil, "limit", "async", "page"])
        XCTAssertEqual(sections.map(\.isOption), [false, true, true, true])
        XCTAssertEqual(sections[3].text, "", "an option that needs no explanation")
        XCTAssertEqual(sections.map(\.picture), [nil, nil, 0, nil], "a picture that is not among the attachments is dropped")

        let blocks = try XCTUnwrap(card.blocks)
        XCTAssertEqual(blocks.count, 4)
        XCTAssertEqual(blocks[0], .paragraph(index: 0, text: "Three parts."))
        guard case .option(_, let option, let text, let advised, let picture) = blocks[1] else { return XCTFail("a flagged block is an option") }
        XCTAssertEqual(option, card.options[0])
        XCTAssertEqual(text, "60 instead of 30 seconds.")
        XCTAssertTrue(advised)
        XCTAssertNil(picture)
        guard case .option(_, _, _, let second, let sketch) = blocks[2] else { return XCTFail() }
        XCTAssertFalse(second)
        XCTAssertEqual(sketch?.name, "sketch.png")
        XCTAssertEqual(card.looseAttachments.map(\.name), ["loose.png"], "what no block points at belongs to the card as a whole")
        XCTAssertEqual(blocks.map(\.id), [0, 1, 2, 3])
    }

    func testACardWithoutSectionsFallsBackToBodyAndOptions() throws {
        let plain = try card(#"{"id":"a","title":"T","body":"B","options":[{"key":"x","label":"X"},{"key":"y","label":"Y"}],"attachments":[{"url":"/files/a.png","kind":"image"}]}"#)
        XCTAssertNil(plain.sections)
        XCTAssertNil(plain.blocks)
        XCTAssertEqual(plain.looseAttachments.count, 1)
        // Not a list, an empty list, or blocks that name options the card does not have: body and options stand.
        for sections in [#""text""#, "[]", "null", #"[{"key":"nope","label":"N","text":"t"}]"#, #"[{"text":"  "}]"#] {
            let odd = try card(#"{"id":"a","body":"B","options":[{"key":"x","label":"X"}],"sections":\#(sections)}"#)
            XCTAssertNil(odd.sections, sections)
            XCTAssertEqual(odd.body, "B")
        }
        // A broken block is dropped, the others stand.
        let mixed = try card(#"{"id":"a","options":[{"key":"x","label":"X"}],"sections":[7,{"text":"Intro"},{"key":"x","text":"Why"}]}"#)
        XCTAssertEqual(mixed.sections?.map(\.text), ["Intro", "Why"])
        XCTAssertEqual(mixed.sections?.last?.label, "x", "a flagged block without a label is called by its key")
    }

    func testRevisedAndMergedCards() throws {
        let revised = try card(#"{"id":"bb790bf0","number":10,"title":"Revised","body":"Second wording.","options":[{"key":"a","label":"Anton"},{"key":"b","label":"Berta"}],"revised":1790931128306,"revisions":1}"#)
        XCTAssertEqual(revised.revised, 1_790_931_128_306)
        XCTAssertEqual(revised.revisions, 1)
        XCTAssertEqual(revised.selfNote, "revised")
        XCTAssertEqual(revised.numberLabel, "Nr. 10")

        let merged = try card(#"{"id":"260e6162","number":13,"title":"Merged","multiple":true,"options":[{"key":"one","label":"Part one"},{"key":"two","label":"Part two"}],"merged_from":[{"id":"59904e2b","number":11,"title":"Part one?"},{"id":"968c48d2","number":12,"title":"Part two?"},{"number":3}],"revised":5}"#)
        XCTAssertEqual(merged.mergedFrom.map(\.number), [11, 12], "an entry without an id is dropped")
        XCTAssertEqual(merged.mergedFrom.first?.title, "Part one?")
        XCTAssertEqual(merged.selfNote, "replaces 2 questions · revised")
        XCTAssertEqual(merged.excerpt, "replaces 2 questions · revised")

        let old = try card(#"{"id":"59904e2b","status":"done","title":"Part one?","summary":"Merged into Nr. 13: Merged","merged_into":"260e6162"}"#)
        XCTAssertEqual(old.mergedInto, "260e6162")
        XCTAssertNil(old.choice)

        let plain = try card(#"{"id":"x","revised":null}"#)
        XCTAssertNil(plain.revised)
        XCTAssertEqual(plain.selfNote, "")
        XCTAssertEqual(plain.revisions, 0)
        XCTAssertTrue(plain.mergedFrom.isEmpty)
        XCTAssertEqual(Wording.eventLabel("revised"), "Question revised")
    }

    func testOptionNotesAndNoteAttachments() throws {
        let decided = try card(#"{"id":"a","status":"decided","choice":"a","choices":["a","c"],"multiple":true,"note":"general","options":[{"key":"a","label":"Anton"},{"key":"b","label":"Berta"},{"key":"c","label":"Cesar"}],"option_notes":{"a":"but not before Monday","b":"not this, too expensive","zzz":"stray","c":""},"note_attachments":[{"name":"shot.png","url":"/files/shot.png","kind":"image"}]}"#)
        XCTAssertEqual(decided.optionNotes, ["a": "but not before Monday", "b": "not this, too expensive"], "notes on options the card has, the empty ones dropped")
        XCTAssertEqual(decided.noteAttachments.map(\.name), ["shot.png"])
        // Cards answered before notes existed have none.
        XCTAssertEqual(try card(#"{"id":"a","status":"decided","choice":"a","options":[{"key":"a","label":"A"}]}"#).optionNotes, [:])
        XCTAssertEqual(try card(#"{"id":"a","option_notes":["a"]}"#).optionNotes, [:])
    }

    func testDraftsOnOpenCardsOnly() throws {
        let open = try card(#"{"id":"a","status":"open","multiple":true,"options":[{"key":"a","label":"Anton"},{"key":"b","label":"Berta"},{"key":"c","label":"Cesar"}],"draft":{"keys":["c","a","gone"],"note":"half a sentence ","notes":{"b":"…","gone":"x"},"ts":1790930354077}}"#)
        XCTAssertEqual(open.draft, CardDraft(keys: ["a", "c"], note: "half a sentence ", notes: ["b": "…"], ts: 1_790_930_354_077),
                       "in the order of the options, the note as typed, nothing about options that are gone")
        XCTAssertNil(try card(#"{"id":"a","status":"decided","choice":"a","options":[{"key":"a","label":"A"}],"draft":{"keys":["a"],"note":"","notes":{},"ts":1}}"#).draft)
        XCTAssertNil(try card(#"{"id":"a","kind":"permission","options":[{"key":"allow","label":"Allow"}],"draft":{"keys":["allow"],"ts":1}}"#).draft)
        XCTAssertNil(try card(#"{"id":"a","options":[{"key":"a","label":"A"}],"draft":{"keys":[],"note":"  ","notes":{},"ts":1}}"#).draft, "a draft with nothing in it is none")
        XCTAssertNil(try card(#"{"id":"a","options":[{"key":"a","label":"A"}],"draft":"soon"}"#).draft)
        XCTAssertNil(try card(#"{"id":"a","options":[{"key":"a","label":"A"}]}"#).draft)
    }

    func testTheDemoBoardShowsEveryNewThing() throws {
        let state = try Fixture.multi()
        let parts = try XCTUnwrap(state.card("c-parts"))
        XCTAssertEqual(parts.sections?.count, 5)
        XCTAssertEqual(parts.mergedFrom.count, 2)
        XCTAssertEqual(parts.draft?.keys, ["start"])
        XCTAssertEqual(parts.draft?.notes, ["agents": "only once the examples are in"])
        XCTAssertEqual(state.card("c-theme")?.selfNote, "revised")
        XCTAssertEqual(state.card("c-db")?.optionNotes, ["sqlite": "fine for the tests, not for production"])
        XCTAssertEqual(state.card("c-backup")?.optionsAsTags, true)
    }
}

final class ContractLogicTests: XCTestCase {
    // MARK: rows

    func testChooseUnfoldsInTheRowUnlessTheCardNeedsAPage() {
        XCTAssertFalse(makeCard(["A", "B", "C"]).needsWindow)
        XCTAssertTrue(makeCard(["A", "B", "C"], body: String(repeating: "b", count: 481)).needsWindow)
        XCTAssertFalse(makeCard(["A", "B", "C"], body: String(repeating: "b", count: 480)).needsWindow)
        XCTAssertTrue(makeCard(["A", "B", "C"], body: "see\n```\ncode\n```").needsWindow)
        XCTAssertTrue(makeCard(["1", "2", "3", "4", "5", "6", "7"]).needsWindow, "more than six options")
        XCTAssertFalse(makeCard(["1", "2", "3", "4", "5", "6"]).needsWindow)
        XCTAssertTrue(makeCard(["A", "B", "C"], attachments: [.image, .image]).needsWindow)
        XCTAssertFalse(makeCard(["A", "B", "C"], attachments: [.image]).needsWindow)
        XCTAssertTrue(makeCard(["A", "B", "C"], attachments: [.file]).needsWindow)
        XCTAssertEqual(makeCard(["A", "B", "C"]).rowActions, .choose(inline: true, count: "3 options"))
        XCTAssertEqual(makeCard(["A", "B"], multiple: true).rowActions, .choose(inline: true, count: "2 options, several allowed"))
    }

    func testManyShortOptionsAreTags() {
        let seven = (1...7).map { "\($0) days" }
        XCTAssertTrue(makeCard(seven).optionsAsTags)
        XCTAssertFalse(makeCard(Array(seven.prefix(6))).optionsAsTags, "from seven options on")
        XCTAssertFalse(makeCard(seven.dropLast() + ["A label of nineteen."]).optionsAsTags, "no label longer than eighteen")
        XCTAssertTrue(makeCard(seven.dropLast() + ["A label, eighteen."]).optionsAsTags)
        XCTAssertFalse(makeCard(seven, kind: .permission).optionsAsTags)
    }

    func testTheSketchOfAnAnsweredQuestion() throws {
        var two = makeCard(["Delete", "Keep"], keys: ["delete", "keep"])
        two.choice = "delete"
        XCTAssertEqual(two.answeredSketch, .yes)
        two.choice = "keep"
        XCTAssertEqual(two.answeredSketch, .no)
        XCTAssertEqual(makeCard(["A", "B", "C"]).answeredSketch, .choose)
        XCTAssertEqual(makeCard(["A", "B"], multiple: true).answeredSketch, .choose)
    }

    // MARK: notes on options

    func testNotesTravelWithTheAnswerAndStayOnTheCard() throws {
        var state = try Fixture.multi()
        try state.decide(cardID: "c-next", answer: .one("encryption"), note: " go ", notes: ["encryption": " but not before Monday ", "live-log": "not this", "several-agents": "  "], now: 9)
        let card = try XCTUnwrap(state.card("c-next"))
        XCTAssertEqual(card.optionNotes, ["encryption": "but not before Monday", "live-log": "not this"], "trimmed, the empty one dropped, notes on options not chosen welcome")
        XCTAssertEqual(card.note, "go")
        XCTAssertEqual(state.messages.last?.text, "Encryption · Encryption: but not before Monday · Live log: not this")

        var other = try Fixture.multi()
        XCTAssertThrowsError(try other.decide(cardID: "c-next", answer: .one("encryption"), note: "", notes: ["nope": "x"], now: 1)) {
            XCTAssertEqual($0 as? BoardError, .unknownOption)
        }
        XCTAssertThrowsError(try other.decide(cardID: "c-next", answer: .one("encryption"), note: "", notes: ["live-log": String(repeating: "x", count: 2001)], now: 1)) {
            XCTAssertEqual($0 as? BoardError, .noteTooLong)
        }
        XCTAssertEqual(other, try Fixture.multi(), "nothing is stored on a refusal")
        XCTAssertEqual(BoardState.brief(String(repeating: "word ", count: 30)).count, 80)
        XCTAssertTrue(BoardState.brief(String(repeating: "word ", count: 30)).hasSuffix("…"))
        XCTAssertEqual(BoardState.brief("two\n  lines"), "two lines")
    }

    func testTheDecideBodyCarriesNotesAndTheWordingAnswered() throws {
        func json(_ body: [String: Any]) throws -> String {
            String(decoding: try JSONSerialization.data(withJSONObject: body, options: [.sortedKeys]), as: UTF8.self)
        }
        XCTAssertEqual(try json(Answer.one("a").body(cardID: "c", note: "", notes: ["b": " no ", "a": ""], revised: 1_790_931_128_306)),
                       #"{"card_id":"c","key":"a","note":"","notes":{"b":"no"},"revised":1790931128306}"#,
                       "the stamp is the whole number the hub sent")
        XCTAssertEqual(try json(DraftEditor.body(cardID: "c", keys: ["a"], note: "typed ", notes: ["b": " x ", "c": " "])),
                       #"{"card_id":"c","keys":["a"],"note":"typed ","notes":{"b":"x"}}"#)
    }

    // MARK: a revised question

    func testAnAnswerToAnOlderWordingIsRefused() throws {
        var state = try Fixture.multi()
        let theme = try XCTUnwrap(state.card("c-theme"))
        let stamp = try XCTUnwrap(theme.revised)
        XCTAssertThrowsError(try state.decide(cardID: "c-theme", answer: .one("dark"), note: "", seen: .some(stamp - 1), now: 1)) {
            XCTAssertEqual($0 as? BoardError, .revised)
        }
        XCTAssertThrowsError(try state.decide(cardID: "c-theme", answer: .one("dark"), note: "", seen: .some(nil), now: 1)) {
            XCTAssertEqual($0 as? BoardError, .revised, "the human saw the question before it was ever revised")
        }
        // An option that is gone since the revision is the same story, said the same way.
        XCTAssertThrowsError(try state.decide(cardID: "c-theme", answer: .one("sepia"), note: "", seen: .some(stamp), now: 1)) {
            XCTAssertEqual($0 as? BoardError, .revised)
        }
        XCTAssertEqual(state, try Fixture.multi())
        try state.decide(cardID: "c-theme", answer: .one("dark"), note: "", seen: .some(stamp), now: 1)
        XCTAssertEqual(state.card("c-theme")?.choice, "dark")
        // A client that names no wording is not checked, as on the hub.
        var loose = try Fixture.multi()
        try loose.decide(cardID: "c-theme", answer: .one("dark"), note: "", now: 1)
        // A card that was never revised takes any stamp.
        try loose.decide(cardID: "c-nav", answer: .one("keep"), note: "", seen: .some(12), now: 1)
        XCTAssertEqual(BoardError.translate("the agent revised this question while you were answering; nothing was sent, read it again and answer once more"),
                       "The agent revised this question while you were answering. Nothing was sent: read it again and answer once more.")
    }

    // MARK: drafts

    func testSetDraftReplacesTheWholeDraftAndAnEmptyOneClearsIt() throws {
        var state = try Fixture.multi()
        XCTAssertTrue(try state.setDraft(cardID: "c-next", keys: ["live-log", "nope", "encryption"], note: "half ", notes: ["live-log": " later ", "nope": "x"], now: 7))
        XCTAssertEqual(state.card("c-next")?.draft, CardDraft(keys: ["encryption", "live-log"], note: "half ", notes: ["live-log": "later"], ts: 7))
        XCTAssertFalse(try state.setDraft(cardID: "c-next", keys: ["encryption", "live-log"], note: "half ", notes: ["live-log": "later"], now: 8), "the same draft again is a no-op")
        XCTAssertEqual(state.card("c-next")?.draft?.ts, 7)
        XCTAssertTrue(try state.setDraft(cardID: "c-next", keys: [], note: "  ", notes: [:], now: 9))
        XCTAssertNil(state.card("c-next")?.draft)
        XCTAssertFalse(try state.setDraft(cardID: "c-next", keys: [], note: "", notes: [:], now: 10))

        XCTAssertThrowsError(try state.setDraft(cardID: "nope", keys: [], note: "", notes: [:], now: 1)) { XCTAssertEqual($0 as? BoardError, .unknownCard) }
        XCTAssertThrowsError(try state.setDraft(cardID: "c-perm", keys: ["allow"], note: "", notes: [:], now: 1)) { XCTAssertEqual($0 as? BoardError, .noDraft) }
        XCTAssertThrowsError(try state.setDraft(cardID: "c-db", keys: ["pg"], note: "", notes: [:], now: 1)) { XCTAssertEqual($0 as? BoardError, .alreadyDecided) }
        XCTAssertThrowsError(try state.setDraft(cardID: "c-next", keys: [], note: String(repeating: "x", count: 10_001), notes: [:], now: 1)) { XCTAssertEqual($0 as? BoardError, .noteTooLong) }
    }

    func testAnAnswerDropsTheDraftAndTakingItBackMakesItTheDraft() throws {
        var state = try Fixture.multi()
        XCTAssertNotNil(state.card("c-parts")?.draft)
        try state.decide(cardID: "c-parts", answer: .several(["board", "start"]), note: "both", notes: ["agents": "later"], now: 5)
        XCTAssertNil(state.card("c-parts")?.draft)
        try state.reopen(cardID: "c-parts", now: 6)
        let back = try XCTUnwrap(state.card("c-parts"))
        XCTAssertEqual(back.status, .open)
        XCTAssertEqual(back.draft, CardDraft(keys: ["start", "board"], note: "both", notes: ["agents": "later"], ts: 6))
        XCTAssertEqual(back.optionNotes, [:])
        XCTAssertEqual(back.note, "")
    }

    func testTheDraftEditorAdoptsTheHubsDraftUnlessTheHumanIsTyping() throws {
        let state = try Fixture.multi()
        var card = try XCTUnwrap(state.card("c-parts"))
        var editor = DraftEditor(card: card)
        XCTAssertEqual(editor.keys, ["start"])
        XCTAssertEqual(editor.notes, ["agents": "only once the examples are in"])
        XCTAssertTrue(editor.matches(card.draft, card: card))
        XCTAssertFalse(editor.sync(card: card, typing: false), "the same draft changes nothing")

        // The human ticks and writes: nothing to adopt, something to send.
        editor.toggle("board", multiple: true)
        editor.setNote("typing", on: "admin")
        editor.note = "almost"
        XCTAssertFalse(editor.matches(card.draft, card: card))
        XCTAssertEqual(editor.picked(of: card).map(\.key), ["start", "board"])
        XCTAssertFalse(editor.sync(card: card, typing: false), "a state that carries the draft it came from leaves the ticks alone")
        XCTAssertEqual(editor.keys, ["start", "board"])

        // Another device changed the draft: adopted, but not while the human is typing here.
        card.draft = CardDraft(keys: ["admin"], note: "from the phone", notes: [:], ts: (card.draft?.ts ?? 0) + 1)
        XCTAssertFalse(editor.sync(card: card, typing: true))
        XCTAssertEqual(editor.note, "almost")
        XCTAssertTrue(editor.sync(card: card, typing: false))
        XCTAssertEqual(editor.keys, ["admin"])
        XCTAssertEqual(editor.note, "from the phone")
        XCTAssertEqual(editor.notes, [:])

        // The agent revised the card and an option went: ticks and notes on it go, whoever is typing.
        editor.toggle("board", multiple: true)
        editor.setNote("keep", on: "start")
        card.options.removeAll { $0.key == "board" || $0.key == "start" }
        XCTAssertTrue(editor.sync(card: card, typing: true))
        XCTAssertEqual(editor.keys, ["admin"])
        XCTAssertEqual(editor.notes, [:])

        // Cleared elsewhere (answered and taken back, or emptied): this copy empties too.
        card.draft = nil
        XCTAssertTrue(editor.sync(card: card, typing: false))
        XCTAssertTrue(editor.isEmpty)
        XCTAssertTrue(editor.matches(nil, card: card))

        // One answer only: a tick replaces the one before; a second tap takes it away.
        var one = DraftEditor()
        one.toggle("a", multiple: false)
        one.toggle("b", multiple: false)
        XCTAssertEqual(one.keys, ["b"])
        one.toggle("b", multiple: false)
        XCTAssertTrue(one.keys.isEmpty)
        one.setNote("x", on: "a")
        one.setNote("", on: "a")
        XCTAssertTrue(one.isEmpty)
    }

    // MARK: later, with the agent, answered

    func testACardHandedToItsAgentComesBackWithTheReply() throws {
        var state = try Fixture.multi()
        var later = LaterList()
        later.putOff(try XCTUnwrap(state.card("c-next")))
        later.putOff(try XCTUnwrap(state.card("c-migrate")), asked: 1000)
        XCTAssertEqual(later.handed, ["c-migrate"])
        XCTAssertTrue(later.isHanded("c-migrate"))
        XCTAssertFalse(later.isHanded("c-next"))

        let inbox = state.inbox(later: later)
        XCTAssertEqual(inbox.later.map(\.card.id), ["c-next"])
        XCTAssertEqual(inbox.handed.map(\.card.id), ["c-migrate"])
        XCTAssertEqual(inbox.laterCountLabel, "1 put off")
        XCTAssertEqual(inbox.handedCountLabel, "1 asked")
        XCTAssertFalse(inbox.fresh.contains { $0.id == "c-migrate" || $0.id == "c-next" })
        XCTAssertEqual(state.freshCount(later: later), 7)

        // The human's own message about it, an event, an older reply: it stays with the agent.
        state.messages.append(Message(id: "u", agent: "api", from: .user, kind: "", cardID: "c-migrate", text: "Why?", details: "", attachments: [], ts: 2000))
        state.messages.append(Message(id: "e", agent: "api", from: .event, kind: "urgency", cardID: "c-migrate", text: "x", details: "", attachments: [], ts: 2000))
        state.messages.append(Message(id: "old", agent: "api", from: .agent, kind: "", cardID: "c-migrate", text: "Earlier", details: "", attachments: [], ts: 900))
        XCTAssertFalse(later.prune(cards: state.cards, messages: state.messages))
        // The session answered about it: it returns to its sender's group. The plain "Later" stays.
        state.messages.append(Message(id: "r", agent: "api", from: .agent, kind: "", cardID: "c-migrate", text: "Because.", details: "", attachments: [], ts: 3000))
        XCTAssertTrue(later.prune(cards: state.cards, messages: state.messages))
        XCTAssertEqual(later.ids, ["c-next"])
    }

    func testTheLaterListOfTheLastVersionStillReads() throws {
        let old = Data(#"{"entries":[{"id":"c-theme","rank":1}]}"#.utf8)
        let list = LaterList.decoded(old)
        XCTAssertEqual(list.ids, ["c-theme"])
        XCTAssertEqual(list.handed, [])
        var now = list
        now.putOff(makeCard(["a", "b"], id: "c-x"), asked: 55)
        XCTAssertEqual(LaterList.decoded(now.encoded()), now)
        XCTAssertEqual(LaterList.decoded(now.encoded()).entries.last?.asked, 55)
    }

    func testAnsweredQuestionsLieAtTheFootOfTheInbox() throws {
        var state = try Fixture.multi()
        var inbox = state.inbox(later: LaterList())
        XCTAssertEqual(inbox.answered.map(\.card.id), ["c-db", "c-name", "c-port"], "the latest first; a permission and a withdrawn card are not among them")
        XCTAssertEqual(inbox.answered.map(\.answer), ["Postgres", "Agent Board", "8790"])
        XCTAssertEqual(inbox.answered.map(\.closed), [false, true, true])
        XCTAssertEqual(inbox.answered.first?.sender?.id, "api")
        XCTAssertEqual(inbox.piles, [.answered])
        XCTAssertEqual(inbox.top(of: .answered)?.title, "Which database?")
        XCTAssertEqual(inbox.top(of: .answered)?.tail, "Postgres")

        let decided = try XCTUnwrap(state.card("c-db")?.decided)
        var utc = Calendar(identifier: .gregorian)
        utc.timeZone = try XCTUnwrap(TimeZone(identifier: "UTC"))
        XCTAssertEqual(inbox.answeredCountLabel(now: decided + 60_000, calendar: utc), "2 today · 3 in all", "two were answered on 2 October (UTC), one the evening before")
        XCTAssertEqual(inbox.answeredCountLabel(now: decided + 40 * 86_400_000, calendar: utc), "3")

        try state.decide(cardID: "c-nav", key: "keep", note: "", now: decided + 120_000)
        var later = LaterList()
        later.putOff(try XCTUnwrap(state.card("c-next")))
        later.putOff(try XCTUnwrap(state.card("c-theme")), asked: 5)
        inbox = state.inbox(later: later)
        XCTAssertEqual(inbox.answered.first?.card.id, "c-nav")
        XCTAssertEqual(inbox.piles, [.later, .handed, .answered])
        XCTAssertEqual(inbox.piles.map(\.title), ["Later", "With the agent", "Answered"])
        XCTAssertEqual(inbox.piles.map(\.sketch), [.later, .explain, .yes])
        XCTAssertEqual(inbox.top(of: .later)?.tail, "Web frontend · Nr. 4")
        XCTAssertEqual(inbox.count(of: .handed, now: 0), "1 asked")
        XCTAssertTrue(state.inbox(later: later, session: "api").answered.isEmpty, "only in the inbox of the whole board")
        XCTAssertNil(state.inbox(later: later, session: "api").top(of: .later))

        // Only the latest forty are listed.
        var many = state
        for i in 0..<50 {
            var card = makeCard(["A", "B"], id: "extra-\(i)")
            card.status = .decided
            card.choice = "k0"
            card.decided = Double(i)
            many.cards.append(card)
        }
        XCTAssertEqual(many.inbox(later: LaterList()).answered.count, InboxModel.answeredMax)
    }

    // MARK: links by number

    func testALinkNamesAQuestionByItsNumber() throws {
        let state = try Fixture.multi()
        XCTAssertEqual(DeepLink.parse("http://host:8790/?q=9"), .question("9"))
        XCTAssertEqual(DeepLink.parse("trommi://open?q=102"), .question("102"))
        XCTAssertEqual(DeepLink.parse("https://board.example/s/api/questions?x=1&q=c-nav"), .question("c-nav"))
        XCTAssertEqual(DeepLink.parse("https://board.example/?q=next"), .walk)
        XCTAssertNil(DeepLink.parse("https://board.example/"))
        XCTAssertNil(DeepLink.parse("https://board.example/?q="))
        XCTAssertNil(DeepLink.parse("https://board.example/?t=secret"))

        XCTAssertEqual(state.card(named: "9")?.id, "c-nav", "by number")
        XCTAssertEqual(state.card(named: "c-nav")?.id, "c-nav", "older links carry the id")
        XCTAssertNil(state.card(named: "999"))
        XCTAssertNil(state.card(named: ""))
        XCTAssertEqual(state.target(of: .question("9")), .card("c-nav"))
        XCTAssertEqual(state.target(of: .walk), .walk)
        XCTAssertNil(state.target(of: .question("nope")))
        // A card whose id is all digits is still found when no card has that number.
        let odd = try BoardState.decode(#"{"cards":[{"id":"777","number":3,"options":[]}]}"#)
        XCTAssertEqual(odd.card(named: "777")?.number, 3)

        let link = try ServerLink.parse("http://192.168.1.20:8790/?t=secret")
        XCTAssertEqual(link.questionURL(number: 102)?.absoluteString, "http://192.168.1.20:8790/?q=102", "for sharing: no token in it")
        XCTAssertEqual(link.padURL?.absoluteString, "http://192.168.1.20:8790/pad?t=secret", "the in-app browser signs in on the way to the pad")
        XCTAssertNil(link.signedInURL(path: "//elsewhere.example/pad"))
    }

    // MARK: the rail of the walk

    func testTheRailShowsHowFarTheWalkIs() {
        var walk = FocusWalk(start: nil, queue: ["a", "b", "c", "d"], later: ["b"])
        XCTAssertEqual(walk.rail(later: ["b"]).map(\.id), ["a", "c", "d", "b"])
        XCTAssertEqual(walk.rail(later: ["b"]).map(\.state), [.open, .open, .open, .later])
        XCTAssertEqual(walk.rail(later: ["b"]).map(\.front), [true, false, false, false])
        XCTAssertEqual(walk.leftLabel, "4 left")

        // "a" was answered, "d" withdrawn by its agent.
        walk.noteAnswered()
        walk.sync(queue: ["b", "c"], later: ["b"], answered: ["a"])
        XCTAssertEqual(walk.rail(later: ["b"]).map(\.id), ["a", "c", "b"])
        XCTAssertEqual(walk.rail(later: ["b"]).map(\.state), [.done, .open, .later])
        XCTAssertEqual(walk.current, "c")
        XCTAssertEqual(walk.leftLabel, "2 left")

        // A tap on a mark goes there; a mark that is not in the walk does nothing.
        XCTAssertTrue(walk.go(to: "b"))
        XCTAssertEqual(walk.rail(later: ["b"]).last?.front, true)
        XCTAssertFalse(walk.go(to: "a"))
        XCTAssertFalse(walk.go(to: "zzz"))

        // Taken back: open again, no tick. A new question joins at its place in the stack.
        walk.sync(queue: ["a", "b", "c", "e"], later: ["b"], answered: [])
        XCTAssertEqual(walk.rail(later: ["b"]).map(\.id), ["a", "c", "e", "b"])
        XCTAssertTrue(walk.rail(later: ["b"]).allSatisfy { $0.state != .done })

        // One card, or a single-card window: no rail.
        XCTAssertTrue(FocusWalk(start: "a", queue: ["a", "b"], later: []).rail(later: []).isEmpty)
        XCTAssertTrue(FocusWalk(start: nil, queue: ["a"], later: []).rail(later: []).isEmpty)
        var last = FocusWalk(start: nil, queue: ["a", "b"], later: [])
        last.sync(queue: ["b"], later: [], answered: ["a"])
        XCTAssertEqual(last.rail(later: []).map(\.state), [.done, .open], "an answered one and one left are still a rail")
    }
}
