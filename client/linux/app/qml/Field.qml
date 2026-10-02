// A text field drawn in the window's own look. Enter accepts (shift+enter
// is a new line where several are allowed), escape gives the keys back.
import QtQuick

Rectangle {
    id: field
    property alias text: input.text
    property string placeholder: ""
    property bool multiline: false
    property bool secret: false
    readonly property bool typing: input.activeFocus
    signal accepted()
    signal escaped()

    function take() { input.forceActiveFocus() }
    function clear() { input.text = "" }

    height: Math.min(ui.px(160), Math.max(ui.px(44), input.contentHeight + ui.px(22)))
    radius: ui.px(10)
    color: ui.surface
    border { width: input.activeFocus ? 2 : 1; color: input.activeFocus ? ui.accent : ui.lineStrong }
    clip: true

    TapHandler { onTapped: input.forceActiveFocus() }

    Text {
        visible: input.text === "" && input.preeditText === ""
        anchors { left: parent.left; right: parent.right; margins: ui.px(14); verticalCenter: parent.verticalCenter }
        text: field.placeholder
        color: ui.faint
        elide: Text.ElideRight
        font: input.font
    }
    TextEdit {
        id: input
        anchors { left: parent.left; right: parent.right; margins: ui.px(14); verticalCenter: parent.verticalCenter }
        height: Math.min(contentHeight, field.height - ui.px(16))
        color: ui.fg
        selectionColor: ui.accent
        selectedTextColor: ui.accentFg
        selectByMouse: true
        wrapMode: field.multiline ? TextEdit.Wrap : TextEdit.NoWrap
        textFormat: TextEdit.PlainText
        font { family: ui.sans; pixelSize: ui.px(15.5) }

        // Tests press keys by name; a field in focus takes these itself.
        function testKey(k) {
            if (k === "enter") field.accepted()
            else if (k === "esc") { field.escaped(); win.takeKeys() }
        }
        Keys.onPressed: e => {
            if (e.key === Qt.Key_Escape) {
                e.accepted = true
                field.escaped()
                win.takeKeys()
            } else if (e.key === Qt.Key_Return || e.key === Qt.Key_Enter) {
                if (field.multiline && (e.modifiers & Qt.ShiftModifier)) return
                e.accepted = true
                field.accepted()
            } else if (e.key === Qt.Key_Tab && !field.multiline) {
                e.accepted = true
            }
        }
    }
}
