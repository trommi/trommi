// A session's mark: its own scribble in its own ink, no tile behind it. A
// session that matters most wears a small scribbled crown, crooked on the
// corner of the mark.
import QtQuick

Item {
    id: m
    property var who: ({})     // { mark, hue, vip, online }, from the board
    property real size: 32
    property bool crowned: !!(who && who.vip)
    width: size
    height: size
    opacity: who && who.online === false ? 0.55 : 1

    Scribble {
        anchors.centerIn: parent
        width: m.size * 0.94
        drawing: (m.who && m.who.mark) || ({})
        color: ui.ink(m.who && m.who.hue !== undefined ? m.who.hue : 162)
        pen: 2
    }
    Scribble {
        visible: m.crowned
        x: -m.size * 0.12
        y: -m.size * 0.24
        width: m.size * 0.6
        box: 26
        boxHeight: 19
        rotation: -17
        path: board.crown()
        color: ui.goldPen
        fill: ui.mix(ui.gold, ui.bg, 0.34)
        pen: 1.9
    }
}
