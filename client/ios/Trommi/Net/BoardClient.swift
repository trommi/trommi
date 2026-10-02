// What the app needs from a server. Two implementations: the real one over
// HTTP (LiveBoardClient) and one in memory for the demo and the UI tests
// (StubBoardClient).
import Foundation

protocol BoardClient: AnyObject, Sendable {
    /// The whole state, once now and again on every change. Ends with an error when the connection drops.
    func events() -> AsyncThrowingStream<BoardState, Error>
    /// A chat message to one session. `about`: the open question the human asks back about instead of answering it.
    func sendMessage(_ text: String, agent: String, about cardID: String?) async throws
    /// Answers a question (POST /decide). `notes`: what the human wrote on single options.
    /// `revised`: the wording the human answered, card.revised as the app held it; an answer
    /// to an older wording is refused with `ClientError.stale`.
    func decide(cardID: String, answer: Answer, note: String, notes: [String: String], revised: Double?) async throws
    func reopen(cardID: String) async throws
    /// What the human ticked and wrote without sending (POST /draft): always the whole draft; an empty one clears it.
    func saveDraft(cardID: String, keys: [String], note: String, notes: [String: String]) async throws
    /// The human's own name and mark for a session, the archive, and laying sessions together (POST /session).
    func editSession(agent: String, changes: SessionChanges) async throws
    /// Mark a session as VIP, or take the mark away (POST /star).
    func star(agent: String, starred: Bool) async throws
    /// Recorded audio to text.
    func transcribe(audio: Data, contentType: String) async throws -> String
    /// Live dictation (POST /speech/live): the events of one dictation, from "ready" to "final".
    /// Ending the stream early ends the dictation on the hub.
    func liveDictation() -> AsyncThrowingStream<DictationEvent, Error>
    /// The next piece of sound for a dictation: 16-bit mono at the rate "ready" named, raw.
    func sendDictationAudio(id: String, pcm: Data) async throws
    /// No more sound: the hub sends the final text and closes the stream.
    func stopDictation(id: String) async throws
    /// The bytes behind a path of this server: an attachment, or a card read aloud.
    func data(path: String) async throws -> Data
    /// Address and cookie for players that stream by themselves (video, audio); nil when there is no server.
    var media: MediaAccess? { get }
}

extension BoardClient {
    func sendMessage(_ text: String, agent: String) async throws {
        try await sendMessage(text, agent: agent, about: nil)
    }

    /// One answer to a card that takes one.
    func decide(cardID: String, key: String, note: String) async throws {
        try await decide(cardID: cardID, answer: .one(key), note: note, notes: [:], revised: nil)
    }

    func decide(cardID: String, answer: Answer, note: String) async throws {
        try await decide(cardID: cardID, answer: answer, note: note, notes: [:], revised: nil)
    }
}

struct MediaAccess: Sendable {
    var link: ServerLink
    var cookie: SessionCookie
}

enum ClientError: Error, Equatable {
    /// 401: the token is not the server's.
    case unauthorized
    /// The server answered with an error; the text is already the app's wording where known.
    case server(String)
    /// 409 on an answer: the agent reworded the question after the human last saw it. Nothing was sent.
    case stale(String)
    /// No answer at all.
    case unreachable(String)
    case notFound
    case badAnswer

    var message: String {
        switch self {
        case .unauthorized: return "The server does not know this token. Take the current link from data/url.txt."
        case .server(let text), .stale(let text): return text
        case .unreachable(let text): return text.isEmpty ? "The server did not answer." : "No connection to the server: \(text)"
        case .notFound: return "Not found."
        case .badAnswer: return "The server answered with something unexpected."
        }
    }
}

/// One readable sentence for whatever went wrong.
func readable(_ error: Error) -> String {
    if let e = error as? ClientError { return e.message }
    if let e = error as? BoardError { return e.message }
    if let e = error as? LoginError { return e.message }
    if error is CancellationError { return "Cancelled." }
    let text = (error as NSError).localizedDescription
    return text.isEmpty ? "The server did not answer." : text
}
