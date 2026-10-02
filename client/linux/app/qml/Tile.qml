// One of the two answer tiles at the right edge of a row: always in the
// same place, so the eye runs down one column.
import QtQuick

Rectangle {
    id: tile
    property string label: ""
    property string icon: "other"
    property bool lead: false      // the answer the agent leads with: filled
    property bool bare: false      // a plain yes/no needs no words
    property string urgency: "normal"
    property string hint: ""       // the key that presses it, shown on the row the keys are on
    property bool busy: false
    property bool advised: false   // the agent recommends this answer: circled by hand
    signal pressed()

    readonly property color tint: ui.urg(urgency)
    readonly property color ink: lead ? ui.surface : ui.cardInk(urgency)

    radius: ui.px(10)
    color: lead ? tint : ui.mix(tint, ui.surface, 0.09)
    border { width: hover.hovered && !lead ? 2 : 0; color: tint }
    opacity: busy ? 0.35 : 1
    scale: tap.pressed ? 0.97 : 1

    HoverHandler { id: hover; cursorShape: Qt.PointingHandCursor }
    TapHandler { id: tap; enabled: !tile.busy; onTapped: tile.pressed() }

    Column {
        anchors.centerIn: parent
        width: parent.width - ui.px(12)
        spacing: ui.px(8)
        TileIcon { anchors.horizontalCenter: parent.horizontalCenter; kind: tile.icon; color: tile.ink; size: ui.px(30) }
        Text {
            visible: !tile.bare
            width: parent.width
            text: tile.label
            color: tile.ink
            horizontalAlignment: Text.AlignHCenter
            wrapMode: Text.Wrap
            maximumLineCount: 3
            elide: Text.ElideRight
            font { family: ui.sans; pixelSize: ui.px(13.5); weight: Font.DemiBold }
        }
    }
    // The agent's advice (.is-advised in tokens.css): a ring drawn a little
    // askew, as if by hand, in the colour of "urgent".
    Rectangle {
        visible: tile.advised
        anchors { fill: parent; leftMargin: ui.px(4); rightMargin: ui.px(4); topMargin: ui.px(9); bottomMargin: ui.px(7) }
        radius: Math.min(width, height) / 2
        rotation: -4
        color: "transparent"
        border { width: ui.px(2.5); color: tile.lead ? ui.mix(ui.urgHigh, Qt.color("white"), 0.7) : ui.urgHigh }
    }
    Text {
        visible: tile.hint !== ""
        anchors { right: parent.right; top: parent.top; rightMargin: ui.px(7); topMargin: ui.px(5) }
        text: tile.hint
        color: tile.ink
        opacity: 0.7
        font { family: ui.mono; pixelSize: ui.px(11) }
    }
}
