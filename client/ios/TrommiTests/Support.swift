import Foundation
import XCTest
#if canImport(TrommiCore)
@testable import TrommiCore
#else
@testable import Trommi
#endif

/// Finds the fixture files, under SwiftPM (Bundle.module) and in the Xcode test bundle alike.
enum Fixture {
    private final class Marker {}

    static func data(_ name: String) throws -> Data {
        #if SWIFT_PACKAGE
        let bundle = Bundle.module
        #else
        let bundle = Bundle(for: Marker.self)
        #endif
        let url = bundle.url(forResource: name, withExtension: "json", subdirectory: "Fixtures")
            ?? bundle.url(forResource: name, withExtension: "json")
        return try Data(contentsOf: try XCTUnwrap(url, "fixture \(name).json is missing from the test bundle"))
    }

    /// What dev/demo-state.mjs writes: one agent's board, without an agent list.
    static func single() throws -> BoardState { try BoardState.decode(data("state")) }

    /// The same board spread over three agents, plus a yes/no card; also the app's demo data.
    static func multi() throws -> BoardState { try BoardState.decode(data("demo-state")) }
}
