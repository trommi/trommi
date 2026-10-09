// The 64 emoji of the check code: check-emoji.ts (what the views draw) must be the core's list, index by index
// (core/src/invite.rs CHECK_EMOJI). The binding does not export the list yet, so the Rust source is read.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { CHECK_EMOJI, checkEmoji, checkEmojiLine } from '../../../app/web/core/check-emoji.ts'

test('check-emoji.ts is the core\'s list', () => {
  const source = fs.readFileSync(new URL('../../../core/src/invite.rs', import.meta.url), 'utf8')
  const table = source.slice(source.indexOf('pub const CHECK_EMOJI'), source.indexOf('];', source.indexOf('pub const CHECK_EMOJI')))
  const core = [...table.matchAll(/\("([^"]+)",\s*"([^"]+)"\)/g)].map(m => [m[1], m[2]])
  assert.equal(core.length, 64)
  assert.deepEqual(CHECK_EMOJI.map(e => [e.emoji, e.word]), core)
  assert.deepEqual(checkEmoji('00-63-07').map(e => e.word), [core[0][1], core[63][1], core[7][1]])
  assert.deepEqual(checkEmoji('00-64'), [])
  assert.equal(checkEmojiLine('01-02'), `${core[1][0]} ${core[1][1]} · ${core[2][0]} ${core[2][1]}`)
})
