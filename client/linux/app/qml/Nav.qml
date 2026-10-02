// Nav is where the human is (the inbox, a session, the question window)
// and what every key does there. The window's parts only draw what it
// holds (as brumm's Store.qml does for its player).
//
// The keys are those of the web client (client/web/js/keys.js, LAYOUT):
// plain keys and "g then x" only, nothing while typing but Escape, and a
// key held down repeats only a move, never an answer.
import QtQuick

Item {
    id: s
    visible: false

    property string view: "inbox"      // inbox | session
    property string unitId: ""         // the session or pair that is open, as the sidebar knows it
    property string agentId: ""        // the session whose conversation shows
    property bool questionsOnly: false // in a session: its open questions instead of the conversation
    property string sel: ""            // the row the keys are on; none until a key points at one
    property int selAt: 0              // where that row stands, so the mark keeps its place
    property string unfolded: ""       // the row whose choices stand open
    property int optAt: -1             // the option the keyboard is on (an unfolded row, the question window)
    property string pile: ""           // the pile at the foot that stands open: later, asked, answered
    property var picked: ({})          // card id -> the keys ticked, where several answers are allowed
    property bool help: false
    property string pending: ""        // the first key of a sequence: "g"
    property string error: ""          // why an answer was not taken …
    property string errorFor: ""       // … and on which card

    // The question window: one question per page.
    property bool focusOpen: false
    property bool walking: false       // through all of them; else the window of one card alone
    property string cardId: ""
    property var rail: []              // the ids of the walk, in its order
    property var walked: []            // of those, the ones answered in this walk
    property string info: ""           // one line in the window: what happened, or went wrong
    property bool infoBad: false

    // ── the layout: every key, as data; "?" lists it ────────────────────
    readonly property var layout: [
        { scope: "app", title: "Anywhere", keys: [
            [["?"], "this list"], [["P", "G P"], "the pad, in the browser"], [["G I"], "go to the inbox"],
            [["G F"], "Focus: every open question, one after the other"], [["G 1…9"], "go to that session of the sidebar"],
            [["."], "next session"], [[","], "previous session"], [["U", "⌫"], "back: take the last answer back"],
            [["T"], "light or dark"], [["Esc"], "leave a field"]] },
        { scope: "list", title: "A list of questions", keys: [
            [["J", "↓"], "next question"], [["K", "↑"], "previous question"], [["Home"], "first question"], [["End"], "last question"],
            [["←", "→"], "next option, where choices are open"], [["Y"], "yes: the thumb up"], [["N"], "no: the thumb down"],
            [["Enter"], "send, where several answers are allowed"], [["Enter", "C"], "open the choices, or the question as a window"],
            [["1…9"], "pick that option"], [["Space"], "pick the option in focus"], [["A"], "ask back instead of answering"],
            [["E"], "explain: show all of it, then ask the session to say more"], [["L"], "later, or fetch it back"],
            [["U", "⌫"], "on an answered row: take that answer back"], [["Esc"], "close the choices, then drop the mark"]] },
        { scope: "focus", title: "Focus: one question per page", keys: [
            [["→", "J"], "next question, without answering"], [["←", "K"], "previous question"], [["Y"], "yes: the thumb up"],
            [["N"], "no: the thumb down"], [["1…9"], "pick that option"], [["Enter"], "send, where several answers are allowed"],
            [["C"], "go to the options"], [["↑", "↓"], "next option, once the keyboard is on one"],
            [["A"], "write to the session about the question"], [["E"], "explain: ask the session to say more"],
            [["L"], "later: on to the next"], [["U", "⌫"], "back: take the last answer back"], [["Esc"], "leave a field, then close"]] },
        { scope: "session", title: "In a session", keys: [
            [["R"], "write to the session"], [["Q"], "questions only, and back"], [["O"], "the other session of a pair"]] },
        { scope: "writing", title: "While writing", keys: [[["Enter"], "send"], [["⇧", "Enter"], "new line"]] },
    ]
    // The scopes that listen now: the question window alone while it is up.
    readonly property var scopes: focusOpen ? ["focus", "writing"] : view === "session" ? (questionsOnly ? ["list", "session", "writing", "app"] : ["session", "writing", "app"]) : ["list", "app"]
    function following(prefix) {
        const out = [["I", "inbox"], ["F", "Focus"], ["P", "pad"], ["1…9", "session"]]
        return focusOpen ? [["P", "pad"]] : out
    }
    function repeats(k) { return ["j", "k", "up", "down", "left", "right"].indexOf(k) >= 0 }

    // ── what is where ───────────────────────────────────────────────────
    readonly property var units: board.sessions
    function unit(id) { return units.find(u => u.id === id) || null }
    function openPile() { return board.piles.find(p => p.kind === pile) || null }
    // The rows the keys can reach, top to bottom: a folded pile's rows are out of reach.
    function rows() {
        if (view === "session") return board.inbox.filter(r => !r.head && r.agent === agentId)
        const p = openPile()
        return board.inbox.filter(r => !r.head).concat(p ? p.rows : [])
    }
    function row(id) {
        const all = board.inbox
        for (let i = 0; i < all.length; i++) if (!all[i].head && all[i].id === id) return all[i]
        for (const p of board.piles) for (const r of p.rows) if (r.id === id) return r
        return null
    }
    function ticked(id) {
        if (picked[id] !== undefined) return picked[id]
        const c = board.card(id)
        return (c && c.draftKeys) || []
    }
    function tick(id, key) {
        const now = ticked(id).slice(), at = now.indexOf(key)
        if (at < 0) now.push(key); else now.splice(at, 1)
        const all = Object.assign({}, picked)
        all[id] = now
        picked = all
        board.saveDraft(id, now, "")
    }

    // ── moving about ────────────────────────────────────────────────────
    function openInbox() { view = "inbox"; win.takeKeys() }
    function openSession(id) {
        const u = unit(id)
        if (!u) return
        unitId = id
        agentId = u.members[0].id
        view = "session"
        questionsOnly = false
        sel = ""
        unfolded = ""
        win.takeKeys()
    }
    function stepSession(by) {
        if (!units.length) return
        const at = view === "session" ? units.findIndex(u => u.id === unitId) : (by > 0 ? -1 : 0)
        openSession(units[(at + by + units.length) % units.length].id)
    }
    function otherPane() {
        const u = unit(unitId)
        if (!u || u.members.length < 2) return false
        const at = u.members.findIndex(m => m.id === agentId)
        agentId = u.members[(at + 1) % u.members.length].id
        return true
    }
    function mark(id) {
        sel = id
        const at = rows().findIndex(r => r.id === id)
        if (at >= 0) selAt = at
    }
    function move(to) {
        const all = rows()
        if (!all.length) return
        const at = all.findIndex(r => r.id === sel)
        const next = to === "first" ? 0 : to === "last" ? all.length - 1 : at < 0 ? 0 : Math.max(0, Math.min(all.length - 1, at + to))
        if (all[next].id !== sel) { unfold(""); mark(all[next].id) }
    }
    function unfold(id) {
        unfolded = id
        optAt = -1
        if (!id) return
        // The keyboard goes to the option the agent would pick, else the first.
        const r = row(id)
        const advised = r ? r.options.findIndex(o => o.advised) : -1
        optAt = Math.max(0, advised)
    }
    function togglePile(kind) {
        pile = pile === kind ? "" : kind
        if (sel && !rows().some(r => r.id === sel)) sel = ""
    }

    // ── the question window ─────────────────────────────────────────────
    // One card alone (ask: with the field ready), or with no id the walk through all of them.
    function openCard(id, ask) {
        if (!id || !board.card(id).open) return
        walking = false
        cardId = id
        show(ask)
    }
    function walk() {
        if (!board.order.length) return
        walking = true
        rail = board.order.slice()
        walked = []
        cardId = sel && board.order.indexOf(sel) >= 0 ? sel : board.order[0]
        show(false)
    }
    function show(ask) {
        info = ""
        optAt = -1
        focusOpen = true
        win.takeKeys()
        if (ask) focusWindow.compose()
    }
    function closeFocus() {
        focusOpen = false
        optAt = unfolded ? optAt : -1
        win.takeKeys()
    }
    // To the next or the previous question, without answering.
    function go(by) {
        if (!walking) return
        const open = rail.filter(id => board.order.indexOf(id) >= 0)
        const at = open.indexOf(cardId)
        const next = open[at + by]
        if (next) { cardId = next; optAt = -1; info = "" }
    }
    function say(text, bad) { info = text; infoBad = !!bad; infoTimer.restart() }
    Timer { id: infoTimer; interval: 6000; onTriggered: s.info = "" }

    // ── answering ───────────────────────────────────────────────────────
    function decide(id, keys, note) {
        error = ""
        board.decide(id, keys, note || "")
    }
    // A tile of a row: a thumb answers, "Choose" unfolds the row or opens the window.
    function tile(id, t) {
        if (sel) mark(id)
        if (t.answer) return decide(id, [t.key])
        const r = row(id)
        if (r && r.window) openCard(id)
        else unfold(unfolded === id ? "" : id)
    }
    function option(id, key) {
        const r = row(id) || board.card(id)
        if (r && r.multiple) tick(id, key)
        else decide(id, [key], focusOpen ? focusWindow.note : "")
    }
    function sendPicked(id) {
        const keys = ticked(id)
        if (keys.length) decide(id, keys, focusOpen ? focusWindow.note : "")
    }
    function later(id) {
        const r = row(id)
        if (r && r.later) board.putBack(id)
        else board.later(id)
    }

    // After every change: the mark stays in its place, on the row that moved
    // up; an open question that left gives way to the next of the walk.
    function sync() {
        const all = rows()
        if (unfolded && !all.some(r => r.id === unfolded)) unfolded = ""
        if (sel && !all.some(r => r.id === sel)) {
            const next = all[Math.min(selAt, all.length - 1)]
            sel = next ? next.id : ""
        } else if (sel) selAt = all.findIndex(r => r.id === sel)
        if (pile && !openPile()) pile = ""
        if (view === "session" && !unit(unitId)) {
            // A pair that was split, or a session that left: stay with whoever is still there.
            const u = units.find(x => x.members.some(m => m.id === agentId))
            if (u) unitId = u.id; else view = "inbox"
        }
        if (!focusOpen) return
        const order = board.order
        for (const id of order) if (rail.indexOf(id) < 0) rail = rail.concat([id])
        if (order.indexOf(cardId) >= 0) return
        if (!walking) return closeFocus()
        // The next of the walk that is still open, else the one before, else it is done.
        const at = rail.indexOf(cardId)
        const next = rail.slice(at + 1).find(id => order.indexOf(id) >= 0) || rail.slice(0, Math.max(0, at)).reverse().find(id => order.indexOf(id) >= 0)
        if (next) { cardId = next; optAt = -1 }
        else closeFocus()
    }
    Connections {
        target: board
        function onChanged() { s.sync() }
        function onDecided(id) { if (s.focusOpen && s.walking) s.walked = s.walked.concat([id]) }
        function onFailed(id, message) {
            s.errorFor = id; s.error = message
            if (s.focusOpen) s.say(message, true)
        }
        function onReturned(id) { // back among the open ones: there it is again
            s.walked = s.walked.filter(x => x !== id)
            if (s.focusOpen && s.walking && board.order.indexOf(id) >= 0) s.cardId = id
            else if (s.sel || s.view === "inbox") { if (s.sel) s.mark(id) }
        }
        function onHanded(id) { if (s.focusOpen && s.walking) s.say("With the agent. It comes back with the reply.") }
    }

    // ── keys ────────────────────────────────────────────────────────────
    // Returns whether the key was taken.
    function key(k) {
        if (board.phase !== "ready") return false
        if (help) { if (k === "?" || k === "esc") help = false; return true }
        if (pending) {
            const first = pending
            pending = ""
            if (k !== "esc") sequence(first + " " + k)
            return true // the second key of a sequence never means anything else
        }
        if (k === "?") { help = true; return true }
        if (k === "ctrl+q") { Qt.quit(); return true }
        if (focusOpen) { // modal: below it only the pad
            if (focusKey(k)) return true
            if (k === "p") board.openPad()
            if (k === "g") startPending()
            return true
        }
        if ((view === "inbox" || questionsOnly) && listKey(k)) return true
        if (view === "session" && sessionKey(k)) return true
        return appKey(k)
    }
    function startPending() { pending = "g"; pendingTimer.restart() }
    Timer { id: pendingTimer; interval: 1600; onTriggered: s.pending = "" }

    function sequence(seq) {
        if (seq === "g p") return board.openPad()
        if (focusOpen) return
        if (seq === "g i") return openInbox()
        if (seq === "g f") return walk()
        const n = /^g ([1-9])$/.exec(seq)
        if (n && units[Number(n[1]) - 1]) openSession(units[Number(n[1]) - 1].id)
    }

    function appKey(k) {
        switch (k) {
        case "p": board.openPad(); return true
        case "g": startPending(); return true
        case ".": stepSession(1); return true
        case ",": stepSession(-1); return true
        case "u": case "backspace": board.backNow(); return true
        case "t": theme.toggle(); return true
        }
        return false
    }

    function listKey(k) {
        const all = rows()
        const r = sel ? all.find(x => x.id === sel) : null
        const open = !!r && unfolded === r.id
        switch (k) {
        case "j": case "down": move(1); return all.length > 0
        case "k": case "up": move(-1); return all.length > 0
        case "home": move("first"); return all.length > 0
        case "end": move("last"); return all.length > 0
        case "right": case "left":
            if (!open || !r.options.length) return false
            optAt = (optAt + (k === "right" ? 1 : -1) + r.options.length) % r.options.length
            return true
        case "esc":
            if (open) { unfold(""); return true }
            if (sel) { sel = ""; return true }
            return false
        case "u": case "backspace":
            if (r && r.done) { board.takeBack(r.id); return true }
            return false // the page's own "back"
        case "pgdn": inbox.scroll(1); return view === "inbox"
        case "pgup": inbox.scroll(-1); return view === "inbox"
        }
        if (/^[1-9]$/.test(k)) {
            if (!open || Number(k) > r.options.length) return false
            option(r.id, r.options[Number(k) - 1].key)
            return true
        }
        if (["y", "n", "l", "c", "enter", "a", "e", "space"].indexOf(k) < 0 || !all.length) return false
        // A letter acts on the marked row. With none marked it marks one and does
        // nothing else: nothing is answered that was not pointed at first.
        if (!r) { mark(all[0].id); return true }
        if (r.done) return true // nothing to open; its key is "take back"
        switch (k) {
        case "y": case "n": {
            if (!r.quick || r.tiles.length < 2) return true
            decide(r.id, [r.tiles[k === "y" ? 1 : 0].key]) // thumb down on the left, up on the right
            return true
        }
        case "l": later(r.id); return true
        case "space":
            if (open && optAt >= 0) option(r.id, r.options[optAt].key)
            return true
        case "enter":
            // Several answers allowed: Enter sends what is ticked, and never toggles the option in focus.
            if (open && r.multiple) { sendPicked(r.id); return true }
            if (open && optAt >= 0) { option(r.id, r.options[optAt].key); return true }
            tile(r.id, { answer: false }); return true
        case "c":
            if (r.quick) openCard(r.id); else tile(r.id, { answer: false })
            return true
        case "a": // ask back: the line under the choices; a row without choices opens as a window, with the field ready
            if (r.quick || r.window) { openCard(r.id, true); return true }
            if (!open) unfold(r.id)
            inbox.askBack(r.id)
            return true
        case "e": // explain: first everything the card holds, then the question to the session
            if (r.permission) return true
            if (r.quick || r.window) { openCard(r.id); return true }
            if (!open) { unfold(r.id); return true }
            board.explain(r.id)
            return true
        }
        return false
    }

    function focusKey(k) {
        const c = focusWindow.card
        const options = c.options || []
        if (/^[1-9]$/.test(k)) {
            if (Number(k) <= options.length) option(cardId, options[Number(k) - 1].key)
            return true
        }
        switch (k) {
        case "esc": closeFocus(); return true
        case "right": case "j": go(1); return true
        case "left": case "k": go(-1); return true
        case "y": if (c.yes) decide(cardId, [c.yes], focusWindow.note); return true
        case "n": if (c.no) decide(cardId, [c.no], focusWindow.note); return true
        case "enter":
            if (c.multiple) sendPicked(cardId)
            else if (optAt >= 0 && options[optAt]) option(cardId, options[optAt].key)
            return true
        case "space":
            if (optAt >= 0 && options[optAt]) option(cardId, options[optAt].key)
            else focusWindow.scroll(6)
            return true
        case "c": if (options.length) optAt = Math.max(0, options.findIndex(o => o.advised)); return true
        case "down": case "up":
            if (optAt >= 0 && options.length) optAt = (optAt + (k === "down" ? 1 : -1) + options.length) % options.length
            else focusWindow.scroll(k === "down" ? 1 : -1)
            return true
        case "a": focusWindow.compose(); return true
        case "v": say("Dictation is not in this client yet. It is on the web and on the phone."); return true
        case "e": focusWindow.explain(); return true
        case "l": focusLater(); return true
        case "u": case "backspace": if (!board.backNow()) say("Nothing to take back."); return true
        }
        return false
    }
    // Later in the window: this one goes to the end, the next comes up.
    function focusLater() {
        const open = rail.filter(id => board.order.indexOf(id) >= 0)
        const next = open[open.indexOf(cardId) + 1] || ""
        const id = cardId
        if (row(id) && row(id).later) { go(1); return } // already put off: only on to the next
        board.later(id)
        if (!walking) return closeFocus()
        if (next && next !== id) { cardId = next; optAt = -1 } else closeFocus()
    }

    function sessionKey(k) {
        switch (k) {
        case "r": conversation.compose(); return true
        case "q": questionsOnly = !questionsOnly; sel = ""; unfolded = ""; return true
        case "o": return otherPane()
        case "v": conversation.say("Dictation is not in this client yet. It is on the web and on the phone."); return true
        case "f": conversation.say("Files are shown in the web client only, for now."); return true
        case "down": conversation.scroll(1); return true
        case "up": conversation.scroll(-1); return true
        case "space": case "pgdn": conversation.scroll(6); return true
        case "pgup": conversation.scroll(-6); return true
        case "home": conversation.scroll(-99999); return true
        case "end": conversation.scroll(99999); return true
        }
        return false
    }

    // Tests: text into the field that has the keys.
    function type(text) {
        const it = win.activeFocusItem
        if (it && it.insert) it.insert(it.cursorPosition, text)
    }
}
