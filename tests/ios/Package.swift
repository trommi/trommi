// swift-tools-version:6.0
// The tests of app/ios/TrommiClient, in the repository's one tests folder. A package of its own, because SwiftPM takes no
// target outside its package: it depends on the client by path. Run `swift test` here, after core/swift/build.sh
// (the tests of TrommiCoreLive link the Rust library). One folder per tested target.
import PackageDescription

let client = "TrommiClient"
let package = Package(
  name: "TrommiClientTests",
  platforms: [.iOS("27.0"), .macOS(.v15)],
  dependencies: [.package(path: "../../app/ios/TrommiClient")],
  targets: [
    .testTarget(name: "TrommiClientTests", dependencies: [.product(name: "TrommiClient", package: client)], path: "TrommiClientTests", resources: [.copy("Fixtures")]),
    .testTarget(name: "TrommiCoreLiveTests", dependencies: [.product(name: "TrommiCoreLive", package: client)], path: "TrommiCoreLiveTests"),
    .testTarget(name: "ShareInboxTests", dependencies: [.product(name: "ShareInbox", package: client)], path: "ShareInboxTests"),
    .testTarget(name: "PushNotifyTests", dependencies: [.product(name: "PushNotify", package: client)], path: "PushNotifyTests"),
    .testTarget(name: "NotifyCoreLiveTests", dependencies: [.product(name: "NotifyCoreLive", package: client)], path: "NotifyCoreLiveTests"),
  ],
  swiftLanguageModes: [.v5]
)
