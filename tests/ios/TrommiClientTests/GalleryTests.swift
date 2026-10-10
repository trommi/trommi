import XCTest
@testable import TrommiClient

final class GalleryTests: XCTestCase {
  private func jv(_ s: String) -> JV { try! JSONDecoder().decode(JV.self, from: Data(s.utf8)) }
  private func att(_ name: String, _ type: String, _ more: String = "") -> JV { jv(#"{"attachment_id":"\#(name)","file_name":"\#(name)","media_type":"\#(type)"\#(more)}"#) }

  func testStageIsOneFixedSize() {
    // the phone (402 pt wide, 18 pt margins): 4:3 of the content width
    let phone = Gallery.stage(width: 366, viewport: 874)
    XCTAssertEqual(phone.width, 366); XCTAssertEqual(phone.height, 275)
    // a wide layout: 16:10
    let wide = Gallery.stage(width: 724, viewport: 1366)
    XCTAssertEqual(wide.height, 453)
    // capped by the viewport: the phone lying on its side, a low window
    XCTAssertEqual(Gallery.stage(width: 724, viewport: 402).height, 281)
    XCTAssertEqual(Gallery.stage(width: 366, viewport: 400).height, 208)
    // a viewport not known yet: the proportion alone
    XCTAssertEqual(Gallery.stage(width: 366).height, 275)
    XCTAssertEqual(Gallery.stage(width: 0, viewport: 800).height, 0)
  }

  func testTallThreshold() {
    XCTAssertFalse(Gallery.isTall(width: 1000, height: 1250), "exactly 1.25 is not tall")
    XCTAssertTrue(Gallery.isTall(width: 1000, height: 1251))
    XCTAssertFalse(Gallery.isTall(width: 1440, height: 900))
    XCTAssertFalse(Gallery.isTall(width: 0, height: 900), "a size not known is not tall")
    XCTAssertFalse(Gallery.isSlim(width: 1000, height: 1799))
    XCTAssertTrue(Gallery.isSlim(width: 1000, height: 1800))
  }

  func testFittedSize() {
    let stage = (width: 366.0, height: 275.0)
    // landscape, larger than the stage: fitted by its width
    let a = Gallery.fitted(width: 1440, height: 900, stage: stage)
    XCTAssertEqual(a.width, 366, accuracy: 0.01); XCTAssertEqual(a.height, 228.75, accuracy: 0.01); XCTAssertFalse(a.scrolls)
    // a square: fitted by its height
    let b = Gallery.fitted(width: 1000, height: 1000, stage: stage)
    XCTAssertEqual(b.width, 275, accuracy: 0.01); XCTAssertEqual(b.height, 275, accuracy: 0.01)
    // smaller than the stage: never blown up
    let c = Gallery.fitted(width: 200, height: 100, stage: stage)
    XCTAssertEqual(c.width, 200); XCTAssertEqual(c.height, 100); XCTAssertFalse(c.scrolls)
    // a phone's screenshot: at the stage's width, its full height, scrolled
    let d = Gallery.fitted(width: 1206, height: 2622, stage: stage)
    XCTAssertEqual(d.width, 366); XCTAssertEqual(d.height, 366 * 2622 / 1206, accuracy: 0.01); XCTAssertTrue(d.scrolls)
    // the same on a wide stage: at most 420 wide
    let e = Gallery.fitted(width: 1206, height: 2622, stage: (width: 724, height: 453))
    XCTAssertEqual(e.width, 420); XCTAssertTrue(e.scrolls)
    // tall but not slim on a wide stage: its own width, at most the stage
    XCTAssertEqual(Gallery.fitted(width: 900, height: 1400, stage: (width: 724, height: 453)).width, 724)
    // a small tall one: its own size, nothing to scroll
    let f = Gallery.fitted(width: 100, height: 200, stage: stage)
    XCTAssertEqual(f.width, 100); XCTAssertEqual(f.height, 200); XCTAssertFalse(f.scrolls)
    // a size not known
    XCTAssertEqual(Gallery.fitted(width: 0, height: 0, stage: stage).width, 0)
  }

  func testStripOrder() {
    let list = [att("log.txt", "text/plain"), att("clip.mp4", "video/mp4"), att("a.png", "image/png"), att("rows.csv", "text/csv"),
                att("b.jpg", "image/jpeg"), att("voice.m4a", "audio/mp4"), att("page.html", "text/html")]
    XCTAssertEqual(Gallery.media(list).map { $0["file_name"].string }, ["a.png", "b.jpg", "clip.mp4"], "the pictures, then the videos")
    XCTAssertEqual(Gallery.files(list).map { $0["file_name"].string }, ["log.txt", "rows.csv", "voice.m4a", "page.html"])
    XCTAssertTrue(Gallery.media([att("log.txt", "text/plain")]).isEmpty, "files only: no stage")
  }

  func testCounter() {
    XCTAssertEqual(Gallery.counter(at: 1, of: 5), "2 / 5")
    XCTAssertEqual(Gallery.counter(at: 0, of: 1), "")
    XCTAssertEqual(Gallery.counter(at: 9, of: 3), "3 / 3")
  }

  func testCaptionIsNeverTheFileName() {
    XCTAssertEqual(Gallery.caption(att("a.png", "image/png")), "")
    XCTAssertEqual(Gallery.caption(att("a.png", "image/png", #","caption":"My screen""#)), "My screen")
    XCTAssertEqual(Gallery.caption(att("a.png", "image/png", #","title":"a.png""#)), "")
    XCTAssertEqual(Gallery.caption(att("a.png", "image/png", #","title":"Before","caption":"After""#)), "After")
  }

  func testSize() {
    XCTAssertNil(Gallery.size(att("a.png", "image/png")))
    XCTAssertEqual(Gallery.size(att("a.png", "image/png", #","width":1440,"height":900"#))?.width, 1440)
    XCTAssertNil(Gallery.size(att("a.png", "image/png", #","width":0,"height":900"#)))
  }

  func testPage() {
    let page = att("mock.html", "text/html")
    let own = att("a.png", "image/png", #","page":"attachment:mock.html""#)
    XCTAssertEqual(Gallery.page(own, among: [own, page]), Gallery.Page(name: "mock.html", file: page, url: nil))
    XCTAssertNil(Gallery.page(own, among: [own]), "the page is not on the card")
    let link = att("b.png", "image/png", #","page":{"url":"https://example.com/designs/row%20a.html?x=1"}"#)
    XCTAssertEqual(Gallery.page(link, among: []), Gallery.Page(name: "row a.html", file: nil, url: "https://example.com/designs/row%20a.html?x=1"))
    XCTAssertNil(Gallery.page(att("c.png", "image/png", #","page":"/home/me/x.html""#), among: []), "a path of the agent's machine")
    XCTAssertNil(Gallery.page(att("d.png", "image/png"), among: []))
  }
}
