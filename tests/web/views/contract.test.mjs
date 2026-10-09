// contract.test.mjs: what the views take from the layer under them, read out of the views' own sources, against
// what that layer gives. The views are app/web/public/*.mjs and the demo room; the layer is app/web/core as the
// build hands it over (gen/vendor/index.mjs, account-remote.mjs, scribble.mjs, work.mjs, check-emoji.mjs,
// qr-decode.mjs, remote.mjs) and the client a page holds (remote.ts RemoteClient, with worker-protocol.ts CALLS).
//   node --test tests/web/views/
//
// It fails on
//   - a name a view reads from one of those modules that the module does not export;
//   - a member of the client a view uses that RemoteClient does not have, and a call the worker would refuse;
//   - a call whose object argument names a field the Client's method does not take, or that has more arguments;
//   - a field of the model, the room, the human registers or a record that types.ts does not name; and any read of
//     a field that protocol v1's model had and this one has not (REMOVED, by name, anywhere in the views);
//   - a call the views make that the demo room's client does not have, unless the view asks first (GUARDED).
//
// How it reads (tests/web/views/sources.mjs says what no such reading can see):
//   modules   `const { a, b } = await core()`, `(await account()).a`, `account().then(A => A.a(…))`, and a name the
//             module is kept under (`const A = await account()`, `k = x` inside `core().then(x => …)`): every `A.a`
//             in the block that declares A. core() is index.mjs plus account-remote's joinRoom (app.mjs).
//   client    every `client.a` and `client?.a` in any view (the name `client` is the client everywhere in them;
//             the hub facade of app.mjs, `hub.*`, reaches the core only through it), and `hub.client.a`.
//   arguments `client.a({ … })`: the top-level keys of the literal; `client.a(x, y)`: how many arguments.
//   model     `X.model.a`, `X.model.room.a`, `X.model.human.a`, the same through a name the model is kept under in
//             that block (`const m = client.model`, `m = this.model`, `const m = () => client.model` and `m().a`),
//             and the fields of a record taken straight from one of the model's maps: `M.sessions.get(k)?.a`,
//             `for (const s of M.sessions.values())`, `[...M.cards.values()].filter(c => c.a)`, `const s = M.sessions.get(k)`.
//             Where a view takes a record as a parameter, TYPED below says what it is (the functions of app.mjs and
//             auth.mjs that turn the model's records into what the views show). A record that reaches a view any
//             other way is not followed; for those only the REMOVED names are caught.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { CORE, blockAround, closing, interfacesOf, keysOf, lineOf, listParts, methodParams, viewSources } from './sources.mjs'

const sources = viewSources()
const core = name => import(path.join(CORE, name))
const where = (s, at) => `${s.name}:${lineOf(s.text, at)}`

// ---- what the layer gives ----
const index = await core('index.ts'), accountRemote = await core('account-remote.ts')
const MODULES = {
  core: new Set([...Object.keys(index), 'joinRoom']),
  account: new Set(Object.keys(accountRemote)),
  scribbleWire: new Set(Object.keys(await core('scribble.ts'))),
  qrReader: new Set(Object.keys(await core('qr-decode.mjs'))),
}
/** A module a view imports by its built address: gen/vendor/<name>.mjs is app/web/core/<name>.ts (dev/build.mjs). */
const VENDOR = { 'index.mjs': 'index.ts', 'account-remote.mjs': 'account-remote.ts', 'check-emoji.mjs': 'check-emoji.ts', 'work.mjs': 'work.ts', 'scribble.mjs': 'scribble.ts', 'qr-decode.mjs': 'qr-decode.mjs', 'remote.mjs': 'remote.ts' }
const { CALLS, ACCOUNT_CALLS, ACCOUNT_OPENS } = await core('worker-protocol.ts')
const { RemoteClient } = await core('remote.ts')
const { Client } = await core('client.ts')
const { emptyModel } = await core('model-shape.ts')
const remote = new RemoteClient({ postMessage() {}, terminate() {} }, emptyModel(), {})
const REMOTE = new Set([...Object.keys(remote), ...Object.getOwnPropertyNames(RemoteClient.prototype)].filter(k => k !== 'constructor'))
const TYPES = interfacesOf(path.join(CORE, 'types.ts'))
const fieldsOf = name => { const t = TYPES.get(name); assert.ok(t, `types.ts has no interface ${name}`); return new Set(t.fields) }

// ---- reading the views ----

/** Every `<name>.<member>` of a name in [from, to) of a source's code: [member, position]. Not `x.<name>.<member>`
 *  unless `anyOwner`. */
function membersOf(code, name, from = 0, to = code.length, anyOwner = false) {
  const out = []
  const re = new RegExp(`${anyOwner ? '' : '(?<![\\w$.])'}${name.replace(/[$()]/g, '\\$&')}\\??\\.([A-Za-z_$][\\w$]*)`, 'g')
  re.lastIndex = from
  for (let m; (m = re.exec(code)) && m.index < to;) out.push([m[1], m.index])
  return out
}
/** Where a name is declared before `at` (let/const, or a parameter of the enclosing function): the block it lives in. */
function scopeOf(code, name, at) {
  const decl = [...code.slice(0, at + 1).matchAll(new RegExp(`\\b(?:let|const|var)\\s[^;\\n]*?\\b${name}\\b`, 'g'))].at(-1)
  return blockAround(code, decl ? decl.index : at)
}

const LOADERS = Object.keys(MODULES)
/** [module, name read, source, position] for every read of a core module's export the patterns above find. */
function moduleReads() {
  const reads = []
  for (const s of sources) {
    const { code } = s
    for (const loader of LOADERS) {
      const call = `${loader}\\(\\)(?:\\.catch\\([^)]*\\)\\))?`
      // const { a, b } = await loader()
      for (const m of code.matchAll(new RegExp(`\\{([^{}=]*)\\}\\s*=\\s*await ${call}`, 'g'))) for (const k of keysOf(code, m.index).keys) reads.push([loader, k, s, m.index])
      // (await loader()).a
      for (const m of code.matchAll(new RegExp(`\\(await ${call}\\)\\.([A-Za-z_$][\\w$]*)`, 'g'))) reads.push([loader, m[1], s, m.index])
      // loader().then(A => …): A.a inside the arrow; `k = A` there keeps the module under k
      for (const m of code.matchAll(new RegExp(`${call}\\.then\\(\\s*\\(?([A-Za-z_$][\\w$]*)\\)?\\s*=>`, 'g'))) {
        const open = code.indexOf('(', m.index + loader.length + 2), end = closing(code, open)
        for (const [k, at] of membersOf(code, m[1], m.index, end)) reads.push([loader, k, s, at])
        const kept = new RegExp(`([A-Za-z_$][\\w$]*)\\s*=\\s*${m[1]}\\b`).exec(code.slice(m.index, end))
        if (kept) { const [from, to] = scopeOf(code, kept[1], m.index); for (const [k, at] of membersOf(code, kept[1], from, to)) if (at < m.index || at > end) reads.push([loader, k, s, at]) }
      }
      // A = await loader()
      for (const m of code.matchAll(new RegExp(`(?<![\\w$.])([A-Za-z_$][\\w$]*)\\s*=\\s*await ${call}`, 'g'))) {
        const [from, to] = blockAround(code, m.index)
        for (const [k, at] of membersOf(code, m[1], Math.max(from, m.index), to)) reads.push([loader, k, s, at])
        // const { a } = A
        for (const d of code.slice(from, to).matchAll(new RegExp(`\\{([^{}=]*)\\}\\s*=\\s*${m[1]}\\b`, 'g'))) for (const k of keysOf(code, from + d.index).keys) reads.push([loader, k, s, from + d.index])
        // has(A, 'a'): the name is text, read from the source
        for (const d of s.text.slice(from, to).matchAll(new RegExp(`\\bhas\\(${m[1]}, '([\\w$]+)'\\)`, 'g'))) reads.push([loader, d[1], s, from + d.index])
      }
    }
  }
  return reads
}
/** [file of app/web/core, name read, source, position] for a module imported by its address under gen/vendor. */
function vendorReads() {
  const reads = []
  for (const s of sources) {
    for (const m of s.text.matchAll(/import\('\.\/gen\/vendor\/([\w-]+\.mjs)'\)/g)) {
      const file = VENDOR[m[1]] ?? null, { code } = s, after = code.slice(m.index + m[0].length)
      if (m[1] === 'core-worker.mjs' || m[1] === 'proof-worker.mjs') continue
      if (!file) { reads.push([m[1], null, s, m.index]); continue }
      // (await import(…)).a   and   import(…).then(m => { x = m.a })   and   .then(m => { x = m }) with x.a anywhere
      const direct = /^\)\.([A-Za-z_$][\w$]*)/.exec(after)
      if (direct) reads.push([file, direct[1], s, m.index])
      const then = /^\.then\(\s*\(?([A-Za-z_$][\w$]*)\)?\s*=>/.exec(after)
      if (!then) continue
      const open = m.index + m[0].length + 5, end = closing(code, open)
      for (const [k, at] of membersOf(code, then[1], open, end)) reads.push([file, k, s, at])
      const kept = new RegExp(`([A-Za-z_$][\\w$]*)\\s*=\\s*${then[1]}\\s*\\}`).exec(code.slice(open, end))
      if (kept) for (const [k, at] of membersOf(code, kept[1])) reads.push([file, k, s, at])
    }
  }
  return reads
}

/** Every member of the client a view names: [member, source, position, guarded]. `guarded`: the view asks whether
 *  it is there (`client.a?.(`, `typeof client.a`, `client.a &&`, `!client.a`, `client?.a?.b`) instead of using it. */
function clientUses() {
  const uses = []
  for (const s of sources) {
    if (s.name === 'demo/demo.mjs') continue   // (the demo's own client, and its hooks on window.trommi)
    for (const [k, at] of membersOf(s.code, 'client', 0, s.code.length, true)) {
      const before = s.code.slice(Math.max(0, at - 24), at), after = s.code.slice(at).replace(/^client\??\.[\w$]+/, '')
      if (/\b(?:req|e|event)\.$/.test(before)) continue   // (not the client: a request's own)
      const guarded = /^\?\.|^\s*(?:&&|\?|===? 'function')/.test(after) || /typeof\s+(?:[\w$.?]+\.)?$|!\s*(?:[\w$.?]+\.)?$/.test(before) || (/\bif\s*\(\s*(?:[\w$.?]+\.)?$/.test(before) && /^\s*\)/.test(after))
      uses.push([k, s, at, guarded])
    }
  }
  return uses
}

// ---- 1. modules ----

test('every name a view reads from a module of the core is exported by it', async () => {
  const missing = [], seen = new Set()
  for (const [loader, name, s, at] of moduleReads()) {
    seen.add(`${loader}.${name}`)
    if (!MODULES[loader].has(name)) missing.push(`${where(s, at)}  ${loader}().${name}`)
  }
  for (const [file, name, s, at] of vendorReads()) {
    if (name === null) { missing.push(`${where(s, at)}  imports gen/vendor/${file}, which this test does not know`); continue }
    seen.add(`${file}:${name}`)
    if (!(name in await core(file))) missing.push(`${where(s, at)}  ${file} exports no ${name}`)
  }
  // (the reading works at all: these are read by the views today)
  for (const k of ['core.parseShareLink', 'account.accountStatus', 'account.generatePassword', 'scribbleWire.CanvasState', 'scribbleWire.deskBoard', 'qrReader.decodeQR', 'core.roomLink', 'core.parseRoomLink', 'remote.ts:openRemote', 'check-emoji.ts:checkEmoji']) assert.ok(seen.has(k), `the scan no longer finds ${k}: its patterns are out of step with the views`)
  assert.deepEqual(missing, [], 'names the views read that the core does not export')
})

test('the account steps the page names are the ones the worker runs', () => {
  const text = readText(path.join(CORE, 'account-remote.ts'))
  const calls = [...new Set([...text.matchAll(/onClient(?:<[^>]*>)?\('(\w+)'/g)].map(m => m[1]))]
  const opens = [...new Set([...text.matchAll(/opening(?:<[^>]*>)?\('(\w+)'/g)].map(m => m[1]))]
  assert.ok(calls.length > 5 && opens.length > 5, 'account-remote.ts names its steps as this test reads them')
  assert.deepEqual(calls.filter(c => !ACCOUNT_CALLS.includes(c)), [], 'account-remote.ts calls a step the worker refuses (ACCOUNT_CALLS)')
  assert.deepEqual(opens.filter(c => !ACCOUNT_OPENS.includes(c)), [], 'account-remote.ts opens with a step the worker refuses (ACCOUNT_OPENS)')
})
function readText(file) { return fs.readFileSync(file, 'utf8') }

// ---- 2. the client ----

/** Members a view may name although the page's client has none: each is asked for before it is used. */
const GUARDED = {
  usage: 'Settings → storage: the hub\'s numbers; no client of main had it either, the line says "unknown"',
  store: 'the demo room\'s own items (whiteboard.mjs reads them only where there is no core)',
}
/** Not the room's client: the router's request object is called `client` in these two views. */
const REQUEST = new Set(['params', 'view'])

test('every member of the client the views use is one the page\'s client has', () => {
  const uses = clientUses().filter(([k]) => !REQUEST.has(k))
  const missing = uses.filter(([k, , , guarded]) => !REMOTE.has(k) && !(guarded && k in GUARDED)).map(([k, s, at]) => `${where(s, at)}  client.${k}`)
  assert.deepEqual(missing, [], 'members of the client the views use that RemoteClient does not have')
  const used = new Set(uses.map(([k]) => k))
  for (const k of ['sendMessage', 'answer', 'setRegisters', 'loadTimeline', 'model', 'on', '_setRoom', 'hub', 'createInvite']) assert.ok(used.has(k), `the scan no longer finds client.${k}`)
  for (const k of Object.keys(GUARDED)) assert.ok(uses.some(([name, , , guarded]) => name === k && guarded), `GUARDED lists ${k}, which no view asks for any more`)
})

test('every call the page may make is a method of the Client, and the worker takes it', () => {
  const methods = new Set(Object.getOwnPropertyNames(Client.prototype))
  assert.deepEqual(CALLS.filter(c => !methods.has(c)), [], 'CALLS names a method the Client does not have')
  // hub.* of the page's client
  const hubUses = new Set()
  for (const s of sources) for (const m of s.code.matchAll(/\bclient\??\.hub\??\.([A-Za-z_$][\w$]*)/g)) hubUses.add(m[1])
  assert.deepEqual([...hubUses].filter(k => !(k in remote.hub)), [], 'members of client.hub the views use that the page\'s client does not have')
})

test('the demo room\'s client has every call the views make without asking', async () => {
  const text = readText(path.join(CORE, '../public/demo/demo.mjs')), code = sources.find(s => s.name === 'demo/demo.mjs').code
  const at = code.indexOf('class MockClient'), end = closing(code, code.indexOf('{', at))
  const has = new Set([...code.slice(at, end).matchAll(/\n {2}(?:async\s+)?([A-Za-z_$][\w$]*)\s*\(/g)].map(m => m[1]))
  for (const m of text.slice(at, end).matchAll(/\bthis\.([A-Za-z_$][\w$]*)\s*=/g)) has.add(m[1])
  /** Calls only a real room has; the view that makes each one is reached only with a real room, or asks first. */
  const REAL_ONLY = {
    sendStrokes: 'whiteboard.mjs: `real` is whether the client has it; the demo\'s board lives in the page',
    sendStrokePiece: 'whiteboard.mjs: behind `real`',
    loadTimelineAfter: 'whiteboard.mjs: behind `real`',
    _setRoom: 'auth.mjs: the account of a real room (every use stands behind `client.hub`)',
    hub: 'what tells a real room from the demo',
    leaveRoom: 'auth.mjs logout: behind `client.hub`',
    pushSubscribe: 'app.mjs push: behind `client.hub?.pushKey`',
    pushStates: 'app.mjs push: behind `client.hub?.pushKey`',
    setDesk: null, storage: null, off: null, stop: null, my_device_id: null,
  }
  const missing = clientUses().filter(([k, , , guarded]) => !REQUEST.has(k) && !has.has(k) && !guarded && !(k in REAL_ONLY)).map(([k, s, at2]) => `${where(s, at2)}  client.${k}`)
  assert.deepEqual([...new Set(missing)], [], 'calls the views make that the demo room\'s client lacks')
})

// ---- 3. arguments ----

test('the fields and the number of arguments of every call fit the Client\'s method', () => {
  const params = methodParams(path.join(CORE, 'client.ts'), 'Client')
  const wrong = []
  let checked = 0
  for (const s of sources) {
    if (s.name === 'demo/demo.mjs') continue
    for (const m of s.code.matchAll(/\bclient\??\.([A-Za-z_$][\w$]*)\(/g)) {
      const want = params.get(m[1])
      if (!want || !CALLS.includes(m[1])) continue
      const open = m.index + m[0].length - 1
      const args = listParts(s.code, open)
      if (args.some(([from, to]) => s.code.slice(from, to).trim().startsWith('...'))) continue
      if (args.length > want.length) wrong.push(`${where(s, m.index)}  client.${m[1]}: ${args.length} arguments, the method takes ${want.length}`)
      args.forEach(([from, to], i) => {
        const at = from + s.code.slice(from, to).search(/\S/)
        if (s.code[at] !== '{' || closing(s.code, at) !== to - 1 - (s.code.slice(from, to).length - s.code.slice(from, to).trimEnd().length)) return
        const given = keysOf(s.code, at), takes = want[i]
        checked++
        if (!takes?.keys) return   // (a parameter the method does not take apart: an open record)
        if (takes.rest) return
        for (const k of given.keys) if (!takes.keys.includes(k)) wrong.push(`${where(s, at)}  client.${m[1]}({ ${k} }): the method takes { ${takes.keys.join(', ')} }`)
      })
    }
  }
  assert.ok(checked > 15, `only ${checked} calls with an object argument were found: the scan is out of step with the views`)
  // KNOWN, and the same on main: shredding a card with a pinned mark or a file hands both to client.shred, which
  // takes { object_id, note } and drops them (client.answer would take them). For client.ts to widen; listed here
  // so that it is seen, and so that this test says when it is done.
  const KNOWN = ['client.shred({ marks })', 'client.shred({ attachments })']
  const beyond = wrong.filter(w => !KNOWN.some(k => w.includes(k)))
  assert.deepEqual(beyond, [], 'calls whose arguments the Client does not take')
  assert.deepEqual(KNOWN.filter(k => !wrong.some(w => w.includes(k))), [], 'KNOWN lists a gap that is closed: take it off the list')
})

// ---- 4. the model ----

/** Fields of protocol v1's model that this one does not have (types.ts of main against types.ts here). A view that
 *  reads one reads `undefined`. By name, in any view: `receiver` narrows a name that other things carry too. */
const REMOVED = [
  { name: 'last_entry_number', of: 'Room' }, { name: 'ever_agent_ids', of: 'Session' }, { name: 'epoch_agent_ids', of: 'Session' },
  { name: 'desk_goals', of: 'Session' }, { name: 'desk_goals_at', of: 'Session' }, { name: 'refused_head', of: 'Card' },
  { name: 'newest_human_envelope_number', of: 'Timeline' }, { name: 'newest_agent_envelope_number', of: 'Timeline' },
  { name: '_device_registers', of: 'Model' }, { name: '_proj', of: 'Model' }, { name: 'object_type', of: 'CardBody' },
]
/** What the page itself puts on model.room (auth.mjs, through client._setRoom): the account's state. */
function pageRoomFields() {
  const out = new Set()
  for (const s of sources) for (const m of s.code.matchAll(/_setRoom\(\{/g)) for (const k of keysOf(s.code, m.index + m[0].length - 1).keys) out.add(k)
  return out
}
const MAPS = { sessions: 'Session', members: 'Member', cards: 'Card', permissions: 'PermissionRequest', notes: 'Note', published: 'Published', timelines: 'Timeline', invites: 'Invite' }
/** Fields the app itself keeps on a record whose type is open (types.ts says so for notes and invites). */
const APP_FIELDS = {
  Note: ['created_at', 'updated_at', 'attachments', 'held', 'removed'],
  Invite: ['session_id', 'takeover', 'with_history', 'desk', 'confirm_code'],
}

/** The names the model goes by in a source: [expression as a regular expression, from, to]. */
function modelNames(s) {
  // the core's model is `client.model` everywhere, and `this.model` in app.mjs's BoardState (the views' own `model`,
  // the board as they show it, is another thing)
  const { code } = s, base = `(?:\\bclient\\??\\.model${s.name === 'app.mjs' ? '|\\bthis\\.model' : ''})`
  const out = [[base, 0, code.length]]
  for (const m of code.matchAll(new RegExp(`(?<![\\w$.])([A-Za-z_$][\\w$]*)\\s*=\\s*(\\(\\)\\s*=>\\s*)?(?:[\\w$.?]+\\.)?${base}(?![ \\t]*[.(?\\w])`, 'g'))) {
    const [from, to] = blockAround(code, m.index)
    out.push([m[2] ? `(?<![\\w$.])${m[1]}\\(\\)` : `(?<![\\w$.])${m[1]}`, Math.max(from, m.index), to])
  }
  return out
}
/**
 * Where a view takes a record of the model as a parameter, so that no pattern can tell what it is: the function, by
 * the text it starts with, and what its names hold. The names count in that function's body (to the end of the
 * line for a one-line arrow). A list of types: a field of any of them. A function named here that the view no
 * longer has fails the test, so the table cannot fall out of step silently.
 */
const TYPED = [
  ['app.mjs', 'const sessionKey = s =>', { s: 'Session' }],
  ['app.mjs', 'const keyOf = o =>', { o: ['Card', 'PermissionRequest', 'Published'] }],
  ['app.mjs', 'const revisionsOf = c =>', { c: 'Card', v: 'CardVersion' }],
  ['app.mjs', 'function parentClaim(m, s) {', { s: 'Session', parent: 'Session' }],
  ['app.mjs', 'const agentIdOf = s =>', { s: 'Session' }],
  ['app.mjs', '\n  agents() {', { s: 'Session' }],
  ['app.mjs', '\n  boardCard(c, number) {', { c: 'Card', a: 'Answer' }],
  ['app.mjs', '\n  permissionCard(p, number) {', { p: 'PermissionRequest' }],
  ['app.mjs', '\n  itemsOf(t, agent, cardId, out) {', { t: 'Timeline', i: 'TimelineItem' }],
  ['app.mjs', '\n  eventsOf(c, card) {', { c: 'Card', a: 'Answer', v: 'CardVersion' }],
  ['app.mjs', '\n  update(change = null) {', { s: 'Session', p: ['Published', 'PermissionRequest'] }],
  ['auth.mjs', 'const sessionName = s =>', { s: 'Session' }],
  ['auth.mjs', 'const fp = d =>', { d: 'Member' }],
  ['auth.mjs', 'const member = d => {', { d: 'Member' }],
  ['auth.mjs', 'const sessionOptions = (except = null) =>', { s: 'Session' }],
  ['auth.mjs', 'const lists = () => {', { d: 'Member', a: 'Member', b: 'Member' }],
  ['auth.mjs', 'const newcomerName = inv =>', { inv: 'Invite' }],
]
function typedReads() {
  const reads = []
  for (const [file, head, names] of TYPED) {
    const s = sources.find(x => x.name === file), at = s?.text.indexOf(head.replace('\\n', '\n')) ?? -1
    assert.ok(at >= 0, `TYPED names \`${head.trim()}\` in ${file}, which is not there any more`)
    const lineEnd = s.code.indexOf('\n', at + head.length), brace = head.trimEnd().endsWith('{')
    const end = brace ? closing(s.code, at + head.lastIndexOf('{')) : lineEnd
    for (const [name, type] of Object.entries(names)) for (const [k, pos] of membersOf(s.code, name, at, end)) reads.push([type, k, s, pos])
  }
  return reads
}

/** [type, field, source, position] for every field of the model the patterns in the header find. */
function modelReads() {
  const reads = []
  for (const s of sources) {
    if (s.name === 'demo/demo.mjs') continue   // (it builds the model; demo.test.mjs checks what it builds)
    const { code } = s
    for (const [name, from, to] of modelNames(s)) {
      const scan = (suffix, fn) => { const re = new RegExp(`${name}${suffix}`, 'g'); re.lastIndex = from; for (let m; (m = re.exec(code)) && m.index < to;) fn(m) }
      scan('\\??\\.([A-Za-z_$][\\w$]*)', m => reads.push(['Model', m[1], s, m.index]))
      scan('\\??\\.room\\??\\.([A-Za-z_$][\\w$]*)', m => reads.push(['Room', m[1], s, m.index]))
      scan('\\??\\.human\\??\\.([A-Za-z_$][\\w$]*)', m => reads.push(['HumanRegisters', m[1], s, m.index]))
      // const room = M.room, h = M.human: the same under that name, in its block
      for (const [part, type] of [['room', 'Room'], ['human', 'HumanRegisters']]) {
        const re = new RegExp(`(?<![\\w$.])([A-Za-z_$][\\w$]*)\\s*=\\s*${name}\\??\\.${part}\\b(?![ \\t]*[.?\\w])`, 'g'); re.lastIndex = from
        for (let m; (m = re.exec(code)) && m.index < to;) { const [a, b] = blockAround(code, m.index); for (const [k, at] of membersOf(code, m[1], Math.max(a, m.index), b)) reads.push([type, k, s, at]) }
      }
      for (const [map, type] of Object.entries(MAPS)) {
        // M.map.get(k)?.a
        scan(`\\??\\.${map}\\??\\.get\\(`, m => {
          const end = closing(code, m.index + m[0].length - 1)
          const f = /^\)\??\.([A-Za-z_$][\w$]*)/.exec(code.slice(end))
          if (f) reads.push([type, f[1], s, end])
        })
        // const x = M.map.get(k)   /   for (const x of M.map.values())   /   for (const [, x] of M.map)
        const named = [`(?:const|let)\\s+([A-Za-z_$][\\w$]*)\\s*=\\s*${name}\\??\\.${map}\\??\\.get\\(`, `for\\s*\\(const\\s+([A-Za-z_$][\\w$]*)\\s+of\\s+${name}\\??\\.${map}\\.values\\(\\)\\)`, `for\\s*\\(const\\s+\\[\\s*\\w*,\\s*([A-Za-z_$][\\w$]*)\\]\\s+of\\s+${name}\\??\\.${map}\\)`]
        for (const pattern of named) {
          const re = new RegExp(pattern, 'g'); re.lastIndex = from
          for (let m; (m = re.exec(code)) && m.index < to;) {
            // a `for` header's variable lives in the statement or block after it; a const in the block around it
            let [a, b] = blockAround(code, m.index)
            if (m[0].startsWith('for')) { const after = m.index + m[0].length, brace = /^\s*\{/.test(code.slice(after)); a = after; b = brace ? closing(code, code.indexOf('{', after)) : code.indexOf('\n', after) }
            for (const [k, at] of membersOf(code, m[1], Math.max(a, m.index), b)) reads.push([type, k, s, at])
          }
        }
        // [...M.map.values()].filter(x => x.a)   and   M.map.values()].some(x => …) and so on
        scan(`\\??\\.${map}\\.values\\(\\)\\]?\\.(?:filter|map|find|some|every|forEach|flatMap|findLast)\\(\\s*\\(?([A-Za-z_$][\\w$]*)\\)?\\s*=>`, m => {
          const open = code.indexOf('(', m.index + m[0].indexOf('values()') + 10), end = closing(code, open)
          for (const [k, at] of membersOf(code, m[1], open, end)) reads.push([type, k, s, at])
        })
      }
    }
  }
  return reads
}

test('every field of the model the views read is one types.ts names', () => {
  const room = pageRoomFields()
  const known = {
    Model: fieldsOf('Model'), Room: new Set([...fieldsOf('Room'), ...room]), HumanRegisters: fieldsOf('HumanRegisters'),
    ...Object.fromEntries([...Object.values(MAPS), 'Answer', 'CardVersion', 'TimelineItem'].map(t => [t, new Set([...fieldsOf(t), ...(APP_FIELDS[t] ?? [])])])),
  }
  // what a Map, an array or a value has by itself is no field
  const BUILT_IN = new Set(['get', 'has', 'values', 'keys', 'entries', 'size', 'length', 'forEach', 'map', 'filter', 'find', 'some', 'every', 'slice', 'at', 'join', 'includes', 'push', 'sort', 'set', 'delete', 'items', 'startsWith', 'trim', 'toString'])
  const reads = [...modelReads(), ...typedReads()]
  if (process.env.CONTRACT_LIST) { const by = new Map(); for (const [types, field] of reads) for (const type of [types].flat()) by.set(type, (by.get(type) ?? new Set()).add(field)); for (const [type, set] of by) console.log(`${type}: ${[...set].sort().join(' ')}`) }
  const has = (type, field) => [type].flat().some(t => known[t].has(field))
  const unknown = [...new Set(reads.filter(([type, field]) => !has(type, field) && !(BUILT_IN.has(field) && type !== 'Model' && type !== 'Room')).map(([type, field, s, at]) => `${where(s, at)}  ${[type].flat().join('|')}.${field}`))]
  assert.deepEqual(unknown, [], 'fields the views read that types.ts does not name')
  // the scan finds the model at all, in each of its forms
  const seen = new Set(reads.flatMap(([type, field]) => [type].flat().map(t => `${t}.${field}`)))
  for (const k of ['Model.sessions', 'Model.cards', 'Model.newer', 'Model.outbox', 'Room.my_device_id', 'Room.connection', 'Room.key_epoch', 'HumanRegisters.desks', 'HumanRegisters.raw', 'Session.card_ids', 'Session.heard_up_to', 'Member.device_role', 'Card.title', 'Timeline.has_more', 'Published.object_state']) assert.ok(seen.has(k), `the scan no longer finds ${k}: its patterns are out of step with the views`)
  assert.ok(room.has('account'), 'the page keeps the account\'s state on model.room (auth.mjs _setRoom)')
})

test('no view reads a field that only protocol v1\'s model had', () => {
  for (const { name, of } of REMOVED) assert.ok(!TYPES.get(of)?.fields.includes(name), `REMOVED lists ${of}.${name}, which types.ts has (again)`)
  const hits = []
  for (const s of sources) for (const { name, of } of REMOVED) for (const m of s.code.matchAll(new RegExp(`\\.${name}\\b`, 'g'))) hits.push(`${where(s, m.index)}  .${name} (was ${of}.${name})`)
  // Three more names left one record and stay on others, so they are caught by their receiver only:
  //   member.agent_session_id (now a session's alone)   session.goals / desk_name (a session's register `goals` now)
  for (const s of sources) {
    for (const m of s.code.matchAll(/\bmembers\.get\([^)]*\)\??\.agent_session_id\b/g)) hits.push(`${where(s, m.index)}  a member's agent_session_id (a session's field)`)
    for (const m of s.code.matchAll(/(?<![\w$.])(?:s|session)\.(?:with_history|desk_name)\b/g)) hits.push(`${where(s, m.index)}  ${m[0]} (no field of a session)`)
  }
  assert.deepEqual(hits, [], 'reads of fields the model no longer has')
})

// ---- 5. where the room is stored, and a share page's address ----

test('the page opens the stored room by the name the worker stores it under, and nothing else', () => {
  const storage = interfacesOf(path.join(CORE, 'worker-protocol.ts')).get('StorageName')
  assert.ok(storage, 'worker-protocol.ts names the storage (StorageName)')
  let seen = 0
  for (const s of sources) for (const m of s.code.matchAll(/\bstorage:\s*\{/g)) {
    seen++
    const given = keysOf(s.code, m.index + m[0].length - 1).keys
    assert.deepEqual(given.filter(k => !storage.fields.includes(k)), [], `${where(s, m.index)}: a storage with fields the worker does not know`)
  }
  assert.ok(seen > 0, 'the scan finds where the app names the storage')
})

test('the app takes the address of a share link of this protocol for a share page', async () => {
  const app = sources.find(s => s.name === 'app.mjs')
  const m = /const SHARE_PAGE = (\/.+\/)\n/.exec(app.text)
  assert.ok(m, 'app.mjs names the share page\'s address (SHARE_PAGE)')
  const page = new RegExp(m[1].slice(1, -1))
  // a share id is 16 bytes: 22 characters of base64url in a link (client.ts shareAttachment), 32 hex before
  const id = Buffer.alloc(16, 0xfb).toString('base64url')
  assert.equal(id.length, 22)
  assert.ok(page.test(`/a/${id}`), 'a link of this protocol')
  assert.ok(page.test(`/a/${'0'.repeat(32)}`), 'a link of before')
  assert.ok(!page.test('/a/short') && !page.test(`/a/${id}/x`))
  // every other place that tells a share page by its address uses the same rule
  for (const s of sources) for (const hit of s.text.matchAll(/\\\/a\\\/\[0-9a-f\]\{32\}\$/g)) assert.fail(`${where(s, hit.index)}: a share page told by a hex id alone`)
  const start = fs.readFileSync(path.join(CORE, 'core-start.ts'), 'utf8')
  assert.ok(start.includes('[A-Za-z0-9_-]{22}'), 'core-start.ts knows the same address (it starts no worker on a share page)')
})

test('a hub client a view makes itself (the share page) is given what the Hub takes', () => {
  let seen = 0
  for (const s of sources) for (const m of s.code.matchAll(/\bnew Hub\(\{/g)) {
    seen++
    assert.deepEqual(keysOf(s.code, m.index + m[0].length - 1).keys.filter(k => !['hub_url', 'client_name', 'fetch'].includes(k)), [], `${where(s, m.index)}: new Hub({ … }) with a field the Hub does not take (hub.ts)`)
  }
  assert.ok(seen > 0, 'the scan finds the share page\'s hub client (media.mjs)')
  assert.match(fs.readFileSync(path.join(CORE, 'hub.ts'), 'utf8'), /constructor\(opts: \{ hub_url: string; client_name\?: string \| null; fetch\?: typeof fetch \}\)/, 'hub.ts: the Hub\'s options are the ones this test names')
})
