// The inbox: every open question of every session, grouped by who is
// asking, the most urgent group first. At its foot the piles lie side by
// side, each small: what was put off, what waits for its session, what was
// answered. A pile unfolds in place, one at a time.
import QtQuick
import QtQuick.Shapes

Item {
    id: inbox

    function itemOf(id) {
        if (id.startsWith("pile:")) return id === "pile:" + nav.pile ? openHead : piles
        for (const rep of [rows, pileRows])
            for (let i = 0; i < rep.count; i++) {
                const it = rep.itemAt(i)
                if (it && it.cardId === id) return it
            }
        return null
    }
    // Keep the row the keys are on in sight, with its sender's heading if it is the first of its group.
    function reveal() {
        if (!nav.sel) return
        const all = nav.rows()
        if (all.length && all[0].id === nav.sel) { flick.contentY = 0; return }
        const it = itemOf(nav.sel)
        if (!it) return
        const top = it.mapToItem(flick.contentItem, 0, 0).y, bottom = top + it.height, room = ui.px(28)
        const max = Math.max(0, flick.contentHeight - flick.height)
        if (top - room - (it.first ? ui.px(54) : 0) < flick.contentY) flick.contentY = Math.max(0, top - room - (it.first ? ui.px(54) : 0))
        else if (bottom + room > flick.contentY + flick.height) flick.contentY = Math.min(max, Math.min(bottom + room - flick.height, top - room))
    }
    function scroll(pages) {
        const max = Math.max(0, flick.contentHeight - flick.height)
        flick.contentY = Math.max(0, Math.min(max, flick.contentY + pages * flick.height * 0.85))
    }
    function askBack(id) { Qt.callLater(() => { const it = itemOf(id); if (it && it.askBack) it.askBack() }) }
    // Rows are laid out a moment after they were made, and the page grows with them: look for the
    // marked row then, and once more when the page has its new height.
    property bool seeking: false
    function seek() { seeking = true; settle.restart(); calm.restart() }
    Timer { id: settle; interval: 40; onTriggered: inbox.reveal() }
    Timer { id: calm; interval: 400; onTriggered: inbox.seeking = false }
    Connections { target: nav; function onSelChanged() { inbox.seek() } function onUnfoldedChanged() { inbox.seek() } function onPileChanged() { inbox.seek() } }

    Rectangle { anchors.fill: parent; color: ui.surface }

    Flickable {
        id: flick
        anchors.fill: parent
        contentWidth: width
        contentHeight: page.height + ui.px(72)
        onContentHeightChanged: if (inbox.seeking) settle.restart()
        clip: true
        boundsBehavior: Flickable.StopAtBounds

        Column {
            id: page
            width: Math.min(ui.px(760), flick.width - ui.px(32))
            x: (flick.width - width) / 2
            y: ui.px(28)
            spacing: ui.px(16)

            // ── the head: the count and its sentence are the way into the walk ──
            Row {
                spacing: ui.px(22)
                height: ui.px(58)
                Text {
                    anchors.baseline: parent.bottom
                    anchors.baselineOffset: -ui.px(14)
                    text: "Inbox"
                    color: ui.fg
                    font { family: ui.sans; pixelSize: ui.px(44); weight: Font.ExtraBold; letterSpacing: -1.2 }
                }
                Item {
                    anchors.bottom: parent.bottom
                    anchors.bottomMargin: ui.px(8)
                    width: walk.width
                    height: ui.px(34)
                    HoverHandler { id: walkHover; cursorShape: board.freshCount > 0 ? Qt.PointingHandCursor : Qt.ArrowCursor }
                    TapHandler { enabled: board.freshCount > 0; onTapped: nav.walk() }
                    Row {
                        id: walk
                        anchors.verticalCenter: parent.verticalCenter
                        spacing: ui.px(8)
                        Item { // the number, circled by hand
                            visible: board.freshCount > 0
                            width: Math.max(ui.px(30), count.implicitWidth + ui.px(18))
                            height: ui.px(30)
                            anchors.verticalCenter: parent.verticalCenter
                            Scribble {
                                anchors.fill: parent
                                stretch: true
                                box: 100
                                path: board.adviceLoop()
                                color: ui.urgHigh
                                pen: 2
                            }
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
                            color: walkHover.hovered && board.freshCount > 0 ? ui.fg : ui.muted
                            font { family: ui.sans; pixelSize: ui.px(17) }
                        }
                        Sketch { visible: board.freshCount > 0; anchors.verticalCenter: parent.verticalCenter; name: "go"; size: ui.px(22); color: ui.urgHigh }
                    }
                }
            }

            // ── the groups: who asks, then their questions ──────────────
            Repeater {
                id: rows
                model: board.inbox
                Item {
                    id: slot
                    required property var modelData
                    required property int index
                    readonly property string cardId: modelData.head ? "" : modelData.id
                    readonly property bool first: index > 0 && !!board.inbox[index - 1].head
                    property var askBack: null
                    width: page.width
                    height: modelData.head ? ui.px(index === 0 ? 40 : 58) : body.height

                    // A heading is a dividing line: the sender's mark and name, a rule, how many.
                    Item {
                        visible: slot.modelData.head
                        anchors { left: parent.left; right: parent.right; bottom: parent.bottom }
                        height: ui.px(36)
                        Mark { id: avatar; who: slot.modelData; size: ui.px(34); anchors.verticalCenter: parent.verticalCenter }
                        Text {
                            id: sender
                            anchors { left: avatar.right; leftMargin: ui.px(14); verticalCenter: parent.verticalCenter }
                            text: slot.modelData.name || ""
                            color: ui.fg
                            font { family: ui.sans; pixelSize: ui.px(19); weight: Font.ExtraBold }
                        }
                        Rectangle {
                            anchors { left: sender.right; leftMargin: ui.px(12); right: howMany.left; rightMargin: ui.px(12); verticalCenter: parent.verticalCenter }
                            height: 1
                            color: ui.lineStrong
                        }
                        Text {
                            id: howMany
                            anchors { right: parent.right; verticalCenter: parent.verticalCenter }
                            text: slot.modelData.count || ""
                            color: ui.muted
                            font { family: ui.sans; pixelSize: ui.px(11); weight: Font.DemiBold; letterSpacing: 1.0; capitalization: Font.AllUppercase }
                        }
                    }
                    Loader {
                        id: body
                        width: parent.width
                        active: !slot.modelData.head
                        sourceComponent: InboxRow {
                            id: openRow
                            card: slot.modelData
                            Component.onCompleted: slot.askBack = () => openRow.askBack()
                        }
                    }
                }
            }

            // ── nothing waits: dashed means provisional ─────────────────
            Item {
                visible: board.loaded && board.freshCount === 0
                width: parent.width
                height: ui.px(130)
                Item {
                    anchors.centerIn: parent
                    width: Math.min(parent.width, empty.implicitWidth + ui.px(64))
                    height: ui.px(72)
                    rotation: -1.5
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

            // ── the piles, pushed together: side by side ────────────────
            Row {
                id: piles
                visible: board.piles.length > 0
                width: parent.width
                topPadding: ui.px(14)
                spacing: ui.px(20)
                readonly property var folded: board.piles.filter(p => p.kind !== nav.pile)
                Repeater {
                    model: piles.folded
                    Item {
                        id: heap
                        required property var modelData
                        readonly property var topCard: modelData.rows[0]
                        readonly property int under: Math.min(2, modelData.rows.length - 1)
                        width: (piles.width - 2 * piles.spacing) / 3
                        height: ui.px(108)
                        HoverHandler { id: heapHover; cursorShape: Qt.PointingHandCursor }
                        TapHandler { onTapped: nav.togglePile(heap.modelData.kind) }

                        Row {
                            id: heapHead
                            x: ui.px(4)
                            spacing: ui.px(9)
                            Sketch { anchors.verticalCenter: parent.verticalCenter; name: heap.modelData.icon; size: ui.px(20); color: ui.muted }
                            Text {
                                anchors.verticalCenter: parent.verticalCenter
                                text: heap.modelData.kind === "later" ? nav.word.later : heap.modelData.label
                                color: heapHover.hovered ? ui.fg : ui.muted
                                font { family: ui.sans; pixelSize: ui.px(15.5); weight: Font.ExtraBold }
                            }
                            Text {
                                anchors.verticalCenter: parent.verticalCenter
                                text: heap.modelData.count
                                color: ui.muted
                                font { family: ui.sans; pixelSize: ui.px(10.5); weight: Font.DemiBold; letterSpacing: 1.0; capitalization: Font.AllUppercase }
                            }
                        }
                        // The edges of the cards beneath: its height hints at how many there are.
                        Repeater {
                            model: heap.under
                            Rectangle {
                                required property int index
                                readonly property int depth: heap.under - index
                                x: ui.px(9) * depth
                                y: sheet.y + ui.px(7) * depth
                                width: sheet.width - 2 * x
                                height: sheet.height
                                radius: ui.radius
                                color: ui.surface
                                border { width: 1; color: ui.line }
                            }
                        }
                        Rectangle { // the top card: the title, and under it a word more
                            id: sheet
                            y: ui.px(32)
                            width: parent.width
                            height: ui.px(58)
                            radius: ui.radius
                            color: ui.surface
                            readonly property bool marked: nav.sel === "pile:" + heap.modelData.kind
                            border { width: marked ? 2 : 1; color: marked ? ui.fg : heapHover.hovered ? ui.muted : ui.lineStrong }
                            Mark {
                                id: heapMark
                                visible: !!heap.topCard.from
                                x: ui.px(12)
                                anchors.verticalCenter: parent.verticalCenter
                                who: heap.topCard.from || ({})
                                size: ui.px(22)
                                width: visible ? size : 0
                            }
                            Column {
                                anchors { left: heapMark.right; leftMargin: ui.px(heapMark.visible ? 12 : 16); right: parent.right; rightMargin: ui.px(12); verticalCenter: parent.verticalCenter }
                                spacing: ui.px(2)
                                Text {
                                    width: parent.width
                                    text: heap.topCard.title
                                    color: ui.fg
                                    elide: Text.ElideRight
                                    font { family: ui.sans; pixelSize: ui.px(14.5); weight: Font.Bold }
                                }
                                Text {
                                    width: parent.width
                                    text: heap.topCard.tail || ""
                                    color: heap.modelData.kind === "answered" ? ui.accent : ui.muted
                                    elide: Text.ElideRight
                                    font {
                                        family: ui.sans; pixelSize: ui.px(heap.modelData.kind === "answered" ? 12.5 : 10.5); weight: Font.DemiBold
                                        letterSpacing: heap.modelData.kind === "answered" ? 0 : 0.8
                                        capitalization: heap.modelData.kind === "answered" ? Font.MixedCase : Font.AllUppercase
                                    }
                                }
                            }
                        }
                    }
                }
            }

            // ── the pile that stands open: its line a dividing line, every sheet a row ──
            Item {
                id: openHead
                readonly property var heap: nav.openPile()
                visible: !!heap
                width: parent.width
                height: visible ? ui.px(46) : 0
                HoverHandler { cursorShape: Qt.PointingHandCursor }
                TapHandler { onTapped: nav.togglePile(nav.pile) }
                Sketch { id: openIcon; anchors.verticalCenter: parent.verticalCenter; x: ui.px(4); name: openHead.heap ? openHead.heap.icon : "later"; size: ui.px(26); color: ui.muted }
                Text {
                    id: openLabel
                    anchors { left: openIcon.right; leftMargin: ui.px(16); verticalCenter: parent.verticalCenter }
                    text: !openHead.heap ? "" : openHead.heap.kind === "later" ? nav.word.later : openHead.heap.label
                    color: nav.sel === "pile:" + nav.pile ? ui.fg : ui.muted
                    font { family: ui.sans; pixelSize: ui.px(19); weight: Font.ExtraBold }
                }
                Shape { // dashed: where these cards stand is provisional
                    anchors { left: openLabel.right; leftMargin: ui.px(12); right: openCount.left; rightMargin: ui.px(12); verticalCenter: parent.verticalCenter }
                    height: 1
                    ShapePath {
                        strokeColor: ui.lineStrong; strokeWidth: 1
                        strokeStyle: nav.pile === "answered" ? ShapePath.SolidLine : ShapePath.DashLine
                        dashPattern: [4, 3]
                        startX: 0; startY: 0
                        PathLine { x: Math.max(0, openHead.width - openLabel.width - openCount.width - ui.px(100)); y: 0 }
                    }
                }
                Text {
                    id: openCount
                    anchors { right: fold.left; rightMargin: ui.px(10); verticalCenter: parent.verticalCenter }
                    text: openHead.heap ? openHead.heap.count : ""
                    color: ui.muted
                    font { family: ui.sans; pixelSize: ui.px(11); weight: Font.DemiBold; letterSpacing: 1.0; capitalization: Font.AllUppercase }
                }
                Sketch { id: fold; anchors { right: parent.right; verticalCenter: parent.verticalCenter } name: "unfold"; size: ui.px(20); color: ui.muted; rotation: 180 }
            }
            Repeater {
                id: pileRows
                model: openHead.heap ? openHead.heap.rows : []
                Item {
                    id: sheetRow
                    required property var modelData
                    required property int index
                    readonly property string cardId: modelData.id
                    readonly property bool first: false
                    property var askBack: null
                    width: page.width
                    height: modelData.done ? ui.px(62) : offRow.height

                    Loader {
                        id: offRow
                        width: parent.width
                        active: !sheetRow.modelData.done
                        sourceComponent: InboxRow {
                            id: putOffRow
                            card: sheetRow.modelData
                            from: sheetRow.modelData.from
                            Component.onCompleted: sheetRow.askBack = () => putOffRow.askBack()
                        }
                    }
                    // An answered question, as a slim row with the way to take the answer back.
                    Rectangle {
                        visible: !!sheetRow.modelData.done
                        anchors.fill: parent
                        radius: ui.radius
                        color: ui.surface2
                        readonly property bool selected: nav.sel === sheetRow.modelData.id
                        border { width: selected ? 2 : 1; color: selected ? ui.fg : ui.line }
                        Sketch { id: doneIcon; x: ui.px(16); anchors.verticalCenter: parent.verticalCenter; name: sheetRow.modelData.icon || "choose"; size: ui.px(24); color: ui.muted }
                        Column {
                            anchors { left: doneIcon.right; leftMargin: ui.px(16); right: take.left; rightMargin: ui.px(12); verticalCenter: parent.verticalCenter }
                            spacing: ui.px(3)
                            Text {
                                width: parent.width
                                text: sheetRow.modelData.title || ""
                                color: ui.fg
                                elide: Text.ElideRight
                                font { family: ui.sans; pixelSize: ui.px(15.5); weight: Font.Bold }
                            }
                            Row {
                                spacing: ui.px(10)
                                Text { text: sheetRow.modelData.labels || ""; color: ui.accent; font { family: ui.sans; pixelSize: ui.px(12.5); weight: Font.Bold } }
                                Mark { visible: !!sheetRow.modelData.who; who: sheetRow.modelData.who || ({}); size: ui.px(14); crowned: false; anchors.verticalCenter: parent.verticalCenter }
                                Text { text: sheetRow.modelData.who ? sheetRow.modelData.who.name : ""; color: ui.muted; font { family: ui.sans; pixelSize: ui.px(12.5) } }
                                Text { text: sheetRow.modelData.ago || ""; color: ui.faint; font { family: ui.sans; pixelSize: ui.px(12) } }
                                Text {
                                    visible: !!sheetRow.modelData.closed
                                    text: "done by the agent"
                                    color: ui.muted
                                    font { family: ui.sans; pixelSize: ui.px(10.5); weight: Font.DemiBold; letterSpacing: 0.8; capitalization: Font.AllUppercase }
                                }
                            }
                        }
                        Btn {
                            id: take
                            anchors { right: parent.right; rightMargin: ui.px(12); verticalCenter: parent.verticalCenter }
                            implicitHeight: ui.px(34)
                            label: "Take back"
                            cap: parent.selected ? "U" : ""
                            tint: ui.fg
                            onPressed: board.takeBack(sheetRow.modelData.id)
                        }
                    }
                }
            }
        }
    }
}
