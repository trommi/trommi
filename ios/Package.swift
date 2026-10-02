// swift-tools-version:5.9
// The part of the app that has no UI: models, decoding, ordering, parsing.
// It builds and tests on Linux too:  swift build && swift test
import PackageDescription

let package = Package(
    name: "TrommiCore",
    platforms: [.iOS(.v17), .macOS(.v14)],
    products: [.library(name: "TrommiCore", targets: ["TrommiCore"])],
    targets: [
        .target(name: "TrommiCore", path: "Trommi/Core"),
        .testTarget(
            name: "TrommiCoreTests",
            dependencies: ["TrommiCore"],
            path: "TrommiTests",
            resources: [.copy("Fixtures")]
        ),
    ]
)
