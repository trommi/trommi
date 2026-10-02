// What the app needs from a server. Two implementations: the real one over
// HTTP (LiveBoardClient) and one in memory for the demo and the UI tests
// (StubBoardClient).
import Foundation

protocol BoardClient: AnyObject, Sendable {
    /// The whole state, once now and again on every change. Ends with an error when the connection drops.
    func events() -> AsyncThrowingStream<BoardState, Error>
    func sendMessage(_ text: String, agent: String) async throws
    func decide(cardID: String, key: String, note: String) async throws
    func reopen(cardID: String) async throws
    /// Recorded audio to text.
    func transcribe(audio: Data, contentType: String) async throws -> String
    /// The bytes behind a path of this server: an attachment, or a card read aloud.
    func data(path: String) async throws -> Data
    /// Address and cookie for players that stream by themselves (video, audio); nil when there is no server.
    var media: MediaAccess? { get }
}

struct MediaAccess: Sendable {
    var link: ServerLink
    var cookie: SessionCookie
}

enum ClientError: Error, Equatable {
    /// 401: the token is not the server's.
    case unauthorized
    /// The server answered with an error; the text is already German where known.
    case server(String)
    /// No answer at all.
    case unreachable(String)
    case notFound
    case badAnswer

    var message: String {
        switch self {
        case .unauthorized: return "Der Server kennt dieses Token nicht. Nimm den aktuellen Link aus data/url.txt."
        case .server(let text): return text
        case .unreachable(let text): return text.isEmpty ? "Der Server hat nicht geantwortet." : "Keine Verbindung zum Server: \(text)"
        case .notFound: return "Nicht gefunden."
        case .badAnswer: return "Der Server hat etwas Unerwartetes geantwortet."
        }
    }
}

/// One readable German sentence for whatever went wrong.
func readable(_ error: Error) -> String {
    if let e = error as? ClientError { return e.message }
    if let e = error as? BoardError { return e.message }
    if let e = error as? LoginError { return e.message }
    if error is CancellationError { return "Abgebrochen." }
    let text = (error as NSError).localizedDescription
    return text.isEmpty ? "Der Server hat nicht geantwortet." : text
}
