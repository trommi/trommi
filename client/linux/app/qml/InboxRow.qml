// One open question as a row. Every row has the same height with its answer
// at the right edge, always in the same place: thumb down and thumb up for
// a two-way question, otherwise one wide "Choose", which unfolds the
// options below the row. A small tag at the lower edge puts the question
// off ("Later"), or fetches it back.
import QtQuick

Item {
    id: row
    property var card: ({})
    property var from: null           // who asked, where nothing around the row says so
    readonly property bool off: !!card.later
    readonly property bool selected: nav.sel === card.id && !nav.focusOpen
    readonly property bool open: nav.unfolded === card.id
    readonly property bool failed: nav.errorFor === card.id && nav.error !== ""
    readonly property color tint: ui.urg(card.urgency)
    readonly property real base: ui.px(148)
    readonly property var ticked: { nav.picked; board.rev; return nav.ticked(card.id) }

    property var askField: null       // the line to ask back, once the row is unfolded
    function askBack() { if (askField) askField.take() }

    height: base + (open && more.item ? more.item.height + ui.px(30) : 0)

    Rectangle {
        id: paper
        anchors.fill: parent
        radius: ui.radius
        color: ui.cardBg(row.card.urgency)
        border { width: row.selected ? 2 : 1; color: row.selected ? ui.fg : ui.cardLine(row.card.urgency) }
    }

    // ── the head: only what stands out gets a tab ───────────────────────
    Rectangle {
        id: tab
        visible: !!row.card.tab
        width: tabText.implicitWidth + ui.px(20)
        height: ui.px(24)
        color: row.tint
        topLeftRadius: ui.radius
        bottomRightRadius: ui.radius
        Text {
            id: tabText
            anchors.centerIn: parent
            text: row.card.tab || ""
            color: ui.surface
            font { family: ui.sans; pixelSize: ui.px(11); weight: Font.Bold; letterSpacing: 0.8; capitalization: Font.AllUppercase }
        }
    }
    Sketch { // one that can wait: a small scribbled hourglass
        visible: !!row.card.whenever
        x: ui.px(18); y: ui.px(6)
        name: "whenever"; size: ui.px(18); color: ui.muted
    }
    Row { // who asked, under "Later"
        visible: !!row.from
        x: tab.visible ? tab.width + ui.px(10) : ui.px(row.card.whenever ? 42 : 20)
        y: ui.px(5)
        spacing: ui.px(6)
        Mark { who: row.from || ({}); size: ui.px(18); anchors.verticalCenter: parent.verticalCenter }
        Text {
            anchors.verticalCenter: parent.verticalCenter
            text: row.from ? row.from.name : ""
            color: ui.cardInk(row.card.urgency)
            font { family: ui.sans; pixelSize: ui.px(11); weight: Font.DemiBold; letterSpacing: 0.7; capitalization: Font.AllUppercase }
        }
    }
    Text { // the number is for looking a card up: small, at the far end, before the age
        anchors { right: actions.left; rightMargin: ui.px(16); top: parent.top; topMargin: ui.px(7) }
        textFormat: Text.StyledText
        text: "<font color=\"" + ui.faint + "\">" + (row.card.nr || "") + "</font>  ·  " + (row.card.ago || "")
        color: ui.cardInk(row.card.urgency)
        opacity: 0.8
        font { family: ui.sans; pixelSize: ui.px(11); weight: Font.Medium; letterSpacing: 0.8; capitalization: Font.AllUppercase }
    }

    // ── the question: a tap opens it as a window ────────────────────────
    Item {
        id: text
        anchors { left: parent.left; leftMargin: ui.px(20); right: actions.left; rightMargin: ui.px(16); top: parent.top; topMargin: ui.px(32) }
        height: row.base - ui.px(44)
        clip: true
        HoverHandler { cursorShape: Qt.PointingHandCursor }
        TapHandler { onTapped: nav.openCard(row.card.id) }
        Column {
            width: parent.width
            anchors.verticalCenter: parent.verticalCenter
            spacing: ui.px(4)
            Text {
                id: title
                width: parent.width
                text: row.card.title || ""
                color: ui.fg
                wrapMode: Text.Wrap
                maximumLineCount: 2
                elide: Text.ElideRight
                lineHeightMode: Text.FixedHeight
                lineHeight: ui.px(28)
                font { family: ui.sans; pixelSize: ui.px(22); weight: Font.ExtraBold; letterSpacing: -0.3 }
            }
            Text {
                visible: text !== ""
                width: parent.width
                // A title that needs two lines leaves room for one line below it.
                maximumLineCount: title.lineCount > 1 ? 1 : 2
                text: row.failed ? nav.error : [row.card.about, row.card.excerpt].filter(x => x).join(" · ")
                color: row.failed ? ui.deny : ui.cardInk(row.card.urgency)
                wrapMode: Text.Wrap
                elide: Text.ElideRight
                lineHeightMode: Text.FixedHeight
                lineHeight: ui.px(24)
                font { family: ui.sans; pixelSize: ui.px(16) }
            }
        }
    }

    // ── the answer, always in the same place ────────────────────────────
    Row {
        id: actions
        anchors { right: parent.right; top: parent.top; margins: ui.px(12) }
        height: row.base - ui.px(24)
        spacing: ui.px(8)
        Repeater {
            model: row.card.tiles || []
            Rectangle {
                id: tile
                required property var modelData
                required property int index
                readonly property bool wide: !modelData.answer
                readonly property color ink: modelData.lead ? ui.surface : ui.cardInk(row.card.urgency)
                width: ui.narrow ? (wide ? ui.px(128) : ui.px(60)) : (wide ? ui.px(256) : ui.px(124))
                height: actions.height
                radius: ui.px(10)
                color: modelData.lead ? row.tint : ui.mix(row.tint, ui.surface, 0.09)
                border { width: hover.hovered && !modelData.lead ? 2 : 0; color: row.tint }
                opacity: hover.hovered && modelData.lead ? 0.92 : 1
                scale: tap.pressed ? 0.97 : 1

                HoverHandler { id: hover; cursorShape: Qt.PointingHandCursor }
                TapHandler { id: tap; onTapped: nav.tile(row.card.id, tile.modelData) }

                Column {
                    anchors.centerIn: parent
                    width: parent.width - ui.px(12)
                    spacing: ui.px(6)
                    Sketch { anchors.horizontalCenter: parent.horizontalCenter; name: tile.modelData.icon; size: ui.px(tile.wide ? 30 : 36); color: tile.ink }
                    Text {
                        visible: tile.wide || !row.card.bare
                        width: parent.width
                        text: tile.modelData.label
                        color: tile.ink
                        horizontalAlignment: Text.AlignHCenter
                        wrapMode: Text.Wrap
                        maximumLineCount: 2
                        font { family: ui.sans; pixelSize: ui.px(tile.wide ? 16 : 13.5); weight: Font.Bold }
                    }
                    Text {
                        visible: tile.wide && !ui.narrow
                        width: parent.width
                        text: tile.modelData.detail
                        color: tile.ink
                        opacity: 0.85
                        horizontalAlignment: Text.AlignHCenter
                        font { family: ui.sans; pixelSize: ui.px(11.5) }
                    }
                }
                // The agent's advice: a loop drawn with the pen round the tile.
                Scribble {
                    visible: !!tile.modelData.advised
                    anchors { fill: parent; margins: -ui.px(5) }
                    stretch: true
                    box: 100
                    path: visible ? board.adviceLoop() : ""
                    color: tile.modelData.lead ? ui.mix(ui.urgHigh, Qt.color("white"), 0.7) : ui.urgHigh
                    pen: 2.4
                }
                KeyCap { // the key that presses it, on the row the keys are on
                    visible: row.selected
                    anchors { right: parent.right; top: parent.top; margins: ui.px(6) }
                    text: tile.wide ? "C" : tile.modelData.lead ? "Y" : "N"
                    ink: tile.ink
                }
            }
        }
    }

    // ── later: a small tag that hangs over the lower edge ───────────────
    Rectangle {
        id: tag
        x: ui.px(20)
        y: row.height - ui.px(17)
        width: tagLine.implicitWidth + ui.px(18)
        height: ui.px(28)
        radius: ui.px(7)
        color: ui.surface
        border { width: 1; color: ui.cardLine(row.card.urgency) }
        HoverHandler { id: tagHover; cursorShape: Qt.PointingHandCursor }
        TapHandler { onTapped: nav.later(row.card.id) }
        Row {
            id: tagLine
            anchors.centerIn: parent
            spacing: ui.px(6)
            Sketch { anchors.verticalCenter: parent.verticalCenter; name: row.off ? "back" : "later"; size: ui.px(19); color: ui.cardInk(row.card.urgency) }
            Text { // the word slides out of the tag when the pointer or the keyboard is on it
                visible: tagHover.hovered || row.selected || row.off
                anchors.verticalCenter: parent.verticalCenter
                text: row.off ? "Fetch back" : "Later"
                color: ui.cardInk(row.card.urgency)
                font { family: ui.sans; pixelSize: ui.px(12.5); weight: Font.DemiBold }
            }
            KeyCap { visible: row.selected; anchors.verticalCenter: parent.verticalCenter; text: "L"; ink: ui.cardInk(row.card.urgency) }
        }
    }

    // ── "Choose", unfolded: the text, every option, and a line to ask back ──
    Loader {
        id: more
        active: row.open
        anchors { left: parent.left; right: parent.right; top: parent.top; topMargin: row.base; leftMargin: ui.px(20); rightMargin: ui.px(12) }
        sourceComponent: Column {
            id: box
            width: more.width
            spacing: ui.px(12)
            // The text in full, unless the row above already shows all of it: nothing is said twice.
            readonly property bool full: (row.card.blocks || []).length > 1 || (row.card.excerpt || "").length > 110 || ((row.card.blocks || [])[0] || {}).kind !== "p"
            Rich {
                visible: box.full && (row.card.blocks || []).length > 0
                width: parent.width
                blocks: row.card.blocks || []
                ink: ui.cardInk(row.card.urgency)
                tint: row.tint
            }
            Flow {
                id: options
                width: parent.width
                spacing: ui.px(8)
                readonly property int n: (row.card.options || []).length
                readonly property real tile: (width - spacing * (Math.min(n, 3) - 1)) / Math.min(Math.max(n, 1), 3) - 0.5
                Repeater {
                    model: row.card.options || []
                    Option {
                        required property var modelData
                        required property int index
                        option: modelData
                        at: index
                        tag: !!row.card.tags
                        width: tag ? implicitWidth : (ui.narrow ? options.width : options.tile)
                        multiple: !!row.card.multiple
                        ticked: row.ticked.indexOf(modelData.key) >= 0
                        cursor: row.selected && nav.optAt === index
                        tint: row.tint
                        urgency: row.card.urgency
                        onPressed: nav.option(row.card.id, modelData.key)
                    }
                }
                Btn { // where several answers are allowed, one tile sends them
                    visible: !!row.card.multiple
                    implicitHeight: row.card.tags ? ui.px(36) : ui.px(64)
                    width: row.card.tags ? implicitWidth : (ui.narrow ? options.width : options.tile)
                    strong: true
                    enabled: row.ticked.length > 0
                    tint: row.tint
                    icon: "send"
                    label: row.ticked.length ? "Send " + row.ticked.length : "Send: pick one or more"
                    cap: row.selected ? "Enter" : ""
                    onPressed: nav.sendPicked(row.card.id)
                }
            }
            Row { // asking back: words to the session about this question; it stays open and stays where it is
                width: parent.width
                spacing: ui.px(8)
                Field {
                    id: askField
                    width: parent.width - ask.width - explain.width - 2 * parent.spacing
                    placeholder: "Ask back instead of answering"
                    onAccepted: ask.pressed()
                }
                Btn {
                    id: ask
                    height: askField.height
                    label: "Ask back"
                    cap: row.selected ? "A" : ""
                    tint: row.tint
                    onPressed: {
                        if (!askField.text.trim()) return askField.take()
                        board.ask(row.card.id, askField.text)
                    }
                }
                Btn {
                    id: explain
                    visible: !row.card.permission
                    height: askField.height
                    icon: "explain"
                    label: "Explain"
                    cap: row.selected ? "E" : ""
                    tint: row.tint
                    onPressed: board.explain(row.card.id)
                }
            }
            Text {
                id: said
                visible: text !== ""
                color: ui.muted
                font { family: ui.sans; pixelSize: ui.px(12.5) }
                Connections {
                    target: board
                    function onAsked(id) {
                        if (id !== row.card.id) return
                        askField.clear()
                        said.text = "Asked. The reply comes in the conversation."
                        win.takeKeys()
                    }
                }
            }
            Component.onCompleted: row.askField = askField
            Component.onDestruction: row.askField = null
        }
    }
}
