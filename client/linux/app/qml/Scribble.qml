// Something drawn by hand: the strokes core/doodle hands out (a session's
// mark, an icon, a loop), as SVG paths in a small box, drawn with one pen.
import QtQuick
import QtQuick.Shapes

Item {
    id: s
    property var drawing: ({})        // { paths, rotate }, from board.mark() or board.icon()
    property string path: ""          // or one path alone
    property real box: 32             // the box the strokes are in …
    property real boxHeight: box      // … which need not be square
    property color color: ui.fg
    property color fill: "transparent"
    property real pen: 2              // the width of the stroke, in units of the box
    property bool stretch: false      // fill the item whatever its shape (a loop round something)
    property bool flat: false         // the ends cut straight, as a marker's are

    width: 32
    height: width * boxHeight / box
    rotation: drawing && drawing.rotate ? drawing.rotate : 0

    readonly property string strokes: path !== "" ? path : ((drawing && drawing.paths) || []).join(" ")
    // Stretched over a shape of its own, the points move and the pen keeps its width: every
    // number of the path is an x or a y in turn.
    function fitted(d) {
        const kx = width / box, ky = height / boxHeight
        let x = true
        return d.replace(/-?\d+(\.\d+)?/g, n => { const v = Number(n) * (x ? kx : ky); x = !x; return v.toFixed(2) })
    }

    Shape {
        width: s.stretch ? s.width : s.box
        height: s.stretch ? s.height : s.boxHeight
        transformOrigin: Item.TopLeft
        scale: s.stretch ? 1 : s.width / s.box
        preferredRendererType: Shape.CurveRenderer
        ShapePath {
            strokeColor: s.color
            strokeWidth: s.pen
            fillColor: s.fill
            capStyle: s.flat ? ShapePath.FlatCap : ShapePath.RoundCap
            joinStyle: ShapePath.RoundJoin
            PathSvg { path: s.stretch ? s.fitted(s.strokes) : s.strokes }
        }
    }
}
