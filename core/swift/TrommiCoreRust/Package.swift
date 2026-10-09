// swift-tools-version:6.0
// TrommiCoreRust: trommi-core (Rust, OpenMLS) for Swift. Three parts:
//   lib/<platform>/libtrommi_core_ffi.a   the Rust static library, built by ../build.sh (not in the repository)
//   Sources/TrommiCoreFFI                 its C header, written by UniFFI (not in the repository); SwiftPM makes the module
//   Sources/TrommiCoreRust                the Swift API, written by UniFFI (not in the repository)
// The library is linked with a search path per platform. SwiftPM allows such a flag only in a root package or one
// used by path, which is how the app uses this one (ios/TrommiApp → ../TrommiCore → this).
import PackageDescription

let lib = "\(Context.packageDirectory)/lib"

let package = Package(
  name: "TrommiCoreRust",
  platforms: [.iOS(.v17), .macOS(.v14)],
  products: [
    .library(name: "TrommiCoreRust", targets: ["TrommiCoreRust"]),
  ],
  targets: [
    .target(name: "TrommiCoreFFI", path: "Sources/TrommiCoreFFI"),
    .target(
      name: "TrommiCoreRust",
      dependencies: ["TrommiCoreFFI"],
      linkerSettings: [
        .unsafeFlags(["-L\(lib)/ios"], .when(platforms: [.iOS])),
        .unsafeFlags(["-L\(lib)/macos"], .when(platforms: [.macOS])),
        .unsafeFlags(["-L\(lib)/linux"], .when(platforms: [.linux])),
        .linkedLibrary("trommi_core_ffi"),
      ]
    ),
    .testTarget(name: "TrommiCoreRustTests", dependencies: ["TrommiCoreRust"]),
  ],
  swiftLanguageModes: [.v5]
)
