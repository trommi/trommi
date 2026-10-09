// Links: universal links of app.trommi.com (Associated Domains `applinks:app.trommi.com`; the web app serves
// /.well-known/apple-app-site-association) and the path a notification carries open the same place in the app:
//   /card/<Nr. or id>            the card            /s/<session>/card/<ref>   the card, from its session
//   /s/<session>                 the conversation    /s/<session>/…            the conversation
//   /settings, /settings/<page>  Settings (sessions, devices, account, theme)
// Anything else opens the app on its Desk. A long press on such a link offers "Open in Safari", as for any universal
// link. A link that arrives before the board has the card (a cold start: the cache is still loading, or the push came
// before the catch-up) waits up to 20 seconds for it.
import Foundation

/** A link that names what the board does not have yet. */
enum PendingLink {
  static var path: String?
  static var until = Date.distantPast
}

extension BoardModel {
  /** Open a link of app.trommi.com; false when it is not one. */
  @discardableResult func open(url: URL) -> Bool {
    guard url.scheme == "https", url.host == "app.trommi.com" else { return false }
    open(path: url.path)
    return true
  }

  /** A path of the web app as a place in the app (the same addresses as app/web: card.mjs, session.mjs, auth.mjs). */
  func open(path: String) {
    PendingLink.path = nil
    if go(path: path) { return }
    PendingLink.path = path
    PendingLink.until = Date().addingTimeInterval(20)
  }

  /** After a change of the board: the link that waited, if its card or session is here now. */
  func openPendingLink() {
    guard let p = PendingLink.path else { return }
    if Date() > PendingLink.until {
      PendingLink.path = nil
      say("Not on the board", "That question or session is not here.")
      return
    }
    if go(path: p) { PendingLink.path = nil }
  }

  /** Navigate; false when the card or the session is not on the board (yet). */
  private func go(path: String) -> Bool {
    guard !demo else { return true }
    guard phase == .board, desk != nil else { return false }
    let segs = path.split(separator: "?", maxSplits: 1).first.map { $0.split(separator: "/").map { String($0).removingPercentEncoding ?? String($0) } } ?? []
    /** A card by its Nr. (the number the Desk shows) or its id (cardByRef of app.mjs). */
    func card(_ ref: String) -> String? {
      if let d = desk?.byCard[ref] { return d.id }
      return Int(ref).flatMap { n in desk?.cards.first { $0.number == n }?.id }
    }
    switch segs.first ?? "" {
    case "card":
      guard segs.count > 1, let id = card(segs[1]) else { return segs.count < 2 }
      tab = .desk; deskPath = [.card(id)]
    case "s":
      guard segs.count > 1 else { return true }
      if segs.count > 3, segs[2] == "card" {
        guard let id = card(segs[3]) else { return false }
        tab = .desk; deskPath = [.card(id)]
        return true
      }
      guard agent(segs[1]) != nil else { return false }
      openChat(segs[1])
    case "settings":
      let page = segs.count > 1 ? (segs[1] == "agents" ? "sessions" : segs[1]) : ""
      tab = .desk
      deskPath = [.settings(["sessions", "devices", "account", "theme"].contains(page) ? page : "")]
    default:
      break
    }
    return true
  }
}
