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
    var r = ShareRequest(action: .send, to: "abc", toName: "Claude", text: secret)
    let f = try inbox.addPayload(Data(secret.utf8), request: r.id, index: 0, name: "notes.txt")
    r.items = [ShareItem(kind: .file, file: f, name: "notes.txt", type: "text/plain")]
    try inbox.commit(r)
    try inbox.writeSnapshot(ShareSnapshot(room: "r", desks: [], sessions: [.init(id: "abc", name: secret, desk: nil, parent: nil)]))
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

  func testSnapshotTree() throws {
    let s = ShareSnapshot(room: "r", desks: [.init(id: "main", name: "Main", crown: "b"), .init(id: "w", name: "Work", crown: nil), .init(id: "e", name: "Empty", crown: nil)],
                          sessions: [.init(id: "a", name: "A", desk: "main", parent: nil),
                                     .init(id: "b", name: "B", desk: "main", parent: nil),
                                     .init(id: "h", name: "Helper", desk: nil, parent: "b"),
                                     .init(id: "c", name: "C", desk: "w", parent: nil),
                                     .init(id: "x", name: "Lost", desk: "gone", parent: nil)])
    let inbox = ShareInbox(container: dir, key: SymmetricKey(size: .bits256))
    try inbox.writeSnapshot(s)
    let t = try XCTUnwrap(inbox.readSnapshot()).tree()
    XCTAssertEqual(t.map { $0.desk.id }, ["main", "w"], "an empty desk is left out")
    XCTAssertEqual(t[0].rows.map { "\($0.session.id)\($0.depth)\($0.crowned ? "*" : "")" }, ["b0*", "h1", "a0", "x0"])
    XCTAssertEqual(t[1].rows.map { $0.session.id }, ["c"])
    XCTAssertEqual(ShareSnapshot(room: "r", desks: [], sessions: [.init(id: "a", name: "A", desk: nil, parent: nil)]).tree().map { $0.rows.count }, [1])
  }

  func testGroupCandidates() {
    XCTAssertEqual(ShareGroup.candidates(bundleID: "XTL-70CB783D.com.trommi.ios.share", infoGroup: nil),
                   ["group.XTL-70CB783D.com.trommi.ios", "group.com.trommi.ios"])
    XCTAssertEqual(ShareGroup.candidates(bundleID: "com.trommi.ios", infoGroup: "group.com.trommi.ios"), ["group.com.trommi.ios"])
  }
}
