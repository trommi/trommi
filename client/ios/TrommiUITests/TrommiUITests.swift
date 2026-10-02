// Drives the app against the board in memory (-trommiStub 1), which is fed
// with Trommi/Resources/demo-state.json (written by tools/demo-state.mjs):
// five sessions (two of them laid together) and one archived; nine open
// questions in the order c-perm, c-migrate, c-phone, c-theme, c-nav, c-ship,
// c-parts, c-next, c-backup. Elements are found by accessibility identifier, so the
// tests do not depend on wording more than they must.
import XCTest

final class TrommiUITests: XCTestCase {
    private var app: XCUIApplication!

    override func setUp() {
        continueAfterFailure = false
        app = XCUIApplication()
        app.launchArguments = ["-trommiStub", "1", "-AppleLanguages", "(en)", "-AppleLocale", "en_GB"]
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
        for _ in 0..<10 where !(target.exists && target.isHittable) {
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

    private func toTop() {
        for _ in 0..<4 { app.swipeDown(velocity: .fast) }
    }

    // MARK: inbox

    func testInboxShowsOpenQuestionsGroupedBySender() {
        assertAppears(labelled("9 questions need you."), "the line under the title")
        assertAppears(element("inbox-group-api"), "the group of the starred session, first")
        XCTAssertTrue(element("row-c-perm").exists, "the permission is the first row")
        XCTAssertTrue(element("row-c-migrate").exists)
        XCTAssertTrue(labelled("Blocking").exists, "the tab names the urgency")
        XCTAssertFalse(element("row-c-spike").exists, "an archived session's question is not asked")
        snap("Inbox")
        reveal(element("inbox-group-web-frontend"))
        reveal(element("inbox-group-infrastructure"))
    }

    func testYesNoQuestionIsAnsweredInTheRowAndCanBeTakenBack() {
        reveal(app.buttons["answer-c-nav-delete"])
        XCTAssertTrue(app.buttons["answer-c-nav-keep"].exists, "no on the left, yes on the right")
        app.buttons["answer-c-nav-delete"].tap()
        assertGone(element("row-c-nav"), "the answered row")
        assertAppears(app.buttons["undo-button"], "the undo bar")
        snap("Answered in the inbox")
        app.buttons["undo-button"].tap()
        toTop()
        assertAppears(labelled("9 questions need you."), "the old count after undo")
    }

    func testPermissionIsAnsweredInTheRow() {
        assertAppears(app.buttons["answer-c-perm-allow"], "Allow")
        XCTAssertTrue(app.buttons["answer-c-perm-deny"].exists, "Deny")
        app.buttons["answer-c-perm-allow"].tap()
        assertGone(element("row-c-perm"), "the permission")
        XCTAssertFalse(app.buttons["undo-button"].exists, "a permission cannot be taken back")
    }

    func testLaterMovesAQuestionToTheBottomAndBack() {
        assertAppears(app.buttons["later-c-migrate"], "Later on a question that is not yes/no")
        app.buttons["later-c-migrate"].tap()
        assertAppears(labelled("8 questions need you."), "what was put off is not counted")
        reveal(element("inbox-group-later"))
        snap("Later")
        reveal(app.buttons["back-c-migrate"]).tap()
        toTop()
        assertAppears(labelled("9 questions need you."), "fetched back")
        assertAppears(app.buttons["later-c-migrate"], "the row is under its sender again")
    }

    // MARK: the whole card

    func testChooseOpensTheCardAndTheAnswerClosesIt() {
        assertAppears(app.buttons["choose-c-migrate"], "Choose")
        app.buttons["choose-c-migrate"].tap()
        assertAppears(app.buttons["option-c-migrate-tonight"], "the options of the card")
        XCTAssertFalse(app.buttons["focus-next"].exists, "one card alone has no back and next")
        snap("Card")
        app.buttons["option-c-migrate-tonight"].tap()
        assertAppears(labelled("8 questions need you."), "back in the inbox, one question less")
        assertAppears(app.buttons["undo-button"], "the inbox offers the way back")
        app.buttons["undo-button"].tap()
        assertAppears(labelled("9 questions need you."), "the answer was taken back")
    }

    func testGoingThroughThemWalksAndAdvancesOnAnAnswer() {
        assertAppears(app.buttons["inbox-go"], "Go through them")
        app.buttons["inbox-go"].tap()
        assertAppears(labelled("1 of 9"), "the most urgent question first")
        assertAppears(app.buttons["option-c-perm-allow"], "the permission")
        app.buttons["focus-next"].tap()
        assertAppears(labelled("2 of 9"), "next without answering")
        assertAppears(app.buttons["option-c-migrate-tonight"], "the second question")
        app.buttons["focus-previous"].tap()
        assertAppears(labelled("1 of 9"), "and back")
        app.buttons["focus-next"].tap()
        app.buttons["option-c-migrate-tonight"].tap()
        assertAppears(labelled("2 of 8"), "the next question slid into its place")
        assertAppears(reveal(app.buttons["option-c-phone-conversation"]), "the options of the next question")
        snap("Next card")
        app.buttons["focus-close"].tap()
        assertAppears(labelled("8 questions need you."), "one answered")
    }

    func testSeveralAnswersAreTickedAndSentTogether() {
        reveal(app.buttons["choose-c-parts"]).tap()
        assertAppears(app.buttons["option-c-parts-start"], "the options as switches")
        XCTAssertFalse(app.buttons["send-c-parts"].isEnabled, "nothing chosen, nothing to send")
        app.buttons["option-c-parts-start"].tap()
        app.buttons["option-c-parts-admin"].tap()
        snap("Several answers")
        app.buttons["send-c-parts"].tap()
        toTop()
        assertAppears(labelled("8 questions need you."), "answered, back in the inbox")
        assertAppears(app.buttons["undo-button"], "the way back")
    }

    func testAskingBackShowsTheThreadUnderTheCard() {
        reveal(app.buttons["row-text-c-ship"]).tap()
        assertAppears(element("thread-user"), "what was asked back")
        assertAppears(element("thread-agent"), "what the agent replied")
        let field = reveal(element("ask-field"))
        field.tap()
        field.typeText("And the index?")
        app.buttons["ask-send"].tap()
        assertAppears(labelled("And the index?"), "the new question in the thread")
        snap("Ask back")
        app.buttons["focus-close"].tap()
        toTop()
        assertAppears(labelled("9 questions need you."), "asking back answers nothing")
    }

    // MARK: sessions

    func testSessionsListShowsPairsAndTheArchive() {
        app.tabBars.buttons["Sessions"].tap()
        assertAppears(element("session-api"), "the list of sessions")
        XCTAssertTrue(element("session-web-frontend").exists)
        XCTAssertTrue(element("session-g-docs").exists, "two sessions laid together are one row")
        snap("Sessions")
        reveal(element("session-infrastructure"))
        reveal(element("archived-old-spike"))
    }

    func testConversationShowsQuestionsInlineAndSendingAppendsOne() {
        app.tabBars.buttons["Sessions"].tap()
        assertAppears(element("session-api"), "the list of sessions")
        element("session-api").tap()
        assertAppears(labelled("Okay, I will have a look."), "the last message of the human")
        assertAppears(element("row-c-migrate"), "the open question, as a row where it was asked")
        snap("Conversation")

        let field = element("composer-field")
        assertAppears(field, "the composer")
        field.tap()
        field.typeText("Hello from the test")
        app.buttons["composer-send"].tap()
        let bubble = app.descendants(matching: .any).matching(NSPredicate(format: "label CONTAINS %@ AND identifier != %@", "Hello from the test", "composer-field")).firstMatch
        assertAppears(bubble, "the sent message in the conversation")
    }

    func testQuestionsOnlyAndFiles() {
        app.tabBars.buttons["Sessions"].tap()
        assertAppears(element("session-web-frontend"), "the list of sessions")
        element("session-web-frontend").tap()
        assertAppears(app.segmentedControls.buttons["Questions only"], "the filter")
        app.segmentedControls.buttons["Questions only"].tap()
        assertAppears(element("row-c-phone"), "its open questions")
        XCTAssertTrue(labelled("4 questions need you.").exists)
        snap("Questions only")
        app.segmentedControls.buttons["Files"].tap()
        assertAppears(labelled("5 items"), "everything the session sent")
        snap("Files")
    }

    func testSessionInfoShowsWhereItRuns() {
        app.tabBars.buttons["Sessions"].tap()
        assertAppears(element("session-api"), "the list of sessions")
        element("session-api").tap()
        assertAppears(app.buttons["session-info"], "the info button")
        app.buttons["session-info"].tap()
        assertAppears(element("session-name"), "the name field")
        assertAppears(labelled("Claude Opus 5.5"), "the model")
        XCTAssertTrue(labelled("build-box").exists, "the machine")
        snap("Session info")
    }
}
