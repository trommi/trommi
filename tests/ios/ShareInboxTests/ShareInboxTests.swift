import XCTest
import Crypto
@testable import ShareInbox

final class ShareInboxTests: XCTestCase {
  var dir: URL!
  override func setUp() {
    dir = FileManager.default.temporaryDirectory.appendingPathComponent("share-inbox-\(ShareInbox.newId())", isDirectory: true)
  }
  override func tearDown() { try? FileManager.default.removeItem(at: dir) }

  func testShareRoundTrip() throws {
    let key = SymmetricKey(size: .bits256)
    let ext = ShareInbox(container: dir, key: key)
    var r = ShareRequest(action: .note, text: "look at this")
    let pic = Data((0..<5000).map { UInt8($0 % 251) })
    let f = try ext.addPayload(pic, request: r.id, index: 0, name: "picture-1.jpg")
    r.items = [ShareItem(kind: .image, file: f, name: "picture-1.jpg", type: "image/jpeg", size: pic.count, width: 10, height: 20),
               ShareItem(kind: .url, name: "link", type: "text/uri-list", text: "https://example.com/a")]
    XCTAssertTrue(ext.pending().isEmpty, "no manifest yet: not visible")
    try ext.commit(r)

    let app = ShareInbox(container: dir, key: key)
    let got = app.pending()
    XCTAssertEqual(got, [r])
    XCTAssertEqual(got[0].words, "look at this\nhttps://example.com/a")
    XCTAssertEqual(try app.payload(got[0].items[0]), pic)
    XCTAssertTrue(app.claim(r.id))
    XCTAssertTrue(app.pending().isEmpty, "a claimed share is not seen twice")
    app.release(r.id)
    XCTAssertEqual(app.pending().count, 1)
    app.claim(r.id); app.finish(r.id)
    XCTAssertTrue(app.pending().isEmpty)
    XCTAssertEqual(try FileManager.default.contentsOfDirectory(atPath: dir.appendingPathComponent("Trommi Share/items").path), [])
  }

  func testNoPlaintextOnDisk() throws {
    let key = SymmetricKey(size: .bits256)
    let inbox = ShareInbox(container: dir, key: key)
    let secret = "a very secret sentence"
    var r = ShareRequest(action: .send, to: "abc", toName: "Claude", desk: "d", text: secret)
    let f = try inbox.addPayload(Data(secret.utf8), request: r.id, index: 0, name: "notes.txt")
    r.items = [ShareItem(kind: .file, file: f, name: "notes.txt", type: "text/plain")]
    try inbox.commit(r)
    try inbox.writeSnapshot(ShareSnapshot(room: "r", desks: [.init(id: "d", name: "Desk", crown: .init(id: "abc", name: secret))]))
    let e = FileManager.default.enumerator(at: dir, includingPropertiesForKeys: nil)!
    var files = 0
    for case let u as URL in e where !u.hasDirectoryPath {
      files += 1
      let d = try Data(contentsOf: u)
      XCTAssertNil(d.range(of: Data(secret.utf8)), "\(u.lastPathComponent) holds plaintext")
      XCTAssertNil(d.range(of: Data("Claude".utf8)), "\(u.lastPathComponent) holds plaintext")
    }
    XCTAssertEqual(files, 3)
  }

  func testWrongKeyAndSwappedFilesDoNotOpen() throws {
    let inbox = ShareInbox(container: dir, key: SymmetricKey(size: .bits256))
    var a = ShareRequest(action: .note), b = ShareRequest(action: .note)
    let fa = try inbox.addPayload(Data("A".utf8), request: a.id, index: 0, name: "a")
    let fb = try inbox.addPayload(Data("B".utf8), request: b.id, index: 0, name: "b")
    a.items = [ShareItem(kind: .file, file: fa, name: "a", type: "text/plain")]
    b.items = [ShareItem(kind: .file, file: fb, name: "b", type: "text/plain")]
    try inbox.commit(a); try inbox.commit(b)
    // b's payload under a's file name: bound to its name, it does not open
    let items = dir.appendingPathComponent("Trommi Share/items")
    try FileManager.default.removeItem(at: items.appendingPathComponent(fa))
    try FileManager.default.copyItem(at: items.appendingPathComponent(fb), to: items.appendingPathComponent(fa))
    XCTAssertThrowsError(try inbox.payload(a.items[0]))
    XCTAssertEqual(try inbox.payload(b.items[0]), Data("B".utf8))
    // another key: nothing opens, damaged manifests are dropped
    let other = ShareInbox(container: dir, key: SymmetricKey(size: .bits256))
    XCTAssertNil(other.readSnapshot())
    XCTAssertEqual(other.pending(), [])
    XCTAssertEqual(inbox.pending(), [], "dropped by the reader with the wrong key")
    // a path in a file name is refused
    XCTAssertThrowsError(try inbox.payload(ShareItem(kind: .file, file: "../snapshot.sealed", name: "x", type: "")))
  }

  func testLimits() throws {
    let inbox = ShareInbox(container: dir, key: SymmetricKey(size: .bits256))
    XCTAssertThrowsError(try inbox.addPayload(Data(count: ShareInbox.maxItemBytes + 1), request: "x", index: 0, name: "big.mov")) {
      XCTAssertEqual($0 as? ShareError, .tooLarge("big.mov"))
    }
    let many = (0...ShareInbox.maxItems).map { ShareItem(kind: .text, name: "t", type: "text/plain", text: "\($0)") }
    XCTAssertThrowsError(try inbox.commit(ShareRequest(action: .note, items: many)))
  }

  func testSweep() throws {
    let inbox = ShareInbox(container: dir, key: SymmetricKey(size: .bits256))
    let orphan = try inbox.addPayload(Data("x".utf8), request: "dead", index: 0, name: "x")
    var r = ShareRequest(action: .note)
    let kept = try inbox.addPayload(Data("y".utf8), request: r.id, index: 0, name: "y")
    r.items = [ShareItem(kind: .file, file: kept, name: "y", type: "text/plain")]
    try inbox.commit(r)
    inbox.claim(r.id)                              // an import that died half way
    inbox.sweep(now: Date())                       // the orphan is fresh: an extension may still be writing
    XCTAssertEqual(inbox.pending().map { $0.id }, [r.id], "a claimed share comes back")
    inbox.sweep(now: Date().addingTimeInterval(7200))
    let items = try FileManager.default.contentsOfDirectory(atPath: dir.appendingPathComponent("Trommi Share/items").path)
    XCTAssertEqual(items, [kept])
    XCTAssertFalse(items.contains(orphan))
  }

  func testSnapshotCrowns() throws {
    let mark = Data([0x89, 0x50, 0x4e, 0x47])
    let s = ShareSnapshot(room: "r", desks: [.init(id: "main", name: "Main", crown: .init(id: "b", name: "B", hue: 40, mark: mark)),
                                             .init(id: "w", name: "Work", crown: nil),
                                             .init(id: "x", name: "Ops", crown: .init(id: "c", name: "C"))],
                          deskMark: mark, lastDesk: "x")
    let inbox = ShareInbox(container: dir, key: SymmetricKey(size: .bits256))
    try inbox.writeSnapshot(s)
    let got = try XCTUnwrap(inbox.readSnapshot())
    XCTAssertEqual(got, s)
    XCTAssertEqual(got.crowned.map { $0.id }, ["main", "x"], "a desk without a crown is no choice")
    XCTAssertEqual(got.preselect(last: nil)?.id, "x", "the app's last desk")
    XCTAssertEqual(got.preselect(last: "main")?.id, "main", "the one picked last in the sheet wins")
    XCTAssertEqual(got.preselect(last: "w")?.id, "x", "a desk without a crown is skipped")
    XCTAssertNil(ShareSnapshot(room: "r", desks: [.init(id: "w", name: "Work", crown: nil)]).preselect(last: nil))
  }

  func testWaiting() throws {
    let inbox = ShareInbox(container: dir, key: SymmetricKey(size: .bits256))
    let r = ShareRequest(action: .send, to: "b", desk: "main")
    XCTAssertFalse(inbox.isWaiting(r.id))
    try inbox.commit(r)
    XCTAssertTrue(inbox.isWaiting(r.id))
    inbox.claim(r.id)
    XCTAssertFalse(inbox.isWaiting(r.id), "claimed by the app: on its way")
  }

  func testGroupCandidates() {
    XCTAssertEqual(ShareGroup.candidates(bundleID: "XTL-70CB783D.com.trommi.ios.share", infoGroup: nil),
                   ["group.XTL-70CB783D.com.trommi.ios", "group.com.trommi.ios"])
    XCTAssertEqual(ShareGroup.candidates(bundleID: "com.trommi.ios", infoGroup: "group.com.trommi.ios"), ["group.com.trommi.ios"])
  }

  // ---- ShareIntake: what a shared or dropped thing becomes in the note ------------------------------------

  func testIntakeKind() {
    typealias O = ShareIntake.Offer
    XCTAssertEqual(ShareIntake.kind(O(image: true, data: true)), .image, "a photo")
    XCTAssertEqual(ShareIntake.kind(O(image: true, url: true, fileURL: true, data: true)), .image, "a picture file from Files")
    XCTAssertEqual(ShareIntake.kind(O(url: true, text: true)), .url, "a link from Safari offers its title as text too")
    XCTAssertEqual(ShareIntake.kind(O(url: true, data: true)), .url, "a link with a .webloc beside it")
    XCTAssertEqual(ShareIntake.kind(O(url: true, fileURL: true)), .file, "a file URL is a file, not a link")
    XCTAssertEqual(ShareIntake.kind(O(data: true)), .file, "a movie, a PDF")
    XCTAssertEqual(ShareIntake.kind(O(data: true, text: true)), .file, "a PDF that also offers its text")
    XCTAssertEqual(ShareIntake.kind(O(text: true)), .text)
    XCTAssertNil(ShareIntake.kind(O()), "nothing we take")
  }

  func testIntakeWords() {
    let link = ShareIntake.words("  https://example.com/a?b=1\n")
    XCTAssertEqual(link?.kind, .url)
    XCTAssertEqual(link?.text, "https://example.com/a?b=1")
    XCTAssertEqual(link?.name, "example.com")
    XCTAssertEqual(ShareIntake.words("HTTP://Example.com")?.kind, .url)
    XCTAssertEqual(ShareIntake.words("see https://example.com")?.kind, .text, "a sentence with a link is text")
    XCTAssertEqual(ShareIntake.words("https://a.example\nhttps://b.example")?.kind, .text, "two lines are text")
    XCTAssertEqual(ShareIntake.words("httpfoo://x")?.kind, .text, "only http and https are links")
    XCTAssertEqual(ShareIntake.words("mailto:a@example.com")?.kind, .text)
    XCTAssertEqual(ShareIntake.words("buy milk")?.text, "buy milk")
    XCTAssertNil(ShareIntake.words(" \n\t "))
    XCTAssertEqual(ShareIntake.words(String(repeating: "x", count: ShareInbox.maxTextChars + 50))?.text?.count, ShareInbox.maxTextChars)
  }

  func testIntakeFileName() {
    XCTAssertEqual(ShareIntake.fileName(suggested: "Report", file: "tmp123", ext: "pdf", typeExt: "pdf"), "Report.pdf")
    XCTAssertEqual(ShareIntake.fileName(suggested: "Report.PDF", file: "tmp123", ext: "pdf", typeExt: nil), "Report.PDF", "the extension once")
    XCTAssertEqual(ShareIntake.fileName(suggested: nil, file: "clip", ext: "", typeExt: "mov"), "clip.mov", "the type's extension when the file has none")
    XCTAssertEqual(ShareIntake.fileName(suggested: "  ", file: "clip", ext: "mp4", typeExt: "mov"), "clip.mp4", "the file's own extension wins")
    XCTAssertEqual(ShareIntake.fileName(suggested: nil, file: "", ext: "", typeExt: nil), "file")
  }

  func testIntakeAppended() {
    XCTAssertEqual(ShareIntake.appended("", "a"), "a")
    XCTAssertEqual(ShareIntake.appended(" \n", " a "), "a", "an empty note becomes the new words")
    XCTAssertEqual(ShareIntake.appended("one", "two"), "one\ntwo")
    XCTAssertEqual(ShareIntake.appended("one", "  "), "one", "nothing new changes nothing")
    let items = [ShareItem(kind: .url, name: "l", type: "text/uri-list", text: "https://example.com"),
                 ShareItem(kind: .image, file: "f", name: "p.jpg", type: "image/jpeg"),
                 ShareItem(kind: .text, name: "t", type: "text/plain", text: " hello "),
                 ShareItem(kind: .url, name: "l", type: "text/uri-list", text: "https://example.com")]
    XCTAssertEqual(ShareIntake.joined(items), "https://example.com\nhello", "one per line, none twice, files are not words")
  }
}
