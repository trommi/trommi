// CoreProofScreen.swift: Settings → MLS proof. An info screen, a little out of the way: it asks the Rust core
// (trommi-core, the app's whole protocol) which version it is and lets it run its own check of itself on this phone
// (`Core.tools.selfTest()`: every cipher suite, step by step, with times), and says what happened. The check makes
// its own devices in memory: it reads and writes nothing of the app, no room, no key, no file, no network.
// Deliberately plain: system fonts, no drawing. The text of a result is one string, for "Copy result".
import SwiftUI
import TrommiClient
#if canImport(UIKit)
import UIKit
#endif

/// The words of a result. No view: the same text is shown and copied.
enum CoreProof {
  /// The steps of one suite, in the order the core ran them.
  struct Suite: Identifiable {
    let id: String
    var steps: [SelfTestStep]
    var ok: Bool { steps.allSatisfy { $0.ok } }
    var ms: Double { CoreProof.ms(steps) }
  }

  static func ms(_ steps: [SelfTestStep]) -> Double { Double(steps.reduce(0) { $0 + $1.micros }) / 1000 }

  /// The steps grouped by suite, the suites in the order of their first step.
  static func suites(_ steps: [SelfTestStep]) -> [Suite] {
    var out: [Suite] = []
    for step in steps {
      if let i = out.firstIndex(where: { $0.id == step.suite }) { out[i].steps.append(step) } else { out.append(Suite(id: step.suite, steps: [step])) }
    }
    return out
  }

  /// The first line of the screen and of the copied text: starts with "OK" or "FAIL".
  static func headline(_ steps: [SelfTestStep]) -> String {
    let all = suites(steps)
    if !steps.isEmpty, steps.allSatisfy({ $0.ok }) {
      return "OK: the Rust core ran \(all.count) suites, \(steps.count) steps, \(String(format: "%.1f", ms(steps))) ms"
    }
    let failed = all.compactMap { suite in suite.steps.first { !$0.ok }.map { "\(suite.id.isEmpty ? "" : suite.id + " ")at \"\($0.name)\"" } }
    return "FAIL: \(failed.isEmpty ? "nothing ran" : failed.joined(separator: "; "))"
  }

  /// The line over a suite's steps: "OK <suite>: 13 of 13 steps, 41.2 ms".
  static func line(_ suite: Suite) -> String {
    "\(suite.ok ? "OK" : "FAIL") \(suite.id): \(suite.steps.filter { $0.ok }.count) of \(suite.steps.count) steps, \(String(format: "%.1f", suite.ms)) ms"
  }

  /// The phone, the app and the core, one fact per line.
  static func environment(coreVersion: String) -> [String] {
    var system = utsname()
    uname(&system)
    let machine = withUnsafeBytes(of: &system.machine) { String(decoding: $0.prefix { $0 != 0 }, as: UTF8.self) }
    let info = Bundle.main.infoDictionary ?? [:]
    #if canImport(UIKit)
    let os = "\(UIDevice.current.systemName) \(UIDevice.current.systemVersion)"
    #else
    let os = ProcessInfo.processInfo.operatingSystemVersionString
    #endif
    return [
      "phone: \(machine)",
      "system: \(os)",
      "cores: \(ProcessInfo.processInfo.activeProcessorCount)",
      "app: Trommi \(info["CFBundleShortVersionString"] as? String ?? "?") (\(info["CFBundleVersion"] as? String ?? "?"))",
      "core: \(coreVersion)",
    ]
  }

  /// The whole result as plain text, to paste somewhere.
  static func report(_ steps: [SelfTestStep], environment: [String]) -> String {
    var out = [headline(steps)] + environment
    for suite in suites(steps) {
      out.append("")
      out.append(line(suite))
      for s in suite.steps {
        out.append("  \(s.ok ? "OK  " : "FAIL") \(String(format: "%7.2f", Double(s.micros) / 1000)) ms  \(s.name)\(s.detail.isEmpty ? "" : ": \(s.detail)")")
      }
    }
    return out.joined(separator: "\n")
  }
}

struct CoreProofPage: View {
  @State private var steps: [SelfTestStep] = []
  @State private var coreVersion = ""
  @State private var running = false
  @State private var copied = false

  var body: some View {
    // While a run is going the line says so: an earlier OK must not stand there if this run never comes back.
    let headline = running ? "Running…" : CoreProof.headline(steps)
    let ok = headline.hasPrefix("OK")
    let environment = CoreProof.environment(coreVersion: coreVersion)
    SettingsPage(title: "MLS proof") {
      VStack(alignment: .leading, spacing: 8) {
        Text(headline)
          .font(.system(size: 22, weight: .bold))
          .foregroundStyle(running ? Color.secondary : (ok ? Color.green : Color.red))
          .fixedSize(horizontal: false, vertical: true)
          .accessibilityIdentifier("mls-proof-headline")
        ForEach(environment, id: \.self) { line in
          Text(line).font(.system(size: 13, design: .monospaced)).foregroundStyle(.secondary).fixedSize(horizontal: false, vertical: true)
        }
      }
      .padding(.horizontal, 4)
      .textSelection(.enabled)

      HStack(spacing: 12) {
        Button(running ? "Running…" : "Run again") { start() }.buttonStyle(.borderedProminent).disabled(running)
        Button(copied ? "Copied" : "Copy result") {
          #if canImport(UIKit)
          UIPasteboard.general.string = CoreProof.report(steps, environment: environment)
          #endif
          copied = true
        }.buttonStyle(.bordered).disabled(running || steps.isEmpty)
      }

      if running, !steps.isEmpty {
        Text("Below: the previous run.").font(.system(size: 13)).foregroundStyle(.secondary).padding(.horizontal, 4)
      }
      ForEach(CoreProof.suites(steps)) { suite in
        VStack(alignment: .leading, spacing: 6) {
          Text(CoreProof.line(suite))
            .font(.system(size: 15, weight: .semibold)).foregroundStyle(suite.ok ? Color.green : Color.red)
            .fixedSize(horizontal: false, vertical: true)
          ForEach(Array(suite.steps.enumerated()), id: \.offset) { _, step in
            VStack(alignment: .leading, spacing: 1) {
              HStack(alignment: .firstTextBaseline, spacing: 8) {
                Text(step.ok ? "OK" : "FAIL").font(.system(size: 13, weight: .bold, design: .monospaced))
                  .foregroundStyle(step.ok ? Color.green : Color.red).frame(width: 36, alignment: .leading)
                Text(step.name).font(.system(size: 15)).foregroundStyle(.primary)
                Spacer(minLength: 6)
                Text(String(format: "%.2f ms", Double(step.micros) / 1000)).font(.system(size: 13, design: .monospaced)).foregroundStyle(.secondary)
              }
              if !step.detail.isEmpty {
                Text(step.detail).font(.system(size: 12, design: .monospaced)).foregroundStyle(.secondary)
                  .padding(.leading, 44).fixedSize(horizontal: false, vertical: true)
              }
            }
          }
        }
        .padding(.horizontal, 4)
        .textSelection(.enabled)
        .opacity(running ? 0.4 : 1)
      }

      Text("Devices made for this run, in memory. Nothing of your room, your keys or the network is used, and nothing is stored.")
        .font(.system(size: 13)).foregroundStyle(.secondary).padding(.horizontal, 4).fixedSize(horizontal: false, vertical: true)
    }
    .onAppear { if steps.isEmpty { start() } }
  }

  /// One run of the core's self test, off the main thread; the screen shows it when it is done.
  private func start() {
    guard !running else { return }
    running = true
    copied = false
    Task.detached(priority: .userInitiated) {
      let version = Core.tools.version
      let result = Core.tools.selfTest()
      await MainActor.run {
        coreVersion = version
        steps = result
        running = false
      }
    }
  }
}
