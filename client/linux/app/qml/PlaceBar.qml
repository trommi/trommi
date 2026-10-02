// In a narrow window the sidebar is one line: where you are, and that tab
// goes on to the next place.
import QtQuick

Rectangle {
    color: ui.surface2
    Rectangle { anchors { left: parent.left; right: parent.right; bottom: parent.bottom } height: 1; color: ui.line }

    readonly property var session: { board.rev; return nav.place === "inbox" ? null : board.session(nav.place) }

    Row {
        anchors { left: parent.left; leftMargin: ui.px(14); verticalCenter: parent.verticalCenter }
        spacing: ui.px(8)
        Text {
            text: session ? session.name : "Inbox"
            color: ui.fg
            font { family: ui.sans; pixelSize: ui.px(14); weight: Font.Bold }
        }
        Text {
            visible: board.openCount > 0
            text: board.openCount + " open"
            color: ui.muted
            font { family: ui.sans; pixelSize: ui.px(13) }
        }
    }
    Text {
        anchors { right: parent.right; rightMargin: ui.px(14); verticalCenter: parent.verticalCenter }
        text: board.online ? "Tab: " + nav.places.length + " places · ? keys" : "Not connected"
        color: board.online ? ui.faint : ui.deny
        font { family: ui.sans; pixelSize: ui.px(12) }
    }
}
