import XCTest
#if canImport(TrommiCore)
@testable import TrommiCore
#else
@testable import Trommi
#endif

final class SessionTests: XCTestCase {
    // MARK: label and icon

    func testLabelIsShownInsteadOfTheName() {
        XCTAssertEqual(Agent(id: "x", name: "trommi", label: "iOS App").displayName, "iOS App")
        XCTAssertEqual(Agent(id: "x", name: "trommi").displayName, "trommi")
        XCTAssertEqual(Agent(id: "x", name: "trommi", icon: "x:4").mark, "x:4")
        XCTAssertEqual(Agent(id: "x", name: "trommi").mark, "x")
    }

    func testEditClearsLabelAndIconWhenTheyAreTheSessionsOwn() {
        let agent = Agent(id: "api", name: "api", label: "API", icon: "api:2")
        XCTAssertEqual(agent.edit(name: "  Backend ", mark: "api:7"), SessionChanges(label: "Backend", icon: "api:7"))
        XCTAssertEqual(agent.edit(name: "api", mark: "api"), SessionChanges(label: "", icon: ""), "back to what the session calls itself")
        XCTAssertEqual(agent.edit(name: "", mark: "api:2"), SessionChanges(label: "", icon: "api:2"), "an emptied name falls back to the session's own")
    }

    func testMarkChoicesStartWithTheCurrentMark() {
        let plain = Agent(id: "api", name: "api")
        XCTAssertEqual(plain.markChoices.count, 12)
        XCTAssertEqual(plain.markChoices.first, "api")
        XCTAssertEqual(plain.markChoices[1], "api:1")
        let picked = Agent(id: "api", name: "api", icon: "api:3")
        XCTAssertEqual(picked.markChoices.first, "api:3")
        XCTAssertEqual(picked.markChoices.count, 11, "the current mark is not offered twice")
    }

    func testSessionBodyAsTheServerReadsIt() throws {
        func json(_ changes: SessionChanges) throws -> String {
            String(decoding: try JSONSerialization.data(withJSONObject: changes.body(agent: "a"), options: [.sortedKeys]), as: UTF8.self)
        }
        XCTAssertEqual(try json(SessionChanges(label: "L", icon: "a:1")), #"{"agent":"a","icon":"a:1","label":"L"}"#)
        XCTAssertEqual(try json(SessionChanges(archived: true)), #"{"agent":"a","archived":true}"#)
        XCTAssertEqual(try json(SessionChanges(group: .set("g1"))), #"{"agent":"a","group":"g1"}"#)
        XCTAssertEqual(try json(SessionChanges(group: .remove)), #"{"agent":"a","group":null}"#, "null takes a session out of its group")
        XCTAssertEqual(try json(SessionChanges()), #"{"agent":"a"}"#)
    }

    func testEditSessionLikeTheServer() throws {
        var state = try Fixture.multi()
        try state.editSession("api", SessionChanges(label: "  " + String(repeating: "x", count: 70), icon: String(repeating: "i", count: 90)))
        XCTAssertEqual(state.agent("api")?.label.count, 60)
        XCTAssertEqual(state.agent("api")?.icon.count, 80)
        try state.editSession("api", SessionChanges(label: ""))
        XCTAssertEqual(state.agent("api")?.displayName, "api")
        XCTAssertThrowsError(try state.editSession("nobody", SessionChanges(label: "x"))) { XCTAssertEqual($0 as? BoardError, .unknownAgent) }
        try state.star("web-frontend", true)
        XCTAssertEqual(state.agent("web-frontend")?.starred, true)
    }

    // MARK: archive

    func testArchiveHidesASessionAndItsQuestions() throws {
        var state = try Fixture.multi()
        XCTAssertThrowsError(try state.editSession("api", SessionChanges(archived: true))) { XCTAssertEqual($0 as? BoardError, .onlineNotArchived) }
        try state.editSession("infrastructure", SessionChanges(archived: true))
        XCTAssertFalse(state.sessions.contains { $0.id == "infrastructure" })
        XCTAssertEqual(state.archivedSessions.map(\.id), ["infrastructure", "old-spike"])
        XCTAssertFalse(state.queue.contains("c-backup"))
        XCTAssertFalse(state.sessionUnits.contains { $0.id == "infrastructure" })
        try state.editSession("old-spike", SessionChanges(archived: false))
        XCTAssertTrue(state.queue.contains("c-spike"), "fetched back, its question is asked again")
        XCTAssertEqual(state.sessions.count, 5)
    }

    // MARK: groups

    func testSessionsSharingAGroupAreOneUnit() throws {
        let state = try Fixture.multi()
        XCTAssertEqual(state.groups.map(\.id), ["g-docs"])
        XCTAssertEqual(state.groups[0].members.map(\.id), ["docs", "docs-review"])
        let units = state.sessionUnits
        XCTAssertEqual(units.map(\.id), ["web-frontend", "api", "infrastructure", "g-docs"])
        let pair = try XCTUnwrap(units.last)
        XCTAssertTrue(pair.isGroup)
        XCTAssertEqual(pair.name, "docs + docs")
        XCTAssertEqual(pair.open, 2)
        XCTAssertEqual(pair.taskLine, "Write the handbook · Review the handbook")
        XCTAssertEqual(state.sessionUnit("docs-review")?.id, "g-docs", "a member leads to its group")
        XCTAssertEqual(state.sessionUnit("g-docs")?.members.count, 2)
        XCTAssertEqual(state.sessionUnit("api")?.members.map(\.id), ["api"])
        XCTAssertNil(state.sessionUnit("old-spike"), "archived sessions are no unit")
    }

    func testAGroupOfOneIsJustASession() throws {
        var state = try Fixture.multi()
        try state.editSession("docs-review", SessionChanges(group: .remove))
        XCTAssertTrue(state.groups.isEmpty)
        XCTAssertEqual(state.sessionUnits.map(\.id), ["web-frontend", "api", "infrastructure", "docs", "docs-review"])
        // The other member archived: the one left is alone too.
        var other = try Fixture.multi()
        try other.editSession("infrastructure", SessionChanges(group: .set("g-docs")))
        try other.editSession("infrastructure", SessionChanges(archived: true))
        XCTAssertEqual(other.groups[0].members.map(\.id), ["docs", "docs-review"])
    }

    func testPairing() throws {
        let state = try Fixture.multi()
        func text(_ changes: [(agent: String, group: String?)]) -> [String] { changes.map { "\($0.agent)=\($0.group ?? "nil")" } }
        XCTAssertEqual(text(state.pairing("api", with: "web-frontend", newGroup: "g-new")), ["web-frontend=g-new", "api=g-new"])
        XCTAssertEqual(text(state.pairing("api", with: "docs", newGroup: "g-new")), ["docs=g-docs", "api=g-docs"], "joins the group the other is in")
        XCTAssertEqual(text(state.pairing("docs", with: "api", newGroup: "g-new")), ["docs-review=nil", "api=g-new", "docs=g-new"],
                       "whoever is left behind alone is on its own again")
        XCTAssertTrue(state.pairing("docs", with: "docs-review", newGroup: "g-new").isEmpty, "already together")
        XCTAssertTrue(state.pairing("api", with: "api", newGroup: "g-new").isEmpty)
        XCTAssertTrue(state.pairing("api", with: "old-spike", newGroup: "g-new").isEmpty, "not with an archived session")
        XCTAssertEqual(text(state.unpairing("docs")), ["docs=nil", "docs-review=nil"], "a group of two dissolves")
        XCTAssertTrue(state.unpairing("api").isEmpty)

        var three = state
        try three.editSession("api", SessionChanges(group: .set("g-docs")))
        XCTAssertEqual(text(three.unpairing("api")), ["api=nil"])
        XCTAssertTrue(BoardState.newGroupID(now: 1_790_920_558_695, random: 12345).hasPrefix("g"))
    }

    // MARK: what a session needs

    func testUnitsAndBadges() throws {
        let state = try Fixture.multi()
        let api = try XCTUnwrap(state.sessionUnit("api"))
        XCTAssertEqual(api.open, 2)
        XCTAssertTrue(api.online)
        XCTAssertTrue(api.running)
        XCTAssertTrue(api.stuck, "a blocking question or a permission")
        XCTAssertEqual(api.badge, .waiting(open: 2, offline: false))
        XCTAssertEqual(api.badge.title, "Waiting for you: 2 questions")
        XCTAssertEqual(api.tasks.map(\.taskID), ["deploy", "tests"])
        XCTAssertTrue(api.starred)

        let web = try XCTUnwrap(state.sessionUnit("web-frontend"))
        XCTAssertEqual(web.badge, .running(open: 4))
        XCTAssertEqual(web.badge.title, "Working, 4 questions open")

        let infra = try XCTUnwrap(state.sessionUnit("infrastructure"))
        XCTAssertEqual(infra.badge, .open(1))
        XCTAssertEqual(infra.badge.title, "Disconnected, 1 question open")

        let docs = try XCTUnwrap(state.sessionUnit("g-docs"))
        XCTAssertEqual(docs.badge, .running(open: 2), "one member works, so the pair does")
    }

    func testBadgeRules() {
        func unit(open: Int, online: Bool, running: Bool, stuck: Bool) -> SessionUnit {
            SessionUnit(id: "u", members: [], open: open, tasks: [], online: online, running: running, stuck: stuck)
        }
        XCTAssertEqual(unit(open: 0, online: true, running: false, stuck: false).badge, SessionBadge.quiet)
        XCTAssertEqual(unit(open: 0, online: true, running: true, stuck: false).badge, .running(open: 0))
        XCTAssertEqual(unit(open: 0, online: true, running: true, stuck: false).badge.title, "Working")
        XCTAssertEqual(unit(open: 1, online: true, running: false, stuck: false).badge, .waiting(open: 1, offline: false),
                       "connected, not working, a question open: it waits for the human")
        XCTAssertEqual(unit(open: 1, online: false, running: false, stuck: true).badge, .waiting(open: 1, offline: true))
        XCTAssertEqual(unit(open: 1, online: false, running: false, stuck: true).badge.title, "Disconnected, was waiting for you: 1 question")
        XCTAssertEqual(unit(open: 0, online: false, running: true, stuck: false).badge, SessionBadge.quiet)
    }

    func testTellApart() throws {
        let state = try Fixture.multi()
        XCTAssertEqual(state.tellApart(), ["docs": "demo/docs", "docs-review": "demo/docs-review"], "same name: the folder tells them apart")
        let json = """
        {"agents": [{"id": "a", "name": "x", "cwd": "/p/one", "host": "left"}, {"id": "a-2", "name": "x", "cwd": "/p/one", "host": "right"},
                    {"id": "b", "name": "y"}, {"id": "b-2", "name": "y"}, {"id": "c", "name": "z"}]}
        """
        let lines = try BoardState.decode(json).tellApart()
        XCTAssertEqual(lines["a"], "left", "same folder: the machine")
        XCTAssertEqual(lines["a-2"], "right")
        XCTAssertEqual(lines["b"], "b", "nothing differs: the id")
        XCTAssertNil(lines["c"])
    }

    func testFactsAndStateLine() throws {
        let state = try Fixture.multi()
        let now = 1_790_920_558_695.0
        let api = try XCTUnwrap(state.agent("api"))
        let facts = api.facts(open: 2, now: now)
        XCTAssertEqual(facts.map(\.term), ["Model", "Machine", "Folder", "Program", "Open questions", "Connected since"])
        XCTAssertEqual(facts.map(\.shown), ["Claude Opus 5.5", "build-box · Linux x64", "/home/demo/api", "claude-code 2.1.0", "2", "2 h ago"])
        XCTAssertEqual(api.stateLine(now: now), "connected")
        let infra = try XCTUnwrap(state.agent("infrastructure"))
        XCTAssertEqual(infra.stateLine(now: now), "disconnected, last seen 5 min ago")
        XCTAssertEqual(infra.facts(open: 1, now: now).last?.shown, "unknown")
        XCTAssertEqual(Agent(id: "x", name: "x").facts(open: 0, now: now).map(\.shown), ["unknown", "unknown", "unknown", "unknown", "0", "unknown"])
        XCTAssertEqual(state.connectedLine, "4 of 5 sessions are connected.")
    }

    func testHue() {
        // hueOf('api') in agents.js: ((97*31 + 112)*31 + 105) % 8 = 96634 % 8 = 2
        XCTAssertEqual(Agent(id: "api", name: "").hue, 262)
        XCTAssertEqual(Agent(id: "", name: "").hue, 162)
    }
}

final class ConversationTests: XCTestCase {
    private let now = 1_790_920_558_695.0
    private var utc: Calendar {
        var calendar = Calendar(identifier: .gregorian)
        calendar.timeZone = TimeZone(identifier: "UTC") ?? .current
        return calendar
    }

    private func kinds(_ items: [ConversationItem]) -> [String] {
        items.map { item in
            switch item {
            case .day(_, let label): return "day:\(label)"
            case .user(let m): return "user:\(m.id)"
            case .agent(let m, let continued): return "agent:\(m.id)\(continued ? "+" : "")"
            case .question(_, let card): return "question:\(card.id)"
            case .event(let m, _): return "event:\(m.kind)"
            }
        }
    }

    func testOpenQuestionsStandInTheConversationWhereTheyWereAsked() throws {
        let state = try Fixture.multi()
        XCTAssertEqual(kinds(state.conversationItems(of: "web-frontend", now: now, calendar: utc)), [
            "day:Today", "agent:w1", "question:c-next", "question:c-theme", "agent:m8", "question:c-phone", "question:c-nav", "event:urgency",
        ])
        XCTAssertEqual(kinds(state.conversationItems(of: "api", now: now, calendar: utc)), [
            "day:Today", "user:m1", "agent:m2", "event:asked", "event:decided", "agent:m5", "user:m10", "agent:m11", "question:c-migrate", "user:m13",
        ], "a question that was answered shrinks to one line")
    }

    func testAnsweringTurnsTheRowIntoALine() throws {
        var state = try Fixture.multi()
        try state.decide(cardID: "c-nav", key: "keep", note: "", now: now)
        let items = kinds(state.conversationItems(of: "web-frontend", now: now, calendar: utc))
        XCTAssertFalse(items.contains("question:c-nav"))
        XCTAssertEqual(items.suffix(3), ["event:asked", "event:urgency", "event:decided"])
    }

    func testDayBreaksAndGrouping() throws {
        let day = 86_400_000.0
        let json = """
        {"messages": [
          {"id": "a", "from": "agent", "text": "one", "ts": \(now - 2 * day)},
          {"id": "b", "from": "agent", "text": "two", "ts": \(now - 2 * day + 60000)},
          {"id": "c", "from": "agent", "text": "late", "ts": \(now - 2 * day + 600000)},
          {"id": "d", "from": "user", "text": "hi", "ts": \(now - day)},
          {"id": "e", "from": "agent", "text": "now", "ts": \(now)}
        ]}
        """
        let state = try BoardState.decode(json)
        XCTAssertEqual(kinds(state.conversationItems(of: "main", now: now, calendar: utc)), [
            "day:Wednesday, 30 September", "agent:a", "agent:b+", "agent:c", "day:Yesterday", "user:d", "day:Today", "agent:e",
        ])
        let ids = state.conversationItems(of: "main", now: now, calendar: utc).map(\.id)
        XCTAssertEqual(Set(ids).count, ids.count, "ids are unique for the list")
    }

    func testAgentIsWorking() throws {
        var state = try Fixture.multi()
        XCTAssertTrue(state.agentIsWorking("api", now: now), "the human wrote a minute ago and nothing came back")
        XCTAssertFalse(state.agentIsWorking("api", now: now + 11 * 60_000))
        XCTAssertFalse(state.agentIsWorking("web-frontend", now: now))
        try state.addUserMessage("ping", agent: "docs", now: now)
        XCTAssertTrue(state.agentIsWorking("docs", now: now + 1000))
    }

    func testHistoryPutsWhatIsInProgressFirst() throws {
        var state = try Fixture.multi()
        XCTAssertEqual(state.history(of: "infrastructure").map(\.card.id), ["c-name", "c-port"], "the latest answer first")
        XCTAssertEqual(state.historyCountLabel(of: "infrastructure"), "2 done")
        let db = try XCTUnwrap(state.history(of: "api").first)
        XCTAssertEqual(db.pick, "Postgres")
        XCTAssertEqual(db.outcome, "in progress")
        XCTAssertTrue(db.canAnswerAgain)
        XCTAssertEqual(db.footnote, "Question 3 · Normal")
        XCTAssertEqual(state.historyCountLabel(of: "api"), "1 in progress")
        XCTAssertEqual(state.history(of: "infrastructure")[0].outcome, "Folder and package.json renamed")

        try state.decide(cardID: "c-perm", key: "deny", note: "", now: now)
        let rows = state.history(of: "api")
        XCTAssertEqual(rows.map(\.card.id), ["c-db", "c-perm"], "decided before done")
        XCTAssertFalse(rows[1].canAnswerAgain, "a permission cannot be answered again")
        XCTAssertEqual(rows[1].outcome, "done")
        XCTAssertEqual(rows[1].footnote, "Question 8 · Permission")
        XCTAssertEqual(state.historyCountLabel(of: "api"), "1 in progress · 1 done")

        let withdrawn = try BoardState.decode(#"{"cards": [{"id": "w", "status": "done", "summary": "moot", "options": [{"key": "a", "label": "A"}]}]}"#)
        XCTAssertEqual(withdrawn.history(of: "main")[0].pick, "No answer")
        XCTAssertFalse(withdrawn.history(of: "main")[0].canAnswerAgain)
    }

    func testFilesListsAttachmentsAndLinksNewestFirst() throws {
        let state = try Fixture.multi()
        let web = state.files(of: "web-frontend")
        XCTAssertEqual(web.map(\.name), ["phone-gespraech.png", "phone-entscheidungen.png", "board-desktop.png", "thema-hell.png", "thema-dunkel.png"])
        XCTAssertEqual(web[0].origin, "How should the board start on a phone?")
        XCTAssertNil(web[2].origin, "sent with a message")
        XCTAssertTrue(web.allSatisfy(\.isPicture))
        XCTAssertEqual(web[0].kind.label, "Picture")
        XCTAssertEqual(web[0].attachment?.kind, .image)

        let docs = state.files(of: "docs")
        XCTAssertEqual(docs.count, 1)
        XCTAssertEqual(docs[0].kind, .link)
        XCTAssertEqual(docs[0].kind.label, "Link")
        XCTAssertTrue(docs[0].name.hasPrefix("localhost:8790/a/q3n0XWb1kq0lYb6m3v8K2A#"))
        XCTAssertNil(docs[0].attachment)
        XCTAssertTrue(state.files(of: "docs-review").isEmpty)
    }

    func testFilesAreListedOnce() throws {
        let json = """
        {"messages": [
          {"id": "1", "from": "agent", "text": "see https://example.org/a. and (https://example.org/b) again https://example.org/a", "ts": 5},
          {"id": "2", "from": "user", "text": "mine https://example.org/user", "ts": 6,
           "attachments": [{"kind": "scribble", "id": "abc", "name": "Scribble abc", "url": "/scribbles/abc.png", "image": true}]},
          {"id": "3", "from": "agent", "text": "", "ts": 7, "attachments": [{"name": "clip.mp4", "url": "/files/clip.mp4", "kind": "video"}, {"name": "a.pdf", "url": "/files/a.pdf", "kind": "file"}]}
        ]}
        """
        let files = try BoardState.decode(json).files(of: "main")
        XCTAssertEqual(files.map(\.url), ["/files/clip.mp4", "/files/a.pdf", "/scribbles/abc.png", "https://example.org/a", "https://example.org/b"])
        XCTAssertEqual(files.map(\.kind), [.video, .file, .scribble, .link, .link], "links the human wrote are not files of the session")
        XCTAssertEqual(files[2].kind.label, "Your scribble")
        XCTAssertTrue(files[2].isPicture)
        XCTAssertEqual(files[3].name, "example.org/a")
    }

    func testLinks() {
        XCTAssertEqual(Links.find(in: "a http://x.org/a?b=1#c, b https://y.org/z] c"), ["http://x.org/a?b=1#c", "https://y.org/z"])
        XCTAssertEqual(Links.find(in: "https://first.org then http://second.org"), ["https://first.org", "http://second.org"])
        XCTAssertEqual(Links.find(in: "http:// alone and https://"), [])
        XCTAssertEqual(Links.find(in: "no link"), [])
        XCTAssertEqual(Links.withoutScheme("https://x.org/a"), "x.org/a")
    }

    func testAssetLinksLeadToTheBoardFromAPhone() throws {
        let board = try ServerLink.parse("http://192.168.1.20:8790/?t=demo")
        XCTAssertEqual(board.destination(of: "http://localhost:8790/a/abc#key")?.absoluteString, "http://192.168.1.20:8790/a/abc#key",
                       "the server writes its own localhost address; from a phone that is the board")
        XCTAssertEqual(board.destination(of: "http://localhost:3000/x")?.absoluteString, "http://localhost:3000/x", "another port is another server")
        XCTAssertEqual(board.destination(of: "https://example.org/a?b=1")?.absoluteString, "https://example.org/a?b=1")
        XCTAssertNil(board.destination(of: "javascript:alert(1)"))
        XCTAssertNil(board.destination(of: "file:///etc/passwd"))
        XCTAssertNil(board.destination(of: "not a link"))
        let secure = try ServerLink.parse("https://board.tail.ts.net/?t=demo")
        XCTAssertEqual(secure.destination(of: "https://board.tail.ts.net/a/abc#key")?.absoluteString, "https://board.tail.ts.net/a/abc#key")

        let asset = try XCTUnwrap(try Fixture.multi().messages.first { $0.id == "d1" }?.asset)
        XCTAssertEqual(board.assetURL(asset)?.absoluteString, "http://192.168.1.20:8790" + asset.url)
        XCTAssertEqual(board.assetURL(asset)?.fragment?.count, 43, "the key travels behind the #")
        XCTAssertNil(board.assetURL(AssetRef(id: "x", type: "html", title: "T", note: "", url: "", gone: true)))
    }

    func testWordsOfTheEmptyConversation() {
        XCTAssertEqual(ConversationText.starters.count, 3)
        XCTAssertEqual(ConversationText.placeholder(nil), "Message to the agent")
        XCTAssertEqual(ConversationText.placeholder("API"), "Message to API")
        XCTAssertEqual(ConversationFilter.allCases.map(\.title), ["Conversation", "Questions only", "Files"])
    }
}
