// Before there is a board: paste its link. And while a kept link is being
// tried: say so, and offer to enter another.
import QtQuick

Item {
    id: view
    readonly property bool asking: board.phase === "link"
    onAskingChanged: if (asking && visible) link.take()
    onVisibleChanged: if (visible && asking) link.take(); else if (!visible) win.takeKeys()
    Component.onCompleted: if (visible && asking) link.take()

    Column {
        width: Math.min(ui.px(520), parent.width - ui.px(40))
        anchors.centerIn: parent
        spacing: ui.px(14)

        Text {
            text: "Trommi"
            color: ui.fg
            font { family: ui.sans; pixelSize: ui.px(40); weight: Font.ExtraBold; letterSpacing: -1 }
        }
        Text {
            width: parent.width
            text: view.asking
                ? "Paste the link of your board. It is in data/url.txt and looks like this: http://host:8790/?t=…"
                : "Connecting to " + board.address + " …"
            color: ui.muted
            wrapMode: Text.Wrap
            lineHeight: 1.35
            font { family: ui.sans; pixelSize: ui.px(16) }
        }
        Field {
            id: link
            visible: view.asking
            width: parent.width
            placeholder: "http://host:8790/?t=…"
            onAccepted: board.connectTo(link.text)
        }
        Text {
            visible: board.error !== ""
            width: parent.width
            text: board.error + (view.asking ? "" : " Trying again.")
            color: ui.deny
            wrapMode: Text.Wrap
            font { family: ui.sans; pixelSize: ui.px(14) }
        }
        Rectangle {
            width: go.implicitWidth + ui.px(44)
            height: ui.px(44)
            radius: height / 2
            color: ui.fg
            Text {
                id: go
                anchors.centerIn: parent
                text: view.asking ? "Connect  Enter" : "Enter another link"
                color: ui.bg
                font { family: ui.sans; pixelSize: ui.px(14.5); weight: Font.DemiBold }
            }
            TapHandler { onTapped: view.asking ? board.connectTo(link.text) : board.forget() }
        }
        Text {
            visible: view.asking
            width: parent.width
            text: "The link is kept in the system keyring (Secret Service), else in a file only you can read."
            color: ui.faint
            wrapMode: Text.Wrap
            font { family: ui.sans; pixelSize: ui.px(12.5) }
        }
    }
}
