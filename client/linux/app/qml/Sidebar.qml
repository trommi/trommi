// The places: the inbox on top, the sessions under it in the human's own
// order (the disconnected ones apart), and how the board is doing at the
// bottom. A session is its scribbled mark and its name; what it needs from
// the human shows as the badge at the end of its row.
import QtQuick
import QtQuick.Shapes

Rectangle {
    id: side
    color: ui.bg

    Rectangle { anchors { right: parent.right; top: parent.top; bottom: parent.bottom } width: 1; color: ui.line }

    readonly property var here: nav.units.filter(u => u.online)
    readonly property var away: nav.units.filter(u => !u.online)

    component Caps: Text {
        color: ui.faint
        font { family: ui.sans; pixelSize: ui.px(11); weight: Font.DemiBold; letterSpacing: 1.0; capitalization: Font.AllUppercase }
    }

    // One session, or several laid together.
    component UnitRow: Rectangle {
        id: entry
        property var unit: ({})
        readonly property bool current: nav.view === "session" && nav.unitId === unit.id
        readonly property bool single: !!unit.single
        readonly property var first: unit.members[0]
        width: parent ? parent.width : 0
        height: Math.max(ui.px(48), names.height + ui.px(16))
        radius: ui.px(10)
        color: current ? ui.surface : hover.hovered ? ui.sunken : "transparent"
        border { width: current ? 1 : 0; color: ui.line }
        opacity: unit.online ? 1 : 0.7

        HoverHandler { id: hover; cursorShape: Qt.PointingHandCursor }
        TapHandler { onTapped: nav.openSession(entry.unit.id) }
        // The crown is its own switch: a click with the other button.
        TapHandler { acceptedButtons: Qt.RightButton; enabled: entry.single; onTapped: board.star(entry.first.id, !entry.first.vip) }

        Mark {
            id: mark
            visible: entry.single
            anchors { left: parent.left; leftMargin: ui.px(12); verticalCenter: parent.verticalCenter }
            who: entry.first
            size: ui.px(30)
        }
        // Sessions laid together: their scribbles over each other inside one loop drawn by hand.
        Item {
            id: pairMark
            visible: !entry.single
            anchors { left: parent.left; leftMargin: ui.px(6); verticalCenter: parent.verticalCenter }
            width: ui.px(58)
            height: width * 34 / 46
            readonly property real k: width / 46
            Repeater {
                model: entry.single ? [] : entry.unit.pair.marks
                Scribble {
                    required property var modelData
                    x: modelData.x * pairMark.k
                    y: modelData.y * pairMark.k
                    width: 32 * modelData.size * pairMark.k
                    drawing: ({ paths: modelData.paths, rotate: modelData.turn })
                    color: ui.ink(modelData.hue)
                    pen: 2.1
                }
            }
            Scribble {
                anchors.fill: parent
                box: 46
                boxHeight: 34
                path: entry.single ? "" : entry.unit.pair.loop
                color: ui.muted
                pen: 1.2
            }
        }
        Column {
            id: names
            anchors { left: entry.single ? mark.right : pairMark.right; leftMargin: ui.px(entry.single ? 12 : 8); right: badge.left; rightMargin: ui.px(6); verticalCenter: parent.verticalCenter }
            spacing: ui.px(1)
            Repeater {
                model: entry.unit.members
                Column {
                    required property var modelData
                    width: names.width
                    Text {
                        width: parent.width
                        text: modelData.name
                        color: nav.view === "session" && nav.agentId === modelData.id ? ui.fg : entry.unit.online ? ui.fg : ui.muted
                        elide: Text.ElideRight
                        font { family: ui.sans; pixelSize: ui.px(14); weight: Font.DemiBold }
                    }
                    Text {
                        visible: text !== ""
                        width: parent.width
                        text: modelData.sub || ""
                        color: ui.faint
                        elide: Text.ElideMiddle
                        font { family: ui.sans; pixelSize: ui.px(11.5) }
                    }
                }
            }
        }
        Badge {
            id: badge
            anchors { right: parent.right; rightMargin: ui.px(10); verticalCenter: parent.verticalCenter }
            state: entry.unit.badge
            count: entry.unit.open
            offline: !entry.unit.online
            width: visible ? ui.px(32) : 0
        }
        // A pair is pulled apart again here.
        Btn {
            visible: !entry.single && hover.hovered
            anchors { right: badge.left; rightMargin: ui.px(2); verticalCenter: parent.verticalCenter }
            quiet: true
            icon: "snip"
            implicitWidth: ui.px(30)
            implicitHeight: ui.px(30)
            onPressed: board.unpair(entry.first.id)
        }
    }

    Flickable {
        anchors { left: parent.left; right: parent.right; top: parent.top; bottom: foot.top; margins: ui.px(8) }
        contentHeight: places.height
        clip: true
        boundsBehavior: Flickable.StopAtBounds

        Column {
            id: places
            width: parent.width
            spacing: ui.px(2)

            Rectangle { // the inbox
                width: parent.width
                height: ui.px(46)
                radius: ui.px(10)
                readonly property bool current: nav.view === "inbox"
                color: current ? ui.surface : inboxHover.hovered ? ui.sunken : "transparent"
                border { width: current ? 1 : 0; color: ui.line }
                HoverHandler { id: inboxHover; cursorShape: Qt.PointingHandCursor }
                TapHandler { onTapped: nav.openInbox() }
                Sketch { id: tray; anchors { left: parent.left; leftMargin: ui.px(15); verticalCenter: parent.verticalCenter } name: "tray"; size: ui.px(24); color: ui.fg }
                Text {
                    anchors { left: tray.right; leftMargin: ui.px(15); verticalCenter: parent.verticalCenter }
                    text: "Inbox"
                    color: ui.fg
                    font { family: ui.sans; pixelSize: ui.px(14); weight: Font.Bold }
                }
                Rectangle {
                    visible: board.freshCount > 0
                    anchors { right: parent.right; rightMargin: ui.px(12); verticalCenter: parent.verticalCenter }
                    width: Math.max(ui.px(22), number.implicitWidth + ui.px(12))
                    height: ui.px(22)
                    radius: height / 2
                    color: ui.urgHigh
                    Text {
                        id: number
                        anchors.centerIn: parent
                        text: board.freshCount
                        color: ui.surface
                        font { family: ui.sans; pixelSize: ui.px(11.5); weight: Font.Bold }
                    }
                }
            }

            Caps { text: "Sessions"; leftPadding: ui.px(12); topPadding: ui.px(18); bottomPadding: ui.px(6) }
            Repeater {
                model: side.here
                UnitRow { required property var modelData; unit: modelData }
            }

            Item { // disconnected: apart, behind a dashed line
                visible: side.away.length > 0
                width: parent.width
                height: visible ? ui.px(44) : 0
                Caps { id: awayWord; text: "Disconnected"; x: ui.px(12); anchors { bottom: parent.bottom; bottomMargin: ui.px(6) } }
                Shape {
                    anchors { left: awayWord.right; leftMargin: ui.px(10); right: parent.right; rightMargin: ui.px(10); verticalCenter: awayWord.verticalCenter }
                    height: 1
                    ShapePath {
                        strokeColor: ui.lineStrong; strokeWidth: 1; strokeStyle: ShapePath.DashLine; dashPattern: [3, 3]
                        startX: 0; startY: 0
                        PathLine { x: Math.max(0, side.width - awayWord.width - ui.px(52)); y: 0 }
                    }
                }
            }
            Repeater {
                model: side.away
                UnitRow { required property var modelData; unit: modelData }
            }
        }
    }

    // ── how the board is doing, and the ways out ────────────────────────
    Column {
        id: foot
        anchors { left: parent.left; right: parent.right; bottom: parent.bottom; margins: ui.px(10) }
        spacing: ui.px(6)

        Row {
            spacing: ui.px(4)
            Btn { quiet: true; icon: "frame"; label: "Focus"; enabled: board.openCount > 0; onPressed: nav.walk() }
            Btn { quiet: true; icon: "page"; label: "Pad"; onPressed: board.openPad() }
            Btn { quiet: true; icon: "question"; implicitWidth: ui.px(34); onPressed: nav.help = true }
            Btn { quiet: true; icon: theme.dark ? "sun" : "moon"; implicitWidth: ui.px(34); onPressed: theme.toggle() }
        }
        Row {
            spacing: ui.px(7)
            leftPadding: ui.px(8)
            Rectangle {
                width: ui.px(8); height: ui.px(8); radius: width / 2
                anchors.verticalCenter: parent.verticalCenter
                color: board.online ? ui.stDone : ui.stDecision
            }
            Text {
                text: board.online ? board.address : "Not connected, trying again"
                color: board.online ? ui.muted : ui.deny
                font { family: ui.sans; pixelSize: ui.px(12) }
                elide: Text.ElideRight
                width: side.width - ui.px(56)
                TapHandler { onTapped: board.retry() }
            }
        }
    }
}
