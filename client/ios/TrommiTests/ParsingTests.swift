import XCTest
#if canImport(TrommiCore)
@testable import TrommiCore
#else
@testable import Trommi
#endif

final class MarkdownTests: XCTestCase {
    func testParagraphsListAndBold() throws {
        let text = try XCTUnwrap(try Fixture.single().messages.first { $0.id == "m2" }).text
        XCTAssertEqual(Markdown.parse(text), [
            .paragraph([.text("Mache ich. Plan:")]),
            .list([[.bold("Datenbank"), .text(" festlegen")], [.text("mobile Ansicht mit Tabs")], [.text("Migration schreiben und Deploy vorbereiten")]]),
            .paragraph([.text("Fragen lege ich dir als Karten aufs Board.")]),
        ])
    }

    func testCodeBlockAndInlineCode() throws {
        let body = try XCTUnwrap(try Fixture.single().card("c-migrate")).body
        let blocks = Markdown.parse(body)
        XCTAssertEqual(blocks.count, 2)
        XCTAssertEqual(blocks[1], .code("ALTER TABLE cards ADD COLUMN urgency text NOT NULL DEFAULT 'normal';"))
        guard case .paragraph(let inlines) = blocks[0] else { return XCTFail("expected a paragraph") }
        XCTAssertEqual(inlines[0], .text("Die Migration "))
        XCTAssertEqual(inlines[1], .code("2026_10_02_add_urgency"))
        XCTAssertTrue(inlines.contains(.bold("48.210 Zeilen")))
    }

    func testFenceWithLanguageAndTextAfter() {
        XCTAssertEqual(Markdown.parse("Vorher\n```swift\nlet a = 1\n\nlet b = 2\n```\nNachher"), [
            .paragraph([.text("Vorher")]), .code("let a = 1\n\nlet b = 2"), .paragraph([.text("Nachher")]),
        ])
    }

    func testUnclosedFenceIsCodeToTheEnd() {
        XCTAssertEqual(Markdown.parse("a\n```\nb"), [.paragraph([.text("a")]), .code("b")])
    }

    func testWindowsLineBreaks() {
        XCTAssertEqual(Markdown.parse("a\r\n\r\n- b\r\n- c\r\n```\r\nd\r\n```"), [
            .paragraph([.text("a")]), .list([[.text("b")], [.text("c")]]), .code("d"),
        ])
    }

    func testBullets() {
        XCTAssertEqual(Markdown.parse("* eins\n  - zwei"), [.list([[.text("eins")], [.text("zwei")]])])
        XCTAssertEqual(Markdown.parse("- eins\nkein Punkt"), [.paragraph([.text("- eins\nkein Punkt")])], "a mixed block is a paragraph")
        XCTAssertEqual(Markdown.parse("**fett** am Anfang"), [.paragraph([.bold("fett"), .text(" am Anfang")])], "bold is no bullet")
        XCTAssertEqual(Markdown.parse("-kein Punkt"), [.paragraph([.text("-kein Punkt")])])
    }

    func testInline() {
        XCTAssertEqual(Markdown.inline("siehe https://example.org/a?b=1) und `x`"),
                       [.text("siehe "), .link("https://example.org/a?b=1"), .text(") und "), .code("x")])
        XCTAssertEqual(Markdown.inline("a ** b ` c"), [.text("a ** b ` c")], "unpaired marks stay text")
        XCTAssertEqual(Markdown.inline("`**nicht fett**`"), [.code("**nicht fett**")])
        XCTAssertEqual(Markdown.inline("**a*b**"), [.text("**a*b**")])
        XCTAssertEqual(Markdown.inline("http:// allein"), [.text("http:// allein")])
        XCTAssertEqual(Markdown.inline(""), [])
        XCTAssertEqual(Markdown.inline("häßlich 😀 **ö**"), [.text("häßlich 😀 "), .bold("ö")])
    }

    func testEmptyAndBlankText() {
        XCTAssertEqual(Markdown.parse(""), [])
        XCTAssertEqual(Markdown.parse("\n\n   \n"), [])
    }
}

final class SSEParserTests: XCTestCase {
    func testOneEvent() {
        var parser = SSEParser()
        XCTAssertEqual(parser.feed(Data("data: {\"a\":1}\n\n".utf8)), ["{\"a\":1}"])
    }

    func testEventSplitAcrossChunksEvenInsideACharacter() {
        let bytes = Array("data: {\"t\":\"Grüße 😀\"}\n\ndata: zwei\n\n".utf8)
        for cut in 1..<bytes.count {
            var parser = SSEParser()
            let events = parser.feed(Data(bytes[..<cut])) + parser.feed(Data(bytes[cut...]))
            XCTAssertEqual(events, ["{\"t\":\"Grüße 😀\"}", "zwei"], "cut at \(cut)")
        }
    }

    func testByteByByte() {
        var parser = SSEParser()
        var events: [String] = []
        for byte in Array("data: a\r\n\r\n: ping\n\ndata:b\n\n".utf8) { events += parser.feed(Data([byte])) }
        XCTAssertEqual(events, ["a", "b"])
    }

    func testMultiLineDataCommentsAndOtherFields() {
        var parser = SSEParser()
        let text = ": hello\nevent: state\nid: 7\ndata: eins\ndata: zwei\nretry: 100\n\n\n\ndata\n\n"
        XCTAssertEqual(parser.feed(Data(text.utf8)), ["eins\nzwei", ""])
    }

    func testIncompleteEventIsHeldBack() {
        var parser = SSEParser()
        XCTAssertEqual(parser.feed(Data("data: halb".utf8)), [])
        XCTAssertEqual(parser.feed(Data("\n".utf8)), [])
        XCTAssertEqual(parser.feed(Data("\n".utf8)), ["halb"])
    }

    func testAStateArrivesThroughTheParser() throws {
        let json = String(decoding: try JSONSerialization.data(withJSONObject: JSONSerialization.jsonObject(with: Fixture.data("demo-state"))), as: UTF8.self)
        var parser = SSEParser()
        let events = parser.feed(Data("data: \(json)\n\n".utf8))
        XCTAssertEqual(events.count, 1)
        XCTAssertEqual(try BoardState.decode(events[0]), try Fixture.multi())
    }

    func testBackoff() {
        XCTAssertEqual((0...6).map { Backoff.delay(attempt: $0) }, [0, 1, 2, 4, 8, 15, 15])
        XCTAssertEqual(Backoff.delay(attempt: 10_000), 15)
    }
}

final class LoginTests: XCTestCase {
    func testLinkFromUrlTxt() throws {
        let link = try ServerLink.parse("  http://192.168.1.20:8790/?t=abc-DEF_123\n")
        XCTAssertEqual(link.baseURL.absoluteString, "http://192.168.1.20:8790")
        XCTAssertEqual(link.token, "abc-DEF_123")
        XCTAssertEqual(link.origin, "http://192.168.1.20:8790")
        XCTAssertEqual(link.loginURL.absoluteString, "http://192.168.1.20:8790/?t=abc-DEF_123")
    }

    func testHttpsWithoutPortAndWithPath() throws {
        let link = try ServerLink.parse("https://board.example.org/irgendwo?x=1&t=tok")
        XCTAssertEqual(link.origin, "https://board.example.org")
        XCTAssertEqual(link.token, "tok")
    }

    func testMissingSchemeIsHttp() throws {
        XCTAssertEqual(try ServerLink.parse("mini.local:8790/?t=tok").origin, "http://mini.local:8790")
    }

    func testSeparateFields() throws {
        let link = try ServerLink.parse(address: "mini.local:8790", token: " tok ")
        XCTAssertEqual(link.origin, "http://mini.local:8790")
        XCTAssertEqual(link.token, "tok")
        XCTAssertThrowsError(try ServerLink.parse(address: "mini.local", token: " ")) { XCTAssertEqual($0 as? LoginError, .noToken) }
    }

    func testRefusedLinks() {
        XCTAssertThrowsError(try ServerLink.parse("   ")) { XCTAssertEqual($0 as? LoginError, .empty) }
        XCTAssertThrowsError(try ServerLink.parse("http://host:8790/")) { XCTAssertEqual($0 as? LoginError, .noToken) }
        XCTAssertThrowsError(try ServerLink.parse("http://host:8790/?t=")) { XCTAssertEqual($0 as? LoginError, .noToken) }
        XCTAssertThrowsError(try ServerLink.parse("ftp://host/?t=x")) { XCTAssertEqual($0 as? LoginError, .unsupportedScheme) }
        XCTAssertThrowsError(try ServerLink.parse("http:///?t=x")) { XCTAssertEqual($0 as? LoginError, .notALink) }
    }

    func testPathsStayOnTheServer() throws {
        let link = try ServerLink.parse("http://host:8790/?t=tok")
        XCTAssertEqual(link.url(path: "/files/a b.png")?.absoluteString ?? link.url(path: "/files/a%20b.png")?.absoluteString, "http://host:8790/files/a%20b.png")
        XCTAssertEqual(link.url(path: "/files/x.mp4")?.absoluteString, "http://host:8790/files/x.mp4")
        XCTAssertEqual(link.url(path: "/speech/card/ab12")?.absoluteString, "http://host:8790/speech/card/ab12")
        XCTAssertNil(link.url(path: "https://evil.example/x.png"), "the cookie must not travel to another host")
        XCTAssertNil(link.url(path: "//evil.example/x.png"))
        XCTAssertNil(link.url(path: "files/x.png"))
        XCTAssertNil(link.url(path: "/\\evil.example"))
        XCTAssertEqual(link.cardSpeechPath("a/b"), "/speech/card/a%2Fb")
    }

    func testCookieOfTodaysServer() {
        let cookie = SessionCookie.from(setCookie: "board=tok; HttpOnly; SameSite=Strict; Path=/; Max-Age=31536000", token: "tok")
        XCTAssertEqual(cookie, SessionCookie(name: "board", value: "tok"))
        XCTAssertEqual(cookie.header, "board=tok")
    }

    func testCookieNamedAfterThePort() {
        XCTAssertEqual(SessionCookie.from(setCookie: "board_8790=tok; HttpOnly; Path=/", token: "tok").name, "board_8790")
    }

    func testCookieAmongOthersAndWithExpires() {
        let header = "theme=dark; Expires=Wed, 21 Oct 2026 07:28:00 GMT; Path=/, board_8795=tok; Expires=Thu, 22 Oct 2026 07:28:00 GMT, other=1"
        XCTAssertEqual(SessionCookie.parse(setCookie: header).map(\.name), ["theme", "board_8795", "other"])
        XCTAssertEqual(SessionCookie.from(setCookie: header, token: "tok").header, "board_8795=tok")
    }

    func testCookieFallbacks() {
        XCTAssertEqual(SessionCookie.from(setCookie: nil, token: "tok").header, "board=tok")
        XCTAssertEqual(SessionCookie.from(setCookie: "", token: "tok").header, "board=tok")
        XCTAssertEqual(SessionCookie.from(setCookie: "other=1", token: "tok").header, "board=tok")
        // A server that stores something else than the token in its cookie is still followed.
        XCTAssertEqual(SessionCookie.from(setCookie: "board_1=session9; Path=/", token: "tok").header, "board_1=session9")
        XCTAssertEqual(SessionCookie.from(setCookie: "board=\"tok\"", token: "tok").header, "board=tok")
    }

    func testStoredLoginRoundTrip() throws {
        let link = try ServerLink.parse("http://host:8790/?t=tok")
        let stored = StoredLogin(link: link, cookie: SessionCookie(name: "board_8790", value: "tok"))
        let back = try JSONDecoder().decode(StoredLogin.self, from: JSONEncoder().encode(stored))
        XCTAssertEqual(back.link, link)
        XCTAssertEqual(back.cookie.header, "board_8790=tok")
    }
}

final class PermissionTests: XCTestCase {
    func testFixtureApproval() throws {
        let body = PermissionBody.parse(try XCTUnwrap(try Fixture.single().card("c-perm")).body)
        XCTAssertEqual(body.description, "Run the test suite")
        XCTAssertEqual(body.raw, "{\"command\":\"npm test -- --coverage\"}")
        XCTAssertEqual(body.rows, [.init(key: "command", value: "npm test -- --coverage")])
    }

    func testRowsKeepTheOrderOfTheText() {
        let body = PermissionBody.parse("Edit a file\n\n{\"file_path\": \"/a.txt\", \"all\": true, \"count\": 2, \"nested\": {\"b\": 1}}")
        XCTAssertEqual(body.rows.map(\.key), ["file_path", "all", "count", "nested"])
        XCTAssertEqual(body.rows[0].value, "/a.txt")
        XCTAssertEqual(body.rows[1].value, "true")
        XCTAssertEqual(body.rows[2].value, "2")
        XCTAssertTrue(body.rows[3].value.contains("\"b\""))
    }

    func testInputThatIsNotJson() {
        let body = PermissionBody.parse("Run it\n\n{abgeschnitten…")
        XCTAssertEqual(body.description, "Run it")
        XCTAssertEqual(body.raw, "{abgeschnitten…")
        XCTAssertTrue(body.rows.isEmpty)
    }

    func testNoInput() {
        let body = PermissionBody.parse("Nur ein Satz {mit Klammer}\nzweite Zeile")
        XCTAssertEqual(body.description, "Nur ein Satz {mit Klammer}\nzweite Zeile")
        XCTAssertEqual(body.raw, "")
        XCTAssertEqual(PermissionBody.parse("").description, "")
    }

    func testInputOnly() {
        let body = PermissionBody.parse("[1, 2]")
        XCTAssertEqual(body.description, "")
        XCTAssertEqual(body.raw, "[1, 2]")
        XCTAssertTrue(body.rows.isEmpty, "an array has no rows")
    }
}
