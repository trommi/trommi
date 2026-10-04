// channel-test-forge.mjs: forged commands against the channel (part of hub/channel-test-e2e.mjs).
// Each forgery is sealed with the core's own sealing (Client._send, a test-only use of an internal), so the
// envelope is well-formed and signed; only its authority or its bind is wrong. Expected: the channel emits
// nothing to Claude Code and reports alert/... on the board, or the hub already refuses it.

import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileStorage } from '../client/core/storage-file.mjs'

export async function run({ core, human, agentId, channel, until, keys }) {
  const { z, codec } = core
  const quiet = async ms => { const before = channel.events.length; await new Promise(r => setTimeout(r, ms)); return channel.events.slice(before) }
  const alerts = () => human.model.sessions.get(human.sessionOfAgent(agentId))?.agent_alerts ?? []
  const card = (await channel.call('create_decision', { title: 'Forge target?', options: [{ key: 'a', label: 'A' }, { key: 'b', label: 'B' }] })).match(/card ([0-9a-f]{32})/)[1]
  await until('card at the human', () => human.model.cards.get(card))
  const answerOf = (c, versionHash, choice = 'a') => ({
    kind: codec.KIND.answer, content: { answer_action: 'answer', choices: [choice] }, recipient: agentId,
    bind: z.encodeAnswerBind({ objectId: z.unhex(card), versionHash: z.unhex(versionHash), choices: [choice] }), session_id: c.session_id,
    object: { object_id: card, object_state: 'answered', urgency: c.urgency, answered_at: Date.now() },
  })

  // 1. An answer with a stale hash: the human answers version 1 after the agent revised to version 2.
  const v1 = human.model.cards.get(card).version_hash
  await channel.call('revise_card', { card_id: card, title: 'Forge target, reworded?' })
  await until('version 2 at the human', () => human.model.cards.get(card).object_version === 2)
  const n1 = alerts().length
  await human._send(answerOf(human.model.cards.get(card), v1))
  await until('alert for the stale answer', () => alerts().length > n1)
  assert.ok(!(await quiet(300)).some(e => e.params?.meta?.kind === 'decision'), 'a stale answer reached Claude')

  // 2. An answer from an agent (the second agent of this folder, slot 2): only humans may answer.
  const room = path.join(keys, human.model.room.room_id)
  const slot2 = fs.readdirSync(room).find(f => /-2\.key$/.test(f))
  assert.ok(slot2, 'the second agent key exists')
  const storage = await fileStorage({ dir: room, key_file: path.join(room, slot2), prefix: slot2.replace(/key$/, '') })
  const other = await core.openRoom({ storage })
  await other.start({ stream: false })

  // R6: agent B cannot read agent A's session. It holds no key for it: A's cards stay undecryptable for B,
  // and B cannot even seal under A's session key.
  const sessionA = human.model.cards.get(card).session_id
  assert.notEqual(other.session_id, sessionA, 'the second agent has a session of its own')
  const seenByB = other.model.cards.get(card)
  assert.ok(!seenByB || (seenByB.content_state === 'undecryptable' && !seenByB.title), 'agent B read a card of agent A\'s session')
  await assert.rejects(other._send(answerOf(human.model.cards.get(card), human.model.cards.get(card).version_hash)), e => e.code === 'no-key')

  // So the forged answer goes under B's own session key, addressed to A: A cannot open it, and only humans may answer anyway.
  const n2 = alerts().length
  let hubRefused = null
  await other._send({ ...answerOf(human.model.cards.get(card), human.model.cards.get(card).version_hash), session_id: other.session_id }).catch(e => { hubRefused = e })
  await other.settle?.().catch(e => { hubRefused = e })
  const refusedAtHub = hubRefused || other.model.outbox.some(o => o.outbox_state === 'failed')
  if (!refusedAtHub) await until('alert for the answer from an agent', () => alerts().length > n2).catch(() => {})   // undecryptable for A: dropped, possibly quietly
  assert.ok(!(await quiet(300)).some(e => e.params?.meta?.kind === 'decision'), 'an answer from an agent reached Claude')

  // 3. A removed device (no longer a member) writes to the agent: the hub refuses it, Claude sees nothing.
  await human.removeDevices([other.model.room.my_device_id])
  await until('removal seen by the channel side', () => !human.model.members.get(other.model.room.my_device_id)?.is_active)
  let removedRefused = false
  try {
    await other.sendMessage({ text: 'I am not a member any more' })
    await other.settle?.()
    removedRefused = other.model.outbox.some(o => o.outbox_state === 'failed')
  } catch { removedRefused = true }
  await other.stop()
  assert.ok(removedRefused, 'the hub accepted an envelope from a removed device')
  assert.ok(!(await quiet(300)).some(e => /not a member/.test(e.params?.content ?? '')), 'a removed device reached Claude')

  // The card still answers normally afterwards.
  await human.answer({ object_id: card, choices: ['b'] })
  await until('the real answer', () => channel.events.find(e => e.params?.meta?.kind === 'decision' && e.params.meta.card_id === card && e.params.meta.choice === 'b'))
  return { stale: 'alert', agent: refusedAtHub ? 'refused at the hub' : 'alert', removed: 'refused at the hub' }
}
