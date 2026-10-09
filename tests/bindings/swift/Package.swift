// swift-tools-version:6.0
// The tests of the Swift binding (core/swift/TrommiCoreRust), as a package of its own at the repository's root:
// tests do not live inside the packages they test. Build the binding first (core/swift/build.sh host), then
//   swift test --package-path tests/bindings/swift
import PackageDescription

let package = Package(
  name: "TrommiBindingsTests",
  platforms: [.iOS(.v17), .macOS(.v14)],
  dependencies: [
    .package(path: "../../../core/swift/TrommiCoreRust"),
  ],
  targets: [
    .testTarget(
      name: "BindingsTests",
      dependencies: [.product(name: "TrommiCoreRust", package: "TrommiCoreRust")]
    ),
  ],
  swiftLanguageModes: [.v5]
)
