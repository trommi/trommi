// swift-tools-version: 6.0
// TrommiApp: the iOS app (an xtool project: exactly one library product, the app). It uses TrommiCore and TrommiClient
// from ../TrommiCore. Build and ship from Linux with omarchy-apple-dev (ios/README.md).
import PackageDescription

let package = Package(
  name: "TrommiApp",
  platforms: [.iOS(.v18), .macOS(.v15)],
  products: [
    // An xtool project's first library product is the main app; each further one is an app extension (xtool.yml).
    .library(name: "TrommiApp", targets: ["TrommiApp"]),
    // The Share Extension (xtool.yml `extensions:`): links only the small ShareInbox, not the sync engine.
    .library(name: "TrommiShare", targets: ["TrommiShare"]),
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
      ],
      resources: [.copy("Resources/pen.json"), .copy("Resources/Fonts"), .copy("Resources/Demo")]
    ),
    .target(
      name: "TrommiShare",
      dependencies: [.product(name: "ShareInbox", package: "TrommiCore")]
    ),
  ],
  swiftLanguageModes: [.v5]
)
