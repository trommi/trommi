// swift-tools-version:6.4
// TrommiCore: the Trommi crypto core (shared/crypto/FORMAT.md) in pure Swift, the hub client on top of it, and the
// command-line client `trommi-swift`. Crypto: swift-crypto (Apple's CryptoKit API; on Apple platforms it is CryptoKit),
// Argon2id: the vendored C reference implementation (Sources/CArgon2).
import PackageDescription

let package = Package(
  name: "TrommiCore",
  platforms: [.iOS(.v27), .macOS(.v15)],
  products: [
    .library(name: "TrommiCore", targets: ["TrommiCore"]),
    .library(name: "TrommiClient", targets: ["TrommiClient"]),
    // The Share Extension's encrypted inbox (App Group); small on purpose: the extension links only this.
    .library(name: "ShareInbox", targets: ["ShareInbox"]),
    // What the Notification Service Extension and the Live Activity widget link: the sealed context in the App Group,
    // opening one card's envelope with per-sender keys, the Live Activity's attributes. Not the sync engine.
    .library(name: "PushNotify", targets: ["PushNotify"]),
    .executable(name: "trommi-swift", targets: ["trommi-swift"]),
  ],
  dependencies: [
    .package(url: "https://github.com/apple/swift-crypto.git", from: "4.5.2"),
  ],
  targets: [
    .target(
      name: "CArgon2",
      path: "Sources/CArgon2",
      exclude: ["LICENSE", "README.md"],
      cSettings: [.define("ARGON2_NO_THREADS")]
    ),
    .target(
      name: "TrommiCore",
      dependencies: [.product(name: "Crypto", package: "swift-crypto"), "CArgon2"]
    ),
    .target(
      name: "TrommiClient",
      dependencies: ["TrommiCore"]
    ),
    .target(
      name: "ShareInbox",
      dependencies: [.product(name: "Crypto", package: "swift-crypto")]
    ),
    .target(
      name: "PushNotify",
      dependencies: ["TrommiCore"]
    ),
    .executableTarget(
      name: "trommi-swift",
      dependencies: ["TrommiClient", "TrommiCore"]
    ),
    .testTarget(
      name: "TrommiCoreTests",
      dependencies: ["TrommiCore"],
      resources: [.copy("Fixtures")]
    ),
    .testTarget(
      name: "TrommiClientTests",
      dependencies: ["TrommiClient", "TrommiCore"],
      resources: [.copy("Fixtures")]
    ),
    .testTarget(
      name: "ShareInboxTests",
      dependencies: ["ShareInbox"]
    ),
    .testTarget(
      name: "PushNotifyTests",
      dependencies: ["PushNotify", "TrommiCore"]
    ),
  ],
  swiftLanguageModes: [.v5]
)
