// types.ts: the shapes of the protocol and of the board model, as types only (nothing here exists at run time).
// The wire format is spec/FORMAT.md and the README "Hub v1: the wire protocol"; the bodies are codec.ts; the
// model is core/README.md "The model" and model.ts. Names follow the README: snake_case, ids as lowercase hex
// strings, times in ms since the epoch, envelope numbers as the hub's order.
//
// What a newer client may write is kept, never refused for its shape: so the body types are open where the README
// says unknown fields are kept (decode keeps them), and the enumerations are the names this version knows.

// ---- small things ------------------------------------------------------------------------------------------------

/** Lowercase hex (ids: 32 hex for objects, sessions and desks, 64 for device ids and envelope hashes). */
export type Hex = string
/** Milliseconds since the epoch. */
export type Ms = number
/** The hub's order of envelopes, 1, 2, ... (0: none yet). */
export type EnvelopeNumber = number

export type Role = 'human' | 'agent'
export type ObjectState = 'open' | 'answered' | 'closed'
export type Urgency = 'low' | 'normal' | 'high' | 'critical'
export type TimelineKind = 'chat' | 'scribble'
export type CardType = 'decision' | 'info'
export type AnswerAction = 'answer' | 'read' | 'shred'
export type ContentType = 'message' | 'strokes' | 'erase' | 'move' | 'send_away' | 'selection_sent'
/** What a decoded body is: read ('ok'), only the header is left ('pruned'), or it cannot be read here. */
export type ContentState = 'ok' | 'pruned' | 'newer_schema' | 'undecryptable' | 'header'
export type Connection = 'offline' | 'connecting' | 'catching_up' | 'live'

/** The envelope kinds of format version 1 (codec KIND); 8 (scribble) is reserved. */
export interface KindNumbers {
  timeline_item: 1; object_version: 2; answer: 3; permission_request: 4; verdict: 5; status: 6; decide_again: 7
}
export type KindName = keyof KindNumbers

// ---- bodies (codec.ts: encodePayload / decodePayload) -----------------------------------------------------------

/** README "Attachment references": what a body names of an encrypted file on the hub. */
export interface AttachmentRef {
  attachment_id: Hex
  file_key: string          // base64url
  sha256: string            // base64url
  total_size: number
  file_name?: string
  media_type?: string
  width?: number
  height?: number
  caption?: string
  page?: unknown
  poster_attachment_id?: Hex
  marks?: unknown[]
}

/** Fields every body may carry beside its own: the schema version and the writer's signed counter (R2). */
export interface BodyBase {
  schema_version?: number
  lamport?: number
  [field: string]: unknown
}

export interface CardOption { key: string; label: string; detail?: string | null; short?: string | null; final?: true; [field: string]: unknown }
export interface CardSection { text: string; key?: string; label?: string; html?: string; picture?: unknown; recommended?: boolean; final?: boolean; short?: string; [field: string]: unknown }

export interface MessageBody extends BodyBase {
  content_type: 'message'
  text?: string
  details?: string | null
  html?: string | null
  attachments?: AttachmentRef[]
  hand_back?: boolean
  explain?: boolean
  present_card?: boolean
  copied_cards?: unknown[]
  marks?: unknown[]
  published_object_id?: Hex
  /** The note it was sent from: { object_id, written_at }. */
  note?: { object_id: Hex; written_at?: Ms | null }
  /** The terminal mirror, from an agent only: 'input' = what the human typed into the agent's terminal (the agent's
   *  connector says so; no human device signed it), 'answer' = the agent's final text of a turn in the terminal,
   *  'work' = an envelope of a turn's trail (`work`; README "The trail"): no text of its own. */
  terminal?: 'input' | 'answer' | 'work'
  /** With terminal 'work': what changed in the trail of one turn since its last envelope. A client folds the
   *  envelopes of a `turn` in the order of `seq` into one block; an item stands where its `id` first came and takes
   *  the fields of every later envelope that names it. */
  work?: WorkEnvelope
}
export interface WorkEnvelope {
  turn: string
  seq: number
  state: 'running' | 'done' | 'interrupted' | 'failed'
  started_at: Ms
  ended_at?: Ms
  /** Steps beyond the trail's limit: counted, not listed. */
  more?: number
  items: WorkItem[]
}
export interface WorkItem {
  id: string
  /** 'step' = a tool call, 'text' = the agent's words between two steps, 'helper' = a subagent. */
  kind: 'step' | 'text' | 'helper'
  /** A step's tool, a helper's kind. */
  tool?: string
  /** The call's own short description; what it is about (a path, a pattern, a query). */
  title?: string
  subject?: string
  state?: 'running' | 'ok' | 'failed' | 'interrupted'
  at?: Ms
  ms?: number
  /** A helper's steps so far. */
  steps?: number
  /** A step that failed because a shell command ended with this exit code (1 to 255). */
  exit?: number
  /** kind 'text': the words (markdown). */
  text?: string
  /** Only at the level `full`: what went in and an excerpt of what came out, cut and redacted. */
  input?: string
  output?: string
}
export interface StrokesBody extends BodyBase { content_type: 'strokes'; strokes: unknown[]; attachments?: AttachmentRef[] }
export interface StrokeIdsBody extends BodyBase { content_type: 'erase' | 'move' | 'send_away'; stroke_ids: string[]; offset?: unknown }
export interface SelectionSentBody extends BodyBase { content_type: 'selection_sent'; text?: string; attachments?: AttachmentRef[]; stroke_ids?: string[]; board?: unknown }
export type TimelineBody = MessageBody | StrokesBody | StrokeIdsBody | SelectionSentBody

export interface ObjectBodyBase extends BodyBase { object_version: number; previous_version_hash?: Hex | null }
export interface CardBody extends ObjectBodyBase {
  object_type: 'card'
  card_type?: CardType | string
  title?: string
  teaser?: string | null
  body?: string | null
  options?: CardOption[]
  sections?: CardSection[] | null
  html?: string | null
  allows_multiple?: boolean
  recommended?: string | string[] | null
  urgency_reason?: string | null
  attachments?: AttachmentRef[]
  change_note?: string | null
  close_summary?: string | null
  withdraw_reason?: string | null
  merged_into_object_id?: Hex | null
  merged_from_object_ids?: Hex[] | null
}
/** A note's fields are the app's (place, session, to, attachments, held, ...): only text is the core's. */
export interface NoteBody extends ObjectBodyBase { object_type: 'note'; text?: string }
export interface PublishedBody extends ObjectBodyBase { object_type: 'published'; attachments?: AttachmentRef[]; title?: string; note?: string | null; released_until?: Ms | null }
export type ObjectBody = CardBody | NoteBody | PublishedBody

export interface AnswerBody extends BodyBase {
  answer_action: AnswerAction | string
  choices?: string[]
  note?: string | null
  option_notes?: Record<string, string>
  attachments?: AttachmentRef[]
  marks?: unknown[]
  trusted?: boolean
}
export interface PermissionRequestBody extends BodyBase { tool_name?: string; description?: string; input_preview?: string; withdraw_reason?: string }
export interface StatusBody extends BodyBase { values: Record<string, unknown> }

/** Any decoded body (open: a newer client's fields are kept). */
export type Body = TimelineBody | ObjectBody | AnswerBody | PermissionRequestBody | StatusBody | BodyBase

/** codec decodeBindFor: the bind of an answer, verdict, permission request or decide-again, bytes as hex. */
export interface Bind {
  cardId?: Hex; cardHash?: Hex; versionHash?: Hex; objectId?: Hex
  choice?: string; choices?: string[]
  previousHash?: Hex
  requestId?: Hex; requestHash?: Hex; expiresAt?: Ms; allow?: boolean
  [field: string]: unknown
}

// ---- the record the sync engine hands the reducer (client _record) --------------------------------------------

/** R2: the signed facts that order writes to a register or a note (model compareWrites). */
export interface Causal { sender_device_id: Hex; sender_sequence: number; sent_at: Ms; lamport: number; no_body?: boolean }

export interface Rec {
  envelope_number: EnvelopeNumber
  envelope_hash: Hex
  sender_device_id: Hex
  sender_role: Role | 'unknown'
  recipient_device_id: Hex | null
  sent_at: Ms
  kind: number
  is_head?: boolean
  object: { object_id: Hex; object_state: number; urgency: number; answered_at?: Ms } | null
  timeline_kind: TimelineKind | string | null
  timeline_id: string | null
  session_id?: Hex | null
  attachment_ids?: Hex[]
  content: Body | null
  content_state: ContentState
  newer_content?: Body | null
  bind: Bind | null
  local_id?: string | null
  causal?: Causal | null
  sender_sequence?: number | null
  pending?: boolean
  object_id_ok?: boolean | null
  /** The session key epoch it was sealed in. */
  _epoch?: number
  [field: string]: unknown
}

export interface ApplyResult { applied: boolean; refused?: string }

// ---- the model (core/README.md "The model") ------------------------------------------------------------------

/** An agent's link report as the model keeps it (model cleanLink). */
export interface Link {
  hears: 'live' | 'oncall'
  attached: boolean
  last_call_at: Ms | null
  working: boolean
  since: Ms | null
  cut_since: Ms | null
  exit: { reason: string; claude: 'alive' | 'gone' | 'checking' } | null
}
export type LinkStateName = 'live' | 'oncall' | 'asleep' | 'cut' | 'gone'
export interface LinkState { state: LinkStateName; since: Ms | null; idle_ms: number | null; reason: string }
/** What linkState reads: a member or a session. */
export interface Linked { is_online?: boolean; offline_since?: Ms | null; link?: Link | null }

export interface Room {
  room_id: Hex | null
  hub_url: string | null
  my_device_id: Hex | null
  my_role: Role | null
  key_epoch: number
  last_entry_number: number
  last_envelope_number: EnvelopeNumber
  connection: Connection
  agent_session_id: string | null
  outbox_blocked: { local_id: string; code: string; message: string } | null
  [field: string]: unknown
}

export interface Member extends Linked {
  device_id: Hex
  device_role: Role
  device_name: string
  fingerprint: string
  platform: string | null
  folder: string | null
  host: string | null
  is_active: boolean
  added_entry_number: number
  removed_entry_number: number | null
  is_me: boolean
  is_online: boolean
  offline_since: Ms | null
  link: Link | null
  agent_session_id: string | null
}

export interface StatusLine { id: string; label: string; state: string | null; detail: string | null; object_id: Hex | null; envelope_number: EnvelopeNumber; updated_at: Ms }
export interface RegisterValue { value: unknown; envelope_number: EnvelopeNumber; sender_sequence?: number | null | undefined; causal: Causal | null }
export interface Profile { model?: string; task?: string; icon?: string; agent_name?: string; parent_session?: string; is_main?: boolean; [field: string]: unknown }
export interface SessionSettings { name?: string; desk?: string | null; archived?: boolean; group?: string; icon?: string; [field: string]: unknown }

export interface Session extends Linked {
  session_id: Hex
  agent_device_ids: Hex[]
  ever_agent_ids: Hex[]
  /** The agents of each session key epoch. */
  epoch_agent_ids: Record<number, Hex[]>
  agent_device_id: Hex | null
  agent_session_id: string | null
  device_name: string
  is_active: boolean
  is_online: boolean
  offline_since: Ms | null
  link: Link | null
  heard_up_to: EnvelopeNumber | null
  heard_at: Ms | null
  session_key_epoch: number
  with_history: boolean
  created_by_agent?: boolean
  creator_device_id?: Hex | null
  profile: Profile | null
  status_lines: StatusLine[]
  agent_alerts: { key: string; value: unknown; envelope_number: EnvelopeNumber }[]
  registers: Map<string, RegisterValue>
  settings: SessionSettings | null
  /** On an agent only: the goals of the desk this session is on, as a human device handed them over (the human
   *  register goals/<session>, sealed under the session's key), and the envelope that said so. */
  desk_goals?: { desk_id: string; desk_name: string; goals: string } | null
  desk_goals_at?: EnvelopeNumber
  card_ids: Hex[]
  open_card_ids: Hex[]
  timeline_key: string
  last_activity_at: Ms
}

export interface CardVersion {
  object_version: number
  version_hash: Hex
  previous_version_hash: Hex | null
  envelope_number: EnvelopeNumber
  sent_at: Ms
  object_state: ObjectState
  urgency: Urgency
  content: Body | null
}

export interface Answer {
  answer_action: AnswerAction | string
  choices: string[]
  note: string | null
  option_notes: Record<string, string>
  attachments: AttachmentRef[]
  marks: unknown[]
  trusted: boolean
  bound_version_hash: Hex | null
  bound_object_version: number
  envelope_number: EnvelopeNumber | null
  envelope_hash: Hex | null
  by_device_id: Hex
  answered_at: Ms
  taken_back_at: EnvelopeNumber | null
  taken_back_sent_at: Ms | null
  pending: boolean
  unsupported?: true
  [field: string]: unknown
}

export type ClosedHow = 'answered' | 'settled' | 'read' | 'shredded' | 'withdrawn' | 'merged' | 'closed'

export interface Card {
  object_id: Hex
  agent_device_id: Hex
  session_id: Hex | null
  object_state: ObjectState
  urgency: Urgency
  card_type: CardType | string
  title: string
  teaser: string | null
  body: string | null
  options: CardOption[]
  sections: CardSection[] | null
  html: string | null
  allows_multiple: boolean
  recommended: string | string[] | null
  urgency_reason: string | null
  attachments: AttachmentRef[]
  change_note: string | null
  close_summary: string | null
  withdraw_reason: string | null
  merged_into_object_id: Hex | null
  merged_from_object_ids: Hex[] | null
  object_version: number
  version_hash: Hex | null
  envelope_number: EnvelopeNumber
  first_envelope_number: EnvelopeNumber
  created_at: Ms
  updated_at: Ms
  versions: CardVersion[]
  answer: Answer | null
  answers: Answer[]
  closed_how: ClosedHow | null
  in_revision: { by: 'hand_back' | 'explain'; envelope_number: EnvelopeNumber } | null
  timeline_key: string
  content_state: ContentState
  unsupported?: 'newer_schema' | 'card_type' | null
  /** The newest refused closing head the hub holds for it (model cardsToReassert). */
  refused_head?: EnvelopeNumber
  [field: string]: unknown
}

export type PermissionState = 'pending' | 'allowed' | 'denied' | 'withdrawn' | 'expired'
export interface PermissionRequest {
  object_id: Hex
  agent_device_id: Hex
  session_id: Hex | null
  tool_name: string
  description: string
  input_preview: string
  expires_at: Ms
  version_hash: Hex
  envelope_number: EnvelopeNumber
  sent_at: Ms
  permission_state: PermissionState
  withdraw_reason: string | null
  verdict: { allow: boolean; by_device_id: Hex; envelope_number: EnvelopeNumber } | null
}

/** A note carries the app's fields beside these (place, session, to, attachments, held, ...). */
export interface Note {
  object_id: Hex
  by_device_id: Hex
  text: string
  object_version: number
  version_hash: Hex | null
  version_hashes: Hex[]
  causal: Causal | null
  envelope_number: EnvelopeNumber | null
  object_state: ObjectState
  pending: boolean
  unsupported: boolean
  local_id?: string
  _base?: Note | null
  [field: string]: unknown
}

export interface Published {
  object_id: Hex
  agent_device_id: Hex
  session_id: Hex | null
  attachments: AttachmentRef[]
  title: string
  note: string | null
  released_until: Ms | null
  object_version: number
  version_hash: Hex
  envelope_number: EnvelopeNumber
  object_state: ObjectState
}

export type ItemState = 'header' | 'loading' | 'loaded' | 'pruned' | 'undecryptable' | 'newer_schema' | 'unsupported'
export interface TimelineItem {
  envelope_number: EnvelopeNumber | null
  local_id: string | null
  pending: boolean
  envelope_hash: Hex | null
  sender_device_id: Hex
  sender_sequence: number | null
  recipient_device_id: Hex | null
  sent_at: Ms
  item_state: ItemState
  content_type: ContentType | string | null
  content: Body | null
  [field: string]: unknown
}

export interface Timeline {
  timeline_key: string
  timeline_kind: TimelineKind | string
  timeline_id: string
  object_id: string
  item_count: number
  newest_envelope_number: EnvelopeNumber
  newest_human_envelope_number: EnvelopeNumber
  newest_agent_envelope_number: EnvelopeNumber
  /** Only the window in memory, keyed by envelope number (or local id while pending), not sorted. */
  items: Map<EnvelopeNumber | string, TimelineItem>
  loaded_down_to: number
  has_more: boolean
  window_open: boolean
}

export interface HumanRegister { value: unknown; envelope_number: EnvelopeNumber | null; by_device_id: Hex | null; pending: boolean; causal: Causal | null }
export interface HumanRegisters {
  drafts: Map<Hex, any>
  snoozes: Map<Hex, { until?: Ms | null; [field: string]: unknown }>
  ducks: Map<Hex, unknown>
  crown: unknown
  desks: Map<string, any>
  session_settings: Map<Hex, SessionSettings>
  scribble_snapshots: Map<string, any>
  raw: Map<string, HumanRegister>
}

export type InviteState = 'open' | 'confirm_code' | 'adding' | 'joined' | 'expired' | 'failed'
export interface Invite {
  invite_id: Hex
  device_role: Role
  link: string
  label: string
  expires_at: Ms
  check_code?: string | null
  invite_state: InviteState
  newcomer: { device_id: Hex; device_name: string } | null
  error: string | null
  [field: string]: unknown
}

export interface Alert { alert_id: string; code: string; message: string; envelope_number: EnvelopeNumber | null; sender_device_id: Hex | null; at: Ms; source: 'local' | 'agent' }

export interface OutboxItem {
  local_id: string
  envelope_kind?: number
  object_id?: Hex | null
  timeline_key?: string | null
  recipient_device_id?: Hex | null
  content?: unknown
  outbox_state: 'sending' | 'blocked' | 'failed'
  error?: unknown
  [field: string]: unknown
}

/** model.newer: what a newer client wrote, counted. */
export interface Newer { count: number; what: string[]; envelope_number: EnvelopeNumber }

export interface Model {
  room: Room
  members: Map<Hex, Member>
  sessions: Map<Hex, Session>
  cards: Map<Hex, Card>
  permissions: Map<Hex, PermissionRequest>
  notes: Map<Hex | string, Note>
  published: Map<Hex, Published>
  timelines: Map<string, Timeline>
  human: HumanRegisters
  invites: Map<Hex, Invite>
  alerts: Alert[]
  outbox: OutboxItem[]
  /** Open cards in board order (projection). */
  stack: Hex[]
  open_permission_ids: Hex[]
  newer: Newer
  // internal: device registers by device id, the projection's sorted state
  _device_registers?: Map<Hex, any>
  _proj?: Projection | null
}

/** model.ts project(): the incremental state of the stack. */
export interface Projection {
  keys: Map<Hex, StackKey>
  sorted: Hex[]
  nextPermExpiry: number
  stackDirty: boolean
  permsDirty?: boolean
  nextWake: number
}
export type StackKey = [rank: number, created_at: Ms, agent_device_id: string, object_id: Hex]

/** One `change` event: what a batch touched. Every field is always present. */
export interface Change {
  cards: Set<Hex>
  sessions: Set<Hex>
  permissions: Set<Hex>
  notes: Set<Hex | string>
  published: Set<Hex>
  timelines: Set<string>
  registers: Set<string>
  members: boolean
  invites: Set<Hex>
  alerts: boolean
  outbox: boolean
  stack: boolean
  room: boolean
  /** Exactly the items added or replaced in this batch, by timeline key. */
  items: Map<string, TimelineItem[]>
}

// ---- storage (core/README.md "Storage adapter") ----------------------------------------------------------------

export interface RangeOptions { after?: string | undefined; before?: string | undefined; limit?: number | undefined; reverse?: boolean | undefined }
/** The device as stored: its id and public keys, and its private keys (CryptoKeys; non-extractable where the adapter wraps them). */
export interface StoredDevice { id: Uint8Array; signPub: Uint8Array; kexPub: Uint8Array; signKey: CryptoKey; kexKey: CryptoKey; [field: string]: unknown }
/** A storage adapter: string keys, structured-clone values, ordered windowed reads, and the device's keys. */
export interface Storage {
  extractable_keys: boolean
  /** IndexedDB: saveDevice wraps extractable keys and swaps in non-extractable ones. */
  wraps_keys?: boolean
  /** A follower tab's overlay (tabs.ts): reads a snapshot, writes stay in memory. */
  overlay?: boolean
  get(key: string): Promise<any>
  set(key: string, value: unknown): Promise<void>
  delete(key: string): Promise<void>
  /** One transaction; undefined deletes. durable: on disk before it resolves (the outbox, R4 write-ahead). */
  setMany(entries: Iterable<readonly [string, unknown]>, opts?: { durable?: boolean }): Promise<void>
  keys(prefix?: string): Promise<string[]>
  range(prefix: string, opts?: RangeOptions): Promise<[string, any][]>
  /** Every key and value in one consistent read, except under the skip prefixes. */
  snapshot?(opts?: { skip?: readonly string[] }): Promise<Map<string, any>>
  saveDevice(device: StoredDevice): Promise<void>
  loadDevice(): Promise<StoredDevice | null>
  close(): Promise<void>
}
