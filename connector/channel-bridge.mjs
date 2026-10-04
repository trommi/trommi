// channel-bridge.mjs: tool calls -> envelopes, commands -> channel events, for connector/channel.mjs.
//
// No protocol code lives here. Everything that touches the hub, the keys or the envelopes goes through the
// client of client/core (README there: "Agent API"); this module only translates between what Claude Code
// knows (the tools and events of today's board, connector/channel-tools.mjs) and that client. Tested with a real
// client in connector/channel-test.mjs.

import fs from 'node:fs'
import path from 'node:path'
import { cleanFences, htmlBeside, strippedHint, fences } from './richhtml.mjs'
import { URGENCIES, STATUSES, MAX_ASSET, ASSET_TYPES, shortOf } from './channel-tools.mjs'

const withShort = value => (shortOf(value) ? { short: shortOf(value) } : {})
const listArg = (value, what) => {
  if (value != null && !Array.isArray(value)) throw new Error(`${what} must be a list`)
  return value ?? []
}
const urgencyArg = (value, fallback) => {
  if (value == null || value === '') {
    if (fallback) return fallback
    throw new Error(`urgency must be one of ${URGENCIES.join(', ')}`)
  }
  if (!URGENCIES.includes(value)) throw new Error(`urgency must be one of ${URGENCIES.join(', ')}; got "${value}"`)
  return value
}

// ---- a question as one structured text (as in server/server.mjs) -------------------------------------

const FLAGGED = /^\[([\w.-]+)(\*)?\](?!\()[ \t]*/
function parseSections(text) {
  return fences.hide(String(text).replace(/\r\n?/g, '\n')).split(/\n[ \t]*\n/).map(p => fences.show(p).trim()).filter(Boolean).map(par => {
    const flag = FLAGGED.exec(par)
    if (!flag) return { text: par }
    let picture = null
    let short = null
    const rest = par.slice(flag[0].length).replace(/\n[ \t]*picture:[ \t]*(.+)$/im, (_, name) => { picture = name.trim(); return '' })
      .replace(/\n[ \t]*short:[ \t]*(.+)$/im, (_, words) => { short = words.trim(); return '' })
    const [first, ...lines] = rest.split('\n')
    const colon = first.search(/:(\s|$)/)
    let advised = Boolean(flag[2])
    const label = (colon < 0 ? first : first.slice(0, colon)).replace(/\s*(\*|\(recommended\))\s*$/i, () => { advised = true; return '' }).trim()
    return {
      key: flag[1], label, text: [colon < 0 ? '' : first.slice(colon + 1), ...lines].join('\n').trim(),
      ...(advised ? { recommended: true } : {}), ...(picture == null ? {} : { picture }), ...(short == null ? {} : { short }),
    }
  })
}

function pictureOf(ref, names, key) {
  const at = Number.isInteger(ref) || /^\d+$/.test(String(ref)) ? Number(ref) : names.findIndex(n => n === String(ref) || n === path.basename(String(ref)))
  if (!(at >= 0 && at < names.length)) {
    throw new Error(`section "${key}" names the picture "${ref}", which is not among this card's attachments (${names.length ? names.map((n, i) => `${i}: ${n}`).join(', ') : 'it has none'}); give a file name or a position counted from 0`)
  }
  return at
}

function sectionsOf(args, names) {
  if (args.sections != null && args.text != null) throw new Error('give sections or text, not both: text is the same thing written as one block')
  if (args.options != null) throw new Error(`${args.sections != null ? 'sections' : 'text'} and options cannot be combined: the flagged blocks are the options. Flag a block with key and label, or go back to body and options`)
  if (args.body != null) throw new Error(`${args.sections != null ? 'sections' : 'text'} and body cannot be combined: the blocks are the body. Put the introduction in as a first block without a key`)
  const blocks = args.sections != null ? listArg(args.sections, 'sections') : parseSections(args.text)
  return blocks.map((b, i) => {
    if (typeof b === 'string') b = { text: b }
    const said = cleanFences(String(b?.text ?? '').trim(), `section ${i + 1}`)
    const rich = htmlBeside(b?.html, said, { field: `the html of section ${b?.key || i + 1}`, beside: 'text' })
    const layout = rich ? { html: rich } : {}
    if (b?.key == null || b.key === '') {
      if (!said) throw new Error(`section ${i + 1} is empty: a block without a key needs text`)
      return { text: said, ...layout }
    }
    const key = String(b.key)
    const label = String(b.label ?? '').trim()
    if (!label) throw new Error(`section "${key}" has a key, so it becomes an option and needs a label: the short name on its tile, at most about four words`)
    return { key, label, text: said, ...layout, ...withShort(b.short), recommended: b.recommended === true, ...(b.picture == null || b.picture === '' ? {} : { picture: pictureOf(b.picture, names, key) }) }
  })
}
const bodyOf = sections => sections.map(s => (s.key == null ? s.text : `**${s.label}**${s.text ? `: ${s.text}` : ''}`)).join('\n\n')
const NO_ADVICE = Symbol('no advice')

/** The content of a decision card, checked as today's board checks it. Body field names (README). */
function questionFields(args, names = []) {
  const sections = args.sections != null || args.text != null ? sectionsOf(args, names) : null
  if (sections && args.html) throw new Error('html and sections (or text) cannot be combined: give the layout to the block it belongs to, as html on that section, or fenced as ```html inside the text')
  const body = sections ? bodyOf(sections) : cleanFences(String(args.body ?? ''), 'body')
  const html = sections ? '' : htmlBeside(args.html, body, { beside: 'body' })
  const flagged = sections?.filter(s => s.key != null)
  const options = flagged ? flagged.map(s => ({ key: s.key, label: s.label, detail: '', ...withShort(s.short) })) : listArg(args.options, 'options').map(o => ({
    key: String(o?.key), label: String(o?.label), detail: o?.detail ? String(o.detail) : '', ...withShort(o?.short),
  }))
  const keys = new Set(options.map(o => o.key))
  if (options.length < 2 || keys.size !== options.length) {
    throw new Error(sections
      ? 'a question needs at least two options with unique keys: flag at least two blocks with key and label (in text: paragraphs starting with [key] Label:)'
      : 'options need at least two entries with unique keys')
  }
  if (!String(args.title ?? '').trim()) throw new Error('a question needs a title')
  const urgency = urgencyArg(args.urgency, 'normal')
  const multiple = args.multiple === true
  const marked = flagged?.filter(s => s.recommended).map(s => s.key) ?? []
  const given = args.recommended === NO_ADVICE ? null : args.recommended ?? (!marked.length ? null : multiple || marked.length > 1 ? marked : marked[0])
  const advised = given == null ? [] : [given].flat().map(String)
  const stray = advised.find(key => !keys.has(key))
  if (stray != null) throw new Error(`recommended must be the key of one of the options; got "${stray}"`)
  if (Array.isArray(given) && !multiple) throw new Error('recommended as a list needs multiple: true; a card with one answer has one recommendation')
  return {
    card_type: 'decision', title: String(args.title), body, html: html || null, options,
    sections: sections ? sections.map(s => (s.key == null ? s : { ...s, recommended: advised.includes(s.key) })) : null,
    allows_multiple: multiple, recommended: Array.isArray(given) ? advised : advised[0] ?? null,
    urgency, urgency_reason: String(args.urgency_reason ?? '').trim(),
  }
}

/** The content of an info card. */
function infoFields(args, names = []) {
  for (const key of ['options', 'multiple', 'recommended']) {
    if (args[key] != null) throw new Error(`an info has no ${key}: it asks nothing, the human reads it and closes it. Something to choose is a question: create_decision`)
  }
  const sections = args.sections != null || args.text != null ? sectionsOf(args, names) : null
  const flagged = sections?.find(s => s.key != null)
  if (flagged) throw new Error(`an info has no options, so no block may have a key (got "${flagged.key}"). Something to choose is a question: create_decision`)
  if (sections && args.html) throw new Error('html and sections (or text) cannot be combined: give the layout to the block it belongs to, as html on that section, or fenced as ```html inside the text')
  const body = sections ? bodyOf(sections) : cleanFences(String(args.body ?? ''), 'body')
  const html = sections ? '' : htmlBeside(args.html, body, { beside: 'body' })
  if (!String(args.title ?? '').trim()) throw new Error('an info needs a title')
  if (!body.trim() && !html) throw new Error('an info needs something to read: body, sections or text')
  return {
    card_type: 'info', title: String(args.title), body, html: html || null, options: [], sections, allows_multiple: false, recommended: null,
    urgency: urgencyArg(args.urgency, 'normal'), urgency_reason: String(args.urgency_reason ?? '').trim(),
  }
}

const namesOf = list => listArg(list, 'attachments').map(f => path.basename(String(f?.path ?? f)))

// ---- files ---------------------------------------------------------------------------------------------

const MEDIA = {
  '.png': 'image/png', '.jpg': 'image/jpeg', '.jpeg': 'image/jpeg', '.gif': 'image/gif', '.webp': 'image/webp', '.svg': 'image/svg+xml', '.avif': 'image/avif',
  '.mp4': 'video/mp4', '.webm': 'video/webm', '.mov': 'video/quicktime', '.mp3': 'audio/mpeg', '.m4a': 'audio/mp4', '.ogg': 'audio/ogg', '.wav': 'audio/wav',
  '.html': 'text/html', '.htm': 'text/html', '.txt': 'text/plain', '.md': 'text/markdown', '.json': 'application/json', '.pdf': 'application/pdf',
  '.csv': 'text/csv', '.diff': 'text/x-diff', '.patch': 'text/x-diff', '.zip': 'application/zip',
}
const ATTACHMENT_ID = /^[0-9a-f]{32}$/
/** A file name from someone else, as one harmless path component. */
export const safeName = name => (path.basename(String(name || 'file')).replace(/[^\w.-]+/g, '_').replace(/^\.+/, '').slice(0, 100) || 'file')
export const mediaTypeOf = name => MEDIA[path.extname(String(name)).toLowerCase()] ?? 'application/octet-stream'
const assetTypeOf = media => (media === 'text/html' ? 'html' : /^(image|video|audio)\//.test(media) ? media.split('/')[0] : 'file')

/** Width and height of a PNG or JPEG, or {} (cheap header read; nothing is decoded). */
function pictureSize(bytes) {
  if (bytes.length > 24 && bytes[0] === 0x89 && bytes[1] === 0x50) {
    const v = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength)
    return { width: v.getUint32(16), height: v.getUint32(20) }
  }
  if (bytes[0] === 0xff && bytes[1] === 0xd8) {
    let i = 2
    while (i + 9 < bytes.length) {
      if (bytes[i] !== 0xff) break
      const marker = bytes[i + 1], len = (bytes[i + 2] << 8) | bytes[i + 3]
      if (marker >= 0xc0 && marker <= 0xc3) return { height: (bytes[i + 5] << 8) | bytes[i + 6], width: (bytes[i + 7] << 8) | bytes[i + 8] }
      i += 2 + len
    }
  }
  return {}
}

const markOf = m => {
  if (!m || typeof m !== 'object') return null
  const n = k => Number(m[k])
  if (![n('x'), n('y'), n('w') || n('width'), n('h') || n('height')].every(Number.isFinite)) throw new Error('a mark needs x, y, w and h, fractions of the picture from 0 to 1')
  return { x: n('x'), y: n('y'), width: Number(m.w ?? m.width), height: Number(m.h ?? m.height), ...(m.label ? { label: String(m.label).slice(0, 24) } : {}) }
}

// ---- the bridge ---------------------------------------------------------------------------------------

/**
 * createBridge({ client, notify, cacheDir, state, saveState, log })
 *   client:    a started client/core agent client
 *   notify:    (method, params) => Promise: an MCP notification to Claude Code
 *   cacheDir:  where the human's attachments are written decrypted (dir 0700, files 0600)
 *   state:     the bridge's own small persisted state ({ permissions: { object_id: request_id } })
 *   saveState: () => void, called after state changed
 * Returns { callTool(name, args) -> text, permissionRequest(params), command(cmd) }.
 */
export function createBridge({ client, notify, cacheDir, state = {}, saveState = () => {}, log = () => {} }) {
  state.permissions ??= {}
  state.shares ??= {}   // published object_id -> [{ share_id, expires_at }]: outsider links this agent made
  state.children ??= {} // child sessions this agent opened for its helpers: lowercase name -> { session_id, name }
  const model = () => client.model
  const me = () => model().room.my_device_id
  // This agent's session on the board: its session_id once sessions have their own keys (R6), its device id before.
  // With a child session id: that one (a helper's session, open_session).
  const mySession = (sid = null) => model().sessions.get(sid ?? client.session_id ?? me())

  // ---- child sessions: one per helper (a subagent of this Claude session), named by the helper ------------
  const opening = new Map()
  const holds = sid => (client.session_ids ?? []).includes(sid)
  function findChild(name) {
    const key = name.toLowerCase()
    const known = state.children[key]
    if (known && holds(known.session_id)) return known.session_id
    // The state file was lost: find it by the name this agent wrote into the child's profile.
    for (const sid of client.childSessionIds?.() ?? []) {
      if (String(model().sessions.get(sid)?.profile?.agent_name ?? '').toLowerCase() !== key) continue
      state.children[key] = { session_id: sid, name }
      saveState()
      return sid
    }
    return null
  }
  const childName = sid => {
    if (!sid || sid === client.session_id) return null
    const hit = Object.values(state.children).find(c => c.session_id === sid)
    return hit?.name ?? model().sessions.get(sid)?.profile?.agent_name ?? sid.slice(0, 12)
  }
  /** The session a tool call writes into: null for the main session, else the named child (opened on first use). */
  async function sessionOf(args, profile = {}) {
    const name = args.session == null ? '' : String(args.session).trim()
    if (!name) return null
    if (name.length > 40 || /[\n\r]/.test(name)) throw new Error('session is a helper\'s short name, at most 40 characters')
    const found = findChild(name)
    if (found) { await reopen(found); return found }
    if (!client.openChildSession) throw new Error('this hub connection cannot open child sessions')
    const key = name.toLowerCase()
    if (!opening.has(key)) {
      const model_ = mySession()?.profile?.model
      opening.set(key, client.openChildSession({ profile: { agent_name: name, ...(model_ ? { model: model_ } : {}), ...profile } }).then(sid => {
        state.children[key] = { session_id: sid, name }
        saveState()
        log(`child session "${name}" opened: ${sid}`)
        return sid
      }).finally(() => opening.delete(key)))
    }
    return opening.get(key)
  }
  /** A closed child (close_session) that is written to again is open again: back in the human's active list. */
  async function reopen(sid) {
    const p = mySession(sid)?.profile
    if (!p?.closed_at) return
    const { closed_at, ...rest } = p
    await client.setStatus({ profile: rest }, { session_id: sid })
  }
  const into = sid => (sid ? { session_id: sid } : {})
  const myCards = () => [...model().cards.values()].filter(c => c.agent_device_id === me()).sort((a, b) => a.first_envelope_number - b.first_envelope_number)

  function findCard(ref) {
    const id = String(ref ?? '').trim().toLowerCase()
    if (!id) throw new Error('card_id is required')
    const mine = myCards()
    const hit = mine.find(c => c.object_id === id) ?? (id.length >= 4 ? mine.filter(c => c.object_id.startsWith(id)) : []).at(0)
    if (!hit || (hit.object_id !== id && mine.filter(c => c.object_id.startsWith(id)).length > 1)) throw new Error(`no card ${ref} of yours; list_cards shows your cards`)
    return hit
  }
  const placeOf = card => {
    const at = model().stack.indexOf(card.object_id)
    return at < 0 ? 'not in the stack yet' : `position ${at + 1} of ${model().stack.length} in the stack`
  }

  // Attachments given as absolute paths: encrypted here, uploaded, referenced (README "attachment reference").
  async function upload(entry, { objectId } = {}) {
    const given = entry && typeof entry === 'object' && !Array.isArray(entry) ? entry : { path: entry }
    const file = path.resolve(String(given.path ?? ''))
    if (!given.path || !fs.existsSync(file) || !fs.statSync(file).isFile()) throw new Error(`attachment not found: ${given.path}`)
    const size = fs.statSync(file).size
    if (size > MAX_ASSET) throw new Error(`${path.basename(file)} is ${Math.round(size / 1048576)} MB; at most ${MAX_ASSET / 1048576} MB`)
    const bytes = new Uint8Array(fs.readFileSync(file))
    const media_type = mediaTypeOf(file)
    const marks = [...(given.mark ? [given.mark] : []), ...listArg(given.marks, 'marks')].slice(0, 4).map(markOf).filter(Boolean)
    // The page this picture was rendered from: a local HTML file travels as an attachment of its own.
    let page = given.page ?? null
    let pageRef = null
    const sibling = media_type.startsWith('image/') && page == null ? ['.html', '.htm'].map(ext => file.replace(/\.[^.\/]+$/, ext)).find(f => f !== file && fs.existsSync(f)) : null
    const pageFile = typeof page === 'string' && !/^(https?:)?\//i.test(page) ? path.resolve(page) : typeof page === 'string' && page.startsWith('/') && fs.existsSync(page) ? page : sibling
    if (pageFile && fs.existsSync(pageFile) && fs.statSync(pageFile).isFile()) {
      pageRef = await client.uploadAttachment(new Uint8Array(fs.readFileSync(pageFile)), { file_name: path.basename(pageFile), media_type: mediaTypeOf(pageFile), object_id: objectId })
      page = `attachment:${pageRef.attachment_id}`
    }
    const ref = await client.uploadAttachment(bytes, {
      file_name: path.basename(file), media_type, ...(media_type.startsWith('image/') ? pictureSize(bytes) : {}),
      ...(given.title ? { caption: String(given.title) } : {}), ...(page ? { page: String(page) } : {}), object_id: objectId,
    })
    return { ref: { ...ref, ...(marks.length ? { marks } : {}) }, pageRef }
  }
  async function uploadAll(list) {
    const refs = []
    for (const entry of listArg(list, 'attachments')) {
      const { ref, pageRef } = await upload(entry)
      refs.push(ref)
      if (pageRef) refs.push({ ...pageRef, role: 'page' })
    }
    return refs
  }

  // Files the human sent: fetched, decrypted, written where Claude can read them.
  async function download(refs) {
    const paths = []
    let image = null
    for (const ref of listArg(refs, 'attachments')) {
      try {
        // A reference is body text from a human device: the id must be exactly an attachment id before it reaches a
        // URL or a file name, and the file must land inside the cache (review 2: path traversal).
        if (!ATTACHMENT_ID.test(String(ref?.attachment_id))) throw new Error('not an attachment id')
        const file = path.resolve(cacheDir, `${ref.attachment_id}-${safeName(ref.file_name)}`)
        if (path.dirname(file) !== path.resolve(cacheDir)) throw new Error('outside the cache')
        const bytes = await client.fetchAttachment(ref)
        fs.mkdirSync(cacheDir, { recursive: true, mode: 0o700 })
        fs.writeFileSync(file, bytes, { mode: 0o600, flag: 'w' })
        paths.push(file)
        if (!image && String(ref.media_type ?? mediaTypeOf(name)).startsWith('image/')) image = file
      } catch (err) {
        log(`attachment ${ref?.attachment_id} not readable: ${err.message}`)
      }
    }
    return { paths, image, names: listArg(refs, 'attachments').map(r => r.file_name || 'file') }
  }
  const fileMeta = got => (got.paths.length ? { files: got.paths.join(','), ...(got.image ? { image_path: got.image } : {}) } : {})
  const uploadLine = got => `The human sent ${got.names.length === 1 ? 'a file' : `${got.names.length} files`}: ${got.names.join(', ')}. The meta attribute files holds ${got.names.length === 1 ? 'its path' : 'their paths'}.`
  // The marks as the agent reads them: one line each, saying what it is pinned to (wording of today's board).
  const brief = (said, max = 80) => { const line = String(said).replace(/\s+/g, ' '); return line.length > max ? `${line.slice(0, max - 1)}…` : line }
  const marksBlock = (card, marks) => {
    const lines = listArg(marks, 'marks').filter(m => m && (m.text || m.strokes)).map(m => {
      const a = m.anchor ?? {}
      const option = a.key == null ? null : card?.options?.find(o => o.key === a.key)
      const section = a.kind === 'section' ? card?.sections?.[a.index] : null
      const where = a.kind === 'option' ? `on option "${option?.label ?? a.key}" [${a.key}]`
        : a.kind === 'section' ? (section?.key ? `on option "${section.label}" [${section.key}]` : `on the paragraph "${brief(section?.text ?? '', 50)}"`)
        : a.kind === 'picture' ? `on the picture ${card?.attachments?.[a.index]?.file_name ?? (a.index ?? 0) + 1}`
        : a.kind === 'text' ? `on the text "${brief(a.quote ?? '', 80)}"`
        : 'general'
      const drawn = m.strokes ? (m.text ? ' (also drawn; see the picture)' : '(drawn; see the picture)') : ''
      return `- ${where}: ${String(m.text ?? '').replace(/\s*\n\s*/g, ' ')}${drawn}`
    })
    return lines.length ? ['', 'Notes pinned to the card:', ...lines] : []
  }

  // The card as an agent reads it, for list_cards.
  const versionOf = c => c.object_version ?? c.versions?.length ?? 1
  const cardLine = c => {
    const open = c.object_state === 'open'
    const answer = c.answer
    return {
      id: c.object_id, kind: c.card_type, status: open ? 'open' : c.closed_how === 'answered' ? 'decided' : c.closed_how === 'shredded' ? 'shredded' : 'done',
      urgency: c.urgency, urgency_reason: c.urgency_reason ?? '', queue_position: model().stack.indexOf(c.object_id) + 1 || null,
      title: c.title, version: versionOf(c),
      ...(answer ? { answered_version: answer.bound_object_version, choice: answer.choices?.[0] ?? null, choices: answer.choices ?? [], note: answer.note ?? '', ...(answer.trusted ? { trusted: true } : {}) } : {}),
      ...(c.in_revision ? { with_agent: c.in_revision.by } : {}),
      multiple: Boolean(c.allows_multiple),
      ...(open ? { body: c.body ?? '', ...(c.html ? { html: c.html } : {}), options: c.options ?? [], recommended: c.recommended ?? null, ...(c.sections ? { sections: c.sections } : {}) } : {}),
      ...(c.merged_into_object_id ? { merged_into: c.merged_into_object_id } : {}),
      ...(c.merged_from_object_ids?.length ? { merged_from: c.merged_from_object_ids } : {}),
    }
  }

  async function revise(args) {
    const card = findCard(args.card_id)
    if (card.object_state === 'answered') {
      throw new Error(`card ${card.object_id} was already decided (choice: ${card.answer?.choices?.[0] ?? ''}); the human answered the question as it stood, so act on that answer, or call close_card and ask anew with create_decision`)
    }
    if (card.object_state !== 'open') throw new Error(`card ${card.object_id} is already done`)
    const FIELDS = ['title', 'body', 'options', 'sections', 'text', 'multiple', 'recommended', 'urgency', 'urgency_reason', 'attachments', 'html']
    if (!FIELDS.some(k => args[k] != null)) throw new Error(`nothing to revise: pass at least one of ${FIELDS.join(', ')}`)
    const info = card.card_type === 'info'
    const resection = args.sections != null || args.text != null
    const plain = args.body != null || args.options != null
    const options = args.options ?? card.options
    const multiple = args.multiple ?? card.allows_multiple
    const kept = [card.recommended ?? []].flat().filter(key => options.some(o => String(o?.key) === key))
    const urgency = args.urgency ?? card.urgency
    const wording = resection ? { sections: args.sections, text: args.text }
      : card.sections && !plain ? { sections: card.sections.map(s => (typeof s.picture === 'number' ? { ...s } : s)) }
      : { body: args.body ?? card.body, ...(info ? {} : { options }) }
    const attachments = args.attachments == null ? card.attachments ?? [] : await uploadAll(args.attachments)
    const names = attachments.map(a => a.file_name)
    const fields = (info ? infoFields : questionFields)({
      title: args.title ?? card.title, ...wording, ...(info ? {} : { multiple }), urgency,
      html: resection ? args.html : args.html ?? card.html ?? undefined,
      urgency_reason: args.urgency_reason ?? (urgency === card.urgency ? card.urgency_reason : ''),
      ...(info ? {} : { recommended: args.recommended != null ? (args.recommended.length ? args.recommended : NO_ADVICE) : resection ? undefined : multiple && Array.isArray(card.recommended) ? kept : kept[0] ?? NO_ADVICE }),
    }, names)
    await client.revise(card.object_id, { ...fields, attachments, change_note: String(args.note ?? '').trim() || null })
    return `card ${card.object_id} revised, now version ${versionOf(card) + 1}, ${placeOf(card)}${card.in_revision ? '; it is before the human again' : ''}${strippedHint()}`
  }

  // Read your own writes: what this agent sent is in the model before the next tool looks (a status line right
  // after create_decision names a card the hub has just confirmed). Costs nothing when nothing is pending.
  // A halted chain (the hub refused one of our envelopes for good) is not something to work around: say so, act on nothing.
  const caughtUp = () => client.settle().catch(err => {
    if (err.code === 'chain-halted') throw new Error('the hub refused one of this session\'s envelopes for good, so the channel stopped sending to keep its signed history intact. Nothing was sent. Tell the human in the terminal; the Trommi app shows the alert.')
    log(`not settled: ${err.message}`)
  })

  const SHARE_MAX_HOURS = 30 * 24
  function ownAsset(id) {
    const asset = [...model().published.values()].find(p => p.agent_device_id === me() && p.object_id === String(id ?? ''))
    if (!asset) throw new Error(`no asset ${id}; list_assets shows yours`)
    return asset
  }
  /** Ends every outsider link of an asset; returns how many were open. */
  async function unshare(object_id) {
    const open = (state.shares[object_id] ?? []).filter(s => s.expires_at > Date.now())
    for (const s of open) await client.revokeShare(s.share_id).catch(err => { if (err.code !== 'not-found') throw err })
    delete state.shares[object_id]
    saveState()
    return open.length
  }

  async function callTool(name, args) {
    if (!args || typeof args !== 'object') args = {}
    await caughtUp()
    switch (name) {
      case 'reply': {
        const card = args.card_id == null ? null : findCard(args.card_id)
        const text = cleanFences(String(args.text ?? ''), 'text')
        const html = htmlBeside(args.html, text)
        // A reply on a card that is with the agent stays a message on the card; it presents the card only when
        // asked (present: true) or as the answer to "Explain".
        const turn = card?.in_revision ?? null
        const present = Boolean(turn) && (args.present === true || (turn.by === 'explain' && args.present !== false))
        const sid = card ? null : await sessionOf(args)
        await client.sendMessage({ ...into(sid),
          text, ...(html ? { html } : {}), ...(args.details ? { details: cleanFences(String(args.details), 'details') } : {}),
          attachments: await uploadAll(args.attachments), ...(card ? { object_id: card.object_id } : {}), ...(present ? { present_card: true } : {}),
        })
        return `sent${turn && !present ? `; card ${card.object_id} stays with you (in revision): put it before the human again with revise_card, or with reply and present: true, when your work on it is done` : present ? `; card ${card.object_id} is before the human again` : ''}${strippedHint()}`
      }
      case 'create_decision': {
        const fields = questionFields(args, namesOf(args.attachments))
        const sid = await sessionOf(args)
        const attachments = await uploadAll(args.attachments)
        const id = await client.sendCard({ ...fields, attachments, ...into(sid) })
        await caughtUp()
        return `card ${id} created, ${placeOf({ object_id: id })}; the choice will arrive as a channel event${strippedHint()}`
      }
      case 'create_info': {
        const fields = infoFields(args, namesOf(args.attachments))
        const sid = await sessionOf(args)
        const attachments = await uploadAll(args.attachments)
        const id = await client.sendCard({ ...fields, attachments, ...into(sid) })
        return `info ${id} put on the board; when the human has read and closed it, info_read arrives, which needs no answer${strippedHint()}`
      }
      case 'revise_card':
        return revise(args)
      case 'merge_cards': {
        const ids = [...new Set(listArg(args.card_ids, 'card_ids').map(String))]
        if (ids.length < 2) throw new Error('merge_cards replaces at least two cards; to change one card use revise_card')
        const old = ids.map(findCard)
        for (const c of old) {
          if (c.card_type === 'info') throw new Error(`card ${c.object_id} is an info, not a question; infos are not merged. Rework it with revise_card or take it away with withdraw_card`)
          if (c.object_state === 'answered') throw new Error(`card ${c.object_id} was already decided; the human spent an answer on it, so act on it and merge only the open ones`)
          if (c.object_state !== 'open') throw new Error(`card ${c.object_id} is already done`)
        }
        const top = old.reduce((a, b) => (URGENCIES.indexOf(b.urgency) > URGENCIES.indexOf(a.urgency) ? b : a))
        const fields = questionFields({ ...args, urgency: args.urgency ?? top.urgency, urgency_reason: args.urgency_reason ?? (args.urgency == null ? top.urgency_reason : '') }, namesOf(args.attachments))
        const sid = await sessionOf(args)
        const attachments = await uploadAll(args.attachments)
        const id = await client.merge(old.map(c => c.object_id), { ...fields, attachments, ...into(sid) })
        return `card ${id} created, replacing ${old.map(c => c.object_id).join(', ')}; answers to the replaced cards will no longer arrive, the choice on this one will arrive as a channel event${strippedHint()}`
      }
      case 'set_urgency': {
        const card = findCard(args.card_id)
        const urgency = urgencyArg(args.urgency)
        if (card.object_state !== 'open') throw new Error(`card ${card.object_id} is ${card.object_state}; urgency only applies to open cards`)
        const changed = card.urgency !== urgency
        await client.setUrgency(card.object_id, urgency, String(args.reason ?? '').trim() || null)
        return `urgency ${changed ? 'set to' : 'already'} ${urgency}; the card keeps its place in the stack`
      }
      case 'withdraw_card': {
        const card = findCard(args.card_id)
        if (card.object_state === 'answered') throw new Error(`card ${card.object_id} was already decided (choice: ${card.answer?.choices?.[0] ?? ''}); the human spent an answer on it, so act on it or call close_card with a summary of why it no longer applies`)
        if (card.object_state !== 'open') throw new Error(`card ${card.object_id} is already done`)
        await client.withdraw(card.object_id, String(args.reason ?? '').trim())
        return 'withdrawn'
      }
      case 'close_card': {
        const card = findCard(args.card_id)
        await client.close(card.object_id, String(args.summary ?? ''))
        return 'closed'
      }
      case 'set_status': {
        const id = String(args.id ?? '').trim()
        if (!id) throw new Error('id is required')
        if (!STATUSES.includes(args.state)) throw new Error(`state must be one of ${STATUSES.join(', ')}; got "${args.state}"`)
        const sid = await sessionOf(args)
        const before = mySession(sid)?.status_lines?.find(s => s.id === id)
        if (!before && !args.label) throw new Error(`label is required for the new status line "${id}"`)
        const card = args.card_id ? findCard(args.card_id) : null
        await client.setStatus({ [`status_line/${id}`]: {
          label: String(args.label ?? before.label), state: args.state, detail: args.detail != null ? String(args.detail) : before?.detail ?? '',
          object_id: args.state === 'decision' ? card?.object_id ?? before?.object_id ?? null : null,
        } }, ...(sid ? [{ session_id: sid }] : []))
        return `status "${id}" is ${args.state}`
      }
      case 'clear_status': {
        const sid = await sessionOf(args)
        const lines = mySession(sid)?.status_lines ?? []
        const gone = args.id ? [String(args.id)] : lines.map(s => s.id)
        if (gone.length) await client.setStatus(Object.fromEntries(gone.map(id => [`status_line/${id}`, null])), ...(sid ? [{ session_id: sid }] : []))
        return 'cleared'
      }
      case 'introduce': {
        if (!args.model) throw new Error('model is required')
        const sid = await sessionOf(args)
        const was = mySession(sid)?.profile ?? {}
        await client.setStatus({ profile: {
          ...was, model: String(args.model), task: args.task != null ? String(args.task) : was.task ?? '',
          ...(args.icon != null ? { icon: String(args.icon) } : {}),
          ...(args.parent !== undefined ? { parent_session: args.parent ? String(args.parent) : null } : {}),
          ...(args.main !== undefined ? { is_main: args.main === true } : {}),
        } }, ...(sid ? [{ session_id: sid }] : []))
        return 'noted'
      }
      case 'list_cards': {
        const sid = args.session == null || args.session === '' ? undefined : findChild(String(args.session).trim())
        if (sid === null) throw new Error(`no child session "${args.session}"; open_session opens one`)
        return JSON.stringify(myCards().filter(c => sid === undefined || c.session_id === sid).map(c => {
          const line = cardLine(c), child = childName(c.session_id)
          return child ? { ...line, session: child } : line
        }), null, 2)
      }
      case 'open_session': {
        const name = String(args.name ?? '').trim()
        if (!name) throw new Error('name is required: the helper\'s short name, e.g. "Design"')
        const profile = { ...(args.task != null ? { task: String(args.task) } : {}), ...(args.icon != null ? { icon: String(args.icon) } : {}), ...(args.model != null ? { model: String(args.model) } : {}) }
        const existed = findChild(name)
        const sid = existed ?? await sessionOf({ session: name }, profile)
        if (existed) await reopen(existed)
        if (existed && Object.keys(profile).length) await client.setStatus({ profile: { ...(mySession(sid)?.profile ?? {}), ...profile } }, { session_id: sid })
        return `${existed ? 'child session already open' : 'child session opened'}: "${name}" (${sid}), under your session on the board. Pass session: "${name}" to reply, create_decision, create_info, merge_cards, set_status, clear_status, introduce, list_cards and publish_asset to write into it; the human's messages and answers there arrive with meta session="${name}".`
      }
      case 'close_session': {
        const name = String(args.name ?? args.session ?? '').trim()
        if (!name) throw new Error('name is required: the helper\'s short name, as given to open_session')
        const sid = findChild(name)
        if (!sid) throw new Error(`no child session "${name}"; open_session opens one`)
        if (args.summary != null && String(args.summary).trim()) await client.sendMessage({ session_id: sid, text: cleanFences(String(args.summary), 'summary'), attachments: [] })
        const s = mySession(sid)
        // A helper that is done works on nothing: its lines would keep saying "working" (and look stuck).
        const lines = s?.status_lines ?? []
        if (lines.length) await client.setStatus(Object.fromEntries(lines.map(l => [`status_line/${l.id}`, null])), { session_id: sid })
        await client.setStatus({ profile: { ...(s?.profile ?? {}), closed_at: Date.now() } }, { session_id: sid })
        const open = myCards().filter(c => c.session_id === sid && c.object_state === 'open').length
        return `child session "${name}" closed: archived on the board, still readable there${open ? `; ${open} open question${open === 1 ? '' : 's'} of it stay${open === 1 ? 's' : ''} on the human's stack, and the session stays in the active list until ${open === 1 ? 'it is' : 'they are'} answered` : ''}. open_session("${name}") opens it again.`
      }
      case 'publish_asset': {
        if (args.silent === true) throw new Error('silent assets are not available on the new hub yet: publish it without silent, or attach the file to a reply')
        if (args.path == null && args.content == null) throw new Error('give path or content')
        if (args.type != null && !ASSET_TYPES.includes(args.type)) throw new Error(`type must be one of ${ASSET_TYPES.join(', ')}`)
        let ref
        if (args.path != null) ({ ref } = await upload(String(args.path)))
        else {
          const bytes = new TextEncoder().encode(String(args.content))
          if (bytes.length > MAX_ASSET) throw new Error('content is too large')
          const media_type = args.type && args.type !== 'html' ? 'application/octet-stream' : 'text/html'
          ref = await client.uploadAttachment(bytes, { file_name: `${String(args.title || 'page').replace(/[^\w.-]+/g, '-').slice(0, 60)}.html`, media_type })
        }
        const title = String(args.title || ref.file_name)
        const asset = { ...ref, asset_type: args.type ?? assetTypeOf(ref.media_type) }
        const note = args.note ? String(args.note) : null
        const sid = await sessionOf(args)
        const id = await client.publish({ attachments: [asset], title, ...(note ? { note } : {}), ...into(sid) })
        // Announced in the session's conversation, as today's board did: a message carrying the published object.
        await client.sendMessage({ ...into(sid), text: [`**${title}**`, note].filter(Boolean).join('\n\n'), attachments: [asset], published_object_id: id })
        return `published as ${id}: "${title}" is shown in your conversation on the board, end-to-end encrypted; members open it in the Trommi app. For someone outside the board: share_asset.`
      }
      case 'list_assets':
        return JSON.stringify([...model().published.values()].filter(p => p.agent_device_id === me() && p.object_state !== 'closed').map(p => ({
          id: p.object_id, title: p.title, note: p.note ?? '', state: p.object_state,
          type: p.attachments?.[0]?.asset_type ?? assetTypeOf(p.attachments?.[0]?.media_type ?? ''), size: p.attachments?.[0]?.total_size ?? null,
          released_until: Math.max(0, ...(state.shares[p.object_id] ?? []).map(x => x.expires_at)) || null,
        })), null, 2)
      case 'revoke_asset': {
        const asset = ownAsset(args.id)
        await unshare(asset.object_id)
        await client.unpublish(asset.object_id)
        return 'revoked: the asset is taken off the board'
      }
      case 'share_asset': {
        const asset = ownAsset(args.id)
        if (args.release === false) {
          const n = await unshare(asset.object_id)
          return n ? 'release taken back: the link for outsiders no longer opens anything. The asset itself is still there.' : 'it was not released'
        }
        const hours = Number(args.expires_hours) > 0 ? Number(args.expires_hours) : SHARE_MAX_HOURS
        if (hours > SHARE_MAX_HOURS) throw new Error(`a release lasts at most ${SHARE_MAX_HOURS / 24} days; expires_hours ${hours} is too long`)
        const { share_id, link, expires_at } = await client.shareAttachment(asset.attachments[0], { expires_at: Date.now() + hours * 3600000 })
        ;(state.shares[asset.object_id] ??= []).push({ share_id, expires_at })
        saveState()
        return [
          `asset ${asset.object_id} is released until ${new Date(expires_at).toISOString()}.`,
          `Link for the recipient: ${link}`,
          'It opens a plain viewer without the board; the key is after the #, the hub never sees it. share_asset with release: false or revoke_asset ends it.',
        ].join('\n')
      }
      case 'adopt_session':
        throw new Error('adopt_session is not available on the new hub: a session\'s profile is signed by that session alone. Ask the helper to call introduce with parent set to your session id.')
      case 'create_voiceover':
        throw new Error('create_voiceover is not available on the new hub yet; use the old board (server "board") for narration.')
    }
    throw new Error(`unknown tool: ${name}`)
  }

  // ---- Claude Code asks for approval: a permission request object -----------------------------------
  const asking = new Set()   // request ids on their way to the hub: a repeat while the first is sealed is the same request
  async function permissionRequest(params) {
    if (asking.has(params.request_id) || Object.values(state.permissions).includes(params.request_id)) return
    asking.add(params.request_id)
    try {
      const id = await client.requestPermission({
        tool_name: String(params.tool_name), description: String(params.description ?? ''), input_preview: String(params.input_preview ?? ''), expires_in_ms: 10 * 60 * 1000,
      })
      state.permissions[id] = params.request_id
      saveState()
      return id
    } finally { asking.delete(params.request_id) }
  }

  // ---- a human's command (already verified and authorised by the core) -> a channel event ------------
  async function command(cmd) {
    const c = cmd.content ?? {}
    const card = cmd.object_id ? model().cards.get(cmd.object_id) : null
    const title = card?.title ?? cmd.object_id ?? ''
    // late: the human had not seen this agent's newest envelope; history: older than what this process had
    // delivered before it lost its state, context only, never a new prompt (README R4).
    // A command in a child session (a helper's) names it, so the main agent hands it to that helper.
    const child = childName(cmd.session_id ?? card?.session_id ?? null)
    const flags = { ...(cmd.late ? { late: '1' } : {}), ...(cmd.history ? { history: '1' } : {}), ...(child ? { session: child } : {}) }
    const send = (content, meta) => notify('notifications/claude/channel', { content: cmd.history ? `(Earlier message, for context only; not a new request.)\n${content}` : content, meta: { ...meta, ...flags } })
    switch (cmd.command) {
      case 'message': {
        // Only a message counts as chat; strokes and other timeline items are never commands (README R1/R4).
        if (c.content_type && c.content_type !== 'message') return log(`timeline item ${c.content_type} not relayed`)
        // A human's present_card on a card it had handed back is "take back": the agent need not rework it (as today's board).
        if (c.present_card && card?.agent_device_id === me()) return send(`The human took "${title}" back; there is no need to rework or explain it.`, { kind: 'handback_withdrawn', card_id: card.object_id })
        const got = await download(c.attachments)
        const about = card && card.agent_device_id === me() && card.object_state === 'open' ? { card_id: card.object_id } : {}
        const copied = listArg(c.copied_cards, 'copied_cards')
        const marks = listArg(c.marks, 'marks')
        const text = String(c.text ?? '').trim()
        return send([
          text || (got.names.length ? uploadLine(got) : copied.length ? `The human passes ${copied.length === 1 ? 'a card' : `${copied.length} cards`} on to you.` : 'The human pinned notes to the card.'),
          ...marksBlock(card, marks),
          ...copied.flatMap(k => ['', typeof k === 'string' ? k : k.text ?? JSON.stringify(k)]),
        ].join('\n'), {
          kind: 'chat', ...about, ...(about.card_id && c.hand_back ? { handback: '1' } : {}), ...(about.card_id && c.explain ? { explain: '1' } : {}),
          ...(marks.length ? { marks: String(marks.length) } : {}),
          ...(copied.length ? { cards: copied.map(k => k.object_id ?? k.id ?? '').join(','), cards_json: JSON.stringify(copied) } : {}),
          ...fileMeta(got),
        })
      }
      case 'answer': case 'trust': {
        const choices = cmd.choices ?? c.choices ?? []
        if (cmd.command === 'trust' || c.trusted) {
          const advised = [card?.recommended ?? []].flat()
          const labels = advised.map(k => `${card?.options?.find(o => o.key === k)?.label ?? k} [${k}]`)
          return send([
            `The human trusts you with "${title}": decide yourself (${advised.length ? `your advice was: ${labels.join(', ')}` : 'you gave no advice'}). Say in one line what you chose with reply and this card_id, then close_card; do not ask again.`,
            ...(c.note ? ['', `Their note: ${c.note}`] : []),
          ].join('\n'), { kind: 'decision', card_id: cmd.object_id, choice: choices[0] ?? advised[0] ?? '', ...(card?.allows_multiple ? { choices: (choices.length ? choices : advised).join(',') } : {}), trust: '1' })
        }
        const got = await download(c.attachments)
        const notes = c.option_notes && typeof c.option_notes === 'object' ? c.option_notes : {}
        const remarked = (card?.options ?? []).filter(o => notes[o.key])
        const marks = listArg(c.marks, 'marks')
        return send([
          c.note || `Decision on "${title}": ${choices.join(', ')}`,
          ...(remarked.length ? ['', 'Notes on options:', ...remarked.map(o => `- ${o.label} [${o.key}], ${choices.includes(o.key) ? 'chosen' : 'not chosen'}: ${String(notes[o.key]).replace(/\s*\n\s*/g, ' ')}`)] : []),
          ...marksBlock(card, marks),
        ].join('\n'), {
          kind: 'decision', card_id: cmd.object_id, choice: choices[0] ?? '', ...(card?.allows_multiple ? { choices: choices.join(',') } : {}),
          ...(remarked.length ? { option_notes: remarked.map(o => o.key).join(',') } : {}), ...(marks.length ? { marks: String(marks.length) } : {}), ...fileMeta(got),
        })
      }
      case 'read':
        return send(`The human read "${title}" and closed it. Nothing is expected of you.`, { kind: 'info_read', card_id: cmd.object_id })
      case 'shred': {
        const got = await download(c.attachments)
        const marks = listArg(c.marks, 'marks')
        return send([
          card?.card_type === 'info' ? `The human threw "${title}" away unread. Do not send it again.`
            : `The human threw the question "${title}" away unanswered. That is neither a yes nor a no. Do not ask it again, in these or other words; carry on without an answer, using your own judgement, or drop the matter.`,
          ...(c.note ? ['', `Their note: ${c.note}`] : []),
          ...marksBlock(card, marks),
        ].join('\n'), { kind: 'shredded', card_id: cmd.object_id, ...(marks.length ? { marks: String(marks.length) } : {}), ...fileMeta(got) })
      }
      case 'decide_again': {
        const was = card?.answers?.findLast(a => a.taken_back_at != null) ?? null
        // An info read and then taken back lies unread again; the agent has nothing to undo and is not told (as today's board).
        if (card?.card_type === 'info' && was?.answer_action === 'read') return
        const previous = cmd.previous_choices ?? was?.choices ?? []
        if (was?.answer_action === 'shred') {
          return send(`The human took "${title}" back out of the shredder; it is open again${card?.card_type === 'info' ? '' : ' and they may answer it after all'}.`, { kind: 'decision_reopened', card_id: cmd.object_id, previous_choice: '', shredded: '1' })
        }
        if (was?.trusted) {
          return send(`The human took back leaving "${title}" to you. Stop acting on what you chose, undo what you safely can, and wait for their answer.`, { kind: 'decision_reopened', card_id: cmd.object_id, previous_choice: previous[0] ?? '', ...(card?.allows_multiple ? { previous_choices: previous.join(',') } : {}), trust: '1' })
        }
        const label = previous.map(k => card?.options?.find(o => o.key === k)?.label ?? k).join(', ')
        return send(`The human took back their answer "${label}" on "${title}". Stop acting on it, undo what you safely can, and wait for the new choice.`, {
          kind: 'decision_reopened', card_id: cmd.object_id, previous_choice: previous[0] ?? '', ...(card?.allows_multiple ? { previous_choices: previous.join(',') } : {}),
        })
      }
      case 'verdict': {
        const request_id = state.permissions[cmd.object_id]
        if (!request_id) return log(`verdict for an unknown permission request ${cmd.object_id}`)
        delete state.permissions[cmd.object_id]
        saveState()
        return notify('notifications/claude/channel/permission', { request_id, behavior: cmd.allow ?? c.allow ? 'allow' : 'deny' })
      }
      case 'selection_sent': {
        const got = await download(c.attachments)
        return send(String(c.text ?? '').trim() || 'The human selected part of the pad and sent it to you. image_path shows exactly the selection.', {
          kind: 'pad', pad: 'global', message_id: String(cmd.envelope_number), elements: listArg(c.stroke_ids, 'stroke_ids').join(','), ...fileMeta(got),
        })
      }
    }
    log(`command ${cmd.command} not relayed`)
  }

  return { callTool, permissionRequest, command }
}
