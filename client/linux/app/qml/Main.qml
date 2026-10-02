// The window: the places on the left (the inbox, then the sessions), the
// place chosen on the right. Everything is reachable from the keyboard;
// Nav holds where the human is and what every key does.
import QtQuick
import QtQuick.Window

Window {
    id: win
    width: testSize.width || 1100
    height: testSize.height || 780
    minimumWidth: 420
    minimumHeight: 360
    visible: true
    title: board.openCount > 0 ? "Trommi (" + board.openCount + ")" : "Trommi"
    color: ui.bg

    // ── the look: client/web/css/tokens.css ─────────────────────────────
    QtObject {
        id: ui
        readonly property var c: theme.colors
        readonly property color bg: c.bg
        readonly property color surface: c.surface
        readonly property color surface2: c.surface2
        readonly property color sunken: c.sunken
        readonly property color fg: c.fg
        readonly property color muted: c.muted
        readonly property color faint: c.faint
        readonly property color line: c.line
        readonly property color lineStrong: c.line_strong
        readonly property color accent: c.accent
        readonly property color accentSoft: c.accent_soft
        readonly property color accentFg: c.accent_fg
        readonly property color deny: c.deny
        readonly property color gold: c.gold
        readonly property color goldPen: c.gold_pen
        readonly property color urgCriticalSoft: c.urg_critical_soft
        readonly property color overlay: Qt.alpha(theme.dark ? "black" : "#0c120f", theme.dark ? 0.65 : 0.55)
        readonly property color urgLow: c.urg_low
        readonly property color urgNormal: c.urg_normal
        readonly property color urgHigh: c.urg_high
        readonly property color urgCritical: c.urg_critical
        readonly property color stDecision: c.st_decision
        readonly property color stWorking: c.st_working
        readonly property color stDone: c.st_done

        // The one colour that drives a card: its urgency.
        function urg(name) {
            return name === "critical" ? urgCritical : name === "high" ? urgHigh : name === "low" ? urgLow : urgNormal
        }
        // color-mix(in srgb, a p, b)
        function mix(a, b, p) {
            return Qt.rgba(a.r * p + b.r * (1 - p), a.g * p + b.g * (1 - p), a.b * p + b.b * (1 - p), 1)
        }
        function cardBg(u) { return mix(urg(u), surface, 0.05) }
        function cardInk(u) { return mix(urg(u), fg, 0.70) }
        function cardLine(u) { return mix(urg(u), surface, 0.30) }
        function state(s) { return s === "decision" ? stDecision : s === "done" ? stDone : stWorking }
        // The ink a session's mark is drawn in: its own hue, readable on both themes.
        function ink(hue) { return theme.dark ? Qt.hsla(hue / 360, 0.70, 0.76, 1) : Qt.hsla(hue / 360, 0.62, 0.30, 1) }

        readonly property string sans: sansFont
        readonly property string mono: monoFont
        readonly property real scale: theme.textScale
        function px(n) { return Math.round(n * scale) }
        // Two radii: small for surfaces, round for buttons.
        readonly property int radius: px(6)
        readonly property bool narrow: win.width < px(760)
    }

    // The markdown's inline code and links take the theme's colours.
    function markup() {
        board.setMarkup(ui.mono, String(ui.mix(ui.accent, ui.surface, 0.12)), String(ui.accent))
    }
    Component.onCompleted: markup()
    Connections {
        target: theme
        function onChanged() { win.markup() }
    }

    onActiveChanged: board.active = win.active
    Connections {
        target: board
        function onOpenRequested(id) {
            win.show()
            win.raise()
            win.requestActivate()
            nav.openCard(id)
        }
    }

    Nav { id: nav }

    // ── keys ────────────────────────────────────────────────────────────
    // A key by the name the layout in Nav knows it under.
    function keyName(e) {
        const ctrl = e.modifiers & Qt.ControlModifier
        if (ctrl && e.key === Qt.Key_Q) return "ctrl+q"
        if (e.modifiers & (Qt.ControlModifier | Qt.AltModifier | Qt.MetaModifier)) return "" // no chords are taken
        switch (e.key) {
        case Qt.Key_Up: return "up"
        case Qt.Key_Down: return "down"
        case Qt.Key_Left: return "left"
        case Qt.Key_Right: return "right"
        case Qt.Key_Return: case Qt.Key_Enter: return "enter"
        case Qt.Key_Escape: return "esc"
        case Qt.Key_Backspace: return "backspace"
        case Qt.Key_PageUp: return "pgup"
        case Qt.Key_PageDown: return "pgdn"
        case Qt.Key_Home: return "home"
        case Qt.Key_End: return "end"
        case Qt.Key_Space: return "space"
        case Qt.Key_Tab: case Qt.Key_Backtab: return ""
        }
        return e.text.length === 1 ? e.text.toLowerCase() : ""
    }

    Item {
        id: keys
        anchors.fill: parent
        focus: true
        Keys.onPressed: e => {
            const k = win.keyName(e)
            if (!k) return
            // A key held down repeats only where that is harmless: moving, never an answer.
            if (e.isAutoRepeat && !nav.repeats(k)) { e.accepted = true; return }
            e.accepted = nav.key(k)
        }
    }
    // Whoever had the keys gives them back here.
    function takeKeys() { keys.forceActiveFocus() }

    Timer { // tests: keys to press once the window is up; "type:Text" writes into the field in focus
        running: testKeys !== ""
        interval: testKeysMs
        onTriggered: {
            for (const k of testKeys.split(" ")) {
                const it = win.activeFocusItem
                if (k.startsWith("type:")) nav.type(k.slice(5).replace(/_/g, " "))
                else if (k === "open") nav.openCard(nav.sel) // as a click on a row's text does
                else if (/^(pair|move):\d:\d$/.test(k)) { // as dropping the n-th session on, or in front of, the m-th
                    const part = k.split(":"), a = nav.units[Number(part[1]) - 1], b = nav.units[Number(part[2]) - 1]
                    if (a && b) part[0] === "pair" ? sidebar.pairUnits(a.id, b.id) : sidebar.moveUnit(a.id, b.id)
                }
                else if (it && it.testKey) it.testKey(k) // a field has the keys
                else nav.key(k)
            }
        }
    }

    // ── the layout ──────────────────────────────────────────────────────
    Connect {
        anchors.fill: parent
        visible: board.phase !== "ready"
    }

    Item {
        anchors.fill: parent
        visible: board.phase === "ready"

        Sidebar {
            id: sidebar
            visible: !ui.narrow
            width: visible ? ui.px(256) : 0
            anchors { left: parent.left; top: parent.top; bottom: parent.bottom }
        }

        // Narrow, as a tile often is: the places shrink to one line.
        Rectangle {
            id: placeBar
            visible: ui.narrow
            height: visible ? ui.px(44) : 0
            anchors { left: parent.left; right: parent.right; top: parent.top }
            color: ui.surface2
            Rectangle { anchors { left: parent.left; right: parent.right; bottom: parent.bottom } height: 1; color: ui.line }
            Row {
                anchors { left: parent.left; leftMargin: ui.px(14); verticalCenter: parent.verticalCenter }
                spacing: ui.px(8)
                Btn { quiet: true; icon: "tray"; label: "Inbox"; cap: board.freshCount > 0 ? String(board.freshCount) : ""; onPressed: nav.openInbox() }
                Btn { quiet: true; icon: "heads"; label: nav.view === "session" ? conversation.session.name || "Sessions" : "Sessions"; onPressed: nav.stepSession(1) }
            }
            Text {
                anchors { right: parent.right; rightMargin: ui.px(14); verticalCenter: parent.verticalCenter }
                text: board.online ? "? keys" : "Not connected"
                color: board.online ? ui.faint : ui.deny
                font { family: ui.sans; pixelSize: ui.px(12) }
            }
        }

        Item {
            id: stage
            anchors { left: sidebar.right; right: parent.right; top: placeBar.bottom; bottom: parent.bottom }

            Inbox { id: inbox; anchors.fill: parent; visible: nav.view === "inbox" }
            Conversation { id: conversation; anchors.fill: parent; visible: nav.view === "session" }

            // What just happened, and the way back: at the lower left, where it covers no title.
            Says { anchors { left: parent.left; bottom: parent.bottom; margins: ui.px(16) } shown: !nav.focusOpen }
        }

        FocusWindow { id: focusWindow; anchors.fill: parent; visible: nav.focusOpen }
    }

    // "g", then where to.
    Rectangle {
        visible: nav.pending !== ""
        anchors { horizontalCenter: parent.horizontalCenter; bottom: parent.bottom; bottomMargin: ui.px(20) }
        width: chip.implicitWidth + ui.px(28)
        height: ui.px(38)
        radius: ui.px(8)
        color: ui.fg
        Row {
            id: chip
            anchors.centerIn: parent
            spacing: ui.px(12)
            KeyCap { anchors.verticalCenter: parent.verticalCenter; text: "G"; ink: ui.bg }
            Repeater {
                model: nav.pending !== "" ? nav.following(nav.pending) : []
                Row {
                    required property var modelData
                    anchors.verticalCenter: parent.verticalCenter
                    spacing: ui.px(5)
                    KeyCap { anchors.verticalCenter: parent.verticalCenter; text: modelData[0]; ink: ui.bg }
                    Text { anchors.verticalCenter: parent.verticalCenter; text: modelData[1]; color: ui.bg; font { family: ui.sans; pixelSize: ui.px(12.5) } }
                }
            }
        }
    }

    HelpBox { anchors.fill: parent; visible: nav.help }
}
