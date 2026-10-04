// The interface between an agent and the board, as one document.
//   node dev/interface-doc.mjs           write docs/interface.md and the data block of client/web/designs/interface.html
//   node dev/interface-doc.mjs --check   only compare with the live definitions; exit 1 when a parameter or an event
//                                        has no note here, or a note names something that no longer exists
//
// The tools, their parameters and the channel events are read from server/server.mjs itself (the block from
// SECTION_TEXT_EXAMPLE to CHANNEL_EVENTS is evaluated; the server is not started). What only a reader of the code
// can know stands in this file: where a field is stored, where the web client shows it, and whether it is used.
// Change those notes here, never in the two outputs.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { HTML_MAX } from '../hub/richhtml.mjs'
import { ASSET_TYPES } from '../server/asset-envelope.mjs'

const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const SERVER = path.join(ROOT, 'server', 'server.mjs')
const DOC = path.join(ROOT, 'docs', 'interface.md')
const PAGE = path.join(ROOT, 'client', 'web', 'designs', 'interface.html')

// ---- the live definitions ---------------------------------------------------

function live() {
  const src = fs.readFileSync(SERVER, 'utf8')
  const from = src.indexOf('const SECTION_TEXT_EXAMPLE')
  const to = src.indexOf('const text = t =>')
  if (from < 0 || to < from) throw new Error('server.mjs no longer has the block from SECTION_TEXT_EXAMPLE to CHANNEL_EVENTS')
  const list = name => JSON.parse(new RegExp(`const ${name} = (\\[[^\\]]*\\])`).exec(src)[1].replace(/'/g, '"'))
  const instructions = /instructions: \[([\s\S]*?)\]\.join\(' '\)/.exec(src)?.[1].split('\n').filter(l => l.trim().startsWith("'")).length ?? 0
  const run = new Function('URGENCIES', 'STATUSES', 'HTML_MAX', 'ASSET_TYPES', 'RETENTION_DAYS',
    `${src.slice(from, to)}\nreturn { TOOLS, TOOL_EXAMPLES, CHANNEL_EVENTS, QUESTION_PROPS }`)
  return { ...run(list('URGENCIES'), list('STATUSES'), HTML_MAX, ASSET_TYPES, 30), instructions }
}

const typeOf = p => {
  if (!p) return ''
  if (p.enum) return p.enum.join(' / ')
  if (p.anyOf) return [...new Set(p.anyOf.map(typeOf))].join(' or ')
  if (p.type === 'array') return `list of ${typeOf(p.items) || 'values'}`
  return p.type ?? ''
}
const gist = says => {
  const line = String(says ?? '').replace(/\s+/g, ' ').trim()
  const end = line.search(/[.:;](\s|$)/)
  const first = end > 20 ? line.slice(0, end) : line
  return first.length > 150 ? `${first.slice(0, 147)}…` : first
}
/** Every parameter of a schema, nested ones as "options[].key". */
function paramsOf(schema) {
  const out = []
  const required = new Set(schema.required ?? [])
  for (const [name, p] of Object.entries(schema.properties ?? {})) {
    out.push({ name, type: typeOf(p), required: required.has(name), says: gist(p.description) })
    const item = p.type === 'array' ? [p.items, ...(p.items?.anyOf ?? [])].find(i => i?.type === 'object') : null
    for (const [sub, q] of Object.entries(item?.properties ?? {})) {
      out.push({ name: `${name}[].${sub}`, type: typeOf(q), required: (item.required ?? []).includes(sub), says: gist(q.description) })
    }
  }
  return out
}

// ---- what the code says about each parameter --------------------------------
// key: "<tool>.<parameter>", or "q.<parameter>" for the fields create_decision, revise_card, merge_cards (and create_info) share.
// value: [stored as, shown where, status]. status: used | not shown | planned.

const USED = 'used', QUIET = 'not shown', PLAN = 'planned'
const PARAM = {
  'reply.text': ['`message.text` (fenced blocks cleaned)', 'conversation; the question card\'s thread when `card_id` is set; read aloud', USED],
  'reply.html': ['`message.html` (cleaned by `richhtml.mjs`)', 'conversation, in a sandboxed frame under the words', USED],
  'reply.details': ['`message.details`', 'conversation, collapsed under "Details"; question card thread', USED],
  'reply.attachments': ['`message.attachments[]`; each file copied to `data/files/`', 'conversation: gallery, player or download', USED],
  'reply.attachments[].path': ['`attachment.name`, `url`, `kind`, `image`, `size`', 'conversation', USED],
  'reply.attachments[].page': ['`attachment.page {url, kind}`; an HTML file is copied to `data/files/`', 'nowhere: no web client reads `page`', QUIET],
  'reply.attachments[].title': ['`attachment.title`', 'nowhere: captions show the file name', QUIET],
  'reply.card_id': ['`message.card_id`; clears `card.with_agent`', 'question card: the thread under the question', USED],

  'q.title': ['`card.title`', 'inbox row, question card, conversation marker', USED],
  'q.body': ['`card.body`', 'question card; inbox row (shortened)', USED],
  'q.html': ['`card.html`', 'question card, in a sandboxed frame; the inbox row only names it ("a table")', USED],
  'q.options': ['`card.options[]`', 'inbox row (two short options answer there), question card', USED],
  'q.options[].key': ['`options[].key`; comes back as `choice` / `choices`', 'nowhere by design: it is the machine name', USED],
  'q.options[].label': ['`options[].label`', 'inbox row, question card, the "Answered" marker', USED],
  'q.options[].detail': ['`options[].detail`', 'inbox row, question card; read aloud', USED],
  'q.sections': ['`card.sections[]`; `body`, `options`, `recommended` are derived from it', 'question card: each paragraph tied to its option', USED],
  'q.sections[].text': ['`sections[].text`', 'question card', USED],
  'q.sections[].key': ['`sections[].key` and `options[].key`', 'nowhere by design', USED],
  'q.sections[].label': ['`sections[].label` and `options[].label`', 'question card, inbox row', USED],
  'q.sections[].html': ['`sections[].html`', 'question card, under its paragraph', USED],
  'q.sections[].recommended': ['`sections[].recommended`, mirrored in `card.recommended`', 'question card, inbox row: the marker on the advice', USED],
  'q.sections[].picture': ['`sections[].picture` (always stored as an index into `attachments`)', 'question card: the picture shown with its option', USED],
  'q.text': ['parsed into `card.sections`; the string itself is not kept', 'question card', USED],
  'q.attachments': ['`card.attachments[]`; files copied to `data/files/`', 'question card: gallery; inbox row: a count ("2 pictures"). A file named `<x>-<key>.png` is shown with that option', USED],
  'q.attachments[].path': ['`attachment.name`, `url`, `kind`, `image`, `size`', 'question card', USED],
  'q.attachments[].page': ['`attachment.page {url, kind}`', 'nowhere: no web client reads `page`', QUIET],
  'q.attachments[].title': ['`attachment.title`', 'nowhere: captions show the file name', QUIET],
  'q.urgency': ['`card.urgency`; decides the place in `state.queue`', 'inbox row and question card (colour, corner tab); conversation marker on a change', USED],
  'q.urgency_reason': ['`card.urgency_reason`', 'inbox row byline, question card; read aloud', USED],
  'q.multiple': ['`card.multiple`', 'inbox row and question card: tick boxes instead of one tap', USED],
  'q.recommended': ['`card.recommended` (a key, a list, or null)', 'inbox row, question card: the marker on the advice; it is what Trust takes', USED],

  'revise_card.card_id': ['finds the card; nothing stored', 'nowhere', USED],
  'revise_card.note': ['`card.revision_note`, the text of the `revised` marker, `versions[].note`', 'conversation marker; question card: version bar and thread', USED],
  'merge_cards.card_ids': ['new card: `merged_from [{id, number, title}]`; old cards: `status: done`, `merged_into`, `summary`', 'inbox row byline "replaces N questions"; conversation markers. `merged_into` is not read', USED],
  'set_urgency.card_id': ['finds the card', 'nowhere', USED],
  'set_urgency.urgency': ['`card.urgency`', 'inbox row, question card, conversation marker', USED],
  'set_urgency.reason': ['`card.urgency_reason`, the text of the `urgency` marker', 'inbox row byline, question card, conversation marker', USED],
  'withdraw_card.card_id': ['`card.status: done`', 'the card leaves the inbox', USED],
  'withdraw_card.reason': ['`card.summary`, the text of the `done` marker ("Withdrawn: …")', 'conversation marker; history ("Result")', USED],
  'close_card.card_id': ['`card.status: done`', 'the card moves from answered to done', USED],
  'close_card.summary': ['`card.summary`, the text of the `done` marker', 'conversation marker; history ("Result")', USED],
  'set_status.id': ['`task.id` (one line per agent and id)', 'nowhere: it is the key of the line', USED],
  'set_status.label': ['`task.label`', 'sessions list and sessions table: a pill per line', USED],
  'set_status.state': ['`task.state`', 'the pill\'s colour; a working line marks the session as running', USED],
  'set_status.detail': ['`task.detail`', 'the pill: "label: detail"', USED],
  'set_status.card_id': ['`task.card_id`; the hub turns the line to `working` when that card is answered', 'nowhere: no client links the line to its card', QUIET],
  'clear_status.id': ['removes `task`', 'the pill disappears', USED],
  'introduce.model': ['`agent.model` (200 characters)', 'sessions table ("Model"), session header', USED],
  'introduce.task': ['`agent.task` (200 characters)', 'sessions list and table, session header', USED],
  'introduce.icon': ['`agent.icon = "draw:<name>"`, `agent.icon_by = "agent"`; refused if the name is unknown, kept out if the human chose one', 'everywhere the session has its mark. `icon_by` is not read', USED],
  'create_voiceover.text': ['an MP3 in `data/speech/<hash>.mp3`; the path is the result', 'nowhere, until the agent attaches the file', USED],
  'create_voiceover.style': ['passed to the speech service as `instructions`', 'nowhere', USED],
  'publish_asset.path': ['encrypted beside the agent; ciphertext in `data/assets/<id>`', 'the asset viewer `/a/<id>#<key>`', USED],
  'publish_asset.content': ['the same, from a string', 'the asset viewer', USED],
  'publish_asset.type': ['inside the envelope; `asset.type` and `message.asset.type` unless silent', 'conversation: the label on the asset card', USED],
  'publish_asset.title': ['inside the envelope; `asset.title`, `message.asset.title` unless silent', 'conversation, question card (links), history, the viewer', USED],
  'publish_asset.note': ['`message.asset.note` and a line of `message.text`', 'conversation: the line under the title', USED],
  'publish_asset.silent': ['`asset.silent`; type, title, note and key never reach the hub', 'nowhere by design', USED],
  'publish_asset.keep': ['`asset.keep`: exempt from the 30-day cleanup', 'nowhere', USED],
  'revoke_asset.id': ['deletes blob and record; the message keeps only the title (`asset.gone`)', 'conversation: "no longer available"', USED],
}
// Tools that share the question fields, and which of them an info takes.
const SHARED = ['create_decision', 'revise_card', 'merge_cards', 'create_info']
const noteFor = (tool, name) => PARAM[`${tool}.${name}`] ?? (SHARED.includes(tool) ? PARAM[`q.${name}`] : null)

const TOOL_NOTE = {
  reply: 'A chat message. Result: `sent`, plus what the cleaner removed from HTML and which picture found its page.',
  create_decision: 'A question card (`kind: decision`). Result: the card id, its number and place in the stack, and reminders (too long, too many open questions, a question about looks without a picture).',
  create_info: 'A card to read (`kind: info`), no options. The human closes it; the agent hears `info_read`.',
  revise_card: 'Rewrites an open card in place; a change of wording is a new version. Works on questions and infos (the description says "decision cards").',
  merge_cards: 'Replaces two or more open questions by one new card. Infos and approvals are refused.',
  set_urgency: 'Moves an open card in the stack. Also works on an info.',
  withdraw_card: 'Takes an open card off the stack. Also works on an info.',
  close_card: 'Marks a card done. The hub does not check the status: it also closes a card that is still open.',
  set_status: 'One status line per work stream. `label` is required for a new line although the schema does not say so.',
  clear_status: 'Removes one line, or all of this session\'s lines.',
  introduce: 'Model, task and symbol of the session.',
  create_voiceover: 'Text to an MP3 through the speech service. Returns the path on the hub\'s machine.',
  list_cards: 'No parameters. Returns JSON: per card `id`, `number`, `kind`, `status`, `urgency`, `urgency_reason`, `queue_position`, `title`, `version`, `multiple`, `choice`, `choices`, `note`, and when they apply `trusted`, `shredded`, `answered_version`, `with_agent`, `revised`, `merged_from`, `merged_into`; open cards also `body`, `html`, `options`, `recommended`, `sections`. Not returned: `option_notes`, `note_attachments`, `attachments`, `draft`, `summary`.',
  publish_asset: 'Runs in the channel process, not on the hub: it encrypts there and uploads ciphertext (`POST /agent/asset`). Needs `path` or `content`; the schema marks neither as required.',
  list_assets: 'No parameters. Returns JSON: `id`, `type`, `title`, `bytes`, `created`, `expires`, `silent`, `link` (null for a silent asset).',
  revoke_asset: 'Ends a link.',
}

// ---- BOARD -> AGENT ---------------------------------------------------------
// key: kind, or the method for what has no kind. [what the agent is expected to do, which route or call fires it]

const EVENT = {
  chat: ['Answer with `reply`. With `card_id`: answer with the same `card_id`, and rework the card with `revise_card` when it was handed back or unclear. Open the files named in `files` first.', '`POST /message`'],
  decision: ['Act on the choice, then `close_card` with a summary. With `trust="1"`: decide yourself, say what you chose with `reply` and the `card_id`, then `close_card`. Read the option notes in the content.', '`POST /decide`'],
  decision_reopened: ['Stop acting on the old choice, undo what is safe to undo, say so with `reply`, wait for the new answer. With `shredded="1"` there is nothing to undo: the card is simply open again.', '`POST /reopen` on an answered, trusted or shredded card'],
  info_read: ['Nothing.', '`POST /close`'],
  handback_withdrawn: ['Nothing: do not rework or explain the card; it is the human\'s again.', '`POST /handback {clear: true}`'],
  shredded: ['Do not ask again, in these or other words. Carry on with your own judgement or drop the matter; if nothing can proceed without an answer, say so once in a `reply`.', '`POST /shred`'],
  scribble: ['Read `image_path` (what the human looked at), then `canvas_path` if the surroundings matter. A chat message often follows.', '`POST /scribble`'],
  pad: ['Read `image_path`; the content already holds the words of the selected notes.', '`POST /pad/send`'],
  'notifications/claude/channel/permission': ['Nothing: Claude Code takes the verdict, and decides whether the terminal or the board came first.', '`POST /decide` on an approval card'],
  'notifications/claude/channel/permission_request': ['Sent by Claude Code, not by the agent. The channel process turns it into a card `kind: permission`, always first in the stack.', 'Claude Code, before a tool call that needs approval'],
  initialize: ['Sent by Claude Code once. `clientInfo` becomes `agent.client` ("Program" in the sessions table).', 'the MCP handshake'],
}

// ---- the records ------------------------------------------------------------
// [field, shape, who sets it, who reads it in the web client, status]

const H = 'hub', A = 'agent', U = 'human'
const RECORDS = [
  { name: 'Card', where: '`state.cards[]`, built by `addCard`', rows: [
    ['id', '8 hex characters', H, 'everything that names a card', USED],
    ['agent', 'session id', H, 'scope, sender on the row', USED],
    ['number', 'integer, counts up per board', H, 'inbox row, question card ("Question 12")', USED],
    ['kind', '`decision` / `info` / `permission`', H + ' (from the tool, or an approval request)', 'inbox, question card', USED],
    ['status', '`open` / `decided` / `done` / `shredded`', H, 'everywhere; `shredded` only in the question window so far', USED],
    ['shredded', 'timestamp or null', H + ', on `/shred`', 'retention; the question window shows the strip "Shredded" from its own memory', USED],
    ['title, body, html', 'strings (markdown; cleaned HTML)', A, 'inbox row, question card', USED],
    ['options[]', '`{key, label, detail}`', A + ' (hub for an approval: Allow / Deny)', 'inbox row, question card', USED],
    ['sections[]', '`{text, html?}` or `{key, label, text, html?, recommended, picture?}`', A, 'question card', USED],
    ['attachments[]', 'see Attachment', A, 'question card, inbox row (count)', USED],
    ['urgency, urgency_reason', '`low` / `normal` / `high` / `critical`; a phrase', A + ' (`create_*`, `revise_card`, `set_urgency`)', 'inbox row, question card', USED],
    ['multiple', 'boolean', A, 'inbox row, question card', USED],
    ['recommended', 'key, list of keys, or null', A, 'inbox row, question card', USED],
    ['version', 'integer from 1', H + ', +1 with every rewording', 'question card (time machine)', USED],
    ['versions[]', 'see Version; at most 20', H, 'question card (time machine)', USED],
    ['revised', 'timestamp of the live wording', H, '`store.js` sends it back with an answer; row note "revised"', USED],
    ['revisions', 'integer, `version - 1`', H, 'nobody', QUIET],
    ['revision_note', 'string', A + ' (`revise_card.note`)', 'nobody directly: the same words are in the `revised` marker', QUIET],
    ['choice, choices', 'key or null; list of keys', U + ' (`/decide`), or the agent\'s advice on Trust', 'inbox (answered pile), conversation, history', USED],
    ['note', 'string', U, 'history ("Your note")', USED],
    ['option_notes', '`{key: text}`', U + ' (`/decide notes`)', 'nobody in the web client (the iOS model reads it)', QUIET],
    ['note_attachments[]', 'see Attachment', U + ' (`/decide attachments`)', 'nobody in the web client', QUIET],
    ['trusted', 'boolean', U + ' (`/decide trust`)', 'inbox: "Trusted: <advice>"', USED],
    ['answered_version', 'integer or null', H, 'nobody', QUIET],
    ['draft', 'see Draft', U + ' (`/draft`), hub on `/reopen`', 'question card', USED],
    ['with_agent', 'timestamp', H + ', on hand-back or "What??"', '`store.js`: the pile "With the agent"', USED],
    ['summary', 'string', A + ' (`close_card`, `withdraw_card`), hub on merge and session end', 'history only', USED],
    ['created, decided', 'timestamps', H, 'age on the row, order, history', USED],
    ['read', 'timestamp or null (info only)', H + ', on `/close`', 'inbox ("Read")', USED],
    ['merged_from', '`[{id, number, title}]`', H, 'row note "replaces N questions" (only the length)', USED],
    ['merged_into', 'card id', H, 'nobody', QUIET],
    ['request_id', 'string (approval only)', 'Claude Code', 'nobody; the hub echoes it in the verdict', QUIET],
  ] },
  { name: 'Message', where: '`state.messages[]`, built by `addMessage` and `addEvent`', rows: [
    ['id, agent, ts', '8 hex; session id; timestamp', H, 'conversation', USED],
    ['from', '`user` / `agent` / `event`', H, 'conversation', USED],
    ['text', 'markdown', A + ', ' + U + ', or the hub for a marker', 'conversation', USED],
    ['html, details', 'strings', A, 'conversation, question card thread', USED],
    ['attachments[]', 'see Attachment', A + ' (paths) or ' + U + ' (uploads, scribble, pad selection)', 'conversation, question card thread', USED],
    ['card_id', 'card id', A + ' (`reply.card_id`), ' + U + ' (`/message card_id`), hub (markers)', 'question card thread; markers open their card', USED],
    ['kind', '`asked` / `info` / `revised` / `urgency` / `decided` / `done` / `read` / `reopened` / `shredded` (markers only)', H, 'conversation; `info`, `read` and `shredded` have no label of their own and show as "Board"', USED],
    ['version, again', 'integer; true after a hand-back (on a `revised` marker)', H, 'question card thread: "version 3 presented"', USED],
    ['trusted', 'true (on a `decided` marker)', H, 'nobody: the text says "Trusted: your call"', QUIET],
    ['handback, explain', 'true', U + ' (`/message`)', 'nobody: only `card.with_agent` is read', QUIET],
    ['asset', '`{id, type, title, note, url, size}`, later `{id, type, title, gone}`', H + ', from `publish_asset`', 'conversation (asset card), question card (links), history', USED],
  ] },
  { name: 'Session (agent)', where: '`state.agents[]`, built by `register`; the list order is the sidebar order', rows: [
    ['id', 'slug of the name, `-2`, `-3` for more of the same', H, 'everywhere', USED],
    ['name', 'string: `BOARD_AGENT` or the folder name', 'the channel process (`/agent/link`)', 'sidebar, rows (as the fallback under `label`)', USED],
    ['cwd, host, platform', 'strings', 'the channel process', 'sessions table: Folder, Machine', USED],
    ['instance', 'random hex per process', 'the channel process', 'nobody; it is pushed to every page all the same', QUIET],
    ['client', '"claude-code 2.1.0"', 'Claude Code (`initialize`), relayed by `/agent/profile`', 'sessions table: Program', USED],
    ['model, task', 'strings', A + ' (`introduce`)', 'sessions list and table, session header', USED],
    ['icon', '`draw:<name>`', A + ' (`introduce`) or ' + U + ' (`/session`)', 'the session\'s mark', USED],
    ['icon_by', '`agent` / `human`', H, 'nobody', QUIET],
    ['label', 'string, 60 characters', U + ' (`/session`)', 'the session\'s shown name', USED],
    ['group', 'string or null', U + ' (`/session`)', 'sessions shown as one', USED],
    ['starred', 'boolean; at most one session has it (crowning one un-crowns the others), with `starred_at`', U + ' (`/star`)', 'inbox order, star', USED],
    ['archived', 'boolean', U + ' (`/session`); cleared when the session links again', 'sidebar; its open cards leave the queue', USED],
    ['position', 'index in the list', H, '`store.js` (order)', USED],
    ['online', 'boolean', H, 'everywhere', USED],
    ['joined, connected, seen', 'timestamps', H, 'sessions table', USED],
  ] },
  { name: 'Status line', where: '`state.tasks[]`, written by `set_status`', rows: [
    ['agent, id', 'session id; the agent\'s name for the line', A, 'key of the pill', USED],
    ['label, detail', 'strings', A, 'the pill: "label: detail"', USED],
    ['state', '`decision` / `working` / `done`', A + '; hub sets `working` when the card is answered', 'colour of the pill; "running" on the session', USED],
    ['card_id', 'card id or null', A, 'nobody', QUIET],
    ['updated', 'timestamp', H, 'nobody', QUIET],
  ] },
  { name: 'Attachment', where: 'on messages, cards, versions; built by `storeAttachment` (agent) and `storeUploads` (human)', rows: [
    ['name', 'file name', H + ', from the path or the upload', 'caption, download name', USED],
    ['url', '`/files/<id>.<ext>`', H, 'everywhere a file shows', USED],
    ['kind, image', '`image` / `video` / `audio` / `file`; boolean', H + ', from the extension', 'how it is drawn', USED],
    ['size', 'bytes', H, 'shown with files', USED],
    ['title', 'string, 200 characters', A + ' (`{path, title}`)', 'nobody', QUIET],
    ['page', '`{url, kind: "file" | "link"}`', A + ' (`{path, page}`), or the hub when `foo.html` lies beside `foo.png`', 'nobody', QUIET],
    ['kind: scribble, id', 'variant for a sent drawing: `{kind: "scribble", id, name, url: "/scribbles/<id>.png", image}`', H, 'conversation: opens the canvas', USED],
    ['pad', 'variant for a pad selection: `{kind: "image", name: "From the pad", url, image, size, pad}`', H, 'conversation', USED],
  ] },
  { name: 'Version', where: '`card.versions[]`, pushed by `revise_card` when the wording changed', rows: [
    ['n, at', 'version number; when it was presented', H, 'question card: "Version 2 of 4 · as it was …"', USED],
    ['title, body, html, options, sections, recommended, multiple, attachments, urgency', 'as on the card at that time', H, 'question card, read-only', USED],
    ['note', 'the agent\'s note that version came with', A, 'question card: version bar', USED],
  ] },
  { name: 'Draft', where: '`card.draft`, only on an open question; the agent never sees it', rows: [
    ['keys', 'list of option keys', U + ' (`/draft`)', 'question card: the ticks', USED],
    ['note', 'string, kept as typed', U, 'question card: the composer', USED],
    ['notes', '`{key: text}`', U, 'question card: the line on each option', USED],
    ['ts', 'timestamp', H, 'question card: adopt a newer draft from another device', USED],
  ] },
  { name: 'Asset', where: '`state.assets[]`, built by `storeAsset`; the ciphertext is `data/assets/<id>`', rows: [
    ['id', '22 base64url characters', 'the channel process', '`ui.js`: finds the record for a link', USED],
    ['type, title', 'null and empty for a silent asset', A, 'label and title of a link', USED],
    ['agent, size, created', 'session id; bytes of ciphertext; timestamp', H, 'nobody in the app (`list_assets` returns them)', QUIET],
    ['keep, silent', 'booleans', A, 'nobody; the hub\'s cleanup reads `keep`', QUIET],
    ['wrapped_key', 'always null', H, 'nobody: a place kept for the room key', PLAN],
  ] },
  { name: 'Pad element', where: '`data/pad.db` through `server/pad.mjs`; not part of the state', rows: [
    ['id, pad', 'ids; the pad is `global` today', 'the pad page', 'the pad page (`client/web/pad/`; not checked field by field)', USED],
    ['type', '`stroke` / `image` / `text` / `voice`', 'the pad page', 'the pad page', USED],
    ['x, y, w, h, rotation, z, group', 'numbers; group id or null', 'the pad page', 'the pad page', USED],
    ['data, blob', 'the element\'s own content; id of its bytes (`/pad/blobs/<id>`)', 'the pad page', 'the pad page', USED],
    ['rev, seq, created, updated', 'the page\'s revision; the hub\'s running number and clock', 'page (`rev`, `created`), hub (`seq`, `updated`)', 'sync', USED],
    ['author', '`human` today', 'the pad page', 'a session id once agents place elements', PLAN],
    ['sent[]', '`{session, at, message_id, rev}`, at most 50', H + ', on `/pad/send`', 'the pad page: where a selection went', USED],
    ['deleted', 'true on a tombstone', 'the pad page', 'sync', USED],
  ] },
  { name: 'State', where: 'the object every page gets on `GET /events`, whole, on every change', rows: [
    ['agents, messages, cards, tasks, assets', 'the lists above', H, '`store.js`', USED],
    ['queue', 'ids of open cards in the order the human sees them', H, 'inbox, question card', USED],
    ['speech', 'boolean: a speech key is set', H, 'read-aloud is offered', USED],
    ['hub', 'id of the session that is the hub', H, 'nobody in the app', QUIET],
    ['next_number', 'integer', H, 'nobody', QUIET],
    ['pending', 'events waiting for sessions that are away', H, 'never sent to a page', USED],
  ] },
]

// ---- HUMAN -> BOARD ---------------------------------------------------------
// [method and route, body or query, what it does, status]

const ROUTES = [
  ['GET /events', '', 'Event stream: the whole state as one JSON frame, on connect and on every change.', USED],
  ['POST /message', '`{text, agent, card_id?, handback?, explain?, cards?: [id or number], attachments?: [{name, data}]}`', 'Chat to one session; with `card_id` a question back about an open card; `handback` ("Revise") / `explain` ("What??") put the card with the agent. `cards` (at most 5) copies cards, usually another session\'s decision, into the message: the agent gets each in full. Files as base64 data URLs, at most 12 and 96 MB.', USED],
  ['POST /handback', '`{card_id, clear: true}`', 'Takes a hand-back or a "What??" back before the agent has reworked the card.', USED],
  ['POST /decide', '`{card_id, key | keys, note?, notes?: {key: text}, revised?, attachments?}`', 'Answers a question or an approval. 409 when the card was reworded meanwhile.', USED],
  ['POST /decide', '`{card_id, trust: true, note?, revised?}`', 'Leaves an open question to the agent ("Whatever" on screen).', USED],
  ['POST /draft', '`{card_id, keys?, note?, notes?}`', 'Keeps what is ticked and written but not sent; the whole draft every time, an empty one clears it.', USED],
  ['POST /close', '`{card_id}`', 'Closes an info: read.', USED],
  ['POST /shred', '`{card_id, note?}`', 'Throws an open question or info away unanswered; the agent is told not to ask again.', USED],
  ['POST /reopen', '`{card_id}`', 'Takes an answer, a trust, a "read" or a shredding back.', USED],
  ['POST /snooze', '`{card_id, until?: ms | "next_morning" | null, clear?: true}`', 'Put an open card off: it leaves the queue (`snoozed_until`, `snoozed_at`) and comes back next morning 07:00 at the latest, or at once with `clear`. The agent is not told.', USED],
  ['POST /session', '`{agent, label?, icon?, archived?, group?, before?}`', 'The human\'s name, symbol, group and place for a session; archiving one that is away.', USED],
  ['POST /star', '`{agent, starred}`', 'Puts the crown on a session: its questions lead the Desk, and it receives the quick note.', USED],
  ['GET /canvas?agent=', '', 'The lasting drawing of one session, as JSON.', USED],
  ['POST /canvas', '`{agent, doc}`', 'Saves it while the human draws.', USED],
  ['POST /scribble', '`{agent, doc, png, view?, text?}`', 'Sends the drawing to the session. The web client never sends `text` (the caption).', USED],
  ['GET /scribbles/<id>.png|json', '', 'A sent drawing.', USED],
  ['POST /speech/say', '`{text, lang?}`', 'Text to audio, for read-aloud.', USED],
  ['GET /speech/card/<id>', '', 'A whole card as audio. `store.js` exports the address; nothing calls it.', QUIET],
  ['GET /files/<name>', '', 'An attachment, with Range requests; an HTML file is served sandboxed.', USED],
  ['GET /a/<id>, /a/<id>/blob, /a/-/…', '', 'The asset viewer and the ciphertext, for who is signed in (cookie, or the board token from this machine). Only the empty frame /a/-/frame.html needs no login. Outsiders: /r/<id> of a released asset.', USED],
  ['GET /pad/elements?pad=&since=', '', 'All elements of the pad, or what changed after a running number.', USED],
  ['POST /pad/elements', '`{pad, client_id, elements: [...]}`', 'Create and change; per element the higher `rev` wins.', USED],
  ['DELETE /pad/elements/<id>', '`?rev=&client_id=`', 'A tombstone.', USED],
  ['PUT, GET /pad/blobs/<id>', 'bytes', 'Pictures and voice notes of the pad, up to 30 MB.', USED],
  ['GET /pad/events?pad=&since=', '', 'The pad\'s own stream: only what changed.', USED],
  ['POST /pad/send', '`{session, pad?, elements: [{id}], png, text?, client_id?}`', 'Sends a selection to a session: a message with the picture, and the event `pad`.', USED],
  ['GET /api/tools', '', '`{version, retention_days, max_asset_mb, tools (with example), drawings, events}` for the help page. The page reads `tools` and `events`; nothing reads `drawings`.', USED],
  ['POST /admin/api/login, logout', '`{key}`', 'The admin key for an admin session cookie.', USED],
  ['GET /admin/api/overview, cleanup, log, diagnose, export', '', 'What the admin page shows; `export` is the state as a file, secrets removed.', USED],
  ['POST /admin/api/links', '', 'The login links.', USED],
  ['POST /admin/api/sessions/forget', '`{id, data?, confirm: id}`', 'Removes a session that is away, with or without its data.', USED],
  ['POST /admin/api/sessions/clear-queue', '`{id, confirm: id}`', 'Drops what waits for a session.', USED],
  ['POST /admin/api/purge, orphans, token/rotate', '`{confirm: "purge" | "orphans" | "rotate"}`', 'Cleanup now; delete unreferenced files; replace the login token.', USED],
]
const AGENT_ROUTES = [
  ['GET /agent/link', '`?name&cwd&host&platform&id&instance`', 'Registers the session and stays open: first `{hello: id, ping, dedicated}`, then one `{method, params}` per event.'],
  ['POST /agent/tool', '`{id, instance, name, args}`', 'Runs a tool on the hub; answers `{text}`.'],
  ['POST /agent/asset', 'query `id`, `instance`; header `x-asset` = base64url of `{id, keep, silent, type?, title?, note?, key?}`; body = ciphertext', 'Stores a published asset.'],
  ['POST /agent/profile', '`{id, instance, fields: {client}}`', 'What Claude Code said about itself.'],
  ['POST /agent/permission', '`{id, instance, params: {request_id, tool_name, description, input_preview}}`', 'An approval request becomes a card.'],
]

// ---- what we want next ------------------------------------------------------
// [what, why, what it needs, where it comes from, state]

const WISHES = [
  ['Trust in the question window', 'The hub takes `/decide {trust}` and the inbox row has the button; the window where a question is read has none, and a trusted card with no advice does not say that it waits for the agent\'s choice.', 'A button and a key in `focus.js`; a state "the agent is choosing" for `trusted` with empty `choices`; an event or field when the agent has said what it chose (today only a `reply` with `card_id`).', 'being built today; contract section 9', 'half built'],
  ['Sub-sessions: `open_session`', 'A subagent should be a session of its own on the board, opened by its parent, instead of posting under a placeholder name through `dev/session.mjs`.', 'A tool `open_session {name, task, icon}` that returns a credential for the helper; `agent.parent`; a first-connect proposal of the team (`group`); events routed to the helper. Blocked: the change was refused by the permission check and waits for Christopher\'s explicit approval.', '`TODO.md`; card Nr. 119', 'blocked'],
  ['Pad tools: `pad_get`, `pad_list`, `pad_put`', 'An agent can only receive a selection as a picture and words. It cannot look again, read what lies near it, or put an answer on the pad.', '`pad_get(ids)`, `pad_list({pad, box})`, `pad_put({pad, type, text | path, near | x, y, reply_to})` in `TOOLS`; `author` = the session id; a rule that an agent changes only its own elements.', '`docs/pad.md` section 3', 'designed'],
  ['Bytes instead of paths for files', 'Attachments travel as absolute paths in both directions (`attachments`, `files`, `image_path`, `canvas_path`, voiceover), so agent and hub must share a disk. That ties every session to the hub\'s machine.', 'Upload from the channel process (as `/agent/asset` already does for assets) and a download route for the agent, or files inside the envelope; the channel process writes them to a local file for Claude Code.', '`docs/architecture.md` section 3; `docs/operations.md`', 'wanted'],
  ['Delivery acknowledgements', 'An event counts as delivered once it is written to the link. A session that dies in that moment loses it, and nothing tells the human whether the agent got the answer.', 'An id per event, an ack from the channel process, a `deliveries` table (exists in `server/store/`, unused), and a mark on the card ("received").', '`docs/architecture.md` section 2; `docs/storage.md`', 'designed'],
  ['Message log with running numbers', 'Every change pushes the whole state to every page. A client cannot fetch what it missed, and nothing guards against a message arriving twice.', 'A sequence number and a client id on every message; `GET /events?since=`; the store in `server/store/` behind the hub.', '`TODO.md`; decided as the next server work (card Nr. 80)', 'designed'],
  ['Stable agent ids', 'The id is the slug of the folder name plus a per-process `instance`. Claude\'s own session id changes on resume, `/compact` and fork.', 'An id bound to a key file (pairing section 6); `agent.claude_session` as a changing extra, read from a `SessionStart` hook.', '`TODO.md`; card Nr. 80 (ticked); `docs/pairing.md` section 6', 'decided'],
  ['Pairing and one credential per member', 'One token is the browser login and every agent\'s credential. A phone or an agent cannot be shut out alone.', 'Invite links, a member list, a key per device and agent (`crypto/hub.mjs` exists, without HTTP routes).', '`docs/pairing.md`; card Nr. 80 (ticked)', 'decided'],
  ['Encryption envelopes', 'The hub reads everything. Planned: content as AES-256-GCM ciphertext under one room key, each message signed by the sending device; the channel process checks the signature before Claude Code sees anything.', 'The envelope (header in clear text: room, epoch, sender, number, card id, status, urgency, answer time); `asset.wrapped_key` filled; a decision bound to the hash of the card version it answers.', '`docs/krypto-konzept.md` sections 5 and 6', 'designed'],
  ['Live state of a session', 'The board knows only what the agent says with `set_status`. "Working / waiting / blocked" should be true without the agent\'s help.', '`agent.live` read from herdr (`HERDR_SOCKET_PATH`, `HERDR_PANE_ID`); hooks alone are not reliable.', '`TODO.md`; `docs/gelernt.md`', 'wanted'],
  ['Live trace: what the agent is doing', 'A channel carries only what the agent sends on purpose: no thinking, no tool calls, no terminal output.', 'A second road beside the channel: hooks or the Agent SDK, and a message kind for it.', '`TODO.md`; `README.md`', 'wanted'],
  ['The page of a picture, and its caption', 'Agents already send `{path, page, title}` and the hub stores and serves the page. No client shows "Open page" or the caption.', 'Client only: read `attachment.page` and `attachment.title` (contract section 8).', 'contract section 8', 'hub built'],
  ['Notes on options and files of an answer, after sending', 'The human\'s notes on single options and the files attached to an answer are stored (`option_notes`, `note_attachments`) and reach the agent, but the web client never shows them again.', 'Client only: show them on answered cards and in the history.', 'contract section 2', 'hub built'],
  ['A status line that leads to its card', '`set_status.card_id` is stored and used by the hub; the README promises that the red line jumps to the card.', 'Client only: read `task.card_id`.', '`README.md`', 'hub built'],
  ['One list of drawings', 'The agent picks its symbol from `drawings.json` (52 names), which is written from the list in `ui.js`. Nothing shows who chose a symbol.', 'The page reads `drawings` from `/api/tools` instead of its own copy; show `icon_by`.', 'contract section 7', 'hub built'],
  ['"Later" on the hub', 'A card put off for later lives in the browser\'s `localStorage`; another device still shows it in front.', '`card.later` (or a per-human list) on the hub, set by a route.', 'found while reading `store.js`', 'wanted'],
  ['Agents joined by a link', 'A session joins by an entry in `.mcp.json` and the flag `--dangerously-load-development-channels`.', 'An invite link pasted into the prompt (pairing section 8.3); a plugin once channels need no developer flag.', '`TODO.md`', 'wanted'],
  ['Push for urgent cards', 'An urgent card waits until the human opens the board.', 'A device registration and a push when a `high` or `critical` card enters the queue.', '`TODO.md`', 'wanted'],
  ['The hub checks what the schema promises', 'The tool schemas are advice to the model; the hub accepts a `reply` without text and a question without a title, and helper sessions (`dev/session.mjs`) never see a schema.', 'Validate `required` and types in `runTool`.', 'found while reading `runTool`', 'wanted'],
]

// ---- mismatches -------------------------------------------------------------
// [group, what, where]

const MISMATCH = [
  ['Sent or stored, read by no web client', '`attachment.page` and `attachment.title`: stored on every attachment an agent sends that way, and the page is served under `/files/`; no client shows either.', '`storeAttachment`; `client/web/js/*`'],
  ['Sent or stored, read by no web client', '`card.option_notes` and `card.note_attachments`: kept on the answered card, never shown again in the web client (iOS reads both).', '`decide()`; `history.js`, `inbox.js`'],
  ['Sent or stored, read by no web client', '`task.card_id` and `task.updated`.', '`set_status`; `agents.js`, `table.js`'],
  ['Sent or stored, read by no web client', '`card.answered_version`, `card.revisions`, `card.revision_note`, `card.merged_into`, `card.request_id`; `message.trusted`, `message.handback`, `message.explain`; `agent.icon_by`, `agent.instance`; `state.hub`, `state.next_number`; `asset.agent`, `size`, `created`, `keep`, `silent`, `wrapped_key`.', 'pushed to every page with each state'],
  ['Sent or stored, read by no web client', '`drawings` in `GET /api/tools`: the help page reads `tools` and `events` only; the symbol picker uses the list in `ui.js`.', '`help.js`, `ui.js`'],
  ['Sent or stored, read by no web client', '`GET /speech/card/<id>`: `store.js` exports `cardAudioUrl`, nothing calls it. Read-aloud uses `POST /speech/say`.', '`store.js`, `speech.js`'],
  ['Sent or stored, read by no web client', 'The markers `info`, `read` and `shredded` in the conversation have no label and no icon of their own: they show as "Board" with the question icon.', '`chat.js` (`EVENT_LABEL`, `ICONS`)'],
  ['Expected by one side, not sent by the other', '`POST /scribble` takes `text` (a caption, which becomes the content of the event); the web client sends `{doc, png, view, agent}` only, so the agent always gets the stock sentence.', '`storeScribble`; `store.js` `sendScribble`'],
  ['Expected by one side, not sent by the other', '"Later" is state the client needs and the hub does not have: it lives in `localStorage` per browser.', '`store.js` (`LATER_KEY`)'],
  ['Documented, but different', 'The schemas\' `required` is not checked by the hub: `reply` without `text` stores an empty message, `create_decision` without `title` an untitled card. The other way round, `set_status` needs `label` for a new line and `publish_asset` needs `path` or `content`, and neither schema says so.', '`TOOLS`; `runTool`'],
  ['Documented, but different', '`close_card` is described as "move a decided card to Done", but the hub does not look at the status: called on an open question or info it closes it, and no answer will come.', '`runTool`, case `close_card`'],
  ['Documented, but different', '`revise_card`, `set_urgency` and `withdraw_card` say "decision card" in their descriptions; all three work on info cards too.', '`TOOLS`; `runTool`'],
  ['Documented, but different', '`set_status` says the strip is "at the top of the board"; the web client draws the lines as pills in the sessions list and table.', '`TOOLS`; `agents.js`, `table.js`'],
  ['Documented, but different', '`README.md`, "Was der Agent bekommt" names every event kind but not every field (`handback`, `explain`, `trust`, `option_notes`, `files`, `marks`, `canvas_path`); it points here for those. `reply` is listed without `html`.', '`README.md`'],
  ['Documented, but different', '`docs/question-contract.md` has two sections numbered 6 (rich content, info cards); the shape of a version\'s attachments in section 5 lacks `title` and `page`, which section 8 adds.', '`docs/question-contract.md`'],
  ['Documented, but different', '`docs/architecture.md` (written this morning) does not know `create_info`, `/close`, trust, or `html` on `reply`.', '`docs/architecture.md`'],
  ['Documented, but different', 'The running hub is older than the code: on 2 October it offered `create_info` and trust, but not yet `/shred` and the `shredded` event. Whatever this document says is true of the code; a hub shows it after a restart.', '`GET /api/tools` on the live hub'],
  ['Documented, but different', 'The MCP server calls itself `board`, version `0.1.0`; the package is Trommi 1.0.0. The name is what the agent sees as `source="board"`.', '`new Server(...)`'],
]

// ---- build ------------------------------------------------------------------

function build() {
  const { TOOLS, TOOL_EXAMPLES, CHANNEL_EVENTS, instructions } = live()
  const problems = []
  const seen = new Set()
  const tools = TOOLS.map(t => {
    const params = paramsOf(t.inputSchema).map(p => {
      const note = noteFor(t.name, p.name)
      if (!note) problems.push(`no note for ${t.name}.${p.name}`)
      seen.add(PARAM[`${t.name}.${p.name}`] ? `${t.name}.${p.name}` : `q.${p.name}`)
      const [stored, shown, status] = note ?? ['?', '?', USED]
      return { ...p, stored, shown, status }
    })
    if (!TOOL_NOTE[t.name]) problems.push(`no note for the tool ${t.name}`)
    return { name: t.name, note: TOOL_NOTE[t.name] ?? '', params, example: TOOL_EXAMPLES[t.name] ?? null }
  })
  for (const key of Object.keys(PARAM)) if (!seen.has(key)) problems.push(`a note for ${key}, which no tool has (any more)`)
  for (const name of Object.keys(TOOL_NOTE)) if (!TOOLS.some(t => t.name === name)) problems.push(`a note for the tool ${name}, which is gone`)
  const events = CHANNEL_EVENTS.map(e => {
    const key = e.kind ?? e.method
    if (!EVENT[key]) problems.push(`no note for the event ${key}`)
    const [expected, fires] = EVENT[key] ?? ['?', '?']
    const keys = [
      ...Object.entries(e.meta ?? e.params ?? {}).map(([name, says]) => ({ name, always: true, says: name === 'kind' ? `always \`${says}\`` : says })),
      ...Object.entries(e.optional ?? {}).map(([name, says]) => ({ name, always: false, says })),
    ]
    return { key, kind: e.kind, method: e.method, direction: e.direction, when: e.when, content: e.content ?? '', keys, expected, fires, example: e.example }
  })
  for (const key of Object.keys(EVENT)) if (!events.some(e => e.key === key)) problems.push(`a note for the event ${key}, which is gone`)
  const all = tools.flatMap(t => t.params)
  const count = {
    tools: tools.length, params: all.length, top: all.filter(p => !p.name.includes('[]')).length,
    distinct: new Set(tools.flatMap(t => t.params.map(p => (PARAM[`${t.name}.${p.name}`] ? `${t.name}.${p.name}` : `q.${p.name}`)))).size,
    quiet: all.filter(p => p.status === QUIET).length,
    events: events.filter(e => e.direction === 'to_agent').length, kinds: events.filter(e => e.kind).length,
    metaKeys: events.filter(e => e.direction === 'to_agent').reduce((n, e) => n + e.keys.length, 0),
    records: RECORDS.length, fields: RECORDS.reduce((n, r) => n + r.rows.reduce((m, row) => m + row[0].split(',').length, 0), 0),
    fieldsQuiet: RECORDS.reduce((n, r) => n + r.rows.filter(row => row[4] === QUIET).reduce((m, row) => m + row[0].split(',').length, 0), 0),
    routes: ROUTES.length, agentRoutes: AGENT_ROUTES.length, wishes: WISHES.length, mismatches: MISMATCH.length, instructions,
  }
  return { tools, events, records: RECORDS, routes: ROUTES, agentRoutes: AGENT_ROUTES, wishes: WISHES, mismatches: MISMATCH, count, problems }
}

// ---- markdown ---------------------------------------------------------------

const cell = s => String(s ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
const table = (head, rows) => [`| ${head.join(' | ')} |`, `| ${head.map(() => '---').join(' | ')} |`, ...rows.map(r => `| ${r.map(cell).join(' | ')} |`)].join('\n')

const PICTURE = `
  Claude Code            channel process              hub                       browser
  (the agent)            server.mjs, one per          server.mjs, port 8790     client/web
                         session, over stdio          data/pad.db, data/

  tools/call  ────────►  POST /agent/tool  ────────►  runTool()
                                                      state changes ─────────►  GET /events
                                                                                (the whole state)
              ◄────────  GET /agent/link   ◄────────  deliver()     ◄─────────  POST /message, /decide,
  <channel source=       (event stream)               (or state.pending          /close, /reopen,
   "board" kind=…>                                     while away)               /scribble, /pad/send
  notifications/
  claude/channel

  permission_request ─►  POST /agent/permission ───►  a card: Allow / Deny ──►  GET /events
              ◄────────  …/channel/permission  ◄────  deliver()     ◄─────────  POST /decide
`.replace(/^\n/, '')

function markdown(m) {
  const c = m.count
  const out = []
  const say = (...lines) => out.push(...lines, '')
  say('# The interface between an agent and the board')
  say('<!-- Written by dev/interface-doc.mjs. Do not edit by hand: change the notes in that script and run it again. -->')
  say(`What an agent can send and receive, what the board stores of it, what the web client shows, and what is still missing. Read from the code on 2 October 2026: \`server/server.mjs\` (tools, events, routes, records), \`server/pad.mjs\`, \`server/asset-envelope.mjs\`, and \`client/web/js/\` for what is shown. Where an older document says something else, the code wins and the difference is listed under [Mismatches found](#7-mismatches-found).`)
  say('The same content as a page with a filter: `client/web/designs/interface.html` (on a running board: `/designs/interface.html`).')
  say('**To refresh:** `node dev/interface-doc.mjs` rewrites this file and the data in the page. The tool, parameter and event tables come from the definitions in `server/server.mjs` (`TOOLS`, `QUESTION_PROPS`, `CHANNEL_EVENTS`); the columns "stored as", "shown where" and "status", the records, the routes, the wishes and the mismatches are notes kept in the script. `node dev/interface-doc.mjs --check` fails when a parameter or event has no note, so a new field cannot slip past this document.')
  say(table(['', 'Count'], [
    ['Tools', c.tools], ['Parameters, nested ones included', `${c.params} (${c.top} at the top level; ${c.distinct} distinct, because four tools share the question fields)`],
    ['Parameters accepted but not shown', c.quiet], ['Events to the agent', `${c.events} (${c.kinds} kinds on the channel, plus the approval verdict)`],
    ['Meta keys on those events', c.metaKeys], ['Records', `${c.records}, with ${c.fields} fields; ${c.fieldsQuiet} of them read by no web client`],
    ['Routes for the browser', c.routes], ['Routes for agents', c.agentRoutes], ['Wishes', c.wishes], ['Mismatches', c.mismatches],
  ]))

  say('## 1. Overview')
  say('Four processes in a row. The agent speaks MCP to its channel process; the channel process speaks HTTP on loopback to the hub; the hub speaks HTTP to the browser. Nothing goes from the agent to the browser directly.')
  say('```text', PICTURE.trimEnd(), '```')
  say('- **Agent to board:** MCP tool calls. The channel process forwards each as `POST /agent/tool {id, instance, name, args}`; the hub runs it (`runTool`), changes the state and pushes the whole state to every page. `publish_asset` is the one tool that does its work in the channel process (it encrypts there). The answer to a tool call is a line of text, often with advice ("this is a lot to read", "you now have 4 open questions").')
  say('- **Board to agent:** events. The hub writes `{method, params}` onto the session\'s open `GET /agent/link` stream; the channel process hands it to Claude Code as an MCP notification. If the session is away, the event waits in `state.pending` (at most 100 per session, 30 days) and is sent when it links again. Nothing acknowledges an event.')
  say('- **Human to board:** the browser\'s routes (section 5). The page holds no state of its own except what is put off for later, unsent text and the theme.')
  say('- **A second kind of agent:** `dev/session.mjs` puts a script or subagent on the board without Claude Code. It uses the same two routes (`/agent/link`, `/agent/tool`), gets no instructions and no schemas, and reads its events from a log file (`data/sessions/<id>.log`) when asked.')
  say('### What a Claude Code channel allows underneath')
  say(table(['Piece', 'What it is', 'What follows for us'], [
    ['Capabilities', '`experimental: { "claude/channel": {}, "claude/channel/permission": {} }` beside `tools`', 'Claude Code must be started with `--dangerously-load-development-channels`; channels are a research preview.'],
    ['`instructions`', `One string at \`initialize\`, ${c.instructions} sentences today`, 'The only place to tell the agent how to behave. Helper sessions never see it.'],
    ['`notifications/claude/channel`', '`{ content: string, meta: { <key>: string } }`; the agent sees `<channel source="board" key="value">content</channel>`', 'Meta values are strings only: lists travel comma-separated (`choices`, `files`, `elements`), booleans as `"1"`, and anything longer (notes on options) has to be lines of the content.'],
    ['`…/channel/permission_request`', 'From Claude Code: `{request_id, tool_name, description, input_preview}`', 'Becomes a card `kind: permission`. Asked once; the channel process retries five times while the hub changes hands.'],
    ['`…/channel/permission`', 'To Claude Code: `{request_id, behavior: "allow" | "deny"}`', 'Claude Code decides whether the terminal or the board answered first.'],
    ['What a channel does not carry', 'The model\'s thinking, its tool calls, terminal output, streamed text', 'The board shows only what the agent sends on purpose. Files travel as paths, never as bytes.'],
    ['Timing', 'A notification sent before the MCP handshake is finished is lost', 'The channel process holds events until `initialized`.'],
  ]))

  say('## 2. Agent to board: the tools')
  say('Status: **used** = the hub acts on it and, where it is meant to be seen, the web client shows it. **not shown** = accepted and stored, but no web client reads it. **planned** = not built. "Shown where" names the places of the web client: the inbox row (a row of the list the screen calls the Desk), the question card (the opened card, `focus.js`), the conversation. On screen `trust` is "Whatever", a hand-back is "Revise", `explain` is "What??", putting off is "Snooze", and `urgency: high | critical` are "Knocks".')
  const shared = m.tools.find(t => t.name === 'create_decision').params.filter(p => PARAM[`q.${p.name}`])
  const paramTable = params => table(['Parameter', 'Type', 'Meaning', 'Stored as', 'Shown where', 'Status'], params.map(p => [`\`${p.name}\`${p.required ? ' *' : ''}`, p.type, p.says, p.stored, p.shown, p.status]))
  say('### The question fields')
  say('Shared by `create_decision`, `revise_card` and `merge_cards`; `create_info` takes `title`, `body`, `sections` (without `key`, `label`, `recommended`, `picture`), `text`, `html`, `attachments`, `urgency`, `urgency_reason`. A question is given as `body` + `options`, or as `sections`, or as `text`: one of the three. `*` marks what the schema requires.')
  say(paramTable(shared))
  for (const t of m.tools) {
    say(`### \`${t.name}\``)
    say(t.note)
    const own = SHARED.includes(t.name) ? t.params.filter(p => PARAM[`${t.name}.${p.name}`]) : t.params
    if (own.length) say(paramTable(own))
    if (SHARED.includes(t.name)) say(t.name === 'create_info' ? 'Plus, of the question fields: `title`, `body`, `sections[].text`, `sections[].html`, `text`, `html`, `attachments`, `urgency`, `urgency_reason`.' : 'Plus all the question fields above.')
  }

  say('## 3. Board to agent: the events')
  say('Every event on the channel is `notifications/claude/channel` with a `content` string and string-valued `meta`. `kind` says what it is.')
  for (const e of m.events) {
    say(`### ${e.kind ? `\`kind="${e.kind}"\`` : `\`${e.method}\``}${e.direction === 'from_client' ? ' (from Claude Code)' : ''}`)
    say(table(['', ''], [
      ['When', e.when], ['Fired by', e.fires], ...(e.content ? [['Content', e.content]] : []),
      ...e.keys.map(k => [`\`${e.kind ? 'meta.' : ''}${k.name}\`${k.always ? '' : ' (sometimes)'}`, k.says]),
      ['Expected of the agent', e.expected],
    ]))
    if (e.example) say('```text', e.example, '```')
  }
  say('Besides events, the agent gets the text result of each tool call, and on the link the frames `{hello, ping, dedicated}` and a comment line every 15 seconds, which only the channel process reads.')

  say('## 4. The records')
  say('What the hub keeps and pushes to every page. "Read by" is the web client (`client/web/js/`).')
  for (const r of m.records) {
    say(`### ${r.name}`)
    say(r.where)
    say(table(['Field', 'Shape', 'Set by', 'Read by', 'Status'], r.rows.map(([f, shape, by, read, status]) => [f.split(', ').map(x => `\`${x}\``).join(', '), shape, by, read, status])))
  }

  say('## 5. Human to board: the browser\'s routes')
  say('Every request needs the login cookie (`board_<port>`, set once by `GET /?t=<token>`); every request that is not a GET must come from the page\'s own origin. Errors are `{error}` with 400, 409 (stale answer, already decided) or 404.')
  say(table(['Route', 'Body or query', 'What it does', 'Status'], m.routes.map(([r, b, d, s]) => [`\`${r}\``, b, d, s])))
  say('### The agents\' door')
  say('Loopback only, not through a proxy, header `x-board-token`. Used by channel processes and by `dev/session.mjs`.')
  say(table(['Route', 'Body or query', 'What it does'], m.agentRoutes.map(([r, b, d]) => [`\`${r}\``, b, d])))

  say('## 6. What we want next')
  say(table(['What', 'Why', 'What it needs', 'From', 'State'], m.wishes))

  say('## 7. Mismatches found')
  for (const group of [...new Set(m.mismatches.map(x => x[0]))]) {
    say(`### ${group}`)
    say(table(['What', 'Where'], m.mismatches.filter(x => x[0] === group).map(([, what, where]) => [what, where])))
  }
  return out.join('\n').replace(/\n{3,}/g, '\n\n').trimEnd() + '\n'
}

// ---- run --------------------------------------------------------------------

const model = build()
for (const p of model.problems) console.error(`interface-doc: ${p}`)
if (process.argv.includes('--check')) process.exit(model.problems.length ? 1 : 0)

fs.writeFileSync(DOC, markdown(model))
const START = '<script id="data" type="application/json">', END = '</script>'
if (fs.existsSync(PAGE)) {
  const page = fs.readFileSync(PAGE, 'utf8')
  const from = page.indexOf(START)
  const to = page.indexOf(END, from)
  if (from < 0) console.error('interface-doc: the page has no data block; left as it is')
  else {
    const { problems, ...data } = model
    // "<" must not end the script element from inside a string.
    fs.writeFileSync(PAGE, page.slice(0, from + START.length) + JSON.stringify(data).replace(/</g, '\\u003c') + page.slice(to))
  }
}
const c = model.count
console.log(`${c.tools} tools, ${c.params} parameters (${c.distinct} distinct, ${c.quiet} not shown), ${c.events} events to the agent with ${c.metaKeys} meta keys, ${c.records} records with ${c.fields} fields (${c.fieldsQuiet} read by no web client), ${c.routes}+${c.agentRoutes} routes, ${c.wishes} wishes, ${c.mismatches} mismatches`)
if (model.problems.length) process.exitCode = 1
