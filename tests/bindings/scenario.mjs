// Runs tests/bindings/scenario.json through the browser binding. The same file runs in Node (node.mjs) and in a
// page (web/page.mjs); what differs is where a device lives, which `world` hides:
//
//   world.core                     the binding's functions without state (trommi-core.js)
//   world.device(name, how)        → a handle on the device stored under `name`; how: 'create' or 'open'.
//                                    handle.call(method, ...args), handle.close(), handle.failNextWrite()
//
// Every step is checked here. What the steps mean is the same in tests/bindings/swift (Scenario.swift).

const text = bytes => new TextDecoder().decode(bytes)
const bytes = string => new TextEncoder().encode(string)
const same = (a, b) => a.length === b.length && a.every((byte, at) => byte === b[at])
/** The code a call is refused with; 'none' when it is not refused. */
const refusal = async work => { try { await work() } catch (error) { return error.code ?? String(error) } return 'none' }
const check = (holds, what) => { if (!holds) throw new Error(what) }
const unhex = text => Uint8Array.from(text.match(/../g) ?? [], byte => parseInt(byte, 16))
const hex = bytes => Array.from(bytes, byte => byte.toString(16).padStart(2, '0')).join('')

/** The least a hub does: one change counter, the ordered log, the Welcomes, and what it serves a device that
 *  comes with the recovery code (every GroupInfo of the room group, every SealedKey, the links). */
class Hub {
  change = 0
  log = []
  welcomes = []        // { change, bytes }
  roomInfos = []       // the room group's GroupInfo of every epoch, from its founding
  sessions = new Map() // hex of a session group -> { founding, current }
  rows = []            // every SealedKey posted
  links = []           // every RecoveryLink posted
  relayed = []         // application messages that are only passed on: { group, bytes }

  /** Posts everything in the device's outbox and reports each as accepted. */
  async post(device) {
    for (const entry of await device.call('outbox')) {
      const part = at => entry.parts[at] ?? new Uint8Array()
      // Where the Commit, its GroupInfo, its Welcome, its SealedKey and its RecoveryAuth stand among the parts.
      let commit = null
      if (entry.kind === 'groupFounding') {
        this.rows.push(part(1))
        this.sessions.set(hex(entry.group), { founding: part(0), current: part(0) })
        commit = [part(2), part(3), part(4), part(5), null]
      } else if (entry.kind === 'commit') commit = [part(0), part(1), part(2), part(3), null]
      else if (entry.kind === 'externalCommit') commit = [part(0), part(1), new Uint8Array(), part(2), part(3)]
      else if (entry.kind === 'recoveryCode') { commit = [part(0), part(1), new Uint8Array(), part(2), null]; this.links.push(part(3)) }
      else if (entry.kind === 'recoveryCommit') commit = [part(0), part(1), part(2), part(3), part(4).length ? part(4) : null]
      else if (entry.kind === 'recoveryFinish') this.links.push(part(0))
      let change = null
      if (entry.kind === 'roomFounding') {
        this.roomInfos.push(part(0))
        this.rows.push(part(1))
        change = ++this.change
      } else if (commit) {
        change = ++this.change
        this.rows.push(commit[3])
        if (entry.group.length === 32) this.roomInfos.push(commit[1])
        else this.sessions.get(hex(entry.group)).current = commit[1]
        if (commit[2].length) this.welcomes.push({ change, bytes: commit[2] })
        this.log.push({ change, group: entry.group, kind: 'commit', bytes: commit[0], recoveryAuth: commit[4] })
      } else if (entry.kind === 'message') {
        change = ++this.change
        this.log.push({ change, group: entry.group, kind: 'message', bytes: part(0), recoveryAuth: null })
      } else if (entry.kind === 'envelope') {
        // A stored envelope has its place in the same one order as the log's entries.
        change = ++this.change
        this.log.push({ change, group: entry.group, kind: 'envelope', bytes: part(0) })
      } else if (entry.kind === 'relayMessage') {
        // Passed on, never stored: no change number.
        this.relayed.push({ group: entry.group, bytes: part(0) })
      }
      await device.call('outboxAccepted', entry.id, change)
    }
  }

  /** A group as the hub serves it to a device that verifies it from its founding. */
  served(group, founding, current) {
    const commits = this.log.filter(entry => entry.kind === 'commit' && same(entry.group, group))
      .map(entry => ({ change: entry.change, commit: entry.bytes, recoveryAuth: entry.recoveryAuth }))
    return { founding, commits, current }
  }

  /** The room as the hub serves it to a device that comes with the recovery code. */
  servedRoom(core, room, code) {
    const anchor = core.recoveryAnchor(code, room, this.rows)
    return {
      room, group: this.served(room, this.roomInfos[0], this.roomInfos.at(-1)), anchor: this.roomInfos[anchor.epoch],
      rows: this.rows, links: this.links,
      sessions: [...this.sessions].map(([group, { founding, current }]) => this.served(unhex(group), founding, current)),
    }
  }

  /** Hands the device the log after its cursor, with every Welcome at its place. Returns what the entries did. */
  async sync(world, device, room) {
    const done = []
    const envelopes = []
    const cursor = await device.call('cursor')
    for (const entry of this.log.filter(entry => entry.change > cursor)) {
      if (entry.kind === 'envelope') {
        envelopes.push(await device.call('receiveEnvelope', entry.bytes, entry.change, true, null, Date.now()))
        continue
      }
      try {
        done.push(await device.call('processLogEntry', entry, Date.now()))
      } catch (error) {
        // An entry behind what the device holds (its own Commit, a group's Commits before it joined) is passed over.
        if (world.core.logFinding(error.code) !== 'duplicate') throw error
      }
      for (const welcome of this.welcomes.filter(welcome => welcome.change === entry.change)) {
        // A Welcome for another device does not open here: that is no finding.
        await device.call('joinWelcome', welcome.bytes, room, null, Date.now()).catch(() => {})
      }
    }
    return { done, envelopes }
  }
}

/** Runs the steps. Returns how many ran; throws at the first that does not go as the scenario says. */
export async function runScenario(scenario, world) {
  const { core } = world
  const hub = new Hub()
  const devices = new Map()    // name -> handle
  const groups = new Map()     // name -> group id
  const remembered = new Map() // device name -> its outbox, as remembered
  let room = null
  let code = null      // the recovery code in force
  const device = name => devices.get(name) ?? (() => { throw new Error(`no device ${name}`) })()
  const group = name => groups.get(name) ?? (() => { throw new Error(`no group ${name}`) })()
  const keyOf = async (name, groupName) => {
    const groupId = group(groupName)
    const { epoch } = await device(name).call('group', groupId)
    return { epoch, held: await device(name).call('holdsKey', groupId, epoch) }
  }
  const chatWith = (envelopes, text) => envelopes.find(envelope => envelope.payload && JSON.parse(new TextDecoder().decode(envelope.payload)).text === text)
  // The board of all desks: the one board id that is no Desk's.
  const board = Uint8Array.from([...new TextEncoder().encode('all-desks'), 0, 0, 0, 0, 0, 0, 9])

  const run = {
    async create(step) { devices.set(step.device, await world.device(step.device, 'create')) },
    async found_room(step) {
      code = core.generateRecoveryCode()
      room = await device(step.device).call('foundRoom', code, Date.now())
      groups.set('room', core.roomGroupId(room))
    },
    async post(step) { await hub.post(device(step.device)) },
    /** One invite from its opening to its Commit in the inviter's outbox. Both sides must show the same six emoji. */
    async invite(step) {
      const [inviter, newcomer] = [device(step.by), device(step.device)]
      const opened = await inviter.call('inviteOpen', step.role, null, 'https://app.example', 'https://hub.example', Date.now())
      check(same(core.inviteLinkParse(opened.link).inviteId, opened.inviteId) && core.hubAddress('https://hub.example') === 'https://hub.example', 'the link names another invite')
      const asked = await newcomer.call('joinRequest', opened.link, { offer: opened.offer, signature: opened.signature }, Date.now())
      check(asked.role === step.role && same(asked.inviter, await inviter.call('id')), 'the Request is for another invite')
      const accepted = await inviter.call('inviteAccept', opened.inviteId, { request: asked.request, mac: asked.mac, signature: asked.signature }, Date.now())
      const shown = await newcomer.call('joinReveal', { reveal: accepted.reveal, signature: accepted.signature })
      check(same(shown.numbers, accepted.code.numbers) && shown.emoji.length === 6 && shown.emoji.join() === accepted.code.emoji.join(), 'the two sides show different codes')
      // An agent device follows the room from the epoch its Offer names: the one before the Commit that enrols it.
      if (step.role === 'agent') await newcomer.call('joinObserve', hub.roomInfos[asked.roomEpoch])
      const confirmed = await inviter.call('inviteConfirm', opened.inviteId, accepted.code.numbers, accepted.requestHash, true, Date.now())
      check(confirmed?.role === step.role && same(confirmed.newDevice, await newcomer.call('id')), 'the confirmed invite was not committed')
    },
    async hand_over(step) {
      const steps = (await device(step.by).call('inviteSteps')).filter(next => next.kind === 'handover')
      check(steps.length === 1, 'the invite asks for no handover')
      await device(step.by).call('inviteHandover', steps[0].inviteId)
    },
    async join(step) {
      const welcome = hub.welcomes.at(-1).bytes
      const joined = await device(step.device).call('joinInvited', welcome, Date.now())
      check(joined.offending.length === 0 && same(joined.addedBy, await device(step.by).call('id')), 'the join is not the expected one')
    },
    async same_key(step) {
      const [first, ...others] = await Promise.all(step.devices.map(name => keyOf(name, step.group)))
      check(first.held, `the key of ${step.group} is not held`)
      for (const other of others) check(other.epoch === first.epoch && other.held, `the devices do not share the key of ${step.group}`)
    },
    async sign_in(step) {
      const signed = await device(step.device).call('hubSignIn', 'https://hub.example', new Uint8Array(32).fill(9))
      check(signed.signature.length === 64 && signed.auth.length > 96, 'the sign-in is not a signed HubAuth')
    },
    async sync(step) {
      const { done, envelopes } = await hub.sync(world, device(step.device), room)
      if (step.message !== undefined) {
        const message = done.find(processed => processed.kind === 'message')?.message
        check(message?.kind === 'workTrail' && text(message.payload) === step.message, 'the message did not arrive as it was sent')
      }
      if (step.removed) check(done.some(processed => processed.removed), 'the device did not learn of its removal')
      if (step.chat !== undefined) {
        const envelope = chatWith(envelopes, step.chat)
        check(envelope?.outcome === 'applied' && envelope.header.kind === 'item' && envelope.header.timeline.kind === 'sessionChat', 'the Chat message was not applied')
        // One that was shown before its turn is now confirmed by its sender's chain.
        if (step.confirmed) check(envelope.confirmed === true, 'the fetched envelope was not confirmed by its chain')
      }
    },
    /** A Chat message in a session, sealed into the outbox. */
    async chat(step) {
      const session = group(step.group).subarray(32)
      const sealed = await device(step.device).call('seal', { kind: 'sessionChat', session, payload: bytes(JSON.stringify({ content_type: 'message', text: step.text })) }, null, [], Date.now())
      const [entry] = (await device(step.device).call('outbox')).filter(entry => entry.id === sealed.outboxId)
      check(entry?.kind === 'envelope' && entry.parts.length === 1 && sealed.seq >= 1 && same(sealed.group, group(step.group)), 'the sealed envelope is not in the outbox')
    },
    /** The newest envelope, handed over out of order, before the entries in front of it: shown, not yet confirmed. */
    async fetch(step) {
      const entry = hub.log.findLast(entry => entry.kind === 'envelope')
      const cursor = await device(step.device).call('cursor')
      const fetched = await device(step.device).call('receiveEnvelope', entry.bytes, entry.change, false, null, Date.now())
      check(fetched.outcome === 'provisional' && JSON.parse(text(fetched.payload)).text === step.text, `an envelope fetched out of order is ${fetched.outcome} ${fetched.code}`)
      check(await device(step.device).call('cursor') === cursor, 'an envelope fetched out of order moved the cursor')
    },
    /** A stroke still being drawn: relayed, never stored. */
    async stroke(step) {
      await device(step.device).call('sendStrokePiece', board, bytes('{"stroke":"AAAAAAAAAAAAAAAAAAAAAA","number":1}'))
    },
    async relay(step) {
      const { group: through, bytes: message } = hub.relayed.at(-1)
      const cursor = await device(step.device).call('cursor')
      const piece = await device(step.device).call('receiveRelay', through, message, Date.now())
      check(piece?.kind === 'strokePiece' && same(piece.board, board) && JSON.parse(text(piece.payload)).number === 1, 'the stroke piece did not arrive')
      check(await device(step.device).call('cursor') === cursor, 'a relayed message moved the cursor')
    },
    /** A board: an item, the writer's snapshot register, another item; the reader loads it and is told what is new. */
    async board(step) {
      const [writer, reader] = [device(step.writer), device(step.reader)]
      const roomGroup = group('room')
      const writerId = await writer.call('id')
      const item = { kind: 'boardItem', board, payload: bytes(`{"content_type":"erase","shape_ids":["${core.base64urlEncode(writerId)}/1/0"]}`) }
      await writer.call('seal', item, null, [], Date.now())
      await hub.post(writer)
      // A device takes its own envelope into its chain when the hub hands it back, like anyone's.
      await hub.sync(world, writer, room)
      const head = await writer.call('chainHead', roomGroup, writerId)
      check(head.seq === 1, 'the writer does not hold its own first envelope')
      const snapshot = { attachment: { file_id: 'AAAAAAAAAAAAAAAAAAAAAA' }, frontier: { [core.base64urlEncode(writerId)]: [head.seq, core.base64urlEncode(head.hash)] }, change: await writer.call('cursor') }
      await writer.call('seal', { kind: 'register', group: roomGroup, name: `board_snapshot/${core.base64urlEncode(board)}`, value: bytes(JSON.stringify(snapshot)) }, null, [], Date.now())
      await hub.post(writer)
      const second = await writer.call('seal', item, null, [], Date.now())
      await hub.post(writer)
      // Before the reader read the register it has no snapshot; after, a hub that leaves the newer item out is found out.
      check(await refusal(() => reader.call('boardLoad', board, [])) === 'not-found', 'a board loaded without its snapshot')
      const { envelopes } = await hub.sync(world, reader, room)
      check(envelopes.length === 3 && envelopes.every(envelope => envelope.outcome === 'applied'), 'the board\'s envelopes were not applied')
      check(envelopes[1].register?.current === true && envelopes[1].header.kind === 'register', 'the snapshot register was not taken')
      const read = JSON.parse(text(await reader.call('register', roomGroup, `board_snapshot/${core.base64urlEncode(board)}`)))
      check(read.change === snapshot.change && read.attachment.file_id === snapshot.attachment.file_id, 'the register reads another value')
      check(await refusal(() => reader.call('boardLoad', board, [])) === 'withheld', 'a withheld item went unnoticed')
      const loaded = await reader.call('boardLoad', board, [{ sender: writerId, seq: second.seq, hash: second.envelopeHash }])
      check(loaded.fresh.length === 1 && loaded.fresh[0] === 0 && loaded.covered.length === 0 && loaded.frontier[0].seq === second.seq, 'the board did not load as written')
      const cut = await reader.call('cutOf', roomGroup, writerId)
      check(cut.seq === second.seq && same(cut.hash, second.envelopeHash), 'the Cut is not the last accepted envelope')
    },
    async found_session(step) {
      const founder = device(step.by)
      // The agent's KeyPackage is the one of its confirmed Request, which the invite's next step names.
      const next = (await founder.call('inviteSteps')).find(next => next.kind === 'foundSession')
      check(next && same(next.device, await device(step.agent).call('id')), 'the invite asks for no session')
      const keyPackages = [next.keyPackage]
      for (const name of step.humans) keyPackages.push(await device(name).call('keyPackage', Date.now()))
      const session = await founder.call('foundSession', await device(step.agent).call('id'), keyPackages, Date.now())
      groups.set(step.name, core.sessionGroupId(room, session))
    },
    async work_trail(step) {
      await device(step.device).call('sendWorkTrail', group(step.group), new Uint8Array(16).fill(7), step.number, bytes(step.text), Date.now())
    },
    async file(step) {
      const plain = Uint8Array.from({ length: step.bytes }, (_, at) => at % 251)
      const encryptor = new core.FileEncryptor()
      const stored = []
      for (let at = 0; at < plain.length; at += step.pieces) stored.push(encryptor.update(plain.subarray(at, at + step.pieces)))
      const end = encryptor.finish()
      stored.push(end.stored)
      check(end.plainLen === plain.length && core.fileLayout(end.storedLen).plainLen === plain.length, 'the file has another length')
      const decryptor = new core.FileDecryptor(end.file)
      const opened = []
      for (const piece of stored) opened.push(decryptor.update(piece))
      opened.push(decryptor.finish())
      check(same(Uint8Array.from(opened.flatMap(piece => [...piece])), plain), 'the file came back changed')
      // One changed byte: the file is refused at the latest when it ends.
      stored[0][30] ^= 1
      const tampered = new core.FileDecryptor(end.file)
      let refused = null
      try { for (const piece of stored) tampered.update(piece); tampered.finish() } catch (error) { refused = error.code }
      check(refused === 'decrypt-failed', `a changed file was not refused (${refused})`)
    },
    async restart(step) {
      const before = devices.get(step.device)
      const id = await before.call('id').catch(() => null)   // a device that closed itself answers no more
      await before.close()
      const again = await world.device(step.device, 'open')
      devices.set(step.device, again)
      if (id) check(same(await again.call('id'), id), 'the device opened from its store is another')
    },
    async update(step) { await device(step.device).call('update', group(step.group), true, Date.now()) },
    async outbox(step) {
      const outbox = await device(step.device).call('outbox')
      check(outbox.length === step.count, `the outbox of ${step.device} holds ${outbox.length}, not ${step.count}`)
      if (step.remember) remembered.set(step.device, outbox)
      if (step.same) {
        const before = remembered.get(step.device)
        check(outbox.every((entry, at) => entry.id === before[at].id && entry.kind === before[at].kind && entry.epoch === before[at].epoch
          && same(entry.group, before[at].group) && entry.parts.length === before[at].parts.length
          && entry.parts.every((part, index) => same(part, before[at].parts[index]))), 'the outbox is not the same after the restart')
      }
    },
    async fail_next_write(step) { await device(step.device).failNextWrite() },
    async second_owner(step) { await (await world.device(step.device, 'open')).close() },
    async remove_human(step) {
      const cut = await device(step.by).call('cutOf', group('room'), await device(step.device).call('id'))
      await device(step.by).call('removeHumanDevices', [cut], Date.now())
    },
    async clean_session(step) {
      const { disallowed } = await device(step.by).call('group', group(step.group))
      const cuts = []
      for (const gone of disallowed) cuts.push(await device(step.by).call('cutOf', group(step.group), gone))
      await device(step.by).call('cleanSession', group(step.group), cuts, null, Date.now())
    },
    async join_with_code(step) {
      const joined = await device(step.device).call('joinRoomWithCode', code, hub.servedRoom(core, room, code), Date.now())
      check(joined.outbox.length === 1 && joined.unverified.length === 0 && joined.missingLink === null, 'the room did not verify whole')
    },
    async join_session_with_code(step) {
      const { founding, current } = hub.sessions.get(hex(group(step.group)))
      await device(step.device).call('joinSessionWithCode', code, hub.served(group(step.group), founding, current), Date.now())
    },
    async earlier_key(step) {
      const held = await Promise.all([step.device, step.like].map(name => device(name).call('holdsKey', group(step.group), step.epoch)))
      check(held.every(Boolean) && await device(step.device).call('keyIsConfirmed', group(step.group), step.epoch), 'the code did not open the earlier key')
    },
    async replace_code(step) {
      const next = await device(step.device).call('newRecoveryCode', code)
      check(next.length === 32 && !same(next, code), 'the new code is not a new code')
      await device(step.device).call('replaceCode', code, bytes('the account\'s sealed copies'), Date.now())
      code = next
    },
    async recover(step) {
      const served = hub.servedRoom(core, room, code)
      check(served.sessions.length > 0, 'the room is served without its sessions')
      const plan = await device(step.device).call('prepareRecovery', code, served)
      const cuts = plan.removals.flatMap(({ group, devices }) => devices.map(gone => ({ group, cut: { device: gone, seq: 0, hash: new Uint8Array(32) } })))
      check(cuts.length > 0 && plan.newCode.length === 32, 'the recovery removes nobody')
      const built = await device(step.device).call('recover', code, served, cuts, bytes('the account\'s sealed copies'), Date.now())
      check(built.unverified.length === 0 && built.outbox.length >= 2, 'the recovery was not built whole')
      code = plan.newCode
    },
    async holds_recovery_mac(step) { check(await device(step.device).call('holdsRecoveryMac'), 'the device does not hold the key of the code in force') },
    async no_key(step) {
      const { epoch } = await keyOf(step.epoch_of, step.group)
      check(!(await device(step.device).call('holdsKey', group(step.group), epoch)), 'the removed device holds the key of the epoch after its removal')
    },
  }

  let ran = 0
  for (const step of scenario.steps) {
    const what = `step ${ran + 1} (${JSON.stringify(step)})`
    let refused = null
    try {
      await run[step.do](step)
    } catch (error) {
      if (!step.refused) throw new Error(`${what}: ${error.code ?? ''} ${error.message}`)
      refused = error.code
    }
    if (step.refused && refused !== step.refused) throw new Error(`${what}: refused with ${refused}, not ${step.refused}`)
    ran++
  }
  for (const handle of devices.values()) await handle.close()
  return ran
}
