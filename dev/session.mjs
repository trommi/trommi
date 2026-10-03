// Put a worker on the board as its own session, without it being a Claude Code
// session with the channel loaded: a subagent, a script, a person at a shell.
//   node dev/session.mjs link "Web UI" [--parent <id>]     hold the session online; answers are appended to data/sessions/<id>.log;
//                                                          --parent: it is a helper of that main session
//   node dev/session.mjs call web-ui reply '{"text":"…"}'   call a board tool as that session
//   node dev/session.mjs answers web-ui                    print what the human answered so far
//   node dev/session.mjs publish web-ui out/report.html [--title "…"] [--type html|image|video|audio|file] [--note "…"] [--silent] [--keep]
//                                                          publish a page or a file as a link and print the link
// The session id is the name in lower case with dashes. Reads the token from data/token
// (or BOARD_TOKEN), the port from BOARD_PORT.
//
// publish stands in for the publish_asset tool, which `call` cannot reach: the
// tool encrypts in the process beside the agent, and here that process is this
// one. The file is encrypted locally (server/asset-envelope.mjs), the hub gets
// the ciphertext over the route a spoke uses, and the link is printed as
// <base>/a/<id>#<key>. The base is BOARD_PUBLIC_URL if set, else the first
// line of data/url.txt without its query. A page must be self-contained
// (inline CSS and scripts, images as data: URLs): the viewer loads nothing
// from the network. Without --silent the asset is announced in the session's
// conversation on the board, as the tool does it; with --silent the hub is
// told neither key nor title, and the printed link is the only copy. --keep
// exempts it from the cleanup after the retention days.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import { parseArgs } from 'node:util'
import { prepareAsset, assetUpload, assetLink } from '../server/asset-envelope.mjs'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.BOARD_PORT || 8790)
const data = process.env.BOARD_DATA || path.join(root, 'data')
const token = process.env.BOARD_TOKEN || fs.readFileSync(path.join(data, 'token'), 'utf8').trim()
const slug = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
// The same session always presents the same key, so it keeps its id across restarts.
const instanceOf = id => crypto.createHash('sha256').update(`${id}|${token}`).digest('hex').slice(0, 16)
const logOf = id => path.join(data, 'sessions', `${id}.log`)

const [cmd, who, ...rest] = process.argv.slice(2)
if (!cmd || !who) {
  console.error('usage: session.mjs link <name> | call <id> <tool> <json> | answers <id> | publish <id> <file> [--title …] [--type …] [--note …] [--silent] [--keep]')
  process.exit(1)
}
const id = slug(who)

if (cmd === 'link') {
  fs.mkdirSync(path.join(data, 'sessions'), { recursive: true })
  const connect = () => {
    // --parent <id>: this session is a helper of that main session; the board shows it under it.
    const { values: linkOpt } = parseArgs({ args: rest, options: { parent: { type: 'string' } } })
    const query = new URLSearchParams({ name: who, id, instance: instanceOf(id), cwd: root, host: os.hostname(), platform: `${os.type()} ${os.arch()}`, ...(linkOpt.parent ? { parent: linkOpt.parent } : {}) })
    const req = http.get({ host: '127.0.0.1', port, path: `/agent/link?${query}`, headers: { 'x-board-token': token } }, res => {
      res.setEncoding('utf8')
      res.on('data', chunk => fs.appendFileSync(logOf(id), chunk))
      res.on('close', () => setTimeout(connect, 2000))
    })
    req.on('error', () => setTimeout(connect, 2000))
  }
  connect()
} else if (cmd === 'call') {
  const [tool, json = '{}'] = rest
  const res = await fetch(`http://127.0.0.1:${port}/agent/tool`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'x-board-token': token },
    body: JSON.stringify({ id, instance: instanceOf(id), name: tool, args: JSON.parse(json) }),
  })
  const out = await res.json()
  console.log(out.text ?? out.error)
  process.exit(res.ok ? 0 : 1)
} else if (cmd === 'answers') {
  // Each frame is one notification from the board; print the ones that carry the human's word.
  const text = fs.existsSync(logOf(id)) ? fs.readFileSync(logOf(id), 'utf8') : ''
  for (const frame of text.split('\n\n')) {
    if (!frame.startsWith('data: ')) continue
    try {
      const { params } = JSON.parse(frame.slice(6))
      if (params?.meta) console.log(JSON.stringify({ ...params.meta, content: params.content }))
    } catch {}
  }
} else if (cmd === 'publish') {
  const { values: opt, positionals: [file] } = parseArgs({
    args: rest, allowPositionals: true,
    options: { title: { type: 'string' }, type: { type: 'string' }, note: { type: 'string' }, silent: { type: 'boolean' }, keep: { type: 'boolean' } },
  })
  if (!file) throw new Error('publish needs a file')
  const { id: asset, key, blob, record } = prepareAsset({ path: file, title: opt.title, type: opt.type, note: opt.note, silent: opt.silent, keep: opt.keep })
  const sent = assetUpload(id, instanceOf(id), record, blob)
  const res = await fetch(`http://127.0.0.1:${port}${sent.route}`, { method: 'POST', headers: { ...sent.headers, 'x-board-token': token }, body: sent.body })
  if (!res.ok) {
    console.error((await res.json().catch(() => null))?.error ?? `the board refused the asset (${res.status})`)
    process.exit(1)
  }
  // Where the human reaches the board: the public address if one is named, else the board's own first address.
  const named = (process.env.BOARD_PUBLIC_URL || '').split(',')[0].trim()
  const base = (named || fs.readFileSync(path.join(data, 'url.txt'), 'utf8').split('\n')[0].split('?')[0]).replace(/\/+$/, '')
  console.log(assetLink(base, asset, key))
}
