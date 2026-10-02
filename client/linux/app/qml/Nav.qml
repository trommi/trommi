// Nav is where the human is — the inbox, a card, a session — and what
// every key does there. The window's parts only draw what it holds (as
// brumm's Store.qml does for its player).
import QtQuick

Item {
    id: s
    visible: false

    property string view: "inbox"      // inbox | card | session
    property string sel: ""            // the card the keys are on, in the inbox
    property string cardId: ""         // the card that is open
    property string cardFrom: "inbox"  // where escape leaves a card to
    property string agentId: ""        // the session that is open
    property bool help: false
    property string error: ""          // why an answer was not taken …
    property string errorFor: ""       // … and on which card

    readonly property var places: ["inbox"].concat(board.sessions.map(a => a.id))
    readonly property string place: view === "session" || (view === "card" && cardFrom === "session") ? agentId : "inbox"

    // ── moving about ────────────────────────────────────────────────────
    function openInbox() { view = "inbox"; win.takeKeys(); sync() }
    function openSession(id) {
        if (!id) return
        agentId = id
        view = "session"
        win.takeKeys()
    }
    function openCard(id) {
        if (!id || board.order.indexOf(id) < 0) return
        if (view !== "card") cardFrom = view
        cardId = id
        sel = id
        view = "card"
        win.takeKeys()
    }
    function closeCard() {
        view = cardFrom === "session" && agentId ? "session" : "inbox"
        win.takeKeys()
    }
    function go(place) { place === "inbox" ? openInbox() : openSession(place) }
    function step(by) {
        const at = Math.max(0, places.indexOf(place))
        go(places[(at + by + places.length) % places.length])
    }
    function move(by) {
        const order = board.order
        if (!order.length) return
        const at = order.indexOf(sel)
        sel = order[Math.max(0, Math.min(order.length - 1, at < 0 ? 0 : at + by))]
    }
    function row(id) {
        const rows = board.inbox
        for (let i = 0; i < rows.length; i++) if (rows[i].id === id) return rows[i]
        return null
    }

    // ── answering ───────────────────────────────────────────────────────
    function decide(id, key, note) {
        error = ""
        board.decide(id, key, note || "")
    }
    // A tile of a row: an answer, "Later" or "Choose".
    function tile(id, t) {
        sel = id
        if (t.answer) decide(id, t.key)
        else if (t.key === "later") board.later(id)
        else if (t.key === "back") board.putBack(id)
        else openCard(id)
    }
    function answer(id, yes) {
        const r = row(id)
        if (!r || !r.quick || r.tiles.length < 2) return
        tile(id, r.tiles[yes ? 1 : 0]) // no on the left, yes on the right
    }

    // After every change: the keys stay on a card that is still there, and
    // an open card that was answered gives way to the next.
    function sync() {
        const order = board.order
        if (order.indexOf(sel) < 0) sel = board.nextAfter(sel) || (order.length ? order[0] : "")
        if (view === "card" && order.indexOf(cardId) < 0) {
            const next = board.nextAfter(cardId)
            if (next) { cardId = next; sel = next }
            else closeCard()
        }
        if (view === "session" && !board.sessions.some(a => a.id === agentId)) view = "inbox"
    }
    Connections {
        target: board
        function onChanged() { s.sync() }
        function onFailed(id, message) { s.errorFor = id; s.error = message }
        function onReopened(id) { // taken back: there it is again
            s.sel = id
            if (s.view === "card") s.cardId = id
        }
    }

    // ── keys ────────────────────────────────────────────────────────────
    // Returns whether the key was taken.
    function key(k) {
        if (board.phase !== "ready") return false
        if (help) { help = false; return true }
        switch (k) {
        case "?": help = true; return true
        case "ctrl+q": Qt.quit(); return true
        case "tab": step(1); return true
        case "shift+tab": step(-1); return true
        case "i": openInbox(); return true
        case "u": if (board.undo.id) board.undoLast(); return true
        case "r": board.retry(); return true
        }
        if (view === "inbox") return inboxKey(k)
        if (view === "card") return cardKey(k)
        return sessionKey(k)
    }

    function inboxKey(k) {
        switch (k) {
        case "j": case "down": move(1); return true
        case "k": case "up": move(-1); return true
        case "g": case "home": move(-9999); return true
        case "G": case "end": move(9999); return true
        case "enter": case "o": case "m": openCard(sel); return true
        case "f": openCard(board.order.length ? board.order[0] : ""); return true
        case "y": answer(sel, true); return true
        case "n": answer(sel, false); return true
        case "s": { // put off, or fetch back what was put off
            const r = row(sel)
            if (r) r.later ? board.putBack(sel) : board.later(sel)
            return true
        }
        }
        return false
    }

    function cardKey(k) {
        const order = board.order, at = order.indexOf(cardId)
        if (/^[1-9]$/.test(k)) {
            const options = cardView.card.options || []
            if (Number(k) <= options.length) decide(cardId, options[Number(k) - 1].key, cardView.note)
            return true
        }
        switch (k) {
        case "esc": closeCard(); return true
        case "y": if (cardView.card.yes) decide(cardId, cardView.card.yes, cardView.note); return true
        case "n": if (cardView.card.no) decide(cardId, cardView.card.no, cardView.note); return true
        case "a": cardView.editNote(); return true
        case "j": case "right": if (at >= 0 && at < order.length - 1) openCard(order[at + 1]); return true
        case "k": case "left": if (at > 0) openCard(order[at - 1]); return true
        case "s": { // put off: on to the next, this one goes to the end
            const next = at >= 0 && at < order.length - 1 ? order[at + 1] : ""
            board.later(cardId)
            if (next) openCard(next)
            return true
        }
        case "down": cardView.scroll(1); return true
        case "up": cardView.scroll(-1); return true
        case "space": case "pgdn": cardView.scroll(6); return true
        case "pgup": cardView.scroll(-6); return true
        }
        return false
    }

    function sessionKey(k) {
        switch (k) {
        case "esc": openInbox(); return true
        case "c": case "enter": conversation.compose(); return true
        case "j": case "down": conversation.scroll(1); return true
        case "k": case "up": conversation.scroll(-1); return true
        case "space": case "pgdn": conversation.scroll(6); return true
        case "pgup": conversation.scroll(-6); return true
        case "g": case "home": conversation.scroll(-99999); return true
        case "G": case "end": conversation.scroll(99999); return true
        case "o": { // this session's most urgent question
            const r = board.inbox.find(x => !x.head && x.agent === agentId)
            if (r) openCard(r.id)
            return true
        }
        }
        return false
    }

    // Tests: text into the field that has the keys.
    function type(text) {
        const it = win.activeFocusItem
        if (it && it.insert) it.insert(it.cursorPosition, text)
    }
}
