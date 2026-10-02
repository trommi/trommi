// The key that does something, printed small on what it does.
import QtQuick

Rectangle {
    property alias text: t.text
    property color ink: ui.muted
    width: Math.max(ui.px(18), t.implicitWidth + ui.px(9))
    height: ui.px(18)
    radius: ui.px(4)
    color: "transparent"
    border { width: 1; color: Qt.alpha(ink, 0.4) }
    Text {
        id: t
        anchors.centerIn: parent
        color: parent.ink
        font { family: ui.mono; pixelSize: ui.px(10.5) }
    }
}
