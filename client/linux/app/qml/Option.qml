// One option of a question as something to press: its word, a line more if
// it has one, the digit that picks it. The option the agent would pick is
// circled by hand; one that is ticked (where several are allowed) is filled.
import QtQuick

Rectangle {
    id: opt
    property var option: ({})        // { key, label, detail, advised }
    property int at: 0               // which of the options it is: its digit is at + 1
    property bool tag: false         // small, for many short options
    property bool multiple: false
    property bool ticked: false
    property bool cursor: false      // the keyboard is on it
    property bool caps: true         // show the digit
    property color tint: ui.accent
    property string urgency: "normal"
    signal pressed()

    height: tag ? ui.px(36) : Math.max(ui.px(64), words.height + ui.px(24))
    implicitWidth: tag ? label.implicitWidth + ui.px(multiple ? 42 : 14) + (caps && at < 9 ? ui.px(38) : ui.px(14)) : ui.px(220)
    radius: ui.px(tag ? 8 : 10)
    color: ticked ? ui.mix(tint, ui.surface, 0.22) : hover.hovered ? ui.mix(tint, ui.surface, 0.15) : ui.mix(tint, ui.surface, 0.09)
    border { width: cursor ? 2 : 1; color: cursor ? ui.fg : ticked ? tint : ui.mix(tint, ui.surface, 0.3) }
    scale: tap.pressed ? 0.985 : 1

    HoverHandler { id: hover; cursorShape: Qt.PointingHandCursor }
    TapHandler { id: tap; onTapped: opt.pressed() }

    Rectangle { // a box to tick, where several answers are allowed
        id: check
        visible: opt.multiple
        anchors { left: parent.left; leftMargin: ui.px(12); verticalCenter: parent.verticalCenter }
        width: visible ? ui.px(18) : 0
        height: ui.px(18)
        radius: ui.px(4)
        color: opt.ticked ? opt.tint : ui.surface
        border { width: 1.5; color: opt.ticked ? opt.tint : ui.lineStrong }
        Text { visible: opt.ticked; anchors.centerIn: parent; text: "✓"; color: ui.surface; font { family: ui.sans; pixelSize: ui.px(12); weight: Font.Bold } }
    }
    Column {
        id: words
        anchors { left: check.right; leftMargin: ui.px(opt.multiple ? 10 : opt.tag ? 14 : 16); right: digit.left; rightMargin: ui.px(8); verticalCenter: parent.verticalCenter }
        spacing: ui.px(3)
        Item {
            width: Math.min(label.implicitWidth, parent.width)
            height: label.height
            Text {
                id: label
                width: Math.min(implicitWidth, words.width)
                text: opt.option.label || ""
                color: ui.mix(opt.tint, ui.fg, 0.55)
                wrapMode: opt.tag ? Text.NoWrap : Text.Wrap
                font { family: ui.sans; pixelSize: ui.px(opt.tag ? 13.5 : 16.5); weight: Font.Bold }
            }
            // The agent's advice: a loop drawn with the pen round the words.
            Scribble {
                visible: !!opt.option.advised
                x: -ui.px(9); y: -ui.px(5)
                width: label.width + ui.px(18); height: label.height + ui.px(10)
                stretch: true
                box: 100
                path: visible ? board.adviceLoop() : ""
                color: ui.urgHigh
                pen: 2.2
            }
        }
        Text {
            visible: !opt.tag && text !== ""
            width: parent.width
            text: opt.option.detail || ""
            color: ui.cardInk(opt.urgency)
            wrapMode: Text.Wrap
            font { family: ui.sans; pixelSize: ui.px(13) }
        }
    }
    KeyCap {
        id: digit
        visible: opt.caps && opt.at < 9
        anchors { right: parent.right; rightMargin: ui.px(10); verticalCenter: parent.verticalCenter }
        width: visible ? ui.px(18) : 0
        text: opt.at + 1
        ink: ui.cardInk(opt.urgency)
    }
}
