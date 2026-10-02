// The places: the inbox on top, the sessions under it, and how the board
// is doing at the bottom.
import QtQuick

Rectangle {
    id: side
    color: ui.surface2

    Rectangle { anchors { right: parent.right; top: parent.top; bottom: parent.bottom } width: 1; color: ui.line }

    Column {
        anchors { left: parent.left; right: parent.right; top: parent.top; margins: ui.px(12) }
        spacing: ui.px(4)

        Text {
            text: "Trommi"
            color: ui.fg
            font { family: ui.sans; pixelSize: ui.px(20); weight: Font.ExtraBold; letterSpacing: -0.4 }
            leftPadding: ui.px(8)
            bottomPadding: ui.px(10)
        }

        Place {
            width: parent.width
            label: "Inbox"
            count: board.openCount
            current: nav.place === "inbox"
            onChosen: nav.openInbox()
        }

        Text {
            text: "SESSIONS"
            color: ui.faint
            font { family: ui.sans; pixelSize: ui.px(11); weight: Font.DemiBold; letterSpacing: 1.0 }
            leftPadding: ui.px(8)
            topPadding: ui.px(16)
            bottomPadding: ui.px(4)
        }

        Repeater {
            model: board.sessions
            Place {
                required property var modelData
                width: parent.width
                label: (modelData.starred ? "★ " : "") + modelData.name
                count: modelData.open
                dot: true
                on: modelData.online
                current: nav.place === modelData.id
                onChosen: nav.openSession(modelData.id)
            }
        }
    }

    Column {
        anchors { left: parent.left; right: parent.right; bottom: parent.bottom; margins: ui.px(12) }
        spacing: ui.px(4)

        Row {
            spacing: ui.px(6)
            leftPadding: ui.px(8)
            Rectangle {
                width: ui.px(8); height: ui.px(8); radius: width / 2
                anchors.verticalCenter: parent.verticalCenter
                color: board.online ? ui.stDone : ui.stDecision
            }
            Text {
                text: board.online ? board.address : "Not connected"
                color: board.online ? ui.muted : ui.deny
                font { family: ui.sans; pixelSize: ui.px(12) }
                elide: Text.ElideRight
                width: side.width - ui.px(52)
            }
        }
        Text {
            text: board.online ? "?  keys" : "trying again · r now"
            color: ui.faint
            font { family: ui.sans; pixelSize: ui.px(12) }
            leftPadding: ui.px(8)
        }
    }
}
