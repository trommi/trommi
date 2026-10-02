// The keys, on "?".
import QtQuick

Rectangle {
    color: Qt.alpha("black", theme.dark ? 0.65 : 0.55)
    TapHandler { onTapped: nav.help = false }

    readonly property var groups: [
        ["Everywhere", [["Tab / Shift+Tab", "next / previous place"], ["i", "inbox"], ["u", "undo (10 seconds)"], ["r", "reconnect now"], ["?", "this help"], ["Ctrl+Q", "quit"]]],
        ["Inbox", [["j / k  ↓ / ↑", "pick a question"], ["g / G", "first / last"], ["y / n", "yes / no (short questions)"], ["s", "later (to the end) / bring back"], ["Enter / m", "choose: open the question"], ["f", "go through them in order"]]],
        ["Question", [["1 – 9", "pick an answer, at once"], ["y / n", "yes / no (short questions)"], ["a", "write a note"], ["j / k  → / ←", "next / previous question"], ["s", "later"], ["↓ / ↑  Space", "scroll"], ["Esc", "back"]]],
        ["Session", [["c / Enter", "write a message"], ["Enter", "send (Shift+Enter: new line)"], ["j / k", "scroll"], ["g / G", "top / bottom"], ["o", "open its most urgent question"], ["Esc", "leave the field, then to the inbox"]]]
    ]

    Rectangle {
        anchors.centerIn: parent
        width: Math.min(ui.px(720), parent.width - ui.px(32))
        height: Math.min(sheet.height + ui.px(40), parent.height - ui.px(32))
        radius: ui.px(12)
        color: ui.surface
        border { width: 1; color: ui.line }
        clip: true

        Flow {
            id: sheet
            x: ui.px(20)
            y: ui.px(20)
            width: parent.width - ui.px(40)
            spacing: ui.px(20)
            Repeater {
                model: groups
                Column {
                    required property var modelData
                    width: sheet.width > ui.px(560) ? (sheet.width - ui.px(20)) / 2 : sheet.width
                    spacing: ui.px(5)
                    Text {
                        text: modelData[0]
                        color: ui.fg
                        bottomPadding: ui.px(2)
                        font { family: ui.sans; pixelSize: ui.px(15); weight: Font.ExtraBold }
                    }
                    Repeater {
                        model: modelData[1]
                        Row {
                            required property var modelData
                            spacing: ui.px(10)
                            Text { width: ui.px(132); text: modelData[0]; color: ui.accent; font { family: ui.mono; pixelSize: ui.px(12.5) } }
                            Text { text: modelData[1]; color: ui.muted; font { family: ui.sans; pixelSize: ui.px(13) } }
                        }
                    }
                }
            }
        }
    }
}
