// One call into the Rust core at launch, on the phone. The screen shows its answer.
import SwiftUI
import TrommiCoreRust

@main
struct ProofApp: App {
  var body: some Scene {
    WindowGroup {
      Text("trommi-core \(coreVersion())").padding().accessibilityIdentifier("result")
    }
  }
}
