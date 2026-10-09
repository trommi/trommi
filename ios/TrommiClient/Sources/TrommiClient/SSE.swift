// SSE.swift: a server-sent events reader on URLSession's delegate (works on iOS and on Linux): the response status,
// then each event (name, data) as its blank line ends it. A stream that brings nothing for `staleMs` (the hub pings every
// few seconds) is ended, so the caller reconnects.
//
// The hub is not trusted with this device's memory: a line, an event and the queue of events not yet read are each
// bounded. A stream that goes over a bound is ended (the caller reconnects and catches up by change number); an
// event is never dropped from the middle of a stream that goes on. Redirects are not followed.
import Foundation
#if canImport(FoundationNetworking)
import FoundationNetworking
#endif

public enum SSEEvent { case status(Int), event(String, String) }

public final class SSEReader: NSObject, URLSessionDataDelegate, @unchecked Sendable {
  private var session: URLSession?
  private var task: URLSessionDataTask?
  private var cont: AsyncStream<SSEEvent>.Continuation?
  private var buffer = [UInt8]()
  private var event = "message"
  private var data = ""
  private let lock = NSLock()
  private let staleMs: Double

  public init(staleMs: Double = 40_000) { self.staleMs = staleMs }

  /** The longest line and the largest event taken, and how many events may wait to be read. */
  static let maxLine = 1 << 20, maxEvent = 2 << 20, maxQueued = 2048

  public func start(_ req: URLRequest) -> AsyncStream<SSEEvent> {
    AsyncStream(bufferingPolicy: .bufferingOldest(Self.maxQueued)) { c in
      let cfg = URLSessionConfiguration.ephemeral
      cfg.timeoutIntervalForRequest = staleMs / 1000
      cfg.timeoutIntervalForResource = 24 * 3600
      cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
      cfg.httpCookieStorage = nil; cfg.urlCache = nil; cfg.urlCredentialStorage = nil
      if !HubClient.transportForTests.isEmpty { cfg.protocolClasses = HubClient.transportForTests }
      let q = OperationQueue(); q.maxConcurrentOperationCount = 1
      let session = URLSession(configuration: cfg, delegate: self, delegateQueue: q)
      let task = session.dataTask(with: req)
      lock.withLock { self.cont = c; self.session = session; self.task = task }
      task.resume()
      c.onTermination = { [weak self] _ in self?.stop() }
    }
  }
  /** Ends the stream. Safe from any thread, and from the stream's own termination. */
  public func stop() {
    // What is to be ended is taken out under the lock and ended outside it: finishing the stream calls back here.
    let (t, s, c) = lock.withLock { () -> (URLSessionDataTask?, URLSession?, AsyncStream<SSEEvent>.Continuation?) in
      defer { task = nil; session = nil; cont = nil }
      return (task, session, cont)
    }
    t?.cancel()
    s?.invalidateAndCancel()
    c?.finish()
  }
  private func yield(_ e: SSEEvent) {
    guard let c = lock.withLock({ cont }) else { return }
    // The reader does not keep up and the queue is full: end here rather than lose an event in between.
    if case .dropped = c.yield(e) { stop() }
  }

  public func urlSession(_ session: URLSession, task: URLSessionTask, willPerformHTTPRedirection response: HTTPURLResponse, newRequest request: URLRequest, completionHandler: @escaping (URLRequest?) -> Void) {
    completionHandler(nil)
  }
  public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    yield(.status(status))
    completionHandler(status == 200 ? .allow : .cancel)
    if status != 200 { stop() }
  }
  public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive d: Data) {
    buffer += Array(d)
    var from = 0
    while let nl = buffer[from...].firstIndex(of: 0x0A) {
      var line = Array(buffer[from..<nl])
      from = nl + 1
      if line.last == 0x0D { line.removeLast() }
      handle(String(decoding: line, as: UTF8.self))
    }
    buffer.removeSubrange(..<from)
    if buffer.count > Self.maxLine || data.utf8.count > Self.maxEvent { stop() }
  }
  private func handle(_ line: String) {
    if line.isEmpty {
      if !data.isEmpty { yield(.event(event, data)) }
      event = "message"; data = ""
      return
    }
    if line.hasPrefix(":") { return }
    if line.hasPrefix("event:") { event = String(line.dropFirst(6).trimmingCharacters(in: .whitespaces).prefix(64)) }
    else if line.hasPrefix("data:") { data += (data.isEmpty ? "" : "\n") + line.dropFirst(5).trimmingCharacters(in: .whitespaces) }
  }
  public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    // An event without its closing blank line was cut off: it is not an event.
    data = ""
    stop()
  }
}
