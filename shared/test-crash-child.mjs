// test-crash-child.mjs: used by test.mjs (write-ahead test). Opens an agent from file storage, sends one message and
// exits hard the moment the hub accepted it: whatever the own chain needs must already be on disk.
import { fileStorage } from './storage-file.mjs'
import { openRoom } from './index.mjs'
const [dir] = process.argv.slice(2)
const c = await openRoom({ storage: await fileStorage({ dir }) })
await c.start({ stream: false })
await c.whenSession()
const post = c.hub.postEnvelope.bind(c.hub)
c.hub.postEnvelope = async b => { const r = await post(b); process.stdout.write(`accepted ${r.envelope_number}\n`); process.kill(process.pid, 'SIGKILL') }
await c.sendMessage({ text: 'one' })
await new Promise(() => {})
