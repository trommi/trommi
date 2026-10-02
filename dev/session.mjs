// Put a worker on the board as its own session, without it being a Claude Code
// session with the channel loaded: a subagent, a script, a person at a shell.
//   node dev/session.mjs link "Web UI"                     hold the session online; answers are appended to data/sessions/<id>.log
//   node dev/session.mjs call web-ui reply '{"text":"…"}'   call a board tool as that session
//   node dev/session.mjs answers web-ui                    print what the human answered so far
// The session id is the name in lower case with dashes. Reads the token from data/token.
import fs from 'node:fs'
import path from 'node:path'
import http from 'node:http'
import crypto from 'node:crypto'
import os from 'node:os'
import { fileURLToPath } from 'node:url'

const root = path.join(path.dirname(fileURLToPath(import.meta.url)), '..')
const port = Number(process.env.BOARD_PORT || 8790)
const data = process.env.BOARD_DATA || path.join(root, 'data')
const token = fs.readFileSync(path.join(data, 'token'), 'utf8').trim()
const slug = name => name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '')
// The same session always presents the same key, so it keeps its id across restarts.
const instanceOf = id => crypto.createHash('sha256').update(`${id}|${token}`).digest('hex').slice(0, 16)
const logOf = id => path.join(data, 'sessions', `${id}.log`)

const [cmd, who, ...rest] = process.argv.slice(2)
if (!cmd || !who) {
  console.error('usage: session.mjs link <name> | call <id> <tool> <json> | answers <id>')
  process.exit(1)
}
const id = slug(who)

if (cmd === 'link') {
  fs.mkdirSync(path.join(data, 'sessions'), { recursive: true })
  const connect = () => {
    const query = new URLSearchParams({ name: who, id, instance: instanceOf(id), cwd: root, host: os.hostname(), platform: `${os.type()} ${os.arch()}` })
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
}
