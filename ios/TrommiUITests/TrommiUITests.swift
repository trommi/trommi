// Drives the app against the board in memory (-trommiStub 1), which is fed
// with Trommi/Resources/demo-state.json: three agents, seven open cards in the
// order c-perm, c-migrate, c-phone, c-theme, c-nav, c-next, c-backup.
import XCTest

final class TrommiUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-trommiStub", "1", "-AppleLanguages", "(de)", "-AppleLocale", "de_DE"]
        app.launch()
    }

    // MARK: helpers

    private func element(_ id: String) -> XCUIElement {
        app.descendants(matching: .any).matching(identifier: id).firstMatch
    }

    private func labelled(_ text: String) -> XCUIElement {
        app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@", text)).firstMatch
    }

    /// Lists build their rows as they scroll into view; swipe until the element is there and can be tapped.
    @discardableResult
    private func reveal(_ target: XCUIElement, file: StaticString = #filePath, line: UInt = #line) -> XCUIElement {
        _ = target.waitForExistence(timeout: 3)
        for _ in 0..<8 where !(target.exists && target.isHittable) {
            app.swipeUp(velocity: .slow)
        }
        XCTAssertTrue(target.exists && target.isHittable, "\(target) did not come into view", file: file, line: line)
        return target
    }

    private func assertAppears(_ target: XCUIElement, _ what: String, timeout: TimeInterval = 5, file: StaticString = #filePath, line: UInt = #line) {
        XCTAssertTrue(target.waitForExistence(timeout: timeout), "\(what) did not appear", file: file, line: line)
    }

    private func assertGone(_ target: XCUIElement, _ what: String, file: StaticString = #filePath, line: UInt = #line) {
        let gone = expectation(for: NSPredicate(format: "exists == false"), evaluatedWith: target)
        XCTAssertEqual(XCTWaiter().wait(for: [gone], timeout: 5), .completed, "\(what) is still there", file: file, line: line)
    }

    /// The pictures end up in the .xcresult, where CI collects them.
    private func snap(_ name: String) {
        let shot = XCTAttachment(screenshot: app.screenshot())
        shot.name = name
        shot.lifetime = .keepAlways
        add(shot)
    }

    // MARK: tests

    func testInboxShowsOpenCardsGroupedByAgent() {
        assertAppears(labelled("7 Fragen warten auf dich."), "the line under the title")
        assertAppears(element("inbox-group-api"), "the group of the most urgent sender")
        XCTAssertTrue(element("inbox-row-c-perm").exists, "the approval is the first row")
        XCTAssertTrue(element("inbox-row-c-migrate").exists)
        XCTAssertTrue(labelled("Blockiert").exists, "the corner tab names the urgency")
        snap("Posteingang")
        reveal(element("inbox-group-web-frontend"))
        reveal(element("inbox-group-infrastruktur"))
    }

    func testQuickCardIsAnsweredInTheRowAndCanBeTakenBack() {
        reveal(app.buttons["answer-c-nav-ja"]).tap()
        assertGone(element("inbox-row-c-nav"), "the answered row")
        assertAppears(labelled("6 Fragen warten auf dich."), "the new count")
        assertAppears(app.buttons["undo-button"], "the undo bar")
        snap("Im Posteingang entschieden")
        app.buttons["undo-button"].tap()
        assertAppears(labelled("7 Fragen warten auf dich."), "the old count after undo")
    }

    func testPermissionIsAnsweredInTheRow() {
        assertAppears(app.buttons["answer-c-perm-allow"], "Erlauben")
        XCTAssertTrue(app.buttons["answer-c-perm-deny"].exists, "Ablehnen")
        app.buttons["answer-c-perm-allow"].tap()
        assertGone(element("inbox-row-c-perm"), "the approval")
        XCTAssertFalse(app.buttons["undo-button"].exists, "an approval cannot be taken back")
    }

    func testDecidingInFocusAdvancesAndUndoBringsTheCardBack() {
        reveal(app.buttons["open-c-migrate"]).tap()
        assertAppears(labelled("2 von 7"), "the position of the opened card")
        assertAppears(app.buttons["option-c-migrate-tonight"], "the options of the card")
        snap("Karte")

        app.buttons["option-c-migrate-tonight"].tap()
        assertAppears(labelled("3 von 7"), "the next card")
        assertAppears(app.buttons["option-c-phone-gespraech"], "the options of the next card")
        assertAppears(app.buttons["undo-button"], "the undo bar")
        snap("Nächste Karte")

        app.buttons["undo-button"].tap()
        assertAppears(labelled("2 von 7"), "the card that came back")
        assertAppears(app.buttons["option-c-migrate-tonight"], "its options, open again")

        app.buttons["focus-close"].tap()
        assertAppears(labelled("7 Fragen warten auf dich."), "the full inbox after undo")
    }

    func testSwipingMovesBetweenCardsWithoutDeciding() {
        reveal(app.buttons["open-c-migrate"]).tap()
        assertAppears(labelled("2 von 7"), "the opened card")
        app.swipeLeft()
        assertAppears(labelled("3 von 7"), "the next card after a swipe")
        app.swipeRight()
        assertAppears(labelled("2 von 7"), "the card before")
        app.buttons["focus-close"].tap()
        assertAppears(labelled("7 Fragen warten auf dich."), "nothing was decided")
    }

    func testChatShowsMessagesAndSendingAppendsOne() {
        app.tabBars.buttons["Sitzungen"].tap()
        assertAppears(element("session-api"), "the list of sessions")
        snap("Sitzungen")
        element("session-api").tap()
        assertAppears(labelled("Okay, schaue ich mir an."), "the last message of the human")
        assertAppears(labelled("Fast fertig."), "the last message of the agent")

        let field = element("composer-field")
        assertAppears(field, "the composer")
        field.tap()
        field.typeText("Hallo aus dem Test")
        app.buttons["composer-send"].tap()

        let bubble = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@ AND identifier != %@", "Hallo aus dem Test", "composer-field")).firstMatch
        assertAppears(bubble, "the sent message in the conversation")
        snap("Gespräch")
    }
}
