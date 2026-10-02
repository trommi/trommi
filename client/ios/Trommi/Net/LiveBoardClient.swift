// The server over HTTP. The cookie is sent by hand on every request and no
// cookie store is used, so nothing is shared with Safari or other apps.
// Only delegate-based URLSession calls are used; they also exist on Linux,
// where this file is tested against a real server.
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

final class LiveBoardClient: BoardClient, @unchecked Sendable {
    let link: ServerLink
    let cookie: SessionCookie
    private let session: URLSession

    var media: MediaAccess? { MediaAccess(link: link, cookie: cookie) }

    init(link: ServerLink, cookie: SessionCookie) {
        self.link = link
        self.cookie = cookie
        session = URLSession(configuration: LiveBoardClient.configuration(), delegate: NoRedirect(), delegateQueue: nil)
    }

    deinit { session.finishTasksAndInvalidate() }

    private static func configuration(idleTimeout: TimeInterval = 30) -> URLSessionConfiguration {
        let config = URLSessionConfiguration.ephemeral
        config.httpCookieStorage = nil
        config.httpShouldSetCookies = false
        config.httpCookieAcceptPolicy = .never
        config.urlCache = nil
        config.requestCachePolicy = .reloadIgnoringLocalCacheData
        config.timeoutIntervalForRequest = idleTimeout
        return config
    }

    // MARK: login

    /// Opens the link like a browser would, without following the redirect, and
    /// reads the cookie the server sets. 401 means the token is wrong.
    static func login(_ link: ServerLink) async throws -> SessionCookie {
        let session = URLSession(configuration: configuration(idleTimeout: 10), delegate: NoRedirect(), delegateQueue: nil)
        defer { session.finishTasksAndInvalidate() }
        var request = URLRequest(url: link.loginURL)
        request.httpMethod = "GET"
        let (_, response) = try await run(request, in: session)
        switch response.statusCode {
        case 401, 403: throw ClientError.unauthorized
        case 200..<400: return SessionCookie.from(setCookie: response.value(forHTTPHeaderField: "Set-Cookie"), token: link.token)
        default: throw ClientError.server("The server answers with error \(response.statusCode).")
        }
    }

    /// Login, then the first state: proves that address, token and cookie work together.
    static func connect(_ link: ServerLink) async throws -> (client: LiveBoardClient, first: BoardState) {
        let cookie = try await login(link)
        let client = LiveBoardClient(link: link, cookie: cookie)
        for try await state in client.events() { return (client, state) }
        throw ClientError.unreachable("")
    }

    // MARK: requests

    private func request(_ path: String, method: String = "GET") throws -> URLRequest {
        guard let url = link.url(path: path) else { throw ClientError.notFound }
        var request = URLRequest(url: url)
        request.httpMethod = method
        request.setValue(cookie.header, forHTTPHeaderField: "Cookie")
        // The server only takes a POST whose Origin is its own address.
        if method != "GET" { request.setValue(link.origin, forHTTPHeaderField: "Origin") }
        return request
    }

    private static func run(_ request: URLRequest, in session: URLSession) async throws -> (Data, HTTPURLResponse) {
        try await withCheckedThrowingContinuation { continuation in
            session.dataTask(with: request) { data, response, error in
                if let http = response as? HTTPURLResponse {
                    continuation.resume(returning: (data ?? Data(), http))
                } else {
                    continuation.resume(throwing: ClientError.unreachable(error.map { ($0 as NSError).localizedDescription } ?? ""))
                }
            }.resume()
        }
    }

    /// The body of a successful answer; otherwise the server's reason as an error.
    private func send(_ request: URLRequest) async throws -> Data {
        let (data, response) = try await LiveBoardClient.run(request, in: session)
        if (200..<300).contains(response.statusCode) { return data }
        if response.statusCode == 401 { throw ClientError.unauthorized }
        if response.statusCode == 404 { throw ClientError.notFound }
        let reason = (try? JSONSerialization.jsonObject(with: data) as? [String: Any])?["error"] as? String
        throw ClientError.server(BoardError.translate(reason ?? "error \(response.statusCode)"))
    }

    private func post(_ path: String, _ body: [String: Any]) async throws {
        var request = try request(path, method: "POST")
        request.setValue("application/json", forHTTPHeaderField: "Content-Type")
        request.httpBody = try JSONSerialization.data(withJSONObject: body)
        _ = try await send(request)
    }

    func sendMessage(_ text: String, agent: String, about cardID: String?) async throws {
        var body = ["text": text, "agent": agent]
        if let cardID { body["card_id"] = cardID }
        try await post("/message", body)
    }

    func decide(cardID: String, answer: Answer, note: String) async throws {
        try await post("/decide", answer.body(cardID: cardID, note: note))
    }

    func reopen(cardID: String) async throws {
        try await post("/reopen", ["card_id": cardID])
    }

    func editSession(agent: String, changes: SessionChanges) async throws {
        try await post("/session", changes.body(agent: agent))
    }

    func star(agent: String, starred: Bool) async throws {
        try await post("/star", ["agent": agent, "starred": starred])
    }

    func transcribe(audio: Data, contentType: String) async throws -> String {
        var request = try request("/speech/transcribe", method: "POST")
        request.setValue(contentType, forHTTPHeaderField: "Content-Type")
        request.httpBody = audio
        request.timeoutInterval = 120
        let data = try await send(request)
        guard let object = try? JSONSerialization.jsonObject(with: data) as? [String: Any] else { throw ClientError.badAnswer }
        return (object["text"] as? String ?? "").trimmingCharacters(in: .whitespacesAndNewlines)
    }

    func data(path: String) async throws -> Data {
        var request = try request(path)
        request.timeoutInterval = 120
        return try await send(request)
    }

    // MARK: events

    func events() -> AsyncThrowingStream<BoardState, Error> {
        AsyncThrowingStream { continuation in
            guard var request = try? self.request("/events") else {
                return continuation.finish(throwing: ClientError.notFound)
            }
            request.setValue("text/event-stream", forHTTPHeaderField: "Accept")
            // The server sends nothing while nothing changes, so an idle stream is normal.
            let config = LiveBoardClient.configuration(idleTimeout: 7 * 24 * 3600)
            config.timeoutIntervalForResource = 365 * 24 * 3600
            request.timeoutInterval = 7 * 24 * 3600
            let delegate = EventStream(continuation)
            let session = URLSession(configuration: config, delegate: delegate, delegateQueue: nil)
            let task = session.dataTask(with: request)
            continuation.onTermination = { _ in
                task.cancel()
                session.invalidateAndCancel()
            }
            task.resume()
        }
    }
}

/// The login answer is a redirect whose Set-Cookie we want to read; following it would lose it.
private final class NoRedirect: NSObject, URLSessionTaskDelegate, @unchecked Sendable {
    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}

/// Receives the bytes of /events and turns them into states. URLSession calls
/// the delegate on one serial queue, so the parser needs no lock.
private final class EventStream: NSObject, URLSessionDataDelegate, @unchecked Sendable {
    private let continuation: AsyncThrowingStream<BoardState, Error>.Continuation
    private var parser = SSEParser()

    init(_ continuation: AsyncThrowingStream<BoardState, Error>.Continuation) {
        self.continuation = continuation
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse,
                    completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
        let status = (response as? HTTPURLResponse)?.statusCode ?? 0
        if status == 200 {
            completionHandler(.allow)
        } else {
            continuation.finish(throwing: status == 401 ? ClientError.unauthorized : ClientError.server("The server answers with error \(status)."))
            completionHandler(.cancel)
        }
    }

    func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive data: Data) {
        for event in parser.feed(data) {
            // A state that cannot be read is skipped; the last good one stays on screen.
            if let state = try? BoardState.decode(event) { continuation.yield(state) }
        }
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
        continuation.finish(throwing: ClientError.unreachable(error.map { ($0 as NSError).localizedDescription } ?? ""))
        session.finishTasksAndInvalidate()
    }

    func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse,
                    newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
        completionHandler(nil)
    }
}
