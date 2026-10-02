// One open question in the inbox. Every row has the same height, so the
// next answer lands where the last one was: the tab in the corner, the
// title, a line or two of what it is about, and two tiles at the right.
import QtQuick

Rectangle {
    id: row
    property var card: ({})
    readonly property bool selected: nav.sel === card.id && nav.view === "inbox"
    readonly property bool failed: nav.errorFor === card.id && nav.error !== ""
    readonly property color tint: ui.urg(card.urgency)

    height: ui.px(148)
    radius: ui.radius
    color: ui.cardBg(card.urgency)
    opacity: card.later && !selected ? 0.82 : 1 // put off: a step back
    border { width: selected ? 2 : 1; color: selected ? tint : ui.cardLine(card.urgency) }

    TapHandler { onTapped: nav.openCard(row.card.id) }

    CornerTab { quiet: row.card.urgency === "low" && !row.card.permission; label: row.card.tab; vip: row.card.vip; tint: row.tint }

    Text {
        anchors { right: actions.left; rightMargin: ui.px(16); top: parent.top; topMargin: ui.px(8) }
        text: (row.card.from ? row.card.from + " · " : "") + (row.card.attachments ? row.card.attachments + " · " : "") + row.card.ago
        color: ui.cardInk(row.card.urgency)
        opacity: 0.75
        font { family: ui.sans; pixelSize: ui.px(11.5); weight: Font.Medium; letterSpacing: 0.7; capitalization: Font.AllUppercase }
    }

    Column {
        anchors { left: parent.left; leftMargin: ui.px(20); right: actions.left; rightMargin: ui.px(16); top: parent.top; topMargin: ui.px(34) }
        spacing: ui.px(6)
        Text {
            id: title
            width: parent.width
            text: row.card.title
            color: ui.fg
            wrapMode: Text.Wrap
            maximumLineCount: 2
            elide: Text.ElideRight
            lineHeightMode: Text.FixedHeight
            lineHeight: ui.px(28)
            font { family: ui.sans; pixelSize: ui.px(23); weight: Font.ExtraBold; letterSpacing: -0.3 }
        }
        Text {
            width: parent.width
            // A title that needs two lines leaves room for one line below it.
            maximumLineCount: title.lineCount > 1 ? 1 : 2
            text: row.failed ? nav.error : row.card.excerpt
            color: row.failed ? ui.deny : ui.cardInk(row.card.urgency)
            wrapMode: Text.Wrap
            elide: Text.ElideRight
            lineHeightMode: Text.FixedHeight
            lineHeight: ui.px(25)
            font { family: ui.sans; pixelSize: ui.px(16.5) }
        }
    }

    Row {
        id: actions
        anchors { right: parent.right; top: parent.top; bottom: parent.bottom; margins: ui.px(8) }
        spacing: ui.px(6)
        Repeater {
            model: row.card.tiles
            Tile {
                required property var modelData
                required property int index
                width: ui.px(100)
                height: actions.height
                label: modelData.label
                icon: modelData.icon
                lead: modelData.lead
                bare: row.card.bare && modelData.answer
                urgency: row.card.urgency
                busy: row.card.busy
                advised: !!modelData.advised
                hint: !row.selected ? "" : modelData.answer ? (index === 1 ? "y" : "n") : modelData.key === "open" ? "m" : "s"
                onPressed: nav.tile(row.card.id, modelData)
            }
        }
    }
}
