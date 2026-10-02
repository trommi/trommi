// The tab flush with a card's top left corner: how urgent it is
// ("Blocking", "Urgent", "Approval"), in the card's colour. The usual case
// has no tab at all, and a question that can wait only a small mark.
import QtQuick

Rectangle {
    id: tab
    property string label: ""
    property bool vip: false
    property bool quiet: false // "whenever": said small, not shouted
    property color tint: ui.urgNormal

    visible: label !== "" || vip
    width: parts.width
    height: ui.px(26)
    color: quiet ? "transparent" : tint
    topLeftRadius: ui.radius
    bottomRightRadius: ui.radius

    component Part: Text {
        height: tab.height
        verticalAlignment: Text.AlignVCenter
        leftPadding: ui.px(10)
        rightPadding: ui.px(10)
        color: ui.surface
        font { family: ui.sans; pixelSize: ui.px(11.5); weight: Font.DemiBold; letterSpacing: 0.7; capitalization: Font.AllUppercase }
    }

    Row {
        id: parts
        Part {
            visible: tab.label !== ""
            text: tab.label
            color: tab.quiet ? tab.tint : ui.surface
            leftPadding: tab.quiet ? ui.px(20) : ui.px(10)
            font.capitalization: tab.quiet ? Font.MixedCase : Font.AllUppercase
            font.italic: tab.quiet
            font.letterSpacing: tab.quiet ? 0 : 0.7
            font.pixelSize: ui.px(tab.quiet ? 12.5 : 11.5)
        }
        Rectangle {
            visible: tab.vip
            width: visible ? star.width : 0
            height: tab.height
            color: ui.fg
            topLeftRadius: tab.label === "" ? ui.radius : 0
            bottomRightRadius: ui.radius
            Part { id: star; text: "★ VIP"; color: ui.bg }
        }
    }
}
