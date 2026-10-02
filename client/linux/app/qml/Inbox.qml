// The inbox: every open decision of every session, grouped by who is
// asking, the most urgent group first.
import QtQuick
import QtQuick.Shapes

Item {
    id: inbox

    // Keep the row the keys are on in sight.
    function reveal() {
        if (!nav.sel) return
        if (board.order.indexOf(nav.sel) === 0) { flick.contentY = 0; return }
        for (let i = 0; i < rows.count; i++) {
            const it = rows.itemAt(i)
            if (!it || it.cardId !== nav.sel) continue
            const top = it.mapToItem(flick.contentItem, 0, 0).y, bottom = top + it.height, room = ui.px(24)
            if (top - room < flick.contentY) flick.contentY = Math.max(0, top - room)
            else if (bottom + room > flick.contentY + flick.height) flick.contentY = bottom + room - flick.height
        }
    }
    Connections { target: nav; function onSelChanged() { Qt.callLater(inbox.reveal) } }
    Connections { target: board; function onChanged() { Qt.callLater(inbox.reveal) } }

    Flickable {
        id: flick
        anchors.fill: parent
        contentWidth: width
        contentHeight: page.height + ui.px(48)
        clip: true
        boundsBehavior: Flickable.StopAtBounds

        Column {
            id: page
            width: Math.min(ui.px(760), flick.width - ui.px(32))
            x: (flick.width - width) / 2
            y: ui.px(28)
            spacing: ui.px(16)

            // ── the head ────────────────────────────────────────────────
            Item {
                width: parent.width
                height: head.height + ui.px(12)
                Column {
                    id: head
                    spacing: ui.px(8)
                    Text {
                        text: "Inbox"
                        color: ui.fg
                        font { family: ui.sans; pixelSize: ui.px(40); weight: Font.ExtraBold; letterSpacing: -1 }
                    }
                    Row {
                        spacing: ui.px(6)
                        Rectangle { // the number, circled
                            visible: board.freshCount > 0
                            width: Math.max(ui.px(30), count.implicitWidth + ui.px(18))
                            height: ui.px(28)
                            radius: height / 2
                            color: "transparent"
                            border { width: 2; color: Qt.alpha(ui.urgHigh, 0.7) }
                            Text {
                                id: count
                                anchors.centerIn: parent
                                text: board.freshCount
                                color: ui.fg
                                font { family: ui.sans; pixelSize: ui.px(17); weight: Font.Bold }
                            }
                        }
                        Text {
                            anchors.verticalCenter: parent.verticalCenter
                            text: !board.loaded ? "Loading …" : board.waitingLine
                            color: ui.muted
                            font { family: ui.sans; pixelSize: ui.px(17.5) }
                        }
                    }
                }
                Rectangle { // through all of them, one after the other
                    visible: board.freshCount > 1 && parent.width > ui.px(520)
                    anchors { right: parent.right; bottom: head.bottom }
                    width: go.implicitWidth + ui.px(40)
                    height: ui.px(44)
                    radius: height / 2
                    color: ui.fg
                    Text {
                        id: go
                        anchors.centerIn: parent
                        text: "Go through them in order  f"
                        color: ui.bg
                        font { family: ui.sans; pixelSize: ui.px(14.5); weight: Font.DemiBold }
                    }
                    TapHandler { onTapped: nav.openCard(board.order[0]) }
                }
            }

            // ── the groups ──────────────────────────────────────────────
            Repeater {
                id: rows
                model: board.inbox
                Item {
                    required property var modelData
                    required property int index
                    readonly property string cardId: modelData.head ? "" : modelData.id
                    width: page.width
                    height: modelData.head ? ui.px(index === 0 ? 30 : 54) : ui.px(148)

                    // A heading is a dividing line: the sender, a rule, how many.
                    Row {
                        visible: modelData.head
                        anchors { left: parent.left; right: parent.right; bottom: parent.bottom; bottomMargin: ui.px(2) }
                        spacing: ui.px(12)
                        Rectangle {
                            id: avatar
                            width: ui.px(24); height: ui.px(24); radius: width / 2
                            color: modelData.later ? "transparent" : ui.fg
                            border { width: modelData.later ? 1 : 0; color: ui.muted }
                            Text {
                                anchors.centerIn: parent
                                text: modelData.initial || ""
                                color: modelData.later ? ui.muted : ui.bg
                                font { family: ui.sans; pixelSize: ui.px(12); weight: Font.Bold }
                            }
                        }
                        Text {
                            id: sender
                            anchors.verticalCenter: avatar.verticalCenter
                            text: modelData.name || ""
                            color: modelData.later ? ui.muted : ui.fg
                            font { family: ui.sans; pixelSize: ui.px(19); weight: Font.ExtraBold }
                        }
                        Rectangle {
                            anchors.verticalCenter: avatar.verticalCenter
                            width: Math.max(0, parent.width - avatar.width - sender.width - howMany.width - 3 * parent.spacing)
                            height: 1
                            color: ui.lineStrong
                        }
                        Text {
                            id: howMany
                            anchors.verticalCenter: avatar.verticalCenter
                            text: modelData.count || ""
                            color: ui.muted
                            font { family: ui.sans; pixelSize: ui.px(11.5); weight: Font.DemiBold; letterSpacing: 1.0; capitalization: Font.AllUppercase }
                        }
                    }

                    Loader {
                        anchors.fill: parent
                        active: !modelData.head
                        sourceComponent: InboxRow { card: modelData }
                    }
                }
            }

            // ── nothing waits: dashed means provisional ─────────────────
            Item {
                visible: board.loaded && board.openCount === 0
                width: parent.width
                height: ui.px(140)
                Item {
                    anchors.centerIn: parent
                    width: Math.min(parent.width, empty.implicitWidth + ui.px(64))
                    height: ui.px(76)
                    rotation: -2
                    Shape {
                        anchors.fill: parent
                        ShapePath {
                            strokeColor: ui.lineStrong
                            strokeWidth: 2
                            strokeStyle: ShapePath.DashLine
                            dashPattern: [4, 3]
                            fillColor: "transparent"
                            PathRectangle { x: 1; y: 1; width: empty.parent.width - 2; height: empty.parent.height - 2; radius: ui.radius }
                        }
                    }
                    Text {
                        id: empty
                        anchors.centerIn: parent
                        width: Math.min(implicitWidth, parent.width - ui.px(24))
                        text: "As soon as an agent has a question, it shows up here."
                        color: ui.muted
                        wrapMode: Text.Wrap
                        horizontalAlignment: Text.AlignHCenter
                        font { family: ui.sans; pixelSize: ui.px(15) }
                    }
                }
            }
        }
    }
}
