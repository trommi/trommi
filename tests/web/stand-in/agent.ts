// agent.ts: a STAND-IN for an agent device, for tests that need "an agent asks a question". TEST ONLY. The real
// connector is Rust; nothing here is shipped or is evidence of how the connector behaves.
//
// Everything it does is the real core's: its device is enrolled as an agent device (it joins by an invite link,
// observes the room group, gets its main session by Welcome), and every item it writes (card versions, permission
// requests, Artifacts, Chat messages, registers, the work trail) is a real envelope or message. It runs on the same
// engine and room functions as the web app (app/web/core/room.ts joinRoom). "Stand-in" is what it is for the
// connector, not for the core.
//
// The command gate (spec/v1.md 9.0.9) is the core's: an envelope the core marks `command` is put to
// `Device.command`, handed to `onCommand` only when the gate says `act`, and reported with `commandFinished`.
//
// `AgentHub` exists because the fake hub's catch-up and stream leave an agent device the room group's Commits out
// (the real hub serves them: hub-api.md "Who may read"). It reads them from the room group's log and puts them at
// their place in the hub's order, so the agent knows who is a human device when it judges a command.
import { getDecrypted, putEncrypted } from '../../../app/web/core/client.ts'
import type { Client } from '../../../app/web/core/client.ts'
import { attachmentRef, encodeBodyBytes, fileIdsOf, fileRefOf } from '../../../app/web/core/codec.ts'
import type { Fields } from '../../../app/web/core/codec.ts'
import type { Draft, Urgency } from '../../../app/web/core/core-api.ts'
import { Hub } from '../../../app/web/core/hub.ts'
import type { ChangeItem, StreamEvent } from '../../../app/web/core/hub.ts'
import { hex, unhex } from '../../../app/web/core/ids.ts'
import type { AttachmentRef } from '../../../app/web/core/types.ts'

const utf8 = new TextEncoder()
const same = (a: Uint8Array, b: Uint8Array): boolean => a.length === b.length && a.every((v, i) => v === b[i])

/** A hub client that also serves the room group's Commits to a device the fake hub leaves them out for. */
export class AgentHub extends Hub {
  private roomLog: Extract<ChangeItem, { kind: 'commit' }>[] = []
  private roomRead = 0
  private async roomCommits(after: number, upTo: number): Promise<ChangeItem[]> {
    const room = this.room_id
    if (!room) return []
    for (let more = true; more;) {
      const page = await this.groupLog(room, { after: this.roomRead, commits_only: true })
      for (const item of page.items) { if (item.kind === 'commit') this.roomLog.push(item); this.roomRead = item.n }
      more = page.more && page.items.length > 0
    }
    return this.roomLog.filter(c => c.change > after && c.change <= upTo)
  }
  override async changes(after: number, limit = 200): Promise<{ items: ChangeItem[]; change: number; more: boolean }> {
    const page = await super.changes(after, limit)
    const seen = new Set(page.items.map(i => i.change))
    const extra = (await this.roomCommits(after, page.change)).filter(c => !seen.has(c.change))
    return { ...page, items: [...page.items, ...extra].sort((a, b) => a.change - b.change) }
  }
  override stream(after: () => number, on: (event: StreamEvent) => void | Promise<void>, onState: (s: 'connecting' | 'live' | 'offline') => void, onError?: (e: unknown) => void): () => void {
    return super.stream(after, async event => {
      if (event.event === 'change') for (const item of await this.roomCommits(after(), event.item.change - 1)) await on({ event: 'change', item })
      await on(event)
    }, onState, onError)
  }
}

export interface Command {
  kind: 'message' | 'answer' | 'verdict' | 'takeBack'
  envelope_hash: string
  from: string
  object_id: string | null
  /** A message's and an answer's body; a verdict's `allow`. */
  body: Fields | null
  choices: string[]
  allow: boolean | null
}

export class AgentStandIn {
  readonly client: Client
  readonly device_id: string
  onCommand: (command: Command) => void = () => {}
  readonly commands: Command[] = []
  /** The objects this agent wrote: their newest version, as it sealed it. */
  private readonly objects = new Map<string, { version: number; hash: string; kind: 'card' | 'artifact'; fields: Fields }>()

  constructor(client: Client) {
    this.client = client
    this.device_id = client.my_device_id
    client.engine.on('envelope', ({ received, how }) => {
      // the core says which envelopes its command gate is to be asked about, and the gate decides (9.0.9)
      if (how !== 'ordered' || !received.command) return
      const h = received.header, hash = received.envelopeHash
      void (async () => {
        const decision = await client.engine.do(d => d.command(hash, Date.now()))
        if (decision.gate !== 'act') return
        const body = received.payload ? JSON.parse(new TextDecoder().decode(received.payload)) as Fields : null
        const command: Command = {
          kind: decision.command === 'chat' ? 'message' : decision.command as Command['kind'], envelope_hash: hex(hash), from: hex(h.sender),
          object_id: h.object ? hex(h.object.objectId) : h.timeline?.kind === 'cardChat' ? hex(h.timeline.id) : null, body,
          choices: decision.choices, allow: decision.allow,
        }
        this.commands.push(command)
        this.onCommand(command)
        await client.engine.do(d => d.commandFinished(hash))
      })().catch(() => {})
    })
  }
  /** Its main session: the one session group it is a leaf of. */
  get session_id(): string {
    const g = this.client.engine.groups.find(x => x.session !== null && !x.archived)
    if (!g?.session) throw new Error('the agent has no session')
    return hex(g.session.sessionId)
  }
  private get session(): Uint8Array { return unhex(this.session_id) }
  private async first(kind: 'card' | 'artifact', fields: Fields, urgency: Urgency, push: boolean): Promise<string> {
    const body = { ...fields, object_version: 1, previous_version_hash: '0'.repeat(64) }, payload = encodeBodyBytes(kind, body)
    const draft: Draft = kind === 'card' ? { kind: 'cardFirst', session: this.session, urgency, push, payload } : { kind: 'artifactFirst', session: this.session, payload }
    const sealed = await this.client.engine.seal(draft, null, fileIdsOf(kind, body))
    const id = hex(sealed.objectId!)
    this.objects.set(id, { version: 1, hash: hex(sealed.envelopeHash), kind, fields })
    return id
  }
  private async next(object_id: string, fields: Fields, closed: boolean, urgency: Urgency = 'normal'): Promise<void> {
    const held = this.objects.get(object_id)
    if (!held) throw new Error('not an object of this agent')
    const merged = { ...held.fields, ...fields }
    const body = { ...merged, object_version: held.version + 1, previous_version_hash: held.hash }, payload = encodeBodyBytes(held.kind, body)
    const draft: Draft = held.kind === 'card' ? { kind: 'cardVersion', session: this.session, objectId: unhex(object_id), closed, urgency, push: false, payload }
      : { kind: 'artifactVersion', session: this.session, objectId: unhex(object_id), closed, payload }
    const sealed = await this.client.engine.seal(draft, null, fileIdsOf(held.kind, body))
    this.objects.set(object_id, { ...held, version: held.version + 1, hash: hex(sealed.envelopeHash), fields: merged })
  }

  /** A decision or info card. Returns its object id. */
  askCard(fields: Fields, { urgency = 'normal', push = true }: { urgency?: Urgency; push?: boolean } = {}): Promise<string> { return this.first('card', { card_type: 'decision', ...fields }, urgency, push) }
  reviseCard(object_id: string, fields: Fields): Promise<void> { return this.next(object_id, fields, false) }
  closeCard(object_id: string, fields: Fields = {}): Promise<void> { return this.next(object_id, fields, true) }
  /** A permission request. Returns its object id. */
  async askPermission(fields: { tool_name: string; description: string; input_preview: string }, expires_at = Date.now() + 600_000): Promise<string> {
    const sealed = await this.client.engine.seal({ kind: 'permissionRequest', session: this.session, urgency: 'critical', push: true, expiresAt: expires_at, payload: encodeBodyBytes('request', fields) }, null, [])
    const id = hex(sealed.objectId!)
    return id
  }
  /** An Artifact: version 1 publishes. Returns its object id. */
  publish(fields: Fields): Promise<string> { return this.first('artifact', { artifact_type: 'media', ...fields }, 'normal', false) }
  unpublish(object_id: string): Promise<void> { return this.next(object_id, {}, true) }
  /** A Chat message in its session, or on one of its cards. */
  async say(fields: Fields, card: string | null = null): Promise<void> {
    const payload = encodeBodyBytes('message', { content_type: 'message', ...fields })
    await this.client.engine.seal(card ? { kind: 'cardChat', session: this.session, card: unhex(card), payload } : { kind: 'sessionChat', session: this.session, payload }, null, fileIdsOf('message', fields))
  }
  /** A register of its session group: `profile`, `status_line/<id>`, `heard`, `alert/<hash>`. */
  async setRegister(name: string, value: unknown): Promise<void> {
    await this.client.engine.seal({ kind: 'register', group: this.client.core.sessionGroupId(this.client.room_id, this.session), name, value: value === null ? null : utf8.encode(JSON.stringify(value)) }, null, [])
  }
  /** One step of a running turn (7.3), by the binding's real `sendWorkTrail`. */
  async workStep(turn: string, number: number, step: { text: string; tool?: string }): Promise<void> {
    const group = this.client.core.sessionGroupId(this.client.room_id, this.session)
    await this.client.engine.land(d => d.sendWorkTrail(group, unhex(turn), number, utf8.encode(JSON.stringify(step)), Date.now()))
  }
  async upload(bytes: Uint8Array, meta: Fields = {}): Promise<AttachmentRef> {
    const { file, size } = await putEncrypted(this.client.core, this.client.hub, bytes)
    return attachmentRef(file, { ...meta, total_size: size })
  }
  fetch(ref: AttachmentRef): Promise<Uint8Array> { return getDecrypted(this.client.core, this.client.hub, fileRefOf(ref)) }
  settle(): Promise<void> { return this.client.settle() }
  stop(): Promise<void> { return this.client.stop() }
}
