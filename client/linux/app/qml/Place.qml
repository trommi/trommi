// One place in the sidebar: the inbox or a session.
import QtQuick

Rectangle {
    id: p
    property string label
    property int count: 0
    property bool dot: false     // sessions show whether they run
    property bool on: false
    property bool current: false
    signal chosen()

    height: ui.px(36)
    radius: ui.px(8)
    color: current ? ui.accentSoft : hover.hovered ? ui.sunken : "transparent"

    HoverHandler { id: hover }
    TapHandler { onTapped: p.chosen() }

    Rectangle {
        id: lamp
        visible: p.dot
        width: ui.px(8); height: ui.px(8); radius: width / 2
        anchors { left: parent.left; leftMargin: ui.px(10); verticalCenter: parent.verticalCenter }
        color: p.on ? ui.stDone : "transparent"
        border { width: p.on ? 0 : 1.5; color: ui.faint }
    }
    Text {
        anchors { left: p.dot ? lamp.right : parent.left; leftMargin: ui.px(8); right: badge.left; rightMargin: ui.px(6); verticalCenter: parent.verticalCenter }
        text: p.label
        color: p.current ? ui.accent : ui.fg
        font { family: ui.sans; pixelSize: ui.px(14); weight: p.current ? Font.DemiBold : Font.Normal }
        elide: Text.ElideRight
    }
    Rectangle {
        id: badge
        visible: p.count > 0
        width: visible ? Math.max(ui.px(22), number.implicitWidth + ui.px(12)) : 0
        height: ui.px(20)
        radius: height / 2
        anchors { right: parent.right; rightMargin: ui.px(8); verticalCenter: parent.verticalCenter }
        color: ui.fg
        Text {
            id: number
            anchors.centerIn: parent
            text: p.count
            color: ui.bg
            font { family: ui.sans; pixelSize: ui.px(12); weight: Font.Bold }
        }
    }
}
