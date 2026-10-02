import XCTest
#if canImport(TrommiCore)
@testable import TrommiCore
#else
@testable import Trommi
#endif

/// The marks must match the web: Fixtures/doodles.json is what doodle(), sketch() and
/// pairDoodle() in client/web/js/ui.js draw (written by tools/doodle-fixtures.mjs).
final class DoodleTests: XCTestCase {
    private struct Expected: Decodable {
        struct Mark: Decodable { var seed: String?; var name: String?; var rotate: Double; var paths: [String] }
        struct Pair: Decodable {
            struct Member: Decodable { var id: String; var mark: String }
            var members: [Member]; var transforms: [String]; var loop: String
        }
        struct Crown: Decodable { var box: String; var path: String }
        var doodles: [Mark]
        var sketches: [Mark]
        var pairs: [Pair]
        var crown: Crown
    }

    private func expected() throws -> Expected { try JSONDecoder().decode(Expected.self, from: Fixture.data("doodles")) }

    /// The letters of a path and its numbers. Sine and cosine may differ in the last
    /// bit between JavaScript and Swift, which can move a rounded value by 0.1.
    private func parts(_ d: String) -> (letters: String, numbers: [Double]) {
        var letters = ""
        var numbers: [Double] = []
        for token in d.split(separator: " ") {
            var text = token
            if let first = text.first, first.isLetter { letters.append(first); text = text.dropFirst() }
            if let value = Double(text) { numbers.append(value) }
        }
        return (letters, numbers)
    }

    private var exact = 0
    private var total = 0

    private func assertSame(_ ours: [PathCommand], _ theirs: String, _ what: String, file: StaticString = #filePath, line: UInt = #line) {
        let text = Doodle.svgPath(ours)
        total += 1
        if text == theirs { exact += 1; return }
        let a = parts(text), b = parts(theirs)
        XCTAssertEqual(a.letters, b.letters, "\(what): other commands", file: file, line: line)
        XCTAssertEqual(a.numbers.count, b.numbers.count, "\(what): other length", file: file, line: line)
        for (x, y) in zip(a.numbers, b.numbers) where abs(x - y) > 0.1001 {
            return XCTFail("\(what): \(text) is not \(theirs)", file: file, line: line)
        }
    }

    func testSeededRandomMatchesJavaScript() {
        // node: seeded('api') from ui.js, first three numbers.
        var r = SeededRandom("api")
        let first = [r.next(), r.next(), r.next()]
        XCTAssertEqual(first[0], 0.7867113668471575, accuracy: 1e-15)
        XCTAssertEqual(first[1], 0.8297738907858729, accuracy: 1e-15)
        XCTAssertEqual(first[2], 0.6024678170215338, accuracy: 1e-15)
        var again = SeededRandom("api")
        XCTAssertEqual(again.next(), first[0], "the same seed gives the same numbers")
        var other = SeededRandom("apj")
        XCTAssertNotEqual(other.next(), first[0])
    }

    func testMarksMatchTheWebGenerator() throws {
        let fixture = try expected()
        XCTAssertGreaterThanOrEqual(fixture.doodles.count, 30)
        for mark in fixture.doodles {
            let seed = mark.seed ?? ""
            let ours = Doodle.mark(seed)
            XCTAssertEqual(ours.rotation, mark.rotate, "rotation of \(seed)")
            XCTAssertEqual(ours.strokes.count, mark.paths.count, "strokes of \(seed)")
            for (stroke, d) in zip(ours.strokes, mark.paths) { assertSame(stroke, d, "doodle \(seed)") }
            XCTAssertEqual(ours.width, 32)
        }
        XCTAssertEqual(exact, total, "every stroke is the same text as on the web")
    }

    func testEveryNamedDrawingMatchesTheWeb() throws {
        let fixture = try expected()
        XCTAssertEqual(Doodle.drawings.count, 40)
        XCTAssertEqual(Set(Doodle.drawings).count, 40)
        XCTAssertEqual(Array(Doodle.drawings.prefix(8)), ["burst", "spiral", "blob", "flower", "waves", "knot", "bolt", "hatch"])
        for name in Doodle.drawings {
            let seed = Doodle.drawingMark(name)
            XCTAssertEqual(seed, "draw:\(name)")
            XCTAssertEqual(Doodle.drawingName(of: seed), name)
            let theirs = try XCTUnwrap(fixture.doodles.first { $0.seed == seed }, "the fixture has no \(seed)")
            let ours = Doodle.mark(seed)
            XCTAssertEqual(ours.rotation, theirs.rotate, "rotation of \(seed)")
            XCTAssertEqual(ours.strokes.count, theirs.paths.count, "strokes of \(seed)")
            for (stroke, d) in zip(ours.strokes, theirs.paths) { assertSame(stroke, d, "drawing \(name)") }
        }
        XCTAssertEqual(exact, total, "every stroke is the same text as on the web")
        // A name that is no drawing is a seed like any other.
        XCTAssertEqual(Doodle.drawingName(of: "draw:nothing-of-the-kind"), "nothing-of-the-kind")
        XCTAssertNil(Doodle.drawingName(of: "api"))
        XCTAssertNil(Doodle.drawingName(of: "draw:"))
        // A straight stroke keeps its corners: no curve in a star.
        XCTAssertFalse(Doodle.mark("draw:star").strokes.joined().contains { if case .quad = $0 { return true } else { return false } })
    }

    func testTheCrownIsTheWebsCrown() throws {
        let crown = try expected().crown
        XCTAssertEqual(crown.box, "0 0 26 19")
        XCTAssertEqual(Doodle.crown.width, 26)
        XCTAssertEqual(Doodle.crown.height, 19)
        XCTAssertEqual(Doodle.crown.strokes.count, 1)
        XCTAssertEqual(Doodle.svgPathShort(Doodle.crown.strokes[0]), crown.path)
    }

    func testEveryFamilyOfMarksIsCovered() throws {
        // The first number of a seed picks the family; the fixtures must reach all eight.
        var families = Set<Int>()
        for mark in try expected().doodles where Doodle.drawingName(of: mark.seed ?? "") == nil {
            var r = SeededRandom(mark.seed ?? "")
            families.insert(Int((r.next() * 8).rounded(.down)))
        }
        XCTAssertEqual(families, Set(0..<8))
    }

    func testSketchesMatchTheWebGenerator() throws {
        let fixture = try expected()
        XCTAssertEqual(Set(fixture.sketches.compactMap(\.name)), Set(SketchKind.allCases.map(\.rawValue)))
        for sketch in fixture.sketches {
            let kind = try XCTUnwrap(SketchKind(rawValue: sketch.name ?? ""))
            let ours = Doodle.sketch(kind)
            XCTAssertEqual(ours.rotation, sketch.rotate, accuracy: 0.05, "rotation of \(kind)")
            XCTAssertEqual(ours.strokes.count, sketch.paths.count)
            for (stroke, d) in zip(ours.strokes, sketch.paths) { assertSame(stroke, d, "sketch \(kind)") }
            XCTAssertEqual(ours.width, 24)
        }
        XCTAssertEqual(exact, total)
    }

    func testPairsMatchTheWebGenerator() throws {
        for pair in try expected().pairs {
            let ours = Doodle.pair(pair.members.map { (id: $0.id, mark: $0.mark) })
            assertSame(ours.loop, pair.loop, "loop of \(pair.members.map(\.id))")
            XCTAssertEqual(ours.members.count, pair.transforms.count)
            for (member, transform) in zip(ours.members, pair.transforms) {
                // "translate(4.5 3.9) scale(0.68) rotate(0 16 16)"
                let numbers = transform.split { !"0123456789.-".contains($0) }.compactMap { Double($0) }
                XCTAssertEqual(numbers.count, 6, transform)
                XCTAssertEqual(member.x, numbers[0], accuracy: 0.0001, transform)
                XCTAssertEqual(member.y, numbers[1], accuracy: 0.0001, transform)
                XCTAssertEqual(member.scale, numbers[2], accuracy: 0.0001, transform)
                XCTAssertEqual(member.rotation, numbers[3], accuracy: 0.0001, transform)
            }
        }
        XCTAssertEqual(exact, total)
    }

    func testMarksAreDeterministicAndStayInTheirBox() {
        for seed in ["api", "web-frontend", "x", "ios-app", "a much longer seed with spaces"] {
            let a = Doodle.mark(seed), b = Doodle.mark(seed)
            XCTAssertEqual(a, b)
            XCTAssertFalse(a.strokes.isEmpty)
            XCTAssertTrue(abs(a.rotation) <= 8)
            for command in a.strokes.joined() {
                let values: [Double]
                switch command {
                case .move(let x, let y), .line(let x, let y): values = [x, y]
                case .quad(let cx, let cy, let x, let y): values = [cx, cy, x, y]
                }
                XCTAssertTrue(values.allSatisfy { $0 >= -2 && $0 <= 34 }, "\(seed): \(command) leaves the box")
            }
        }
        XCTAssertNotEqual(Doodle.mark("api"), Doodle.mark("api:1"))
        XCTAssertEqual(Doodle.advice("c-nav/delete"), Doodle.advice("c-nav/delete"))
        XCTAssertNotEqual(Doodle.advice("a"), Doodle.advice("b"))
        XCTAssertEqual(Doodle.advice("a").strokes.count, 1)
    }

    func testRoundingLikeToFixed() {
        XCTAssertEqual(Doodle.round1(1.25), 1.3)
        XCTAssertEqual(Doodle.round1(-1.25), -1.3)
        XCTAssertEqual(Doodle.round1(15.04), 15.0)
        XCTAssertEqual(Doodle.svgPath([.move(4, 12), .quad(8, 7, 10, 9.6), .line(28, 11.5)]), "M4.0 12.0 Q8.0 7.0 10.0 9.6 L28.0 11.5")
    }
}
