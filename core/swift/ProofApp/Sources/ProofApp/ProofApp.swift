// The smallest app over the Rust core: it runs the core's self-test at launch, off the main thread, and shows each
// step with its time and the versions of what ran. What the real app shows on its information screen is the same
// call.
import SwiftUI
import TrommiCoreRust

@main
struct ProofApp: App {
  @State private var lines = "running the self-test"

  var body: some Scene {
    WindowGroup {
      ScrollView {
        Text(lines).font(.system(.footnote, design: .monospaced)).padding().accessibilityIdentifier("result")
      }
      .task {
        lines = await Task.detached { report() }.value
      }
    }
  }
}

/// The self-test as text: one line for the outcome, one per step, then the versions.
func report() -> String {
  let test = selfTest(nowMs: UInt64(Date().timeIntervalSince1970 * 1000))
  let milliseconds = { (micros: UInt64) in String(format: "%.1f ms", Double(micros) / 1000) }
  var lines = [test.ok ? "OK: \(test.steps.count) steps in \(milliseconds(test.micros))" : "FAILED"]
  lines += test.steps.map { "\($0.ok ? "ok  " : "FAIL") \(milliseconds($0.micros))  \($0.name) \($0.detail)" }
  let versions = test.versions
  lines += ["core \(versions.core)", "OpenMLS \(versions.openmls)", versions.provider, "binding \(versions.binding)", "recovery: \(versions.recovery)"]
  return lines.joined(separator: "\n")
}
