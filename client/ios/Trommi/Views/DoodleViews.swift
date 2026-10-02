// The hand-scribbled marks, drawn from the strokes Core generates
// (Core/Doodle.swift, a port of the web client's generator).
import SwiftUI

/// Pen strokes in a box of `width` x `height`, scaled to fit the view and centred.
struct StrokesShape: Shape {
    let strokes: [[PathCommand]]
    let width: Double
    let height: Double

    func path(in rect: CGRect) -> Path {
        let scale = min(rect.width / CGFloat(width), rect.height / CGFloat(height))
        let dx = rect.minX + (rect.width - CGFloat(width) * scale) / 2
        let dy = rect.minY + (rect.height - CGFloat(height) * scale) / 2
        func point(_ x: Double, _ y: Double) -> CGPoint {
            CGPoint(x: dx + CGFloat(x) * scale, y: dy + CGFloat(y) * scale)
        }
        var path = Path()
        for stroke in strokes {
            for command in stroke {
                switch command {
                case .move(let x, let y):
                    path.move(to: point(x, y))
                case .line(let x, let y):
                    path.addLine(to: point(x, y))
                case .quad(let cx, let cy, let x, let y):
                    path.addQuadCurve(to: point(x, y), control: point(cx, cy))
                }
            }
        }
        return path
    }
}

/// One mark or icon, stroked in the current foreground colour.
struct DoodleView: View {
    let doodle: Doodle
    var size: CGFloat = 28
    /// Width of the pen in the mark's own box (32 wide for a session's mark, 24 for an icon).
    var pen: CGFloat = 2

    var body: some View {
        StrokesShape(strokes: doodle.strokes, width: doodle.width, height: doodle.height)
            .stroke(style: StrokeStyle(lineWidth: pen * size / CGFloat(doodle.width), lineCap: .round, lineJoin: .round))
            .frame(width: size, height: size)
            .rotationEffect(.degrees(doodle.rotation))
            .accessibilityHidden(true)
    }
}

/// A sketched icon: thumbs, hand, later, choose, hourglass.
struct SketchIcon: View {
    let kind: SketchKind
    var size: CGFloat = 24

    var body: some View {
        DoodleView(doodle: Doodle.sketch(kind), size: size, pen: 1.7)
    }
}

/// The mark of one session, in its own colour; grey while it is disconnected.
struct SessionMark: View {
    let agent: Agent
    var size: CGFloat = 36

    var body: some View {
        DoodleView(doodle: Doodle.mark(agent.mark), size: size * 0.72)
            .foregroundStyle(agent.online ? Theme.avatar(hue: agent.hue) : Theme.faint)
            .frame(width: size, height: size)
            .background(Theme.sunken, in: Circle())
    }
}

/// Several sessions as one mark: their scribbles over each other inside one loop drawn by hand.
struct PairMark: View {
    let members: [Agent]
    var height: CGFloat = 36

    var body: some View {
        let pair = Doodle.pair(members.map { (id: $0.id, mark: $0.mark) })
        let k = height / CGFloat(Doodle.Pair.height)
        ZStack {
            ForEach(Array(pair.members.enumerated()), id: \.offset) { index, place in
                let side = 32 * CGFloat(place.scale) * k
                DoodleView(doodle: Doodle.mark(place.seed), size: side)
                    .rotationEffect(.degrees(place.rotation - Doodle.mark(place.seed).rotation))
                    .foregroundStyle(color(index))
                    .position(x: CGFloat(place.x) * k + side / 2, y: CGFloat(place.y) * k + side / 2)
            }
            StrokesShape(strokes: [pair.loop], width: Doodle.Pair.width, height: Doodle.Pair.height)
                .stroke(Theme.lineStrong, style: StrokeStyle(lineWidth: 1.4 * k, lineCap: .round, lineJoin: .round))
        }
        .frame(width: CGFloat(Doodle.Pair.width) * k, height: height)
        .accessibilityHidden(true)
    }

    private func color(_ index: Int) -> Color {
        guard members.indices.contains(index) else { return Theme.faint }
        return members[index].online ? Theme.avatar(hue: members[index].hue) : Theme.faint
    }
}

/// A session, or several laid together.
struct UnitMark: View {
    let unit: SessionUnit
    var size: CGFloat = 36

    var body: some View {
        if unit.members.count == 1, let only = unit.members.first {
            SessionMark(agent: only, size: size)
        } else {
            PairMark(members: unit.members, height: size)
        }
    }
}

/// The agent's advice: the option it would pick is circled by hand.
struct AdviceCircle: View {
    let seed: String

    var body: some View {
        let loop = Doodle.advice(seed)
        GeometryReader { box in
            StretchedStrokes(strokes: loop.strokes, width: loop.width, height: loop.height)
                .stroke(Theme.advice, style: StrokeStyle(lineWidth: 2.5, lineCap: .round, lineJoin: .round))
                .frame(width: box.size.width, height: box.size.height)
        }
        .rotationEffect(.degrees(loop.rotation))
        .allowsHitTesting(false)
        .accessibilityHidden(true)
    }
}

/// Like StrokesShape, but stretched to fill the view in both directions.
private struct StretchedStrokes: Shape {
    let strokes: [[PathCommand]]
    let width: Double
    let height: Double

    func path(in rect: CGRect) -> Path {
        let sx = rect.width / CGFloat(width)
        let sy = rect.height / CGFloat(height)
        func point(_ x: Double, _ y: Double) -> CGPoint {
            CGPoint(x: rect.minX + CGFloat(x) * sx, y: rect.minY + CGFloat(y) * sy)
        }
        var path = Path()
        for stroke in strokes {
            for command in stroke {
                switch command {
                case .move(let x, let y):
                    path.move(to: point(x, y))
                case .line(let x, let y):
                    path.addLine(to: point(x, y))
                case .quad(let cx, let cy, let x, let y):
                    path.addQuadCurve(to: point(x, y), control: point(cx, cy))
                }
            }
        }
        return path
    }
}
