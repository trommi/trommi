// swift-tools-version: 6.0
// TrommiApp: the iOS app (an xtool project: exactly one library product, the app). It uses TrommiCore and TrommiClient
// from ../TrommiCore. Build and ship from Linux with omarchy-apple-dev (ios/README.md).
import PackageDescription

let package = Package(
  name: "TrommiApp",
  platforms: [.iOS(.v17), .macOS(.v14)],
  products: [
    // An xtool project contains exactly one library product, the main app.
    .library(name: "TrommiApp", targets: ["TrommiApp"]),
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
      ]
    ),
  ],
  swiftLanguageModes: [.v5]
)
