// Perf.swift: main-thread hitches, measured on the phone without Instruments: a display link notes every frame that
// came more than 16.7 ms after the one before (a frame missed: the main thread was busy), counted per window (a
// refresh, a scroll). TROMMI_PERF=1 runs a fixed script after launch (three refreshes, a scroll) and logs the counts
// (os log com.trommi.ios perf).
import SwiftUI
import os
import TrommiClient
#if canImport(UIKit)
import UIKit

@MainActor final class HitchMeter: NSObject {
  static let shared = HitchMeter()
  static let log = Logger(subsystem: "com.trommi.ios", category: "perf")
  private var link: CADisplayLink?
  private var last: CFTimeInterval = 0
  private var windows: [String: (hitches: Int, worst: Double, frames: Int)] = [:]
  private var open = Set<String>()
  func start() {
    guard link == nil else { return }
    let l = CADisplayLink(target: self, selector: #selector(tick(_:)))
    l.add(to: .main, forMode: .common)
    link = l
  }
  @objc private func tick(_ l: CADisplayLink) {
    let now = l.timestamp
    defer { last = now }
    guard last > 0, !open.isEmpty else { return }
    let ms = (now - last) * 1000
    for w in open {
      var v = windows[w] ?? (0, 0, 0)
      v.frames += 1
      if ms > 16.7 + 1 { v.hitches += 1; v.worst = max(v.worst, ms); PerfLog.line(String(format: "hitch %@ %.0f ms", w, ms)) }
      windows[w] = v
    }
  }
  func begin(_ w: String) { start(); open.insert(w); windows[w] = windows[w] ?? (0, 0, 0) }
  func end(_ w: String) {
    open.remove(w)
    guard let v = windows[w] else { return }
    Self.log.notice("trommi perf: \(w, privacy: .public): \(v.hitches, privacy: .public) hitches > 16 ms in \(v.frames, privacy: .public) frames, worst \(Int(v.worst), privacy: .public) ms")
    PerfLog.line(String(format: "WINDOW %@: %d hitches > 16 ms in %d frames, worst %d ms", w, v.hitches, v.frames, Int(v.worst)))
  }
}
#endif

enum PerfScript {
  /** TROMMI_PERF=1: three refreshes and a scroll of the Desk, measured. */
  @MainActor static func runIfAsked(_ model: BoardModel) {
    #if canImport(UIKit)
    guard ProcessInfo.processInfo.environment["TROMMI_PERF"] == "1" else { return }
    MainSampler.start()
    Task { @MainActor in
      try? await Task.sleep(nanoseconds: 3_000_000_000)
      for i in 1...2 {
        HitchMeter.shared.begin("refresh \(i)")
        await model.refresh()
        try? await Task.sleep(nanoseconds: 600_000_000)
        HitchMeter.shared.end("refresh \(i)")
        try? await Task.sleep(nanoseconds: 1_000_000_000)
      }
      HitchMeter.shared.begin("scroll")
      model.perfScroll &+= 1
      try? await Task.sleep(nanoseconds: 3_000_000_000)
      HitchMeter.shared.end("scroll")
    }
    #endif
  }
}

/** Counts of work per render (TROMMI_PERF): pen marks drawn and their time, row bodies built. */
enum RenderCount {
  nonisolated(unsafe) static var penDraws = 0
  nonisolated(unsafe) static var penNs: UInt64 = 0
  nonisolated(unsafe) static var bodies: [String: Int] = [:]
  static func body(_ name: String) { if PerfLog.on { bodies[name, default: 0] += 1 } }
  static func flush(_ label: String) {
    guard PerfLog.on else { return }
    PerfLog.line(String(format: "%@: pen draws %d (%.1f ms), bodies %@", label, penDraws, Double(penNs) / 1e6, bodies.map { "\($0.key) \($0.value)" }.sorted().joined(separator: ", ")))
    penDraws = 0; penNs = 0; bodies = [:]
  }
}

#if canImport(UIKit)
import Darwin

/**
 * A sampler for TROMMI_PERF: when the main thread has not come back for 30 ms, it is interrupted (SIGUSR2) and its
 * stack written to the perf log, so a hitch says where the time went (no Instruments on this machine).
 */
nonisolated(unsafe) private var sampleFrames = [UnsafeMutableRawPointer?](repeating: nil, count: 64)
nonisolated(unsafe) private var sampleCount: Int32 = 0
nonisolated(unsafe) private var sampleReady: Int32 = 0
private func onSample(_ sig: Int32) {
  sampleCount = backtrace(&sampleFrames, 64)
  sampleReady = 1
}
enum MainSampler {
  nonisolated(unsafe) static var beat: UInt64 = 0
  nonisolated(unsafe) static var mainThread: pthread_t? = nil
  @MainActor static func start() {
    guard PerfLog.on, mainThread == nil else { return }
    mainThread = pthread_self()
    signal(SIGUSR2, onSample)
    // the main thread's heartbeat: a timer every 5 ms in common modes
    let t = Timer(timeInterval: 0.005, repeats: true) { _ in MainSampler.beat = DispatchTime.now().uptimeNanoseconds }
    RunLoop.main.add(t, forMode: .common)
    Thread.detachNewThread {
      var lastSampled: UInt64 = 0
      while true {
        usleep(5000)
        let now = DispatchTime.now().uptimeNanoseconds
        let b = MainSampler.beat
        if b > 0 && now - b > 30_000_000 && now - lastSampled > 15_000_000, let m = MainSampler.mainThread {
          lastSampled = now
          sampleReady = 0
          pthread_kill(m, SIGUSR2)
          var waited = 0
          while sampleReady == 0 && waited < 20 { usleep(500); waited += 1 }
          if sampleReady == 1 {
            let n = Int(sampleCount)
            var lines = [String]()
            sampleFrames.withUnsafeMutableBufferPointer { buf in
              if let syms = backtrace_symbols(buf.baseAddress, Int32(n)) {
                for i in 0..<n { if let c = syms[i] { lines.append(String(cString: c)) } }
                free(syms)
              }
            }
            let mine = lines.filter { $0.contains("TrommiApp") || $0.contains("Trommi") }.prefix(14).map { l -> String in
              // "3 TrommiApp 0x... symbol + 12": keep the symbol
              let parts = l.split(separator: " ", maxSplits: 3, omittingEmptySubsequences: true)
              return parts.count > 3 ? String(parts[3]) : l
            }
            PerfLog.line("STALL \((now - b) / 1_000_000) ms main at: " + (mine.isEmpty ? lines.prefix(8).joined(separator: " | ") : mine.joined(separator: " | ")))
          }
        }
      }
    }
  }
}
#endif
