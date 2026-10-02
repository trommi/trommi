// A plain button: a word, an icon before it if it has one, the key that
// presses it behind it. Clean and normal; only the icon is drawn by hand.
import QtQuick

Rectangle {
    id: btn
    property string label: ""
    property string icon: ""        // a Sketch name
    property string cap: ""         // the key, shown small
    property bool strong: false     // the one that leads: filled
    property bool quiet: false      // no frame until the pointer is on it
    property color tint: ui.accent
    signal pressed()

    implicitWidth: line.implicitWidth + ui.px(26)
    implicitHeight: ui.px(40)
    width: implicitWidth
    height: implicitHeight
    radius: ui.px(8)
    color: strong ? tint : hover.hovered && enabled ? ui.mix(tint, ui.surface, 0.12) : quiet ? "transparent" : ui.mix(tint, ui.surface, 0.06)
    border { width: strong || quiet ? 0 : 1; color: ui.mix(tint, ui.surface, 0.28) }
    opacity: enabled ? 1 : 0.5
    scale: tap.pressed && enabled ? 0.97 : 1

    readonly property color ink: strong ? ui.surface : ui.mix(tint, ui.fg, 0.75)

    HoverHandler { id: hover; cursorShape: btn.enabled ? Qt.PointingHandCursor : Qt.ArrowCursor }
    TapHandler { id: tap; enabled: btn.enabled; onTapped: btn.pressed() }

    Row {
        id: line
        anchors.centerIn: parent
        spacing: ui.px(7)
        Sketch { visible: btn.icon !== ""; anchors.verticalCenter: parent.verticalCenter; name: btn.icon || "go"; size: ui.px(19); color: btn.ink }
        Text {
            visible: btn.label !== ""
            anchors.verticalCenter: parent.verticalCenter
            text: btn.label
            color: btn.ink
            font { family: ui.sans; pixelSize: ui.px(13.5); weight: Font.DemiBold }
        }
        KeyCap { visible: btn.cap !== ""; anchors.verticalCenter: parent.verticalCenter; text: btn.cap; ink: btn.ink }
    }
}
