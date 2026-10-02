// One card as a whole page: what is asked, why it is urgent, the details,
// and every option as a large button. One activation decides, and the next
// card comes.
import QtQuick

Item {
    id: view
    readonly property var card: { board.rev; return nav.cardId ? board.card(nav.cardId) : ({}) }
    readonly property string note: noteField.text
    readonly property color tint: ui.urg(card.urgency || "normal")
    readonly property bool failed: nav.errorFor === card.id && nav.error !== ""

    function editNote() { noteField.take() }
    function scroll(by) {
        const max = Math.max(0, flick.contentHeight - flick.height)
        flick.contentY = Math.max(0, Math.min(max, flick.contentY + by * ui.px(60)))
    }
    // Another card: from the top, with an empty note.
    Connections {
        target: nav
        function onCardIdChanged() { flick.contentY = 0; noteField.clear() }
    }

    Flickable {
        id: flick
        anchors.fill: parent
        contentWidth: width
        contentHeight: page.height + ui.px(56)
        clip: true
        boundsBehavior: Flickable.StopAtBounds

        Column {
            id: page
            width: Math.min(ui.px(760), flick.width - ui.px(32))
            x: (flick.width - width) / 2
            y: ui.px(24)
            spacing: ui.px(14)

            // Where this card stands, and the way back.
            Item {
                width: parent.width
                height: ui.px(24)
                Text {
                    anchors.verticalCenter: parent.verticalCenter
                    text: "‹ " + (nav.cardFrom === "session" ? "Session" : "Inbox") + "  Esc"
                    color: ui.muted
                    font { family: ui.sans; pixelSize: ui.px(13.5) }
                    TapHandler { onTapped: nav.closeCard() }
                }
                Text {
                    anchors { right: parent.right; verticalCenter: parent.verticalCenter }
                    text: view.card.total > 1 ? view.card.position + " of " + view.card.total + "  ·  j / k" : ""
                    color: ui.muted
                    font { family: ui.sans; pixelSize: ui.px(13.5) }
                }
            }

            Rectangle {
                width: parent.width
                height: inner.y + inner.height + ui.px(20)
                radius: ui.radius
                color: ui.cardBg(view.card.urgency || "normal")
                border { width: 1; color: ui.cardLine(view.card.urgency || "normal") }

                CornerTab { quiet: view.card.urgency === "low" && !view.card.permission; label: view.card.tab || ""; vip: !!view.card.vip; tint: view.tint }
                Text {
                    anchors { right: parent.right; rightMargin: ui.px(16); top: parent.top; topMargin: ui.px(8) }
                    text: (view.card.agentName || "") + " · " + (view.card.ago || "")
                    color: ui.cardInk(view.card.urgency || "normal")
                    opacity: 0.75
                    font { family: ui.sans; pixelSize: ui.px(11.5); weight: Font.Medium; letterSpacing: 0.7; capitalization: Font.AllUppercase }
                }

                Column {
                    id: inner
                    anchors { left: parent.left; right: parent.right; top: parent.top; leftMargin: ui.px(20); rightMargin: ui.px(20); topMargin: ui.px(40) }
                    spacing: ui.px(12)

                    Text {
                        width: parent.width
                        text: view.card.title || ""
                        color: ui.fg
                        wrapMode: Text.Wrap
                        lineHeight: 1.15
                        font { family: ui.sans; pixelSize: ui.px(27); weight: Font.ExtraBold; letterSpacing: -0.4 }
                    }
                    Item { // why it is urgent, behind a bar in the card's colour
                        visible: !!view.card.reason
                        width: parent.width
                        height: visible ? reason.height : 0
                        Rectangle { width: 3; height: parent.height; color: view.tint }
                        Text {
                            id: reason
                            x: ui.px(13)
                            width: parent.width - x
                            text: view.card.reason || ""
                            color: view.tint
                            wrapMode: Text.Wrap
                            font { family: ui.sans; pixelSize: ui.px(14); weight: Font.DemiBold }
                        }
                    }
                    Rich {
                        width: parent.width
                        visible: blocks.length > 0
                        blocks: view.card.blocks || []
                        ink: ui.cardInk(view.card.urgency || "normal")
                        tint: view.tint
                    }
                    Text {
                        visible: !!view.card.attachments
                        text: (view.card.attachments || "") + " · shown in the web client only"
                        color: ui.cardInk(view.card.urgency || "normal")
                        font { family: ui.sans; pixelSize: ui.px(11.5); weight: Font.DemiBold; letterSpacing: 0.7; capitalization: Font.AllUppercase }
                    }
                    Text {
                        visible: view.failed
                        width: parent.width
                        text: nav.error
                        color: ui.deny
                        wrapMode: Text.Wrap
                        font { family: ui.sans; pixelSize: ui.px(14) }
                    }

                    // ── the options ─────────────────────────────────────
                    Column {
                        width: parent.width
                        spacing: ui.px(8)
                        topPadding: ui.px(4)
                        Repeater {
                            model: view.card.options || []
                            Rectangle {
                                id: option
                                required property var modelData
                                required property int index
                                readonly property color ink: modelData.lead ? ui.surface : ui.fg
                                width: parent.width
                                height: Math.max(ui.px(56), words.height + ui.px(20))
                                radius: ui.px(10)
                                color: modelData.lead ? view.tint : ui.surface
                                border { width: modelData.lead ? 0 : hover.hovered ? 2 : 1; color: hover.hovered ? view.tint : ui.cardLine(view.card.urgency || "normal") }
                                opacity: view.card.busy ? 0.4 : 1
                                scale: tap.pressed ? 0.985 : 1

                                HoverHandler { id: hover; cursorShape: Qt.PointingHandCursor }
                                TapHandler { id: tap; enabled: !view.card.busy; onTapped: nav.decide(view.card.id, option.modelData.key, view.note) }

                                Rectangle { // the key that picks it
                                    id: keycap
                                    anchors { left: parent.left; leftMargin: ui.px(12); verticalCenter: parent.verticalCenter }
                                    width: ui.px(26); height: ui.px(26); radius: ui.px(6)
                                    color: "transparent"
                                    border { width: 1; color: Qt.alpha(option.ink, 0.35) }
                                    Text {
                                        anchors.centerIn: parent
                                        text: option.index + 1
                                        color: option.ink
                                        font { family: ui.mono; pixelSize: ui.px(13) }
                                    }
                                }
                                // The agent's advice, circled as if by hand (.is-advised in tokens.css).
                                Rectangle {
                                    visible: !!option.modelData.advised
                                    anchors { fill: parent; margins: -ui.px(5) }
                                    radius: height / 2
                                    rotation: -1.2
                                    color: "transparent"
                                    border { width: ui.px(2.5); color: ui.urgHigh }
                                }
                                Text {
                                    id: advice
                                    visible: !!option.modelData.advised
                                    anchors { right: parent.right; rightMargin: ui.px(18); verticalCenter: parent.verticalCenter }
                                    text: "Recommended"
                                    color: option.modelData.lead ? Qt.alpha(ui.surface, 0.9) : ui.urgHigh
                                    font { family: ui.sans; pixelSize: ui.px(11.5); weight: Font.DemiBold; letterSpacing: 0.7; capitalization: Font.AllUppercase }
                                }
                                Column {
                                    id: words
                                    anchors { left: keycap.right; leftMargin: ui.px(12); right: advice.visible ? advice.left : parent.right; rightMargin: ui.px(14); verticalCenter: parent.verticalCenter }
                                    spacing: ui.px(2)
                                    Text {
                                        width: parent.width
                                        text: option.modelData.label
                                        color: option.ink
                                        wrapMode: Text.Wrap
                                        font { family: ui.sans; pixelSize: ui.px(16.5); weight: Font.DemiBold }
                                    }
                                    Text {
                                        visible: text !== ""
                                        width: parent.width
                                        text: option.modelData.detail
                                        color: option.modelData.lead ? Qt.alpha(ui.surface, 0.85) : ui.cardInk(view.card.urgency || "normal")
                                        wrapMode: Text.Wrap
                                        font { family: ui.sans; pixelSize: ui.px(13.5) }
                                    }
                                }
                            }
                        }
                    }

                    Field {
                        id: noteField
                        width: parent.width
                        placeholder: "A note with it?  a"
                        onAccepted: win.takeKeys() // it goes out with the answer
                    }
                }
            }

            Text {
                width: parent.width
                text: (view.card.yes ? "y / n or " : "") + "1–" + ((view.card.options || []).length) + " answers at once  ·  a note  ·  s later  ·  j / k next and previous"
                color: ui.faint
                wrapMode: Text.Wrap
                horizontalAlignment: Text.AlignHCenter
                font { family: ui.sans; pixelSize: ui.px(12.5) }
            }
        }
    }
}
