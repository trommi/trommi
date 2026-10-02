// For ten seconds after an answer: what was decided, and the way to take
// it back.
import QtQuick

Item {
    id: bar
    readonly property var undo: board.undo
    readonly property bool offered: !!undo.id
    height: offered ? ui.px(60) : 0
    visible: offered
    clip: true

    Rectangle {
        width: Math.min(ui.px(760), parent.width - ui.px(32))
        anchors.horizontalCenter: parent.horizontalCenter
        y: ui.px(6)
        height: ui.px(42)
        radius: height / 2
        color: ui.fg

        Text {
            anchors { left: parent.left; leftMargin: ui.px(18); right: back.left; rightMargin: ui.px(10); verticalCenter: parent.verticalCenter }
            textFormat: Text.StyledText
            text: bar.undo.error ? bar.undo.error
                : "Answered: <b>" + String(bar.undo.label || "").replace(/&/g, "&amp;").replace(/</g, "&lt;") + "</b>"
            color: ui.bg
            elide: Text.ElideRight
            font { family: ui.sans; pixelSize: ui.px(14) }
        }
        Rectangle {
            id: back
            anchors { right: parent.right; rightMargin: ui.px(5); verticalCenter: parent.verticalCenter }
            width: label.implicitWidth + ui.px(30)
            height: parent.height - ui.px(10)
            radius: height / 2
            color: ui.bg
            Text {
                id: label
                anchors.centerIn: parent
                text: "Undo  u"
                color: ui.fg
                font { family: ui.sans; pixelSize: ui.px(14); weight: Font.DemiBold }
            }
            TapHandler { onTapped: board.undoLast() }
        }
    }
}
