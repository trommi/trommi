// What just happened, and the way back. Whenever a question leaves the
// view (answered, put off, handed to its session) one small note says so
// in plain words and carries "Back", which undoes it. It stays a few
// seconds; the line under it runs out. (client/web/js/back.js)
import QtQuick

Rectangle {
    id: says
    readonly property var note: board.note
    property bool shown: true
    readonly property bool up: !!note.head
    visible: up && shown
    width: Math.min(ui.px(420), line.implicitWidth + ui.px(28))
    height: ui.px(52)
    radius: ui.px(10)
    color: ui.surface
    border { width: 1; color: ui.lineStrong }
    z: 5

    Row {
        id: line
        anchors { left: parent.left; leftMargin: ui.px(14); verticalCenter: parent.verticalCenter; verticalCenterOffset: -ui.px(2) }
        spacing: ui.px(12)
        Column {
            anchors.verticalCenter: parent.verticalCenter
            Text {
                text: says.note.head || ""
                color: ui.fg
                font { family: ui.sans; pixelSize: ui.px(13.5); weight: Font.Bold }
            }
            Text {
                visible: text !== ""
                width: Math.min(implicitWidth, ui.px(250))
                text: says.note.title || ""
                color: ui.muted
                elide: Text.ElideRight
                font { family: ui.sans; pixelSize: ui.px(12.5) }
            }
        }
        Btn {
            visible: !!says.note.back
            anchors.verticalCenter: parent.verticalCenter
            implicitHeight: ui.px(32)
            icon: "reverse"
            label: "Back"
            cap: "U"
            tint: ui.fg
            onPressed: board.backNow()
        }
    }
    // The time left: a line that runs out from its end.
    property real remaining: 1
    Rectangle {
        anchors { left: parent.left; leftMargin: ui.px(12); bottom: parent.bottom; bottomMargin: ui.px(5) }
        width: (says.width - ui.px(24)) * says.remaining
        height: 2
        radius: 1
        color: ui.urgHigh
    }
    NumberAnimation { id: run; target: says; property: "remaining"; from: 1; to: 0; duration: 4000 }
    onNoteChanged: if (up) run.restart()
}
