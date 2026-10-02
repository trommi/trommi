// The hand-scribbled marks: one per session, generated from its id, so a
// session is recognised before its name is read; several sessions scribbled
// together inside one loop; and the sketched icons (thumbs, hand, later, choose).
// A port of seeded(), penPath(), DOODLES, doodle(), pairDoodle() and sketch()
// in client/web/js/ui.js: the same seed gives the same strokes as on the web.
// Coordinates are rounded to one decimal like the web's toFixed(1).
import Foundation

/// One step of a pen stroke, in the coordinates of the mark's box.
enum PathCommand: Equatable, Sendable {
    case move(Double, Double)
    case line(Double, Double)
    /// A quadratic curve: control point, then end point.
    case quad(Double, Double, Double, Double)
}

/// The generator of ui.js: FNV-1a over the UTF-16 code units, then a mixing step per number.
struct SeededRandom {
    private var h: UInt32 = 2_166_136_261

    init(_ text: String) {
        // JavaScript iterates a string by code point and takes charCodeAt(0) of each:
        // the first UTF-16 unit of every scalar.
        for scalar in text.unicodeScalars {
            let unit = UInt32(UTF16.encode(scalar)?.first ?? 0)
            h = (h ^ unit) &* 16_777_619
        }
    }

    /// The next number in 0..<1.
    mutating func next() -> Double {
        h = (h ^ (h >> 15)) &* 2_246_822_507
        h = (h ^ (h >> 13)) &* 3_266_489_909
        h ^= h >> 16
        return Double(h) / 4_294_967_296
    }
}

struct Doodle: Equatable, Sendable {
    /// One list of commands per stroke of the pen.
    var strokes: [[PathCommand]]
    /// How far the whole mark is turned, in degrees.
    var rotation: Double
    /// The box the coordinates live in: 32 x 32 for a session's mark, 24 x 24 for an icon.
    var width: Double
    var height: Double

    private typealias Point = (x: Double, y: Double)

    /// toFixed(1): round half away from zero to one decimal.
    static func round1(_ value: Double) -> Double {
        (value * 10).rounded(.toNearestOrAwayFromZero) / 10
    }

    /// A smooth line through points, the way a pen moves: quadratic curves between midpoints.
    private static func pen(_ points: [Point], closed: Bool = false) -> [PathCommand] {
        guard points.count > 1 else { return [] }
        let p = closed ? points + [points[0], points[1]] : points
        var out: [PathCommand] = [.move(round1(p[0].x), round1(p[0].y))]
        if p.count > 2 {
            for i in 1..<(p.count - 1) {
                let mx = (p[i].x + p[i + 1].x) / 2, my = (p[i].y + p[i + 1].y) / 2
                out.append(.quad(round1(p[i].x), round1(p[i].y), round1(mx), round1(my)))
            }
        }
        if !closed, let last = p.last { out.append(.line(round1(last.x), round1(last.y))) }
        return out
    }

    private static func segment(_ x1: Double, _ y1: Double, _ x2: Double, _ y2: Double) -> [PathCommand] {
        [.move(round1(x1), round1(y1)), .line(round1(x2), round1(y2))]
    }

    // The eight families of DOODLES, in the order of ui.js. Every call of r.next()
    // stands where the JavaScript calls r(), so the numbers are drawn in the same order.

    private static func burst(_ r: inout SeededRandom) -> [[PathCommand]] {
        let n = 6 + Int((r.next() * 4).rounded(.down))
        let turn = r.next() * Double.pi
        var out: [[PathCommand]] = []
        for i in 0..<n {
            let a = turn + (Double(i) / Double(n)) * Double.pi * 2 + (r.next() - 0.5) * 0.25
            let len = 7 + r.next() * 6
            let from = 1.5 + r.next() * 2
            out.append(segment(16 + cos(a) * from, 16 + sin(a) * from, 16 + cos(a) * len, 16 + sin(a) * len))
        }
        return out
    }

    private static func spiral(_ r: inout SeededRandom) -> [[PathCommand]] {
        let turns = 2.2 + r.next() * 1.2
        let start = r.next() * 6
        var points: [Point] = []
        for i in 0..<34 {
            let t = Double(i) / 33
            let a = start + t * turns * Double.pi * 2
            let rad = 1.5 + t * 11 + (r.next() - 0.5) * 1.1
            points.append((16 + cos(a) * rad, 16 + sin(a) * rad))
        }
        return [pen(points)]
    }

    private static func blob(_ r: inout SeededRandom) -> [[PathCommand]] {
        var out: [[PathCommand]] = []
        for pass in 0..<2 {
            var points: [Point] = []
            for i in 0..<9 {
                let a = (Double(i) / 9) * Double.pi * 2 + Double(pass) * 0.4
                let rad = 9.5 + (r.next() - 0.5) * 4 - Double(pass) * 1.5
                points.append((16 + cos(a) * rad, 16 + sin(a) * rad * 0.9))
            }
            out.append(pen(points, closed: true))
        }
        return out
    }

    private static func flower(_ r: inout SeededRandom) -> [[PathCommand]] {
        let n = 4 + Int((r.next() * 3).rounded(.down))
        let turn = r.next() * Double.pi
        var out: [[PathCommand]] = []
        for i in 0..<n {
            let a = turn + (Double(i) / Double(n)) * Double.pi * 2
            let w = 0.42 + r.next() * 0.12
            let len = 10.5 + r.next() * 2.5
            let tip: Point = (16 + cos(a) * len, 16 + sin(a) * len)
            let left: Point = (16 + cos(a - w) * len * 0.72, 16 + sin(a - w) * len * 0.72)
            let right: Point = (16 + cos(a + w) * len * 0.72, 16 + sin(a + w) * len * 0.72)
            out.append(pen([(16, 16), left, tip, right, (16, 16)]))
        }
        return out
    }

    private static func waves(_ r: inout SeededRandom) -> [[PathCommand]] {
        var out: [[PathCommand]] = []
        for y in [9.0, 16.0, 23.0] {
            var points: [Point] = []
            for i in 0..<7 {
                points.append((4 + Double(i) * 4, y + (i % 2 == 1 ? -2.6 : 2.6) + (r.next() - 0.5) * 1.6))
            }
            out.append(pen(points))
        }
        return out
    }

    private static func knot(_ r: inout SeededRandom) -> [[PathCommand]] {
        let a = Double(2 + Int((r.next() * 2).rounded(.down)))
        let b = 3.0
        let phase = r.next() * 3
        var points: [Point] = []
        for i in 0..<40 {
            let t = (Double(i) / 39) * Double.pi * 2
            let x = 16 + sin(a * t + phase) * 11 + (r.next() - 0.5) * 0.8
            let y = 16 + sin(b * t) * 10 + (r.next() - 0.5) * 0.8
            points.append((x, y))
        }
        return [pen(points)]
    }

    private static func bolt(_ r: inout SeededRandom) -> [[PathCommand]] {
        var points: [Point] = []
        for i in 0..<6 {
            points.append((8 + Double(i % 2) * 12 + (r.next() - 0.5) * 5, 4 + Double(i) * 4.8))
        }
        let x1 = 6 + r.next() * 3
        let x2 = 26 - r.next() * 3
        return [pen(points), pen([(x1, 27), (x2, 27.5)])]
    }

    private static func hatch(_ r: inout SeededRandom) -> [[PathCommand]] {
        var out: [[PathCommand]] = []
        for i in 0..<6 {
            let x1 = 5 + Double(i) * 3.6 + r.next()
            let y1 = 25 + r.next() * 2
            let x2 = 11 + Double(i) * 3.6 + r.next()
            let y2 = 6 + r.next() * 2
            out.append(segment(x1, y1, x2, y2))
        }
        return out
    }

    /// The scribbled mark that belongs to one session (doodle(id) in ui.js).
    static func mark(_ seed: String) -> Doodle {
        var r = SeededRandom(seed)
        let family = Int((r.next() * 8).rounded(.down))
        let strokes: [[PathCommand]]
        switch family {
        case 0: strokes = burst(&r)
        case 1: strokes = spiral(&r)
        case 2: strokes = blob(&r)
        case 3: strokes = flower(&r)
        case 4: strokes = waves(&r)
        case 5: strokes = knot(&r)
        case 6: strokes = bolt(&r)
        default: strokes = hatch(&r)
        }
        // Math.round: halves go up.
        let rotation = ((r.next() - 0.5) * 16 + 0.5).rounded(.down)
        return Doodle(strokes: strokes, rotation: rotation, width: 32, height: 32)
    }

    // MARK: several sessions as one mark

    /// Where one member's mark stands inside the pair's box of 46 x 34.
    struct Placement: Equatable, Sendable {
        var seed: String
        var x: Double
        var y: Double
        var scale: Double
        /// Degrees, around the middle of the member's own 32 x 32 box.
        var rotation: Double
    }

    struct Pair: Equatable, Sendable {
        var members: [Placement]
        /// The loop drawn round all of them: one and a bit turns, starting and ending apart.
        var loop: [PathCommand]
        static let width = 46.0
        static let height = 34.0
    }

    /// Several sessions scribbled together (pairDoodle in ui.js). `members`: id and mark seed of each.
    static func pair(_ members: [(id: String, mark: String)]) -> Pair {
        var r = SeededRandom(members.map(\.id).joined(separator: "+"))
        let n = members.count
        let size = n > 2 ? 0.56 : 0.68
        var placed: [Placement] = []
        for (i, member) in members.enumerated() {
            let own = mark(member.mark)
            let x = 4.5 + (n > 1 ? Double(i) * ((37 - 32 * size) / Double(n - 1)) : 0)
            let y = (34 - 32 * size) / 2 + (i % 2 == 1 ? 2.4 : -2.2)
            placed.append(Placement(seed: member.mark, x: round1(x), y: round1(y), scale: size, rotation: own.rotation + (i % 2 == 1 ? 9 : -7)))
        }
        let start = r.next() * 6
        let steps = 15
        var points: [Point] = []
        for i in 0..<steps {
            let a = start + (Double(i) / Double(steps - 2)) * Double.pi * 2
            let drift = Double(i) / Double(steps) * 1.6
            let x = 23 + cos(a) * (20.5 - drift + (r.next() - 0.5) * 1.4)
            let y = 17 + sin(a) * (14.5 - drift + (r.next() - 0.5) * 1.4)
            points.append((x, y))
        }
        return Pair(members: placed, loop: pen(points))
    }

    // MARK: sketched icons

    private static let thumb: [[Point]] = [
        [(4.6, 11.2), (4.2, 19.6), (7.3, 19.9), (7.7, 11), (4.3, 10.7)],
        [(8.2, 11.4), (10, 7.6), (10.8, 3.6), (13.4, 3.9), (13, 7.4), (12.4, 9.9), (17.8, 9.6), (19.8, 10.8), (19.2, 13.4), (18.4, 16.8), (17.2, 19.8), (14, 20.1), (10.2, 19.8), (8.1, 18.9)],
        [(15.2, 13.2), (18.6, 13.3)],
        [(14.8, 16.4), (17.9, 16.6)],
    ]

    private static func strokes(of kind: SketchKind) -> [[Point]] {
        switch kind {
        case .yes: return thumb
        case .no: return thumb.map { $0.map { (24 - $0.x, 24 - $0.y) } }
        case .hand:
            return [
                [(7.6, 14.6), (5.8, 12.2), (3.9, 11.4), (3.7, 13.3), (5.6, 16.2), (7.4, 19.4), (10, 21.3), (13.6, 21.4), (16.4, 19.6), (17.6, 15.4), (17.8, 8.4), (16.6, 7), (15.6, 8.6), (15.5, 11.6)],
                [(7.6, 14.2), (7.5, 6.2), (8.6, 4.8), (9.8, 6.2), (10, 11.2)],
                [(10, 11), (10.1, 4.2), (11.4, 2.7), (12.6, 4.2), (12.6, 11)],
                [(12.7, 11.2), (13, 5.2), (14.2, 4), (15.3, 5.6), (15.3, 11.8)],
            ]
        case .later:
            return [[(12, 3.8), (12.3, 10), (11.9, 16.4)], [(6.6, 11.6), (12.1, 17.2), (17.4, 11.3)], [(4.6, 20.8), (12, 20.3), (19.6, 20.6)]]
        case .back:
            return [[(12.1, 20.2), (11.8, 14), (12.2, 7.6)], [(6.6, 12.6), (12, 6.8), (17.5, 12.3)], [(4.6, 3.6), (12, 3.9), (19.5, 3.4)]]
        case .choose:
            return [
                [(3.6, 6.6), (5.2, 8.6), (8.4, 4.4)],
                [(11.4, 6.6), (16, 6.3), (20.6, 6.8)],
                [(4.4, 12.4), (6.4, 12.3)], [(11.2, 12.4), (15, 12.7), (19, 12.2)],
                [(4.4, 18), (6.5, 18.2)], [(11.4, 18.2), (14, 17.9), (16.8, 18.3)],
            ]
        case .other:
            return [[(4.6, 8.6), (11, 8.2), (18.8, 8.7)], [(14.6, 4.8), (19.2, 8.6), (14.9, 12.2)], [(19.4, 15.6), (12, 15.9), (5.2, 15.4)], [(9.4, 11.9), (4.8, 15.5), (9.2, 19.3)]]
        case .whenever:
            return [
                [(6.4, 3.8), (17.8, 3.6), (17.4, 6.4), (12.6, 11.8), (17.6, 17.6), (18, 20.4), (6.2, 20.6), (6.5, 17.8), (11.4, 12.2), (6.6, 6.6), (6.2, 3.4)],
                [(10.4, 18.4), (12.1, 16.6), (13.8, 18.5)],
            ]
        }
    }

    /// An icon drawn like the session marks: a few uneven pen strokes with a little tilt (sketch(name) in ui.js).
    static func sketch(_ kind: SketchKind) -> Doodle {
        var r = SeededRandom("sketch:\(kind.rawValue)")
        let rotation = round1((r.next() - 0.5) * 9)
        var out: [[PathCommand]] = []
        for stroke in strokes(of: kind) {
            var points: [Point] = []
            for point in stroke {
                let x = point.x + (r.next() - 0.5) * 0.7
                let y = point.y + (r.next() - 0.5) * 0.7
                points.append((x, y))
            }
            out.append(pen(points))
        }
        return Doodle(strokes: out, rotation: rotation, width: 24, height: 24)
    }

    /// The circle the agent's advice is drawn with: one and a bit turns by hand that do
    /// not quite close, in a box of 100 x 100. The web draws this with CSS borders, so
    /// there is nothing to match stroke for stroke; it only has to be the same every time.
    static func advice(_ seed: String) -> Doodle {
        var r = SeededRandom("advice:\(seed)")
        let start = 3.4 + r.next() * 0.6
        let steps = 17
        var points: [Point] = []
        for i in 0..<steps {
            let a = start + (Double(i) / Double(steps - 2)) * Double.pi * 2
            let drift = Double(i) / Double(steps) * 5
            let x = 50 + cos(a) * (47 - drift + (r.next() - 0.5) * 4)
            let y = 50 + sin(a) * (46 - drift + (r.next() - 0.5) * 4)
            points.append((x, y))
        }
        return Doodle(strokes: [pen(points)], rotation: -3, width: 100, height: 100)
    }

    // MARK: as text

    /// The stroke as the `d` of an SVG path, written like ui.js writes it. Used to compare with the web.
    static func svgPath(_ commands: [PathCommand]) -> String {
        func n(_ v: Double) -> String { String(format: "%.1f", v) }
        return commands.map { command in
            switch command {
            case .move(let x, let y): return "M\(n(x)) \(n(y))"
            case .line(let x, let y): return "L\(n(x)) \(n(y))"
            case .quad(let cx, let cy, let x, let y): return "Q\(n(cx)) \(n(cy)) \(n(x)) \(n(y))"
            }
        }.joined(separator: " ")
    }
}
