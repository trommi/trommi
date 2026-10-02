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
    function keyName(e) {
        const shift = e.modifiers & Qt.ShiftModifier, ctrl = e.modifiers & Qt.ControlModifier
        switch (e.key) {
        case Qt.Key_Up: return "up"
        case Qt.Key_Down: return "down"
        case Qt.Key_Left: return "left"
        case Qt.Key_Right: return "right"
        case Qt.Key_Tab: return shift ? "shift+tab" : "tab"
        case Qt.Key_Backtab: return "shift+tab"
        case Qt.Key_Return: case Qt.Key_Enter: return "enter"
        case Qt.Key_Escape: return "esc"
        case Qt.Key_PageUp: return "pgup"
        case Qt.Key_PageDown: return "pgdn"
        case Qt.Key_Home: return "home"
        case Qt.Key_End: return "end"
        case Qt.Key_Space: return "space"
        }
        if (ctrl && e.key >= Qt.Key_A && e.key <= Qt.Key_Z)
            return "ctrl+" + String.fromCharCode(e.key).toLowerCase()
        return e.text
    }

    Item {
        id: keys
        anchors.fill: parent
        focus: true
        Keys.onPressed: e => {
            const k = win.keyName(e)
            if (!k) return
            e.accepted = nav.key(k)
        }
    }
    // Whoever had the keys gives them back here.
    function takeKeys() { keys.forceActiveFocus() }

    Timer { // tests: keys to press once the window is up; "type:Text" writes into the field in focus
        running: testKeys !== ""
        interval: 600
        onTriggered: {
            for (const k of testKeys.split(" ")) {
                const it = win.activeFocusItem
                if (k.startsWith("type:")) nav.type(k.slice(5).replace(/_/g, " "))
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
            width: visible ? ui.px(232) : 0
            anchors { left: parent.left; top: parent.top; bottom: parent.bottom }
        }

        // Narrow, as a tile often is: the places shrink to one line.
        PlaceBar {
            id: placeBar
            visible: ui.narrow
            height: visible ? ui.px(40) : 0
            anchors { left: parent.left; right: parent.right; top: parent.top }
        }

        Item {
            id: stage
            anchors { left: sidebar.right; right: parent.right; top: placeBar.bottom; bottom: undoBar.top }

            Inbox { id: inbox; anchors.fill: parent; visible: nav.view === "inbox" }
            CardView { id: cardView; anchors.fill: parent; visible: nav.view === "card" }
            Conversation { id: conversation; anchors.fill: parent; visible: nav.view === "session" }
        }

        UndoBar {
            id: undoBar
            anchors { left: sidebar.right; right: parent.right; bottom: parent.bottom }
        }
    }

    HelpBox { anchors.fill: parent; visible: nav.help }
}
