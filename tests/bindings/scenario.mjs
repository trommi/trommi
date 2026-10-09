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
const check = (holds, what) => { if (!holds) throw new Error(what) }

/** The least a hub does: one change counter, the ordered log, the Welcomes, the room's newest GroupInfo. */
class Hub {
  change = 0
  log = []
  welcomes = []   // { change, bytes }
  roomGroupInfo = null

  /** Posts everything in the device's outbox and reports each as accepted. */
  async post(device) {
    for (const entry of await device.call('outbox')) {
      const part = at => entry.parts[at] ?? new Uint8Array()
      // Where the Commit, its GroupInfo and its Welcome stand among the parts of each kind.
      const commit = entry.kind === 'groupFounding' ? [part(2), part(3), part(4)]
        : entry.kind === 'commit' ? [part(0), part(1), part(2)] : null
      let change = null
      if (entry.kind === 'roomFounding') {
        this.roomGroupInfo = part(0)
        change = ++this.change
      } else if (commit) {
        change = ++this.change
        if (entry.group.length === 32) this.roomGroupInfo = commit[1]
        if (commit[2].length) this.welcomes.push({ change, bytes: commit[2] })
        this.log.push({ change, group: entry.group, kind: 'commit', bytes: commit[0], recoveryAuth: null })
      } else if (entry.kind === 'message') {
        change = ++this.change
        this.log.push({ change, group: entry.group, kind: 'message', bytes: part(0), recoveryAuth: null })
      }
      await device.call('outboxAccepted', entry.id, change)
    }
  }

  /** Hands the device the log after its cursor, with every Welcome at its place. Returns what the entries did. */
  async sync(world, device, room) {
    const done = []
    const cursor = await device.call('cursor')
    for (const entry of this.log.filter(entry => entry.change > cursor)) {
      try {
        done.push(await device.call('processLogEntry', entry))
      } catch (error) {
        // An entry behind what the device holds (its own Commit, a group's Commits before it joined) is passed over.
        if (world.core.logFinding(error.code) !== 'duplicate') throw error
      }
      for (const welcome of this.welcomes.filter(welcome => welcome.change === entry.change)) {
        // A Welcome for another device does not open here: that is no finding.
        await device.call('joinWelcome', welcome.bytes, room, null, Date.now()).catch(() => {})
      }
    }
    return done
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
  const device = name => devices.get(name) ?? (() => { throw new Error(`no device ${name}`) })()
  const group = name => groups.get(name) ?? (() => { throw new Error(`no group ${name}`) })()
  const keyOf = async (name, groupName) => {
    const groupId = group(groupName)
    const { epoch } = await device(name).call('group', groupId)
    return { epoch, key: await device(name).call('contentKey', groupId, epoch) }
  }
  const noCut = async name => ({ device: await device(name).call('id'), seq: 0, hash: new Uint8Array(32) })

  const run = {
    async create(step) { devices.set(step.device, await world.device(step.device, 'create')) },
    async found_room(step) {
      room = await device(step.device).call('foundRoom', core.generateRecoveryCode(), Date.now())
      groups.set('room', core.roomGroupId(room))
    },
    async post(step) { await hub.post(device(step.device)) },
    async add_human(step) {
      const newcomer = device(step.device)
      const keyPackage = await newcomer.call('keyPackage', Date.now())
      check(same(core.keyPackageInfo(keyPackage).device, await newcomer.call('id')), 'the KeyPackage names another device')
      await device(step.by).call('addHumanDevice', await newcomer.call('id'), keyPackage, Date.now())
    },
    async join(step) {
      const welcome = hub.welcomes.at(-1).bytes
      const joined = await device(step.device).call('joinWelcome', welcome, room, await device(step.by).call('id'), Date.now())
      check(joined.offending.length === 0 && same(joined.addedBy, await device(step.by).call('id')), 'the join is not the expected one')
    },
    async same_key(step) {
      const [first, ...others] = await Promise.all(step.devices.map(name => keyOf(name, step.group)))
      check(first.key.length === 32, 'a content key is not 32 bytes')
      for (const other of others) check(other.epoch === first.epoch && same(other.key, first.key), `the keys of ${step.group} differ`)
    },
    async sign_in(step) {
      const signed = await device(step.device).call('hubSignIn', room, 'https://hub.example', new Uint8Array(32).fill(9))
      check(signed.signature.length === 64 && signed.auth.length > 96, 'the sign-in is not a signed HubAuth')
    },
    async enrol(step) { await device(step.by).call('changeAgents', [await device(step.device).call('id')], [], Date.now()) },
    async observe(step) { await device(step.device).call('observeRoom', hub.roomGroupInfo, null) },
    async sync(step) {
      const done = await hub.sync(world, device(step.device), room)
      if (step.message !== undefined) {
        const message = done.find(processed => processed.kind === 'message')?.message
        check(message?.kind === 'workTrail' && text(message.payload) === step.message, 'the message did not arrive as it was sent')
      }
      if (step.removed) check(done.some(processed => processed.removed), 'the device did not learn of its removal')
    },
    async found_session(step) {
      const founder = device(step.by)
      const keyPackages = []
      for (const name of [...step.humans, step.agent]) keyPackages.push(await device(name).call('keyPackage', Date.now()))
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
        check(outbox.every((entry, at) => entry.id === before[at].id && entry.parts.length === before[at].parts.length
          && entry.parts.every((part, index) => same(part, before[at].parts[index]))), 'the outbox is not the same after the restart')
      }
    },
    async fail_next_write(step) { await device(step.device).failNextWrite() },
    async second_owner(step) { await (await world.device(step.device, 'open')).close() },
    async remove_human(step) { await device(step.by).call('removeHumanDevices', [await noCut(step.device)], Date.now()) },
    async clean_session(step) {
      const { disallowed } = await device(step.by).call('group', group(step.group))
      const cuts = disallowed.map(gone => ({ device: gone, seq: 0, hash: new Uint8Array(32) }))
      await device(step.by).call('cleanSession', group(step.group), cuts, null, Date.now())
    },
    async no_key(step) {
      const { epoch } = await keyOf(step.epoch_of, step.group)
      await device(step.device).call('contentKey', group(step.group), epoch)
    },
  }

  let ran = 0
  for (const step of scenario.steps) {
    const what = `step ${ran + 1} (${JSON.stringify(step)})`
    if (step.do === 'no_key') step.refused = 'no-key'
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
