// The hand-drawn icons of the answer tiles, the same paths as TILE_ICON in
// client/web/js/inbox.js: a thumb up, a thumb down, and so on.
import QtQuick
import QtQuick.Shapes

Item {
    id: icon
    property string kind: "yes" // yes, no, other, open, later, back
    property color color: "black"
    property real size: 30
    width: size
    height: size

    readonly property var paths: ({
        yes: "M7.2 11.2 L10.4 4.7 c1.5 -.2 2.3 .9 2.1 2.3 l-.5 3 h4.7 c1.3 0 2.1 1.1 1.8 2.3 l-1.2 5 c-.3 1.1 -1.1 1.7 -2.2 1.7 H7.3 M7.2 11 v8.1 H4.6 V11 z",
        no: "M16.8 12.8 L13.6 19.3 c-1.5 .2 -2.3 -.9 -2.1 -2.3 l.5 -3 H7.3 c-1.3 0 -2.1 -1.1 -1.8 -2.3 l1.2 -5 c.3 -1.1 1.1 -1.7 2.2 -1.7 h7.8 M16.8 13 V4.9 h2.6 V13 z",
        other: "M5 9.5 h11.5 l-3.2 -3.3 M19 14.5 H7.5 l3.2 3.3",
        open: "M4.5 7.2 h15 M4.5 12 h15 M4.5 16.8 h9.5",
        later: "M12 5 v12.5 M6.5 12.5 L12 18 l5.5 -5.5 M5 20.5 h14",
        back: "M12 19 V6.5 M6.5 11.5 L12 6 l5.5 5.5 M5 3.5 h14"
    })

    Shape {
        width: 24
        height: 24
        scale: icon.size / 24
        transformOrigin: Item.TopLeft
        preferredRendererType: Shape.CurveRenderer
        ShapePath {
            strokeColor: icon.color
            strokeWidth: 1.7
            fillColor: "transparent"
            capStyle: ShapePath.RoundCap
            joinStyle: ShapePath.RoundJoin
            PathSvg { path: icon.paths[icon.kind] || icon.paths.other }
        }
    }
}
