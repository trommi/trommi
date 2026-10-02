// The light markdown agents write, drawn block by block: paragraphs with
// bold, code and links, bullet lists, and code blocks in a box of their
// own. A click on a code block copies it.
import QtQuick

Column {
    id: rich
    property var blocks: []
    property color ink: ui.fg
    property real size: ui.px(15.5)
    property color tint: ui.accent // the box of a code block is edged in it
    spacing: ui.px(10)

    Repeater {
        model: rich.blocks
        Loader {
            required property var modelData
            width: rich.width
            sourceComponent: modelData.kind === "code" ? code : modelData.kind === "ul" ? list : paragraph

            Component {
                id: paragraph
                Text {
                    text: modelData.html
                    textFormat: Text.RichText
                    color: rich.ink
                    linkColor: ui.accent
                    wrapMode: Text.Wrap
                    lineHeight: 1.4
                    font { family: ui.sans; pixelSize: rich.size }
                    onLinkActivated: link => Qt.openUrlExternally(link)
                    HoverHandler { cursorShape: parent.hoveredLink ? Qt.PointingHandCursor : Qt.ArrowCursor }
                }
            }
            Component {
                id: list
                Column {
                    spacing: ui.px(4)
                    Repeater {
                        model: modelData.items
                        Row {
                            required property string modelData
                            width: parent.width
                            spacing: ui.px(8)
                            Text { text: "•"; color: rich.ink; font { family: ui.sans; pixelSize: rich.size } width: ui.px(12); horizontalAlignment: Text.AlignRight }
                            Text {
                                width: parent.width - ui.px(20)
                                text: modelData
                                textFormat: Text.RichText
                                color: rich.ink
                                linkColor: ui.accent
                                wrapMode: Text.Wrap
                                lineHeight: 1.4
                                font { family: ui.sans; pixelSize: rich.size }
                                onLinkActivated: link => Qt.openUrlExternally(link)
                            }
                        }
                    }
                }
            }
            Component {
                id: code
                Rectangle {
                    height: source.implicitHeight + ui.px(20)
                    radius: ui.radius
                    color: ui.surface
                    border { width: 1; color: ui.mix(rich.tint, ui.surface, 0.3) }
                    clip: true
                    Text {
                        id: source
                        x: ui.px(12)
                        y: ui.px(10)
                        width: parent.width - ui.px(24)
                        text: modelData.text
                        textFormat: Text.PlainText
                        color: ui.fg
                        wrapMode: Text.WrapAnywhere
                        font { family: ui.mono; pixelSize: rich.size * 0.88 }
                    }
                    Text {
                        id: copied
                        anchors { right: parent.right; top: parent.top; margins: ui.px(6) }
                        text: "copied"
                        visible: false
                        color: ui.muted
                        font { family: ui.sans; pixelSize: ui.px(11) }
                        Timer { id: hide; interval: 1200; onTriggered: copied.visible = false }
                    }
                    TapHandler {
                        onTapped: { board.copy(modelData.text); copied.visible = true; hide.restart() }
                    }
                }
            }
        }
    }
}
