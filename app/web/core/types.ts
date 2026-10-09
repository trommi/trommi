// types.ts: the shapes of the board model, as types only (nothing here exists at run time).
// The model is core/README.md "The model": what the views render from. model.ts builds it from what the Rust core
// accepted (core-api.ts); codec.ts turns the bodies of spec/v2.md section 9.1 into the fields named here. Names are
// snake_case, ids lowercase hex (the wire and the core speak base64url; ids.ts and codec.ts convert at the edge),
// times in ms since the epoch, envelope numbers are the hub's change numbers.
//
// What a newer client may write is kept, never refused for its shape: so the body types are open (unknown fields
// stay), and the enumerations are the names this version knows.

// ---- small things ------------------------------------------------------------------------------------------------

/** Lowercase hex (ids: 32 hex for objects, sessions, boards and files, 64 for device ids and envelope hashes). */
export type Hex = string
/** Milliseconds since the epoch. */
export type Ms = number
/** The hub's change number under which an envelope arrived: one counter per room, 1, 2, ... (0: none yet). */
export type EnvelopeNumber = number

export type Role = 'human' | 'agent'
export type ObjectState = 'open' | 'answered' | 'closed'
export type Urgency = 'low' | 'normal' | 'high' | 'critical'
/** A timeline's kind as the model's keys name it: a Chat, or a Scribble Board. */
export type TimelineKind = 'chat' | 'scribble'
export type CardType = 'decision' | 'info'
export type AnswerAction = 'answer' | 'read' | 'shred'
/** What a timeline item's content is. `stroke_piece` is the model's own: the points of a stroke still being drawn
 *  (spec 7.2), shown in the board's window and never stored. */
export type ContentType = 'message' | 'strokes' | 'erase' | 'move' | 'send_away' | 'stroke_piece'
/** What is known of a body: read ('ok'), only the header is left ('pruned'), or it cannot be read here. */
export type ContentState = 'ok' | 'pruned' | 'newer_schema' | 'undecryptable' | 'header'
export type Connection = 'offline' | 'connecting' | 'catching_up' | 'live'

// ---- bodies as the model holds them (codec.ts decodeBody / encodeBody) --------------------------------------------

/** What a body names of an encrypted file on the hub. On the wire (spec 9.1.1) `attachment_id` is `file_id` and
 *  `poster_attachment_id` is `poster_file_id`, both base64url. */
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
  /** The page a picture was made from: 'attachment:<attachment_id>' of the same list, or an address. */
  page?: unknown
  poster_attachment_id?: Hex
  marks?: unknown[]
  [field: string]: unknown
}

/** Fields every body may carry beside its own. */
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
  /** The Artifact this message presents (on the wire: `artifact_object_id`). */
  published_object_id?: Hex
  /** The note it was sent from: { object_id, written_at }. */
  note?: { object_id: Hex; written_at?: Ms | null }
  /** The terminal mirror, from an agent only: 'input' = what the human typed into the agent's terminal, 'answer' =
   *  the agent's final text of a turn. 'work' is never on the wire: model.ts gives a turn's work trail (spec 7.3)
   *  this form, one item per step, so that the views fold it as they always did (work.ts). */
  terminal?: 'input' | 'answer' | 'work'
  work?: WorkEnvelope
}
/** One step of a turn's trail in the form the views fold (work.ts foldWork). */
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
  tool?: string
  title?: string
  subject?: string
  state?: 'running' | 'ok' | 'failed' | 'interrupted'
  at?: Ms
  ms?: number
  steps?: number
  exit?: number
  text?: string
  input?: string
  output?: string
}
/** A board item's content in the model: positions and lengths in board units, shape ids `<sender hex>/<seq>/<index>`
 *  (codec.ts turns it into the whole 1/16 units and base64url ids of spec 10.5, and back). */
export interface StrokesBody extends BodyBase { content_type: 'strokes'; strokes: unknown[] }
export interface StrokeIdsBody extends BodyBase { content_type: 'erase' | 'move' | 'send_away'; stroke_ids: string[]; offset?: unknown }
export type TimelineBody = MessageBody | StrokesBody | StrokeIdsBody

export interface CardBody extends BodyBase {
  object_version?: number
  previous_version_hash?: Hex | null
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
export interface AnswerBody extends BodyBase {
  answer_action?: AnswerAction | string
  choices?: string[]
  note?: string | null
  option_notes?: Record<string, string>
  attachments?: AttachmentRef[]
  marks?: unknown[]
  trusted?: boolean
}

/** Any decoded body (open: a newer client's fields are kept). */
export type Body = TimelineBody | CardBody | AnswerBody | BodyBase

// ---- the model (core/README.md "The model") ------------------------------------------------------------------

/** The signed facts of a register or note write (spec 9.3.2). Kept for display and for the cache; which write is
 *  the current one is the core's word, never worked out from these. */
export interface Causal { sender_device_id: Hex; sender_sequence: number; sent_at: Ms; lamport: number }

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
  /** The room group's epoch. */
  key_epoch: number
  /** THE cursor: the hub's change number up to which this device has processed. */
  last_envelope_number: EnvelopeNumber
  connection: Connection
  outbox_blocked: { local_id: string; code: string; message: string } | null
  [field: string]: unknown
}

export interface Member extends Linked {
  device_id: Hex
  /** 'agent' for an agent device and for a helper device. */
  device_role: Role
  device_name: string
  fingerprint: string
  platform: string | null
  folder: string | null
  host: string | null
  is_active: boolean
  /** The room group's epoch in which this device first saw the member, and the one in which it was gone. */
  added_entry_number: number
  removed_entry_number: number | null
  is_me: boolean
  is_online: boolean
  offline_since: Ms | null
  link: Link | null
}

export interface StatusLine { id: string; label: string; state: string | null; detail: string | null; object_id: Hex | null; envelope_number: EnvelopeNumber; updated_at: Ms }
export interface RegisterValue { value: unknown; envelope_number: EnvelopeNumber; sender_sequence?: number | null | undefined; causal: Causal | null }
export interface Profile { model?: string; task?: string; icon?: string; agent_name?: string; parent_session?: string; is_main?: boolean; [field: string]: unknown }
export interface SessionSettings { name?: string; desk?: string | null; archived?: boolean; group?: string; icon?: string; [field: string]: unknown }

export interface Session extends Linked {
  session_id: Hex
  /** The session's MLS group; null until this device knows the group. */
  group_id: Hex | null
  /** Every leaf of the session's group that is no human device: a main session's agent device; a helper session's
   *  opener and helper devices. */
  agent_device_ids: Hex[]
  /** The device that speaks in it: a main session's agent device; a helper session's first helper device, else its opener. */
  agent_device_id: Hex | null
  /** The start of agent_device_id (16 hex), or null. */
  agent_session_id: string | null
  device_name: string
  /** False once the group is archived, gone, or has no agent device left. */
  is_active: boolean
  /** A leaf of the group is no longer allowed by the room (spec 5.2.8): nothing is taken there until it is cleaned. */
  stale: boolean
  /** The group was archived (spec 5.2.10). */
  group_archived: boolean
  is_online: boolean
  offline_since: Ms | null
  link: Link | null
  heard_up_to: EnvelopeNumber | null
  heard_at: Ms | null
  /** The session group's epoch. */
  session_key_epoch: number
  /** Always false: a helper session's parent is a signed fact of its group, given as profile.parent_session. */
  created_by_agent: boolean
  /** A helper session's opener; null for a main session. */
  creator_device_id: Hex | null
  /** A helper session's main session, from its group's signed extension; null for a main session. */
  parent_session_id: Hex | null
  /** The agent's register `profile`, with parent_session and is_main from the session's group. */
  profile: Profile | null
  status_lines: StatusLine[]
  agent_alerts: { key: string; value: unknown; envelope_number: EnvelopeNumber }[]
  /** Every current register of the session's group, raw, by its model key. */
  registers: Map<string, RegisterValue>
  settings: SessionSettings | null
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
  /** The device that owns the card now (spec 9.2): the one a human addresses an answer to. */
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
  /** The envelope hash of the current version: an answer binds to it. */
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
  /** The change number of the envelope whose state the card shows (an older one never moves it back). */
  state_envelope_number: EnvelopeNumber
  [field: string]: unknown
}

/** `withdrawn` has no source in protocol v2 (a request has no later version); the name stays for the views. */
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
  /** Under an own pending echo: the confirmed note it stands in front of. */
  _base?: Note | null
  [field: string]: unknown
}

/** An Artifact (the model's map keeps its old name, `published`). */
export interface Published {
  object_id: Hex
  agent_device_id: Hex
  session_id: Hex | null
  attachments: AttachmentRef[]
  title: string
  note: string | null
  /** On the wire: `shared_until`. */
  released_until: Ms | null
  artifact_type: string | null
  object_version: number
  version_hash: Hex
  envelope_number: EnvelopeNumber
  /** When version 1 was sent. */
  sent_at: Ms
  object_state: ObjectState
  content_state: ContentState
}

export type ItemState = 'header' | 'loading' | 'loaded' | 'pruned' | 'undecryptable' | 'newer_schema' | 'unsupported'
export interface TimelineItem {
  envelope_number: EnvelopeNumber | null
  local_id: string | null
  pending: boolean
  envelope_hash: Hex | null
  sender_device_id: Hex
  /** The sender's envelope number in its chain (`seq`): a shape's id is `<sender_device_id>/<sender_sequence>/<index>`. */
  sender_sequence: number | null
  recipient_device_id: Hex | null
  sent_at: Ms
  item_state: ItemState
  content_type: ContentType | string | null
  content: Body | null
  /** Fetched out of order and not yet reached by its sender's chain (spec 9.0.6). */
  provisional?: boolean
  [field: string]: unknown
}

export interface Timeline {
  timeline_key: string
  timeline_kind: TimelineKind | string
  timeline_id: string
  object_id: string
  item_count: number
  newest_envelope_number: EnvelopeNumber
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
  /** By timeline id ('desk/<board hex>'): { attachment, frontier, last_envelope_number } (the register `board_snapshot/<board>`). */
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
  /** What was sealed: the draft's kind (core-api.ts Draft). */
  envelope_kind?: string
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
  /** What model.ts keeps for itself (echoes, the projection's sort state, device names): never travels, never rendered. */
  _builder?: unknown
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
