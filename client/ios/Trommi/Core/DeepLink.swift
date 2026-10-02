// Links that name a question. The board's address names a question by its
// number (?q=102, as app.js writes it); older links carry the card's id, and
// ?q=next means the walk through all open questions. The same query is read
// from the app's own scheme (trommi://open?q=102) and from a board address.
import Foundation

enum DeepLink: Equatable, Sendable {
    /// A question by number or, as older links do, by id.
    case question(String)
    /// The walk through every open question.
    case walk

    /// Reads ?q= from any address; nil when it names no question.
    static func parse(_ url: URL) -> DeepLink? {
        guard let parts = URLComponents(url: url, resolvingAgainstBaseURL: false),
              let q = parts.queryItems?.first(where: { $0.name == "q" })?.value?.trimmingCharacters(in: .whitespacesAndNewlines),
              !q.isEmpty else { return nil }
        return q == "next" ? .walk : .question(q)
    }

    static func parse(_ text: String) -> DeepLink? {
        URL(string: text.trimmingCharacters(in: .whitespacesAndNewlines)).flatMap(parse)
    }
}

/// Where a link leads once the board is loaded.
enum LinkTarget: Equatable, Sendable {
    case card(String)
    case walk
}

extension BoardState {
    /// The card a link names: by its number when `q` is all digits and such a card exists, else by its id (cardOf in app.js).
    func card(named q: String) -> Card? {
        if !q.isEmpty, q.allSatisfy({ $0.isASCII && $0.isNumber }), let number = Int(q), let hit = cards.first(where: { $0.number == number }) {
            return hit
        }
        return card(q)
    }

    func target(of link: DeepLink) -> LinkTarget? {
        switch link {
        case .walk: return .walk
        case .question(let q): return card(named: q).map { .card($0.id) }
        }
    }
}

extension ServerLink {
    /// The address of a question on the board, by its number: "http://host:8790/?q=102". For sharing; it carries no token.
    func questionURL(number: Int) -> URL? {
        var parts = URLComponents(url: baseURL, resolvingAgainstBaseURL: false)
        parts?.path = "/"
        parts?.queryItems = [URLQueryItem(name: "q", value: String(number))]
        return parts?.url
    }

    /// A page of this server opened in the in-app browser, which has no cookie of its own: the
    /// link signs in on the way, and the server redirects to the page without the token.
    func signedInURL(path: String) -> URL? {
        guard let page = url(path: path), var parts = URLComponents(url: page, resolvingAgainstBaseURL: false) else { return nil }
        parts.queryItems = (parts.queryItems ?? []) + [URLQueryItem(name: "t", value: token)]
        return parts.url
    }

    /// The central pad (/pad on the web), until the app has one of its own.
    var padURL: URL? { signedInURL(path: "/pad") }
}
