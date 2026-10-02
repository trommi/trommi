// The question window: one question per page, large. On the left the
// question as a conversation (what is asked, the whole text, and the words
// exchanged about it), on the right the answers, always in the same place.
// At the foot one composer: Send writes to the session about the question,
// Explain asks it to say more, "Back to agent" hands the question to the
// session (it returns with the reply), Later puts it off.
// Opened without a card it is the walk through every open question: a rail
// at the left shows how far it is, ← and → page without answering.
import QtQuick

Item {
    id: view
    readonly property var card: { board.rev; return nav.cardId ? board.card(nav.cardId) : ({}) }
    readonly property string note: composer.text.trim()
    readonly property color tint: ui.urg(card.urgency || "normal")
    readonly property string urgency: card.urgency || "normal"
    readonly property var options: card.options || []
    readonly property bool duo: !!card.yes && !!card.no
    readonly property var ticked: { nav.picked; board.rev; return nav.cardId ? nav.ticked(nav.cardId) : [] }
    readonly property bool wide: width > ui.px(900)
    readonly property bool railed: nav.walking && wide && nav.rail.length > 1

    function compose() { composer.take() }
    function scroll(by) {
        const max = Math.max(0, flick.contentHeight - flick.height)
        flick.contentY = Math.max(0, Math.min(max, flick.contentY + by * ui.px(60)))
    }
    function explain() { if (!card.permission) board.explain(nav.cardId) }
    function handBack() { if (!card.permission) board.handBack(nav.cardId, composer.text) }
    // Another card: from the top, with an empty field.
    Connections {
        target: nav
        function onCardIdChanged() { flick.contentY = 0; composer.clear() }
    }
    Connections {
        target: board
        function onAsked(id) { if (id === nav.cardId && nav.focusOpen) { composer.clear(); Qt.callLater(() => view.scroll(9999)) } }
        function onDecided(id) { composer.clear() }
        function onHanded(id) { composer.clear() }
    }

    Rectangle { anchors.fill: parent; color: ui.overlay; TapHandler { onTapped: nav.closeFocus() } }
    MouseArea { anchors.fill: sheet; hoverEnabled: true; onWheel: w => w.accepted = true } // nothing below hears the window

    // ── the rail: how far the walk is ───────────────────────────────────
    Rectangle {
        id: rail
        visible: view.railed
        readonly property int n: nav.rail.length
        readonly property real step: n > 40 ? ui.px(11) : n > 24 ? ui.px(15) : ui.px(24)
        x: sheet.x - width - ui.px(10)
        width: ui.px(46)
        height: Math.min(sheet.height, marks.height + ui.px(74))
        anchors.verticalCenter: sheet.verticalCenter
        radius: width / 2
        color: ui.surface
        Flickable {
            id: railFlick
            anchors { top: parent.top; topMargin: ui.px(18); horizontalCenter: parent.horizontalCenter }
            width: parent.width
            height: Math.min(marks.height, parent.height - ui.px(74))
            contentHeight: marks.height
            clip: true
            interactive: false
            Column {
                id: marks
                width: parent.width
                Repeater {
                    model: nav.rail
                    Item {
                        id: dot
                        required property string modelData
                        required property int index
                        readonly property var row: { board.rev; return nav.row(modelData) }
                        readonly property bool front: modelData === nav.cardId
                        readonly property string state: nav.walked.indexOf(modelData) >= 0 || !row ? "done" : row.later ? "later" : "open"
                        // A gap where the sender changes.
                        readonly property bool gap: index > 0 && !!row && !!nav.row(nav.rail[index - 1]) && nav.row(nav.rail[index - 1]).agent !== row.agent
                        width: marks.width
                        height: rail.step + (gap ? ui.px(8) : 0)
                        onFrontChanged: if (front) railFlick.contentY = Math.max(0, Math.min(Math.max(0, marks.height - railFlick.height), y - railFlick.height / 2))
                        Scribble {
                            anchors { horizontalCenter: parent.horizontalCenter; bottom: parent.bottom; bottomMargin: (rail.step - height) / 2 }
                            width: Math.max(rail.step, ui.px(24))
                            readonly property var strokes: board.railMark(dot.state, false, dot.modelData)
                            path: strokes[0]
                            pen: dot.state === "done" ? 2.4 : 2.2
                            color: dot.state === "done" ? ui.muted
                                 : dot.row && (dot.row.urgency === "critical" || dot.row.urgency === "high") ? ui.urg(dot.row.urgency) : ui.faint
                            fill: dot.state === "open" ? color : "transparent"
                        }
                        Scribble { // the one in front: a ring round it
                            visible: dot.front
                            anchors { horizontalCenter: parent.horizontalCenter; bottom: parent.bottom; bottomMargin: (rail.step - height) / 2 }
                            width: ui.px(26)
                            path: visible ? board.railMark("open", true, dot.modelData)[1] : ""
                            color: ui.fg
                            pen: 1.6
                        }
                        TapHandler { enabled: dot.state !== "done"; onTapped: { nav.cardId = dot.modelData; nav.optAt = -1 } }
                    }
                }
            }
        }
        Column {
            anchors { bottom: parent.bottom; bottomMargin: ui.px(14); horizontalCenter: parent.horizontalCenter }
            Text {
                anchors.horizontalCenter: parent.horizontalCenter
                text: board.openCount
                color: ui.fg
                font { family: ui.sans; pixelSize: ui.px(17); weight: Font.ExtraBold }
            }
            Text {
                anchors.horizontalCenter: parent.horizontalCenter
                text: "left"
                color: ui.muted
                font { family: ui.sans; pixelSize: ui.px(9.5); weight: Font.DemiBold; letterSpacing: 1; capitalization: Font.AllUppercase }
            }
        }
    }

    // ← and →: to the next question without answering
    component Pager: Rectangle {
        property string icon: "go"
        property bool flipped: false
        signal pressed()
        visible: nav.walking && view.wide
        width: ui.px(48); height: ui.px(48); radius: width / 2
        color: ui.surface
        border { width: 1; color: ui.line }
        anchors.verticalCenter: sheet.verticalCenter
        HoverHandler { cursorShape: Qt.PointingHandCursor }
        TapHandler { onTapped: parent.pressed() }
        Sketch { anchors.centerIn: parent; name: "go"; size: ui.px(22); color: ui.fg; rotation: parent.flipped ? 180 : 0 }
    }
    Pager { x: ui.px(16); flipped: true; onPressed: nav.go(-1) }
    Pager { x: view.width - width - ui.px(16); onPressed: nav.go(1) }

    // ── the window ──────────────────────────────────────────────────────
    Rectangle {
        id: sheet
        x: view.wide ? ui.px(nav.walking ? 130 : 76) : ui.px(8)
        y: view.wide ? ui.px(28) : ui.px(8)
        width: view.width - x - (view.wide ? ui.px(76) : ui.px(8))
        height: view.height - 2 * y
        radius: ui.px(18)
        color: ui.surface
        clip: true

        Rectangle { // the card's colour, fading out from the top
            width: parent.width
            height: ui.px(190)
            radius: sheet.radius
            gradient: Gradient {
                GradientStop { position: 0; color: ui.mix(view.tint, ui.surface, 0.10) }
                GradientStop { position: 1; color: ui.surface }
            }
        }

        // who asks, how urgent, which number, since when
        Row {
            id: top
            x: ui.px(40); y: ui.px(14)
            spacing: ui.px(10)
            height: ui.px(26)
            Rectangle {
                visible: !!view.card.tab
                anchors.verticalCenter: parent.verticalCenter
                width: tabText.implicitWidth + ui.px(18); height: ui.px(24); radius: ui.px(6)
                color: view.tint
                Text {
                    id: tabText
                    anchors.centerIn: parent
                    text: view.card.tab || ""
                    color: ui.surface
                    font { family: ui.sans; pixelSize: ui.px(11); weight: Font.Bold; letterSpacing: 0.8; capitalization: Font.AllUppercase }
                }
            }
            Mark { anchors.verticalCenter: parent.verticalCenter; who: view.card.who || ({}); size: ui.px(20) }
            Text {
                anchors.verticalCenter: parent.verticalCenter
                text: view.card.agentName || ""
                color: ui.cardInk(view.urgency)
                font { family: ui.sans; pixelSize: ui.px(11.5); weight: Font.Bold; letterSpacing: 1.0; capitalization: Font.AllUppercase }
            }
            Text {
                anchors.verticalCenter: parent.verticalCenter
                text: [view.card.nr, view.card.ago].filter(x => x).join("  ·  ")
                color: ui.muted
                font { family: ui.sans; pixelSize: ui.px(11); weight: Font.Medium; letterSpacing: 0.8; capitalization: Font.AllUppercase }
            }
        }
        Row { // a narrow window has no room beside it: the two arrows stand here
            visible: nav.walking && !view.wide
            anchors { right: closeBtn.left; rightMargin: ui.px(6); verticalCenter: closeBtn.verticalCenter }
            Btn { quiet: true; implicitWidth: ui.px(38); tint: ui.fg; onPressed: nav.go(-1); Sketch { anchors.centerIn: parent; name: "go"; size: ui.px(20); color: ui.fg; rotation: 180 } }
            Btn { quiet: true; implicitWidth: ui.px(38); tint: ui.fg; onPressed: nav.go(1); Sketch { anchors.centerIn: parent; name: "go"; size: ui.px(20); color: ui.fg } }
        }
        Rectangle { // close
            id: closeBtn
            anchors { right: parent.right; top: parent.top; margins: ui.px(12) }
            width: ui.px(42); height: ui.px(42); radius: width / 2
            color: closeHover.hovered ? ui.sunken : ui.surface
            border { width: 1; color: ui.line }
            HoverHandler { id: closeHover; cursorShape: Qt.PointingHandCursor }
            TapHandler { onTapped: nav.closeFocus() }
            Text { anchors.centerIn: parent; text: "✕"; color: ui.fg; font { family: ui.sans; pixelSize: ui.px(15) } }
        }

        // ── left: the question as a conversation ────────────────────────
        Flickable {
            id: flick
            anchors { left: parent.left; leftMargin: ui.px(40); top: top.bottom; topMargin: ui.px(24); bottom: foot.top; bottomMargin: ui.px(12) }
            width: view.wide ? parent.width - answers.width - ui.px(40 + 36 + 40) : parent.width - ui.px(56)
            contentWidth: width
            contentHeight: talk.height + (view.wide ? 0 : answersNarrow.height + ui.px(20))
            clip: true
            boundsBehavior: Flickable.StopAtBounds

            Column {
                id: talk
                width: flick.width
                spacing: ui.px(16)

                Text {
                    width: parent.width
                    text: view.card.title || ""
                    color: ui.fg
                    wrapMode: Text.Wrap
                    lineHeight: 1.1
                    font { family: ui.sans; pixelSize: ui.px(view.wide ? 34 : 26); weight: Font.ExtraBold; letterSpacing: -0.8 }
                }
                Item { // why it is urgent, and what the card says of its own history
                    visible: !!view.card.about
                    width: parent.width
                    height: visible ? about.height : 0
                    Rectangle { width: 3; height: parent.height; color: view.tint }
                    Text {
                        id: about
                        x: ui.px(13)
                        width: parent.width - x
                        text: view.card.about || ""
                        color: view.tint
                        wrapMode: Text.Wrap
                        font { family: ui.sans; pixelSize: ui.px(14.5); weight: Font.DemiBold }
                    }
                }
                Rich { // the whole text …
                    visible: !sections.visible && blocks.length > 0
                    width: parent.width
                    blocks: view.card.blocks || []
                    size: ui.px(16.5)
                    tint: view.tint
                }
                Column { // … or its blocks in order: a paragraph, or a paragraph that is an option
                    id: sections
                    visible: (view.card.sections || []).length > 0
                    width: parent.width
                    spacing: ui.px(12)
                    Repeater {
                        model: view.card.sections || []
                        Item {
                            id: block
                            required property var modelData
                            readonly property bool flagged: !!modelData.key
                            readonly property int at: view.options.findIndex(o => o.key === modelData.key)
                            readonly property bool hot: flagged && (blockHover.hovered || nav.optAt === at || view.ticked.indexOf(modelData.key) >= 0)
                            width: sections.width
                            height: inner.height + (flagged ? ui.px(20) : 0)
                            Rectangle {
                                visible: block.flagged
                                anchors.fill: parent
                                radius: ui.px(10)
                                color: block.hot ? ui.mix(view.tint, ui.surface, 0.10) : "transparent"
                                border { width: 1; color: block.hot ? view.tint : ui.line }
                            }
                            HoverHandler { id: blockHover; enabled: block.flagged; cursorShape: Qt.PointingHandCursor }
                            TapHandler { enabled: block.flagged; onTapped: nav.option(nav.cardId, block.modelData.key) }
                            Column {
                                id: inner
                                x: block.flagged ? ui.px(14) : 0
                                y: block.flagged ? ui.px(10) : 0
                                width: parent.width - 2 * x
                                spacing: ui.px(4)
                                Row {
                                    visible: block.flagged
                                    spacing: ui.px(8)
                                    KeyCap { visible: block.at >= 0 && block.at < 9; anchors.verticalCenter: parent.verticalCenter; text: block.at + 1; ink: ui.cardInk(view.urgency) }
                                    Text {
                                        text: block.modelData.label || ""
                                        color: ui.mix(view.tint, ui.fg, 0.55)
                                        font { family: ui.sans; pixelSize: ui.px(16.5); weight: Font.Bold }
                                    }
                                    Text {
                                        visible: !!block.modelData.advised
                                        anchors.verticalCenter: parent.verticalCenter
                                        text: "the agent's pick"
                                        color: ui.urgHigh
                                        font { family: ui.sans; pixelSize: ui.px(10.5); weight: Font.DemiBold; letterSpacing: 0.8; capitalization: Font.AllUppercase }
                                    }
                                }
                                Rich { width: parent.width; visible: blocks.length > 0; blocks: block.modelData.blocks || []; size: ui.px(block.flagged ? 15 : 16.5); tint: view.tint }
                                Text {
                                    visible: !!block.modelData.picture
                                    text: "Picture: " + (block.modelData.picture || "") + " (in the web client)"
                                    color: ui.faint
                                    font { family: ui.sans; pixelSize: ui.px(12) }
                                }
                            }
                        }
                    }
                }
                Text {
                    visible: !!view.card.attachments
                    text: (view.card.attachments || "") + ": pictures and files are shown in the web client for now"
                    color: ui.faint
                    font { family: ui.sans; pixelSize: ui.px(12.5) }
                }

                // the words exchanged about this question
                Repeater {
                    model: view.card.thread || []
                    Item {
                        id: line
                        required property var modelData
                        readonly property bool mine: !!modelData.mine
                        width: talk.width
                        height: bubble.height
                        Rectangle {
                            id: bubble
                            width: Math.min(parent.width * 0.88, ui.px(560))
                            x: line.mine ? parent.width - width : 0
                            height: said.height + ui.px(22)
                            radius: ui.px(12)
                            color: line.mine ? ui.accentSoft : ui.surface2
                            border { width: line.mine ? 0 : 1; color: ui.line }
                            Column {
                                id: said
                                x: ui.px(14); y: ui.px(10)
                                width: parent.width - ui.px(28)
                                spacing: ui.px(6)
                                Rich {
                                    width: parent.width
                                    visible: !line.modelData.fixed
                                    blocks: line.modelData.blocks || []
                                }
                                Row { // "Explain" is one fixed question: it stands as its name
                                    visible: !!line.modelData.fixed
                                    spacing: ui.px(8)
                                    Sketch { name: "explain"; size: ui.px(20); color: ui.fg }
                                    Text { text: "Explain this, please."; color: ui.fg; font { family: ui.sans; pixelSize: ui.px(15.5) } }
                                }
                                Text {
                                    width: parent.width
                                    text: (line.mine ? "You · " : (view.card.agentName || "Agent") + " · ") + (line.modelData.time || "")
                                    color: ui.faint
                                    horizontalAlignment: line.mine ? Text.AlignRight : Text.AlignLeft
                                    font { family: ui.sans; pixelSize: ui.px(11.5) }
                                }
                            }
                        }
                    }
                }
            }
            // A narrow window: the answers stand under the text.
            Loader {
                id: answersNarrow
                y: talk.height + ui.px(20)
                width: flick.width
                active: !view.wide
                sourceComponent: answerColumn
            }
        }

        // ── right: the answers ──────────────────────────────────────────
        Flickable {
            id: answers
            visible: view.wide
            anchors { right: parent.right; rightMargin: ui.px(40); top: top.bottom; topMargin: ui.px(24); bottom: foot.top; bottomMargin: ui.px(12) }
            width: ui.px(view.card.tags && view.options.length > 16 ? 420 : 330)
            contentHeight: answersWide.height
            clip: true
            boundsBehavior: Flickable.StopAtBounds
            Loader { id: answersWide; width: answers.width; active: view.wide; sourceComponent: answerColumn }
        }

        Component {
            id: answerColumn
            Column {
                spacing: ui.px(8)
                // Two ways: thumb down on the left, thumb up on the right, as in the list.
                Row {
                    visible: view.duo
                    width: parent.width
                    spacing: ui.px(8)
                    Repeater {
                        model: view.duo ? (view.card.tiles || []) : []
                        Rectangle {
                            id: thumb
                            required property var modelData
                            readonly property color ink: modelData.lead ? ui.surface : ui.cardInk(view.urgency)
                            width: (parent.width - ui.px(8)) / 2
                            height: Math.min(width, ui.px(160))
                            radius: ui.px(12)
                            color: modelData.lead ? view.tint : ui.mix(view.tint, ui.surface, 0.09)
                            border { width: modelData.lead ? 0 : 1; color: ui.mix(view.tint, ui.surface, 0.3) }
                            scale: thumbTap.pressed ? 0.97 : 1
                            HoverHandler { cursorShape: Qt.PointingHandCursor }
                            TapHandler { id: thumbTap; onTapped: nav.decide(nav.cardId, [thumb.modelData.key], view.note) }
                            Column {
                                anchors.centerIn: parent
                                width: parent.width - ui.px(16)
                                spacing: ui.px(8)
                                Sketch { anchors.horizontalCenter: parent.horizontalCenter; name: thumb.modelData.icon; size: ui.px(40); color: thumb.ink }
                                Text {
                                    id: thumbWord
                                    visible: !view.card.bare
                                    width: parent.width
                                    text: thumb.modelData.label
                                    color: thumb.ink
                                    horizontalAlignment: Text.AlignHCenter
                                    wrapMode: Text.Wrap
                                    font { family: ui.sans; pixelSize: ui.px(16); weight: Font.Bold }
                                    Advice { visible: !!thumb.modelData.advised; filled: thumb.modelData.lead; tint: view.tint }
                                }
                            }
                            Rectangle { // a thumb without a word: the swipe stands where its word would be
                                visible: !!thumb.modelData.advised && !thumbWord.visible
                                x: parent.width * 0.26; y: parent.height * 0.72
                                width: parent.width * 0.48; height: ui.px(14)
                                rotation: -1.5
                                color: thumb.modelData.lead ? ui.mix(view.tint, theme.dark ? Qt.color("white") : Qt.color("black"), theme.dark ? 0.55 : 0.40) : ui.urgHigh
                                opacity: thumb.modelData.lead ? 0.5 : 0.3
                            }
                            KeyCap { anchors { right: parent.right; top: parent.top; margins: ui.px(8) } text: thumb.modelData.lead ? "Y" : "N"; ink: thumb.ink }
                        }
                    }
                }
                // More ways: one below the other; many short ones as small tags.
                Flow {
                    visible: !view.duo
                    width: parent.width
                    spacing: ui.px(view.card.tags ? 6 : 8)
                    Repeater {
                        model: view.duo ? [] : view.options
                        Option {
                            required property var modelData
                            required property int index
                            option: modelData
                            at: index
                            tag: !!view.card.tags
                            width: tag ? implicitWidth : parent.width
                            multiple: !!view.card.multiple
                            ticked: view.ticked.indexOf(modelData.key) >= 0
                            cursor: nav.optAt === index
                            tint: view.tint
                            urgency: view.urgency
                            onPressed: nav.option(nav.cardId, modelData.key)
                        }
                    }
                }
                Btn { // several answers: one tile sends them
                    visible: !!view.card.multiple
                    width: parent.width
                    implicitHeight: ui.px(56)
                    strong: true
                    enabled: view.ticked.length > 0
                    tint: view.tint
                    icon: "send"
                    label: view.ticked.length ? "Send " + view.ticked.length : "Send: pick one or more"
                    cap: "Enter"
                    onPressed: nav.sendPicked(nav.cardId)
                }
            }
        }

        // ── the foot: one composer and the four ways on ─────────────────
        Column {
            id: foot
            anchors { left: parent.left; right: parent.right; bottom: parent.bottom; leftMargin: ui.px(view.wide ? 40 : 16); rightMargin: ui.px(view.wide ? 40 : 16); bottomMargin: ui.px(18) }
            spacing: ui.px(8)
            Text {
                visible: nav.info !== ""
                width: parent.width
                text: nav.info
                color: nav.infoBad ? ui.deny : ui.muted
                wrapMode: Text.Wrap
                font { family: ui.sans; pixelSize: ui.px(13.5); weight: nav.infoBad ? Font.DemiBold : Font.Normal }
            }
            Flow {
                width: parent.width
                spacing: ui.px(8)
                Field {
                    id: composer
                    width: view.wide ? parent.width - ways.width - ui.px(8) : parent.width
                    multiline: true
                    placeholder: "Write to " + (view.card.agentName || "the agent")
                    onAccepted: send.pressed()
                }
                Row {
                    id: ways
                    spacing: ui.px(6)
                    Btn {
                        id: send
                        height: ui.px(44)
                        icon: "send"
                        label: "Send"
                        enabled: composer.text.trim() !== ""
                        tint: view.tint
                        onPressed: if (composer.text.trim()) board.ask(nav.cardId, composer.text)
                    }
                    Btn {
                        height: ui.px(44)
                        visible: !view.card.permission
                        icon: "explain"
                        label: nav.word.explain
                        cap: view.wide ? "E" : ""
                        tint: view.tint
                        onPressed: view.explain()
                    }
                    Btn {
                        height: ui.px(44)
                        visible: !view.card.permission
                        icon: "reverse"
                        label: nav.word.handBack
                        cap: view.wide ? "B" : ""
                        tint: view.tint
                        onPressed: view.handBack()
                    }
                    Btn {
                        height: ui.px(44)
                        icon: "later"
                        label: nav.word.later
                        cap: view.wide ? "L" : ""
                        tint: view.tint
                        onPressed: nav.focusLater()
                    }
                }
            }
        }

        // What just happened in the window, and the way back.
        Says { anchors { horizontalCenter: parent.horizontalCenter; top: parent.top; topMargin: ui.px(10) } shown: nav.focusOpen }
    }
}
