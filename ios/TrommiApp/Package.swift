// swift-tools-version: 6.4
// TrommiApp: the iOS app and its three extensions (an xtool project). Everything that is not a view is the package
// ../TrommiClient; the protocol is trommi-core (Rust), linked into the app through TrommiCoreLive and into the
// notification extension through NotifyCoreLive. Build the Rust library first (ios/README.md).
import PackageDescription

let package = Package(
  name: "TrommiApp",
  platforms: [.iOS(.v27), .macOS(.v15)],
  products: [
    // An xtool project's first library product is the main app; each further one is an app extension (xtool.yml).
    .library(name: "TrommiApp", targets: ["TrommiApp"]),
    // The Share Extension (xtool.yml `extensions:`): links only the small ShareInbox, not the sync engine.
    .library(name: "TrommiShare", targets: ["TrommiShare"]),
    // The Notification Service Extension: opens a push's sealed part and shows the fixed text (links PushNotify and the core's one opening call, not the engine).
    .library(name: "TrommiNotify", targets: ["TrommiNotify"]),
    // The Live Activity's widget (Dynamic Island, lock screen).
    .library(name: "TrommiLive", targets: ["TrommiLive"]),
  ],
  dependencies: [
    .package(path: "../TrommiClient"),
  ],
  targets: [
    .target(
      name: "TrommiApp",
      dependencies: [
        .product(name: "TrommiClient", package: "TrommiClient"),
        .product(name: "TrommiCoreLive", package: "TrommiClient"),
        .product(name: "ShareInbox", package: "TrommiClient"),
        .product(name: "PushNotify", package: "TrommiClient"),
      ],
      // The privacy manifest belongs at the bundle's root, not in the package's resource bundle: xtool.yml copies it.
      exclude: ["Resources/PrivacyInfo.xcprivacy"],
      resources: [.copy("Resources/pen.json"), .copy("Resources/Fonts"), .copy("Resources/Demo")]
    ),
    .target(
      name: "TrommiShare",
      dependencies: [.product(name: "ShareInbox", package: "TrommiClient")]
    ),
    .target(
      name: "TrommiNotify",
      dependencies: [.product(name: "PushNotify", package: "TrommiClient"), .product(name: "NotifyCoreLive", package: "TrommiClient")]
    ),
    .target(
      name: "TrommiLive",
      dependencies: [.product(name: "PushNotify", package: "TrommiClient")]
    ),
  ],
  swiftLanguageModes: [.v5]
)
