// Files and Share links. The file encryption is the REAL core's (the WASM binding); the hub is the FAKE one, and the
// Artifact that makes a file shareable is a plain JSON envelope of the stand-in core.
import test from 'node:test'
import assert from 'node:assert/strict'
import { core, scene } from './helpers.mjs'
import { openShared, parseShareLink } from '../../../app/web/core/client.ts'
import { Hub } from '../../../app/web/core/hub.ts'

test('a file of 3 MiB: uploaded in pieces, fetched on another device, shared by link, revoked', async t => {
  const { fake, a, b, agent } = await scene(t, { agent: true, second: true })
  const bytes = new Uint8Array(3 * 1024 * 1024 + 17)
  for (let i = 0; i < bytes.length; i++) bytes[i] = (i * 31 + (i >> 9)) & 255
  const ref = await a.uploadAttachment(bytes, { file_name: 'big.bin', media_type: 'application/octet-stream' })
  assert.equal(ref.total_size, bytes.length)
  const put = fake.requests.find(r => r.method === 'PUT' && r.path.startsWith('/v1/files/'))
  assert.ok(put.body.bytes > bytes.length, 'what the hub holds is the encrypted file, a little longer')
  // the reference travels in a message's body; the other device fetches and opens the file with it
  await a.sendMessage({ session_id: agent.session_id, text: 'the dump', attachments: [ref] })
  await a.settle(); await b.settle()
  const item = [...b.model.timelines.get(`chat:session/${agent.session_id}`).items.values()].find(i => i.content?.text === 'the dump')
  const got = await b.fetchAttachment(item.content.attachments[0])
  assert.equal(got.length, bytes.length)
  assert.ok(Buffer.from(got).equals(Buffer.from(bytes)))
  assert.equal((await b.attachmentBlob(item.content.attachments[0])).size, bytes.length)
  // a wrong key opens nothing
  await assert.rejects(b.fetchAttachment({ ...item.content.attachments[0], attachment_id: ref.attachment_id, file_key: Buffer.alloc(32, 7).toString('base64url') }).then(x => { if (x === got) throw Object.assign(new Error('from the cache'), { code: 'decrypt-failed' }) }), { code: 'decrypt-failed' })

  // a Share link gives one file of an open Artifact to someone outside (11.5)
  const page = new TextEncoder().encode('<h1>Report</h1>')
  const shared = await agent.upload(page, { file_name: 'report.html', media_type: 'text/html' })
  const artifact = await agent.publish({ title: 'Report', attachments: [shared] })
  await agent.settle(); await a.settle()
  assert.equal(a.model.published.get(artifact).title, 'Report')
  const { share_id, link, expires_at } = await a.shareAttachment(a.model.published.get(artifact).attachments[0], { keep_link: true })
  assert.equal(parseShareLink(link).share_id, share_id)
  assert.match(link, /\/artifact\/[A-Za-z0-9_-]{22}#/)
  // a link of before (/a/…) is the same link
  assert.equal(parseShareLink(link.replace('/artifact/', '/a/')).share_id, share_id)
  assert.ok(expires_at > Date.now())
  assert.deepEqual((await a.myShares()).map(s => [s.share_id, s.link]), [[share_id, link]])
  const outside = new Hub({ hub_url: fake.url })
  assert.deepEqual([...await openShared(await core(), outside, link)], [...page])
  await a.revokeShare(share_id)
  assert.deepEqual(await a.myShares(), [])
  await assert.rejects(openShared(await core(), outside, link), { code: 'not-found' })
  assert.throws(() => parseShareLink('https://app.trommi.com/a/nothing'), { code: 'bad-format' })
})
