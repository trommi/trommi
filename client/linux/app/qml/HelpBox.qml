// The keys, on "?": every key that works where you are, drawn from the one
// table in Nav that also says what they do.
import QtQuick

Rectangle {
    color: ui.overlay
    TapHandler { onTapped: nav.help = false }

    readonly property var groups: nav.layout.filter(g => nav.scopes.indexOf(g.scope) >= 0)

    Rectangle {
        anchors.centerIn: parent
        width: Math.min(ui.px(860), parent.width - ui.px(32))
        height: Math.min(sheet.height + ui.px(96), parent.height - ui.px(32))
        radius: ui.px(14)
        color: ui.surface
        border { width: 1; color: ui.line }
        clip: true

        Text {
            x: ui.px(24); y: ui.px(18)
            text: "Keys"
            color: ui.fg
            font { family: ui.sans; pixelSize: ui.px(22); weight: Font.ExtraBold }
        }
        Btn { anchors { right: parent.right; top: parent.top; margins: ui.px(14) } implicitHeight: ui.px(32); label: "Close"; cap: "Esc"; tint: ui.fg; onPressed: nav.help = false }

        Flickable {
            anchors { fill: parent; topMargin: ui.px(60); bottomMargin: ui.px(36) }
            contentHeight: sheet.height
            clip: true
            Flow {
                id: sheet
                x: ui.px(24)
                width: parent.width - ui.px(48)
                spacing: ui.px(22)
                Repeater {
                    model: groups
                    Column {
                        required property var modelData
                        width: sheet.width > ui.px(600) ? (sheet.width - ui.px(22)) / 2 : sheet.width
                        spacing: ui.px(6)
                        Text {
                            text: modelData.title
                            color: ui.fg
                            bottomPadding: ui.px(2)
                            font { family: ui.sans; pixelSize: ui.px(14.5); weight: Font.ExtraBold }
                        }
                        Repeater {
                            model: modelData.keys
                            Row {
                                required property var modelData
                                spacing: ui.px(10)
                                Row {
                                    width: ui.px(92)
                                    spacing: ui.px(4)
                                    Repeater {
                                        model: modelData[0]
                                        KeyCap { required property string modelData; text: modelData; ink: ui.fg }
                                    }
                                }
                                Text { width: parent.parent.width - ui.px(104); text: modelData[1]; color: ui.muted; wrapMode: Text.Wrap; font { family: ui.sans; pixelSize: ui.px(13) } }
                            }
                        }
                    }
                }
            }
        }
        Text {
            anchors { left: parent.left; leftMargin: ui.px(24); bottom: parent.bottom; bottomMargin: ui.px(12) }
            text: "Keys rest while you type in a field. Dictation (V) and files (F) are on the web for now."
            color: ui.faint
            font { family: ui.sans; pixelSize: ui.px(12) }
        }
    }
}
