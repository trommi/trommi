// The link the human pastes or scans, the cookie the server hands out for it,
// and the addresses the app builds from both.
import Foundation

enum LoginError: Error, Equatable {
    case empty
    case notALink
    case unsupportedScheme
    case noToken

    var message: String {
        switch self {
        case .empty: return "Paste the link from data/url.txt."
        case .notALink: return "That is not an address. Expected is a link like http://computer:8790/?t=TOKEN."
        case .unsupportedScheme: return "The link must start with http:// or https://."
        case .noToken: return "The link has no token (?t=...). Take the whole link from data/url.txt."
        }
    }
}

struct ServerLink: Equatable, Sendable {
    /// Scheme, host and port only, e.g. http://192.168.1.20:8790
    var baseURL: URL
    var token: String

    /// Reads "http://host:8790/?t=TOKEN". A missing scheme is taken as http,
    /// because the server speaks plain http on the local network.
    static func parse(_ input: String) throws -> ServerLink {
        var text = input.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw LoginError.empty }
        if !text.contains("://") { text = "http://" + text }
        guard let parts = URLComponents(string: text), let scheme = parts.scheme?.lowercased() else { throw LoginError.notALink }
        guard scheme == "http" || scheme == "https" else { throw LoginError.unsupportedScheme }
        guard let host = parts.host, !host.isEmpty else { throw LoginError.notALink }
        guard let token = parts.queryItems?.first(where: { $0.name == "t" })?.value, !token.isEmpty else { throw LoginError.noToken }
        var base = URLComponents()
        base.scheme = scheme
        base.host = host
        base.port = parts.port
        guard let url = base.url else { throw LoginError.notALink }
        return ServerLink(baseURL: url, token: token)
    }

    /// Address and token typed into separate fields.
    static func parse(address: String, token: String) throws -> ServerLink {
        let clean = token.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !clean.isEmpty else { throw LoginError.noToken }
        var text = address.trimmingCharacters(in: .whitespacesAndNewlines)
        guard !text.isEmpty else { throw LoginError.empty }
        if !text.contains("://") { text = "http://" + text }
        guard var parts = URLComponents(string: text) else { throw LoginError.notALink }
        parts.queryItems = [URLQueryItem(name: "t", value: clean)]
        guard let joined = parts.string else { throw LoginError.notALink }
        return try parse(joined)
    }

    /// What the server compares with its Host header on every POST: scheme://host[:port].
    var origin: String {
        var text = baseURL.absoluteString
        while text.hasSuffix("/") { text.removeLast() }
        return text
    }

    /// The address that sets the cookie.
    var loginURL: URL {
        var parts = URLComponents(url: baseURL, resolvingAgainstBaseURL: false) ?? URLComponents()
        parts.path = "/"
        parts.queryItems = [URLQueryItem(name: "t", value: token)]
        return parts.url ?? baseURL
    }

    /// The address of a path on this server. Paths come from the state (attachment
    /// urls) and must stay on this server, because the cookie travels with them:
    /// anything that is not a plain absolute path gives nil.
    func url(path: String) -> URL? {
        guard path.hasPrefix("/"), !path.hasPrefix("//"), !path.contains("\\") else { return nil }
        guard let url = URL(string: path, relativeTo: baseURL)?.absoluteURL else { return nil }
        guard url.host == baseURL.host, url.port == baseURL.port, url.scheme == baseURL.scheme else { return nil }
        return url
    }

    func cardSpeechPath(_ cardID: String) -> String {
        "/speech/card/" + (cardID.addingPercentEncoding(withAllowedCharacters: .alphanumerics) ?? cardID)
    }

    /// The link as the human would paste it; used to show what is stored.
    var display: String { origin }
}

struct SessionCookie: Equatable, Sendable {
    var name: String
    var value: String

    /// The value of the Cookie request header.
    var header: String { "\(name)=\(value)" }

    static func fallback(token: String) -> SessionCookie { SessionCookie(name: "board", value: token) }

    /// The cookie the server set for the login request. Its name may depend on
    /// the port (board_8790), so it is read from Set-Cookie: the cookie that
    /// carries the token, else one whose name starts with "board", else board=<token>
    /// (the server names it board_<port> and still accepts the plain name).
    static func from(setCookie header: String?, token: String) -> SessionCookie {
        let cookies = parse(setCookie: header ?? "")
        if let exact = cookies.first(where: { $0.value == token }) { return exact }
        if let named = cookies.first(where: { $0.name.hasPrefix("board") && !$0.value.isEmpty }) { return named }
        return fallback(token: token)
    }

    /// Name and value of every cookie in a Set-Cookie header. Several cookies
    /// may arrive joined with commas, and "Expires=Wed, 21 Oct ..." has a comma too.
    static func parse(setCookie header: String) -> [SessionCookie] {
        var pieces: [String] = []
        for part in header.split(separator: ",", omittingEmptySubsequences: false) {
            let first = part.split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
            if startsCookie(first) || pieces.isEmpty { pieces.append(String(part)) } else { pieces[pieces.count - 1] += "," + part }
        }
        return pieces.compactMap { piece in
            let pair = piece.split(separator: ";", maxSplits: 1, omittingEmptySubsequences: false).first ?? ""
            guard let eq = pair.firstIndex(of: "=") else { return nil }
            let name = pair[..<eq].trimmingCharacters(in: .whitespaces)
            var value = pair[pair.index(after: eq)...].trimmingCharacters(in: .whitespaces)
            if value.count >= 2, value.hasPrefix("\""), value.hasSuffix("\"") { value = String(value.dropFirst().dropLast()) }
            return name.isEmpty ? nil : SessionCookie(name: name, value: value)
        }
    }

    /// "name=" at the start, with a name made of token characters.
    private static func startsCookie(_ text: Substring) -> Bool {
        guard let eq = text.firstIndex(of: "=") else { return false }
        let name = text[..<eq].trimmingCharacters(in: .whitespaces)
        return !name.isEmpty && name.allSatisfy { $0.isASCII && ($0.isLetter || $0.isNumber || "_-.".contains($0)) }
    }
}

/// What is kept in the Keychain between launches.
struct StoredLogin: Codable, Equatable, Sendable {
    var baseURL: String
    var token: String
    var cookieName: String

    init(link: ServerLink, cookie: SessionCookie) {
        baseURL = link.origin
        token = link.token
        cookieName = cookie.name
    }

    var link: ServerLink? {
        guard let url = URL(string: baseURL), url.host != nil else { return nil }
        return ServerLink(baseURL: url, token: token)
    }

    var cookie: SessionCookie { SessionCookie(name: cookieName.isEmpty ? "board" : cookieName, value: token) }
}
