// An icon drawn like the session marks (sketch() in client/web/js/ui.js):
// the thumbs, later, back, choose, explain, send, and so on.
import QtQuick

Scribble {
    property string name: "choose"
    property real size: 24
    width: size
    box: 24
    pen: 1.7
    drawing: board.icon(name)
}
