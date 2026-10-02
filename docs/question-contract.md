# Question contract: sections, option notes, drafts, session order, versions and hand-back

What the hub puts into a card and takes from a page, for whoever renders the
Focus window or another client. All of it is additive: a client that
knows none of them keeps working with `body`, `options`, `recommended`,
`note`.

Everything below is in the state every page gets over `/events`, on the card
itself (`state.cards[i]`).

## 1. `card.sections`: one structured text, paragraphs tied to options

An agent may hand in a question as one structured text instead of `body` plus
`options`. The hub then stores the blocks on the card and derives the old
fields from them.

### Shape

`card.sections` is **absent** on a card filed the old way (test with
`Array.isArray(card.sections)`), otherwise an ordered list of blocks, each one
of two kinds:

```js
// plain block: context, introduction, a remark between options
{ text: "Three parts, each stands on its own. Tick what I may build." }

// flagged block: this paragraph IS an option
{
  key: "sync",            // the option's key; card.options has an entry with the same key
  label: "Sync between hubs", // short tile label, the same string as that option's label
  text: "Two machines show the same board. About two days more.", // markdown, may be ""
  recommended: false,     // always present on a flagged block; mirrors card.recommended
  picture: 0              // optional: index into card.attachments (0 = first); absent when none
}
```

Guarantees:

- A block is flagged exactly when it has `key`. Plain blocks have only `text`,
  never empty.
- The flagged blocks, in order, are exactly `card.options`, in order:
  `options[i] = { key, label, detail: '' }`. There are at least two, keys unique.
- `recommended` on a block is true exactly when its key is in
  `card.recommended` (a key, a list of keys for `multiple`, or `null`). The hub
  keeps both in step, whichever the agent gave or revised.
- `picture`, when present, is a valid index into `card.attachments` at the time
  of the call. Several blocks may point at the same attachment. Attachments no
  block points at belong to the card as a whole.
- `text` is markdown, as `body` is. It may be `""` for a flagged block (an
  option that needs no explanation).
- `card.body` is the same text for old clients: the blocks joined by a blank
  line, flagged ones as `**Label**: text` (just `**Label**` when the text is
  empty). `card.multiple` is whatever the agent set (default false).
- `revise_card` may replace the blocks, drop them (the card becomes a plain
  one: `sections` disappears, `body` and `options` stand alone) or add them to
  a plain card. `card.revised` changes as for any rewording, so treat
  `sections` like `body`: re-render when the card changes.

### What the client does

- **Left side:** when `card.sections` is there, render the blocks in order
  instead of `card.body`. A plain block is a paragraph. A flagged block is a
  paragraph with its `label` as its heading, visibly belonging to its option.
- **Tie between paragraph and tile:** hovering or focusing either the
  paragraph or its option tile highlights both (`key` is the join).
- **Answering from the text:** on a `multiple` card the paragraph carries the
  option's checkbox; a tap on the paragraph (or its checkbox) toggles the
  option, exactly as its tile does, and both show the same state. On a card
  with one answer a tap on the paragraph selects that option the way its tile
  does (send as before: `POST /decide {card_id, key}`).
- **Advice:** the mark for the agent's recommendation shows on both, the
  paragraph and the tile (`block.recommended`).
- **Picture:** a block with `picture` shows `card.attachments[picture]` with
  its paragraph. The gallery's tie between pictures and options, where it
  exists, should use this link rather than position.
- **Answer:** unchanged. `POST /decide {card_id, key}` or `{card_id, keys}`
  with the option keys; the agent hears `choice` / `choices`.

### Fallback

- No `sections`: render `body` and `options` as before.
- A client that does not know `sections` shows `body` (which already contains
  every paragraph, labels in bold) and the option tiles with their labels and
  empty details. Nothing is lost but the tie.

### What the agent sends (for reference)

`create_decision`, `revise_card`, `merge_cards` take `sections` (the list
above; `picture` may be given as a file name or an index) or `text`, the same
thing as one string:

```
The export times out for large accounts. Tick what I may build.

[limit*] Raise the limit: 60 instead of 30 seconds. Done in five minutes.

[async] Export in the background: The file arrives by mail. About two days.
picture: sketch.png

[page] Paginate the export
Smaller files, but every consumer of the API has to follow.
```

Paragraphs are separated by a blank line. `[key] Label: text` flags one;
without a colon the first line is the label. `[key*]` or `(recommended)` after
the label is the advice; a last line `picture: name-or-index` ties an
attachment. The hub parses `text` into `sections`; the card never carries the
raw string.

## 2. Notes on single options

The human can write a note on any option, chosen or not, besides the general
note.

### Sending

```
POST /decide
{ "card_id": "…", "key": "a" | "keys": ["a", "c"],
  "note": "general note, optional",
  "notes": { "a": "but not before Monday", "b": "not this, too expensive" },
  "revised": <card.revised as the page knows it, optional> }
```

- `notes` is optional: an object from option key to text. Notes for options
  that are **not** chosen are welcome.
- Each note is trimmed; empty ones are dropped. A note over 2000 characters or
  a `notes` that is not an object is refused with 400. A key the card does not
  have is refused with 400, or with 409 and the "revised while you were
  answering" message when the card has been revised (same handling as for
  `key`/`keys`). Nothing is stored on a refusal.

### Stored

```js
card.note          // the general note, as before
card.option_notes  // { "<key>": "text", … } in the order of the options; {} when none.
                   // Absent on cards answered before this existed: read it as card.option_notes ?? {}
```

The `decided` event in the conversation (`message.kind === 'decided'`) has as
its `text` the chosen labels, then ` · Label: note` for each note (shortened
to 80 characters), e.g. `Zweitens · Zweitens: aber erst morgen · Drittens: nicht das, zu teuer`.

### What the agent gets

The channel event keeps its shape; the notes are lines of its text, and
`option_notes` in meta names the keys that have one:

```
<channel source="board" kind="decision" card_id="…" choice="a" choices="a,c" option_notes="a,b">
general note

Notes on options:
- Anton [a], chosen: but not before Monday
- Berta [b], not chosen: not this, too expensive
</channel>
```

Without a general note the first line is the usual `Decision on "<title>": a, c`.

### What the client does

A small scribble mark on each option tile (and on its paragraph, for a
sectioned card) opens a line to write on that option. Show existing notes on
decided cards from `card.option_notes`.

## 3. Drafts: ticked but not sent

What the human ticked and wrote on an open card without sending is kept on the
hub, so "Later" loses nothing and another device shows the same ticks.

### Sending

```
POST /draft   (same login and Origin rules as /decide)
{ "card_id": "…", "keys": ["a", "c"], "note": "half a sentence", "notes": { "b": "…" } }
→ 200 {"ok":true}
```

- Always send the **whole** draft; it replaces the previous one. All three
  fields are optional; a draft with no keys, no note text and no notes
  **clears** it.
- Keys and note keys the card does not have are dropped silently (the card may
  have been revised meanwhile). `keys` come back in the order of the options.
  `note` is stored as typed (not trimmed, so a draft does not eat the space
  you just typed); option notes are trimmed, as in an answer.
- 400: unknown card, a permission card, `keys` not a list, `notes` not an
  object, an option note over 2000 or a note over 10000 characters.
  409: the card is no longer open.
- Sending the same draft again is a no-op: no state push, `ts` unchanged.
- Debouncing is the client's job; every changed draft pushes the state to all
  pages. The state file follows within a second.

### Stored

```js
card.draft = { keys: ["a", "c"], note: "half a sentence", notes: { b: "…" }, ts: 1790930354077 }
// absent when there is none
```

- Only on open decision cards. For a card with one answer `keys` holds what
  the human had selected (normally at most one).
- Gone when the card is answered, withdrawn, merged away or closed.
- When the agent revises the card, keys and notes for options that no longer
  exist drop out; if nothing is left, the draft is gone.
- When the human takes an answer back (`POST /reopen`), the answer becomes the
  draft: `keys` = the former choices, `note` = the former note, `notes` = the
  former `option_notes` (which is `{}` again on the open card). So a reopened
  card shows the ticks and notes it was sent with.
- The agent is not told and `list_cards` does not show it.

### What the client does

Take `card.draft` as the initial state of ticks, note and option notes
whenever a card is shown; write it back with `POST /draft` (debounced) on
every change; when the state arrives with a different `draft.ts` and the human
is not typing in that card, adopt it. After a successful `/decide` there is
nothing to clear: the hub drops the draft.

## 4. Order of the sessions in the sidebar

The human drags sessions into an order of their own; the hub keeps it.

### Sending

```
POST /session   (the route that also takes label, icon, archived, group)
{ "agent": "<id of the session that was dragged>", "before": "<id of the session it was dropped in front of>" }
{ "agent": "<id>", "before": null }      // dropped at the very end
→ 200 {"ok":true}        400 when either id is unknown; nothing moves
```

- `before` may be combined with the other fields of `/session`; leaving the
  key out leaves the order alone (`"before": null` is a move to the end, an
  absent `before` is not a move).
- Members of a group stay together. Dragging a session that has a `group`
  moves the whole group (in its current inner order) in front of the target.
  A target that belongs to another group stands for its group: the dragged
  block lands before that group's first member, never inside it. Only when
  the target is a member of the dragged session's **own** group does the
  session alone move, which reorders within the group.
- `before` equal to `agent` is accepted and changes nothing.

### Stored

- `state.agents` **is** the order: render the sidebar in array order. Each
  agent also carries `position` (0, 1, 2, …, its index in that list), kept
  across reconnects, restarts and hub changes. A new session is appended at
  the end; forgetting a session closes the gap.
- Only the sidebar follows this order. `state.queue` and the inbox's sorting
  of sender groups (VIP, urgency) are untouched.

### What the client does

On drop, send one `POST /session {agent, before}` and render from the state
that comes back over `/events`; do not keep an order of its own.

## 5. Versions of a card, and handing a card back

A question stays one card through its whole life. Every rewording by the
agent (`revise_card`) keeps the version it replaced; the human can look back
at how the question developed.

### Stored on the card

```js
card.version        // 1 when filed, +1 with every rewording. The live fields ARE this version.
card.revisions      // as before: version - 1
card.revised        // as before: when the live version was presented (absent for version 1: use card.created)
card.revision_note  // the agent's note for the live version ("" or absent when none)
card.versions = [   // absent until the first rewording; oldest first; at most the last 20
  {
    n: 1,                 // the version number
    at: 1790930354077,    // when that version was presented
    title, body, options, // as the card had them
    sections,             // only if that version had sections
    recommended,          // key, list or null
    multiple,
    attachments,          // [{name, url, kind, image, size}]; the files stay served while the card lives
    urgency,
    note                  // the agent's note that version came with ("" for version 1)
  }, …
]
card.answered_version // set when decided: the version the answer was given to; null after a reopen
card.with_agent       // a timestamp while the card is with the agent (see below); absent otherwise
```

- A rewording is a change to title, body, options, sections, advice,
  `multiple` or attachments. A mere change of urgency is not a version.
- `card.versions[i]` has the same field names as a card, so the component that
  renders a card can render a version read-only (`picture` indexes in its
  `sections` refer to **its** `attachments`).
- More than 20 earlier versions: the oldest drop out, and files only they
  showed are deleted. `n` keeps counting, so the list may start at `n > 1`.
- Versions are purged with the card.

### In the conversation

The `revised` event (`message.kind === 'revised'`, `card_id`) now carries:

```js
{ kind: 'revised', card_id, version: 3, text: "<note or title>", again: true /* only after a hand-back */ }
```

After a hand-back, `text` starts with `Presented again: `. Use `version` to
place "version 3 presented" in the thread, and `again` to word it.

### Handing back and "What??"

```
POST /message { "text": "…", "agent": "<id>", "card_id": "<open card>", "handback": true }
POST /message { "text": "…", "agent": "<id>", "card_id": "<open card>", "explain": true }
```

- Both flags only count with the `card_id` of an open decision card of that
  session; otherwise they are ignored and the message is plain chat.
- The stored message carries `handback: true` / `explain: true` (besides
  `card_id`); the agent's channel event carries `handback="1"` / `explain="1"`.
- The card gets `with_agent = <now>`. It is cleared when the agent revises the
  card (any `revise_card`) or replies with that `card_id`, and when the card is
  answered, withdrawn, merged or closed. A plain question back (no flag) does
  not set it.
- Clients should read "with the agent" from `card.with_agent`, not from
  localStorage: every device then agrees.

### What the client does

- A small time-machine mark on a card with `card.versions?.length` steps back
  through the versions, read-only; the live card is the last step.
- On a decided card, `answered_version` says which version the answer belongs
  to (it is always the live one at that moment; a decided card cannot be
  revised).
- "Back to agent" sends `handback: true`, "What??" sends `explain: true`; show
  the card as waiting while `with_agent` is set, and as presented again when
  the `revised` event with `again: true` arrives.

## 6. Rich content: tables and HTML beside the words

Two ways, the first with no new syntax.

**A markdown table** in any text the board draws (`reply.text`, `details`,
`body`, a section's `text`): rows between pipes, a rule of dashes under the
first. It is drawn as a table; a column of numbers stands right-aligned, and
`:--`, `:-:`, `--:` in the rule set a column outright. It may stand right under
a sentence, without a blank line.

**HTML**, for what a table in pipes cannot say (merged cells, a small grid,
details, marks):

| Where | How |
|---|---|
| a message | `reply { text, html }` |
| a question | `create_decision` / `revise_card` / `merge_cards { body, html, options }` |
| one block of a question | `sections: [{ text, html, key?, label? }]` |
| inside any text | a block fenced as ```` ```html ```` |

Rules, checked by the server (`server/richhtml.mjs`):

- `html` never stands alone: a message needs `text`, a card `body`, a section
  its `text`. Those words are shown above the layout, are what read-aloud
  speaks, and are all that a client without HTML shows (iOS and Linux ignore
  `html` for now).
- At most 200 KB per block (`BOARD_MAX_HTML_KB`).
- It is stored already cleaned: `script`, `iframe`, `object`, `embed`, `meta`,
  `link`, `base`, `audio`, `video`, `template`, `noscript` are removed, `form`
  tags too (their fields stay); `on…` handlers, `srcdoc`, `srcset`; any `href`
  that is not `http(s):`, `mailto:`, `#…` or relative; any `src` that is not a
  `data:image/…`; `@import` and `url(…)` to an address in CSS. The answer to
  the tool call names what was removed.
- `html` cannot be combined with `sections` or `text` on a card (give it to a
  block). On `revise_card`: left out, it stands; `""` takes it away. It is part
  of `questionSig`, so a new layout is a new version, and each entry of
  `card.versions` keeps the `html` it had.

### Stored and delivered

`message.html`, `card.html`, `card.sections[i].html`, `card.versions[i].html`:
strings, only present when there is one. `list_cards` returns `html` with an
open card. Fenced blocks stay in their text, cleaned in place.

### What the web client does

`store.js` folds every `html` field into its text as a ```` ```html ```` block
(`foldHtml`), and `rich()` draws such a block with `htmlBlock()`
(`js/richhtml.js`): a frame with `sandbox="allow-scripts"` (no origin, so no
cookies, no storage, no way to the board's DOM; no forms, popups or top
navigation), filled by `srcdoc`, under its own policy
`default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src data:; script-src 'nonce-…'`.
The only script that carries the nonce is the board's own: it reports the
content's height, takes theme and fonts, and hands a clicked link to the page.
The board's tokens and a stylesheet for plain semantic HTML are put in, with
the classes `grid`, `cols-2`, `cols-3`, `card`, `tag`, `muted`, `num`, `good`,
`warn`, `bad`. The frame is as tall as its content up to 70% of the screen,
then it scrolls inside and offers "Open large". A row in a list only names it
("a table", "a layout").

## 6. Info cards: something to read, nothing to decide

A third card kind beside `decision` and `permission`. The agent files it with
`create_info`; the human reads it and closes it.

### The card

```js
{
  id, agent, number,          // numbered like every card
  kind: "info",
  status: "open" | "done",    // never "decided"
  title: "How the nightly migration works",
  body: "…markdown…",         // always there; with sections it is the blocks joined by a blank line
  sections: [{ text, html? }, …], // optional; plain blocks only, no block has a key
  html: "…",                  // optional, as on a question (only without sections)
  attachments: [{ name, url, kind, image, size }],
  options: [],                // always empty
  multiple: false, recommended: null, choice: null, choices: [],
  urgency, urgency_reason,
  version, versions, revised, revision_note, with_agent,  // exactly as on a question (section 5)
  read: 1790930354077,        // set when the human closed it; null after a take-back; absent before
  decided: <same as read>,    // so retention treats it like an answered card
  summary: ""                 // the agent's reason if it withdrew the card itself
}
```

- It is in `state.cards` and, while open, in `state.queue`. Within one
  urgency level the queue lists questions first, then infos (then by age).
- Counting: "questions" = queue entries with `kind !== 'info'`, "to read" =
  queue entries with `kind === 'info'`. There is no separate list.
- A row for an info shows number, title, sender and age like a question, but no
  option tiles and no Choose: one action, "Close" (and opening it to read).
  The card view shows title, body or sections, html, attachments, and the same
  conversation, "What??" and "Back to agent" as a question.
- No draft (`POST /draft` answers 400) and no `/decide` (400).

### Closing

```
POST /close { "card_id": "…" }      (same login and Origin rules as /decide)
→ 200 {"ok":true}
  400 unknown card, or the card is not an info
  409 already closed
```

The card becomes `status: "done"` at once with `read` set, leaves the queue,
and the conversation gets an event `{ kind: "read", card_id, text: <title> }`.
The agent gets `<channel source="board" kind="info_read" card_id="…">`; nothing
is expected of it.

### Other things that happen to it

- `POST /reopen {card_id}` on a closed info puts it back unread (`status:
  "open"`, `read: null`), with a `reopened` event; the agent is not told. An
  info the agent withdrew cannot be taken back (400), as with questions.
- `POST /message {text, agent, card_id}` with or without `handback` /
  `explain` works as on a question, including `with_agent`.
- The agent reworks it with `revise_card` (versions, "Presented again" after a
  hand-back), takes it away with `withdraw_card`; `merge_cards` refuses it.
- In the conversation, filing it is the event `{ kind: "info", card_id, text:
  <title> }` (a question's is `asked`).

## 7. A session's symbol, chosen by the agent

- `agent.icon` is `"draw:<name>"` as before; new beside it is `agent.icon_by`:
  `"agent"` when the agent chose it through `introduce(icon)`, `"human"` when
  the human picked it (`POST /session {agent, icon}`), absent when there is no
  icon or on sessions from before this existed (treat absent as the human's).
- The agent never overwrites a symbol with `icon_by !== "agent"`. Clearing it
  (`POST /session {agent, icon: ""}`) hands the choice back to the agent.
- The names come from `client/web/drawings.json`: `[{ name, meaning, hue }]`,
  read at start and whenever the file changes (`BOARD_DRAWINGS` names another
  file). `GET /api/tools` returns the same list as `drawings` (`[]` when the
  file is missing), and the `introduce` tool lists the names with meanings.
  Without the file any lower-case name is accepted.

## 8. A picture and the page it was rendered from

An attachment may carry its page, so the human can open and try what the
picture shows, right under it.

### Shape

Every stored attachment (on messages, cards, and inside `card.versions[i]`):

```js
{
  name: "variant-a.png", url: "/files/3f9a1c2e.png", kind: "image", image: true, size: 48211,
  title: "Variant A",                                 // optional caption
  page: { url: "/files/7b20d4aa.html", kind: "file" } // optional
  //    { url: "/designs/s5.html",     kind: "link" }
  //    { url: "https://…/a/<id>#<key>", kind: "link" }
}
```

- `page.kind === "file"`: a self-contained HTML file the agent sent with the
  picture, stored beside it under `/files/`. It is served behind the login as
  `text/html` with `Content-Security-Policy: sandbox allow-scripts;
  default-src 'none'; style-src 'unsafe-inline'; img-src data:; font-src
  data:; script-src 'unsafe-inline'`. The sandbox (no `allow-same-origin`)
  gives the page an origin of its own: it runs its inline scripts, but has
  neither the board's cookies nor its storage and can load or call nothing.
  Open it in a new tab or in an `<iframe sandbox="allow-scripts">`; never
  inject its markup into the board's own document.
- `page.kind === "link"`: a path on the board (starts with `/`), an asset link
  or an `http(s)` URL. Open it as a link (new tab).
- No `page`: just a picture (or file), as before.
- Any kind of attachment may carry `title`; `page` is meant for pictures.

### How it gets there (for reference)

Agents pass attachments as a path or as `{ path, page?, title? }`. A file
`foo.html` beside an attached picture `foo.png` is linked by itself, and the
tool result says so. Human uploads have no `page`.

### What the client does

Under each picture with `page`, a link or button "Open page" (the `title` as
caption if there is one). Earlier versions of a card keep their pictures and
pages; the files live as long as the card.

## 9. Trust: leaving the decision to the agent

### Sending

```
POST /decide { "card_id": "…", "trust": true, "note": "optional", "revised": <card.revised, optional> }
→ 200 {"ok":true}
  400 the card is an approval (permission) or an info, is unknown or already decided,
      or `key` / `keys` were sent along (trust is no choice of options)
  409 the card was revised while the human was answering (as for any answer)
```

Only on an open card of `kind: "decision"`. Do not offer the button on
permission cards (they gate what the agent may do) or on infos.

### Stored

```js
card.status   = "decided"
card.trusted  = true          // false again after a take-back; absent on cards never trusted
card.choices  = ["b"]         // the agent's recommendation (card.recommended), in option order; [] when it gave none
card.choice   = "b"           // the first of them, or null
card.note     = "…"           // the human's note, if any
card.answered_version         // as for any answer
// card.draft is gone; card.option_notes is {}
```

The `decided` event in the conversation has `trusted: true` and the text
`Trusted: your call`, followed by ` · <recommended labels>` when there is
advice. The agent gets the usual decision event with `trust="1"` (and `choice`
empty when it had recommended nothing); it decides, says what it chose in a
`reply` with the `card_id`, and closes the card. A card that shows `trusted`
with empty `choices` is therefore waiting for that reply.

### Taking it back

`POST /reopen {card_id}` works as for any answer: the card is open again with
`trusted: false`, `choice: null`, `choices: []`. Nothing is ticked (the human
ticked nothing); a note they wrote comes back as `card.draft.note`. The agent
hears `decision_reopened` with `trust="1"`.

## 10. Shred: throwing a card away unanswered

### Sending

```
POST /shred { "card_id": "…", "note": "optional, at most 2000 characters" }
→ 200 {"ok":true}
  400 unknown card, or the card is an approval (permission): those must be answered
  409 the card is not open (already answered, closed or shredded)
```

On an open card of `kind: "decision"` or `kind: "info"`.

### Stored

```js
card.status   = "shredded"     // a fourth status beside open, decided, done
card.shredded = 1790930354077  // when; null again after a take-back; absent on cards never shredded
card.choice   = null, card.choices = []
card.note     = "…"            // the human's note, if any
// card.draft and card.with_agent are gone
```

- The card is out of `state.queue`; count neither as a question nor as "to
  read". It stays in `state.cards` until the retention time has passed
  (counted from `shredded`), so the client can keep a "Shredded" list:
  `state.cards.filter(c => c.status === 'shredded')`.
- The conversation gets `{ kind: "shredded", card_id, text: "<title>" }` (with
  ` · <note>` appended when there is one).
- The agent gets `<channel source="board" kind="shredded" card_id="…">`: not a
  yes and not a no; it must not ask again.
- The agent cannot revise or withdraw a shredded card.

### Taking it back

`POST /reopen {card_id}` on a shredded card makes it open again as it was
(`status: "open"`, `shredded: null`, back in the queue), with a `reopened`
event. The agent hears `decision_reopened` with `shredded="1"` and an empty
`previous_choice`. The draft is not restored (it was dropped on shredding).
