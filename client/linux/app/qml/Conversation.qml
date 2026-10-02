// A session's conversation: what the agent wrote, what the human wrote,
// and the board's own markers in between (asked, decided, more urgent),
// with a field to write to the agent at the bottom.
import QtQuick

Item {
    id: view
    readonly property var session: { board.rev; return nav.agentId ? board.session(nav.agentId) : ({}) }
    property var messages: []
    property string stamp: ""
    property string sendError: ""

    function compose() { composer.take() }
    function scroll(by) {
        const max = Math.max(0, list.contentHeight - list.height) + list.originY
        list.contentY = Math.max(list.originY, Math.min(max, list.contentY + by * ui.px(60)))
    }
    // Drawn anew only when the conversation changed, and then it stays at
    // its end if it was there.
    function refresh() {
        if (!nav.agentId) return
        const next = board.conversationStamp(nav.agentId)
        if (next === stamp) return
        const other = stamp.split("|")[0] !== nav.agentId
        const atEnd = other || list.atYEnd
        const y = list.contentY
        stamp = next
        messages = board.conversation(nav.agentId)
        if (atEnd) Qt.callLater(list.positionViewAtEnd)
        else list.contentY = y
    }
    Connections { target: board; function onChanged() { view.refresh() } }
    Connections { target: nav; function onAgentIdChanged() { view.sendError = ""; view.refresh() } }
    Connections {
        target: board
        function onSent(agent) { composer.clear(); view.sendError = "" }
        function onSendFailed(message) { view.sendError = message }
    }
    Component.onCompleted: refresh()

    // ── who this is ─────────────────────────────────────────────────────
    Item {
        id: head
        anchors { left: parent.left; right: parent.right; top: parent.top }
        height: who.height + ui.px(24)
        Column {
            id: who
            width: Math.min(ui.px(760), parent.width - ui.px(32))
            anchors { horizontalCenter: parent.horizontalCenter; top: parent.top; topMargin: ui.px(14) }
            spacing: ui.px(6)
            Row {
                spacing: ui.px(10)
                Text {
                    text: (view.session.starred ? "★ " : "") + (view.session.name || "")
                    color: ui.fg
                    font { family: ui.sans; pixelSize: ui.px(24); weight: Font.ExtraBold; letterSpacing: -0.4 }
                }
                Text {
                    anchors.baseline: parent.children[0].baseline
                    text: (view.session.online ? "running" : "not running")
                        + (view.session.open ? "  ·  " + (view.session.open === 1 ? "1 open question  o" : view.session.open + " open questions  o") : "")
                    color: view.session.online ? ui.stDone : ui.muted
                    font { family: ui.sans; pixelSize: ui.px(13.5) }
                }
            }
            Text {
                visible: text !== ""
                width: parent.width
                text: [view.session.model, view.session.cwd].filter(x => x).join("  ·  ")
                color: ui.faint
                elide: Text.ElideMiddle
                font { family: ui.mono; pixelSize: ui.px(12) }
            }
            Flow { // the traffic-light lines the agent reports
                width: parent.width
                spacing: ui.px(6)
                visible: (view.session.tasks || []).length > 0
                Repeater {
                    model: view.session.tasks || []
                    Rectangle {
                        required property var modelData
                        width: chip.implicitWidth + ui.px(26)
                        height: ui.px(24)
                        radius: height / 2
                        color: ui.mix(ui.state(modelData.state), ui.surface, 0.14)
                        Rectangle {
                            x: ui.px(8); anchors.verticalCenter: parent.verticalCenter
                            width: ui.px(7); height: ui.px(7); radius: width / 2
                            color: ui.state(modelData.state)
                        }
                        Text {
                            id: chip
                            x: ui.px(20); anchors.verticalCenter: parent.verticalCenter
                            text: modelData.label + (modelData.detail ? ": " + modelData.detail : "")
                            color: ui.fg
                            font { family: ui.sans; pixelSize: ui.px(12) }
                        }
                    }
                }
            }
        }
        Rectangle { anchors { left: parent.left; right: parent.right; bottom: parent.bottom } height: 1; color: ui.line }
    }

    // ── the conversation ────────────────────────────────────────────────
    ListView {
        id: list
        anchors { left: parent.left; right: parent.right; top: head.bottom; bottom: foot.top }
        clip: true
        boundsBehavior: Flickable.StopAtBounds
        model: view.messages
        spacing: ui.px(12)
        topMargin: ui.px(16)
        bottomMargin: ui.px(16)
        cacheBuffer: ui.px(1200)

        delegate: Item {
            id: line
            required property var modelData
            readonly property bool mine: modelData.from === "user"
            readonly property bool marker: modelData.from === "event"
            readonly property real column: Math.min(ui.px(760), list.width - ui.px(32))
            width: list.width
            height: marker ? event.height : bubble.height

            // The board's own marker: a line through the conversation.
            Item {
                id: event
                visible: line.marker
                width: line.column
                x: (list.width - width) / 2
                height: ui.px(30)
                readonly property color tint: line.modelData.cardId ? ui.urg(line.modelData.urgency) : ui.faint
                Rectangle { anchors { left: parent.left; right: words.left; rightMargin: ui.px(10); verticalCenter: parent.verticalCenter } height: 1; color: ui.line }
                Rectangle { anchors { left: words.right; leftMargin: ui.px(10); right: parent.right; verticalCenter: parent.verticalCenter } height: 1; color: ui.line }
                Row {
                    id: words
                    anchors.centerIn: parent
                    spacing: ui.px(8)
                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        text: line.modelData.label || ""
                        color: event.tint
                        font { family: ui.sans; pixelSize: ui.px(11); weight: Font.DemiBold; letterSpacing: 0.9; capitalization: Font.AllUppercase }
                    }
                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        width: Math.min(implicitWidth, line.column - ui.px(240))
                        text: line.modelData.text || ""
                        color: line.modelData.cardId ? ui.fg : ui.muted
                        elide: Text.ElideRight
                        font { family: ui.sans; pixelSize: ui.px(13.5); weight: line.modelData.cardId ? Font.DemiBold : Font.Normal }
                    }
                    Text {
                        anchors.verticalCenter: parent.verticalCenter
                        text: line.modelData.cardId ? "open ›" : (line.modelData.time || "")
                        color: line.modelData.cardId ? event.tint : ui.faint
                        font { family: ui.sans; pixelSize: ui.px(12) }
                    }
                }
                TapHandler { enabled: !!line.modelData.cardId; onTapped: nav.openCard(line.modelData.cardId) }
            }

            Rectangle {
                id: bubble
                visible: !line.marker
                readonly property real widest: line.column * 0.86
                width: widest
                x: (list.width - line.column) / 2 + (line.mine ? line.column - width : 0)
                height: body.height + ui.px(22)
                radius: ui.px(12)
                color: line.mine ? ui.accentSoft : ui.surface
                border { width: line.mine ? 0 : 1; color: ui.line }

                Column {
                    id: body
                    x: ui.px(14)
                    y: ui.px(11)
                    width: parent.width - ui.px(28)
                    spacing: ui.px(8)
                    Rich { width: parent.width; blocks: line.modelData.blocks || [] }
                    Rich {
                        width: parent.width
                        visible: blocks.length > 0
                        blocks: line.modelData.details || []
                        ink: ui.muted
                        size: ui.px(13.5)
                    }
                    Text {
                        width: parent.width
                        text: (line.modelData.attachments ? line.modelData.attachments + " in the web client  ·  " : "") + (line.mine ? "You · " : "") + (line.modelData.time || "")
                        color: ui.faint
                        horizontalAlignment: line.mine ? Text.AlignRight : Text.AlignLeft
                        font { family: ui.sans; pixelSize: ui.px(11.5) }
                    }
                }
            }
        }

        Text {
            visible: list.count === 0
            anchors.centerIn: parent
            text: "No conversation with this session yet."
            color: ui.muted
            font { family: ui.sans; pixelSize: ui.px(15) }
        }
    }

    // ── writing to the agent ────────────────────────────────────────────
    Item {
        id: foot
        anchors { left: parent.left; right: parent.right; bottom: parent.bottom }
        height: write.height + ui.px(14)
        Rectangle { anchors { left: parent.left; right: parent.right; top: parent.top } height: 1; color: ui.line }
        Column {
            id: write
            width: Math.min(ui.px(760), parent.width - ui.px(32))
            anchors { horizontalCenter: parent.horizontalCenter; bottom: parent.bottom; bottomMargin: ui.px(8) }
            spacing: ui.px(4)
            topPadding: ui.px(8)
            Text {
                visible: text !== ""
                width: parent.width
                text: view.sendError || (view.session.online === false ? "This session is not running. The message waits until it is back." : "")
                color: view.sendError ? ui.deny : ui.muted
                wrapMode: Text.Wrap
                font { family: ui.sans; pixelSize: ui.px(12.5) }
            }
            Field {
                id: composer
                width: parent.width
                multiline: true
                placeholder: "Message to " + (view.session.name || "the agent") + " …  c"
                onAccepted: board.send(nav.agentId, composer.text)
            }
            Text {
                visible: composer.typing
                text: "Enter sends  ·  Shift+Enter new line  ·  Esc back"
                color: ui.faint
                font { family: ui.sans; pixelSize: ui.px(11.5) }
            }
        }
    }
}
