// The one table that says what the keys of the server-rendered board do. Read by the controller that listens
// (t/controllers/keys_controller.js) and by the hub for the "?" sheet (server/views/keys.mjs), so what the sheet
// lists and what works cannot drift apart. Plain data and two helpers: nothing here touches a page.

/** scope: where the keys count ('desk' | 'card' | 'picture' | 'agents' | 'app'). keys: 'j', 'ArrowDown', 'g d' (g, then d),
 *  '1…9' (any of them; the action gets the number), 'Mod+k'. repeat: may fire while held. typing: also in a field.
 *  needs: listed and taken only where the page has it ('sidebar': the sessions' list; 'desks': the menu's desks,
 *  and not on the Agents page, where D is a line's drawing). native: listed, handled where it lives (the key is left alone). verb: the longer wording for the sheet. */
export const LAYOUT = [
  { scope: 'desk', title: 'On the Desk', keys: [
    { id: 'list.next', keys: ['j', 'ArrowDown'], does: 'next question; after the last, an opened stack below', repeat: true },
    { id: 'list.prev', keys: ['k', 'ArrowUp'], does: 'previous question', repeat: true },
    { id: 'list.first', keys: ['Home'], does: 'first question' },
    { id: 'list.last', keys: ['End'], does: 'last question' },
    { id: 'list.open', keys: ['Enter', 'c'], does: 'open the question on its own page' },
    { id: 'list.later', keys: ['l'], does: 'Snooze; on a snoozed one: fetch it back' },
    { id: 'list.revise', keys: ['b'], does: 'Revise: back to the agent' },
    { id: 'list.trust', keys: ['r'], does: 'Whatever: the agent decides' },
    { id: 'list.shred', keys: ['x'], does: 'Shred: throw it away unanswered' },
    { id: 'list.takeback', keys: ['u', 'Backspace'], does: 'take back: the marked line of a stack, else the newest toast\'s Undo' },
    { id: 'pad.cards', keys: ['w'], does: 'hide the cards so only the paper is left, and bring them back' },
    { id: 'list.leave', keys: ['Escape'], does: 'drop the mark' },
  ] },
  { scope: 'card', title: 'An opened question', keys: [
    { id: 'card.send', keys: ['Enter'], does: 'send, where several answers are allowed' },
    { id: 'card.later', keys: ['l', 's'], does: 'Snooze' },
    { id: 'card.trust', keys: ['r'], does: 'Whatever: the agent decides' },
    { id: 'card.revise', keys: ['b'], does: 'Revise: say what should change; Enter hands it back' },
    { id: 'card.what', keys: ['e'], does: 'What??: ask the agent to explain' },
    { id: 'card.shred', keys: ['x'], does: 'Shred: throw it away unanswered' },
    { id: 'card.write', keys: ['a'], does: 'write to the agent about the question' },
    { id: 'card.back', keys: ['u', 'Backspace'], does: 'undo: the newest toast\'s Undo, else this answer or the hand-back' },
    { id: 'card.next', keys: ['j', 'ArrowRight'], does: 'next question, without answering', repeat: true },
    { id: 'card.prev', keys: ['k', 'ArrowLeft'], does: 'previous question', repeat: true },
    { id: 'card.pic.next', keys: ['Shift+ArrowRight'], does: 'next picture', repeat: true },
    { id: 'card.pic.prev', keys: ['Shift+ArrowLeft'], does: 'previous picture', repeat: true },
    { id: 'card.leave', keys: ['Escape'], does: 'leave a field, then back to the Desk', typing: true },
  ] },
  { scope: 'picture', title: 'A picture', keys: [
    { id: 'pic.next', keys: ['ArrowRight', 'j'], does: 'next picture', repeat: true },
    { id: 'pic.prev', keys: ['ArrowLeft', 'k'], does: 'previous picture', repeat: true },
    { id: 'pic.leave', keys: ['Escape'], does: 'back to the question' },
  ] },
  { scope: 'agents', title: 'On the Agents page', keys: [
    { id: 'ledger.next', keys: ['ArrowDown', 'j'], does: 'next session', repeat: true },
    { id: 'ledger.prev', keys: ['ArrowUp', 'k'], does: 'previous session', repeat: true },
    { id: 'ledger.open', keys: ['Enter'], does: 'open its conversation' },
    { id: 'ledger.walk', keys: ['q'], does: 'its questions, one after the other' },
    { id: 'ledger.rename', keys: ['r'], does: 'rename' },
    { id: 'ledger.mark', keys: ['d'], does: 'another drawing' },
    { id: 'ledger.crown', keys: ['c'], does: 'crown: its questions come first' },
    { id: 'ledger.pair', keys: ['+'], does: 'lay together with another' },
    { id: 'ledger.archive', keys: ['a'], does: 'archive a disconnected one; fetch an archived one back' },
    { id: 'ledger.down', keys: ['Shift+ArrowDown'], does: 'move it down' },
    { id: 'ledger.up', keys: ['Shift+ArrowUp'], does: 'move it up' },
    { id: 'ledger.find', keys: ['/'], does: 'find a session', native: true },
    { id: 'ledger.leave', keys: ['Escape'], does: 'close what is open, then drop the mark' },
  ] },
  { scope: 'app', title: 'Anywhere', keys: [
    { id: 'help', keys: ['?'], does: 'this list' },
    { id: 'memo.new', keys: ['n'], does: 'a new note (memo)' },
    { id: 'go.desk', keys: ['g d', 'g i'], does: 'Desk', verb: 'go to the Desk' },
    { id: 'go.agents', keys: ['g a'], does: 'Agents', verb: 'go to the Agents page' },
    { id: 'go.jump', keys: ['Mod+k', 'g j'], does: 'menu', verb: 'open the Trommi menu: desks and places' },
    { id: 'go.walk', keys: ['g f'], does: 'Next, please', verb: 'Next, please: every open question, one after the other' },
    // 1…9 alone are the desks'; G then 1…9 are the sessions'.
    { id: 'go.session', keys: ['g 1…9'], does: 'session 1 to 9', verb: 'go to that session of the sidebar', needs: 'sidebar' },
    { id: 'desk.switch', keys: ['1…9'], does: 'desk 1 to 9', verb: 'switch to that desk', needs: 'desks' },
    { id: 'session.next', keys: ['.'], does: 'next session', needs: 'sidebar' },
    { id: 'session.prev', keys: [','], does: 'previous session', needs: 'sidebar' },
    { id: 'pen', keys: ['p'], does: 'the pen: draw on the paper' },
    { id: 'rail', keys: ['['], does: 'fold the sidebar to a rail, or open it', needs: 'sidebar' },
    { id: 'back', keys: ['u', 'Backspace'], does: 'undo: the newest toast\'s Undo' },
    { id: 'theme', keys: ['t'], does: 'light or dark' },
    { id: 'field.leave', keys: ['Escape'], does: 'leave a field', typing: true },
  ] },
]

/** The scopes that listen on a view, first to hear first. */
/** The short list (card Nr. 200): the keys the "?" sheet and the help page show. Everything else in LAYOUT still
 *  works, but is not listed yet ("More keys later"). */
export const SHORT = [
  { id: 'move', keys: ['ArrowUp', 'ArrowDown'], does: 'move: the next or the previous question (on a card: ← →)' },
  { id: 'open', keys: ['Enter'], does: 'open' },
  { id: 'back', keys: ['Escape'], does: 'back: leave a field, close, back to the Desk' },
  { id: 'memo.new', keys: ['n'], does: 'a new note (memo)' },
  { id: 'later', keys: ['l'], does: 'later (snooze)' },
  { id: 'help', keys: ['?'], does: 'this list' },
]

export const scopesOf = view => (['desk', 'card', 'picture', 'agents'].includes(view) ? [view, 'app'] : ['app'])

const NAMES = { ArrowUp: '↑', ArrowDown: '↓', ArrowLeft: '←', ArrowRight: '→', Escape: 'Esc', ' ': 'Space', Delete: 'Del', Backspace: '⌫' }
/** One part of a key ('Shift+ArrowUp', 'g', 'Mod+k') as the caps it is printed on. mod: what "Mod" is on this machine. */
export const capOf = (part, mod = 'Ctrl') => part.split('+').map(p => (p === 'Mod' ? mod : p === 'Shift' ? '⇧' : NAMES[p] ?? (p.length === 1 ? p.toUpperCase() : p)))
