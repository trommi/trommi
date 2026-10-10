// swift-tools-version:6.0
// TrommiClient: everything of the iOS app that is not a view. The protocol itself (spec/v1.md) is not here: it is
// trommi-core (Rust, OpenMLS), reached through `Core.swift`, a Swift protocol that mirrors core/README.md, and bound
// to the real library by the target TrommiCoreLive (UniFFI, core/swift/TrommiCoreRust).
//
//   TrommiClient     model (Board, Desk, …), the device store, the hub client, the engine `Room`. No crypto of its
//                    own and no link to the Rust library: it builds and tests on Linux without it.
//   TrommiCoreLive   `Core.swift` on the Rust core. Only the app links it: +3 MB.
//   NotifyCoreLive   PushNotify's one call (open a push) on the Rust core, for the notification extension alone,
//                    so that it links neither the engine nor the model.
//   ShareInbox       the Share Extension's sealed inbox in the App Group (local storage, Apple's CryptoKit).
//   PushNotify       what the Notification Service Extension and the Live Activity widget need.
//
// Build the Rust library first: core/swift/build.sh (ios/README.md). The tests are a package of their own in the
// repository's one tests folder: tests/ios (SwiftPM takes no target outside its package).
import PackageDescription

let package = Package(
  name: "TrommiClient",
  platforms: [.iOS("27.0"), .macOS(.v15)],
  products: [
    .library(name: "TrommiClient", targets: ["TrommiClient"]),
    .library(name: "TrommiCoreLive", targets: ["TrommiCoreLive"]),
    .library(name: "NotifyCoreLive", targets: ["NotifyCoreLive"]),
    .library(name: "ShareInbox", targets: ["ShareInbox"]),
    .library(name: "PushNotify", targets: ["PushNotify"]),
  ],
  dependencies: [
    .package(url: "https://github.com/apple/swift-crypto.git", from: "4.5.2"),
    .package(path: "../../core/swift/TrommiCoreRust"),
  ],
  targets: [
    .target(name: "TrommiClient", dependencies: [.product(name: "Crypto", package: "swift-crypto")]),
    .target(name: "TrommiCoreLive", dependencies: ["TrommiClient", .product(name: "TrommiCoreRust", package: "TrommiCoreRust")]),
    .target(name: "NotifyCoreLive", dependencies: ["PushNotify", .product(name: "TrommiCoreRust", package: "TrommiCoreRust")]),
    .target(name: "ShareInbox", dependencies: [.product(name: "Crypto", package: "swift-crypto")]),
    .target(name: "PushNotify", dependencies: []),
  ],
  swiftLanguageModes: [.v5]
)
