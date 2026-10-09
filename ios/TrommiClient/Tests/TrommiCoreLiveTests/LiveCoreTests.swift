// LiveCore on the real Rust library. That this file links and runs under `swift test` on Linux is the proof that the
// static library of core/swift/build.sh, UniFFI's Swift file and the package's linker settings fit together.
import Foundation
import XCTest
import TrommiClient
import TrommiCoreLive

final class LiveCoreTests: XCTestCase {
  /// The `version` of the package in core/Cargo.toml, read from the checkout this test was built in.
  private func cargoVersion() throws -> String {
    var root = URL(fileURLWithPath: #filePath)
    for _ in 0..<5 { root.deleteLastPathComponent() }   // Tests/TrommiCoreLiveTests, Tests, TrommiClient, ios, the root
    let manifest = try String(contentsOf: root.appendingPathComponent("core/Cargo.toml"), encoding: .utf8)
    for line in manifest.split(separator: "\n") {
      if line.hasPrefix("[") && line != "[package]" { break }
      let parts = line.split(separator: "=", maxSplits: 1).map { $0.trimmingCharacters(in: .whitespaces) }
      if parts.count == 2, parts[0] == "version" { return parts[1].trimmingCharacters(in: CharacterSet(charactersIn: "\"")) }
    }
    throw TrommiError("test", "no version in core/Cargo.toml")
  }

  func testVersionIsTheCoresOwn() throws {
    let version = LiveCore().version
    XCTAssertFalse(version.isEmpty)
    XCTAssertEqual(version, try cargoVersion())
  }

  /// What the binding does not have yet refuses by name, and never pretends. Recovery is the core's last planned
  /// module, so this call is the last stub to go; delete the test with it.
  func testAStubSaysItIsAStub() {
    XCTAssertThrowsError(try LiveCore().recoverySigner(code: [])) { error in
      XCTAssertEqual((error as? TrommiError)?.code, LiveCore.notBuiltCode)
      XCTAssertEqual((error as? TrommiError)?.message, "recoverySigner(code:): not in this build of the core binding")
    }
  }

  /// The self test always answers with at least one step: a failed one named "self_test" while it is a stub.
  func testSelfTestAnswers() {
    XCTAssertFalse(LiveCore().selfTest().isEmpty)
  }

  /// The app reaches the core only through `Core.tools`.
  func testInstalledAsTheProcessCore() {
    Core.tools = LiveCore()
    XCTAssertTrue(Core.isInstalled)
    XCTAssertEqual(Core.tools.version, LiveCore().version)
  }
}
