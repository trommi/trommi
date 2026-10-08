// SSE.swift: a server-sent events reader on URLSession's delegate (works on iOS and on Linux): the response status,
// then each event (name, data) as its blank line ends it. A stream that brings nothing for `staleMs` (the hub pings every
// few seconds) is ended, so the caller reconnects.
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

  public func start(_ req: URLRequest) -> AsyncStream<SSEEvent> {
    AsyncStream { c in
      self.cont = c
      let cfg = URLSessionConfiguration.default
      cfg.timeoutIntervalForRequest = staleMs / 1000
      cfg.timeoutIntervalForResource = 24 * 3600
      cfg.requestCachePolicy = .reloadIgnoringLocalCacheData
      let q = OperationQueue(); q.maxConcurrentOperationCount = 1
      self.session = URLSession(configuration: cfg, delegate: self, delegateQueue: q)
      self.task = self.session!.dataTask(with: req)
      self.task!.resume()
      c.onTermination = { [weak self] _ in self?.stop() }
    }
  }
  public func stop() {
    lock.lock(); defer { lock.unlock() }
    task?.cancel(); task = nil
    session?.invalidateAndCancel(); session = nil
    cont?.finish(); cont = nil
  }

  public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive response: URLResponse, completionHandler: @escaping (URLSession.ResponseDisposition) -> Void) {
    let status = (response as? HTTPURLResponse)?.statusCode ?? 0
    cont?.yield(.status(status))
    completionHandler(status == 200 ? .allow : .cancel)
    if status != 200 { cont?.finish() }
  }
  public func urlSession(_ session: URLSession, dataTask: URLSessionDataTask, didReceive d: Data) {
    buffer += Array(d)
    while let nl = buffer.firstIndex(of: 0x0A) {
      var line = Array(buffer[..<nl])
      buffer.removeSubrange(...nl)
      if line.last == 0x0D { line.removeLast() }
      handle(String(decoding: line, as: UTF8.self))
    }
  }
  private func handle(_ line: String) {
    if line.isEmpty {
      if !data.isEmpty { cont?.yield(.event(event, data)) }
      event = "message"; data = ""
      return
    }
    if line.hasPrefix(":") { return }
    if line.hasPrefix("event:") { event = line.dropFirst(6).trimmingCharacters(in: .whitespaces) }
    else if line.hasPrefix("data:") { data += (data.isEmpty ? "" : "\n") + line.dropFirst(5).trimmingCharacters(in: .whitespaces) }
  }
  public func urlSession(_ session: URLSession, task: URLSessionTask, didCompleteWithError error: Error?) {
    if !data.isEmpty { cont?.yield(.event(event, data)); data = "" }
    cont?.finish()
  }
}
