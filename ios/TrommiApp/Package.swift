// swift-tools-version: 6.4
// TrommiApp: the iOS app (an xtool project: exactly one library product, the app). It uses TrommiCore and TrommiClient
// from ../TrommiCore. Build and ship from Linux with omarchy-apple-dev (ios/README.md).
import PackageDescription

let package = Package(
  name: "TrommiApp",
  platforms: [.iOS(.v27), .macOS(.v15)],
  products: [
    // An xtool project's first library product is the main app; each further one is an app extension (xtool.yml).
    .library(name: "TrommiApp", targets: ["TrommiApp"]),
    // The Share Extension (xtool.yml `extensions:`): links only the small ShareInbox, not the sync engine.
    .library(name: "TrommiShare", targets: ["TrommiShare"]),
    // The Notification Service Extension: the card's title in a push (links PushNotify only, not the sync engine).
    .library(name: "TrommiNotify", targets: ["TrommiNotify"]),
    // The Live Activity's widget (Dynamic Island, lock screen).
    .library(name: "TrommiLive", targets: ["TrommiLive"]),
  ],
  dependencies: [
    .package(path: "../TrommiCore"),
  ],
  targets: [
    .target(
      name: "TrommiApp",
      dependencies: [
        .product(name: "TrommiCore", package: "TrommiCore"),
        .product(name: "TrommiClient", package: "TrommiCore"),
        .product(name: "ShareInbox", package: "TrommiCore"),
        .product(name: "PushNotify", package: "TrommiCore"),
      ],
      resources: [.copy("Resources/pen.json"), .copy("Resources/Fonts"), .copy("Resources/Demo")]
    ),
    .target(
      name: "TrommiShare",
      dependencies: [.product(name: "ShareInbox", package: "TrommiCore")]
    ),
    .target(
      name: "TrommiNotify",
      dependencies: [.product(name: "PushNotify", package: "TrommiCore"), .product(name: "TrommiCore", package: "TrommiCore")]
    ),
    .target(
      name: "TrommiLive",
      dependencies: [.product(name: "PushNotify", package: "TrommiCore")]
    ),
  ],
  swiftLanguageModes: [.v5]
)
