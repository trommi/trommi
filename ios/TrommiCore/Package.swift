// swift-tools-version:6.0
// TrommiCore: the Trommi crypto core (shared/crypto/FORMAT.md) in pure Swift, the hub client on top of it, and the
// command-line client `trommi-swift`. Crypto: swift-crypto (Apple's CryptoKit API; on Apple platforms it is CryptoKit),
// Argon2id: the vendored C reference implementation (Sources/CArgon2).
import PackageDescription

let package = Package(
  name: "TrommiCore",
  platforms: [.iOS(.v18), .macOS(.v15)],
  products: [
    .library(name: "TrommiCore", targets: ["TrommiCore"]),
    .library(name: "TrommiClient", targets: ["TrommiClient"]),
    // The Share Extension's encrypted inbox (App Group); small on purpose: the extension links only this.
    .library(name: "ShareInbox", targets: ["ShareInbox"]),
    .executable(name: "trommi-swift", targets: ["trommi-swift"]),
  ],
  dependencies: [
    .package(url: "https://github.com/apple/swift-crypto.git", "3.0.0"..<"5.0.0"),
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
  ],
  swiftLanguageModes: [.v5]
)
