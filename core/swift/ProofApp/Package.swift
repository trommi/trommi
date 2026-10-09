// swift-tools-version:6.0
// The smallest iOS app that links trommi-core (Rust) and calls it at launch. An xtool project, built the way the
// Trommi app is (ios/README.md): `xtool dev build` on Linux, no Mac.
import PackageDescription

let package = Package(
  name: "ProofApp",
  platforms: [.iOS(.v17), .macOS(.v14)],
  products: [
    .library(name: "ProofApp", targets: ["ProofApp"]),
  ],
  dependencies: [
    .package(path: "../TrommiCoreRust"),
  ],
  targets: [
    .target(name: "ProofApp", dependencies: [.product(name: "TrommiCoreRust", package: "TrommiCoreRust")]),
  ],
  swiftLanguageModes: [.v5]
)
