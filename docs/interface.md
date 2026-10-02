# The interface between an agent and the board

<!-- Written by dev/interface-doc.mjs. Do not edit by hand: change the notes in that script and run it again. -->

What an agent can send and receive, what the board stores of it, what the web client shows, and what is still missing. Read from the code on 2 October 2026: `server/server.mjs` (tools, events, routes, records), `server/pad.mjs`, `server/asset-envelope.mjs`, and `client/web/js/` for what is shown. Where an older document says something else, the code wins and the difference is listed under [Mismatches found](#7-mismatches-found).

The same content as a page with a filter: `client/web/designs/interface.html` (on a running board: `/designs/interface.html`).

**To refresh:** `node dev/interface-doc.mjs` rewrites this file and the data in the page. The tool, parameter and event tables come from the definitions in `server/server.mjs` (`TOOLS`, `QUESTION_PROPS`, `CHANNEL_EVENTS`); the columns "stored as", "shown where" and "status", the records, the routes, the wishes and the mismatches are notes kept in the script. `node dev/interface-doc.mjs --check` fails when a parameter or event has no note, so a new field cannot slip past this document.

|  | Count |
| --- | --- |
| Tools | 16 |
| Parameters, nested ones included | 119 (75 at the top level; 60 distinct, because four tools share the question fields) |
| Parameters accepted but not shown | 11 |
| Events to the agent | 8 (7 kinds on the channel, plus the approval verdict) |
| Meta keys on those events | 36 |
| Records | 10, with 144 fields; 23 of them read by no web client |
| Routes for the browser | 35 |
| Routes for agents | 5 |
| Wishes | 19 |
| Mismatches | 20 |

## 1. Overview

Four processes in a row. The agent speaks MCP to its channel process; the channel process speaks HTTP on loopback to the hub; the hub speaks HTTP to the browser. Nothing goes from the agent to the browser directly.

```text
  Claude Code            channel process              hub                       browser
  (the agent)            server.mjs, one per          server.mjs, port 8790     client/web
                         session, over stdio          state.json, data/

  tools/call  ────────►  POST /agent/tool  ────────►  runTool()
                                                      state changes ─────────►  GET /events
                                                                                (the whole state)
              ◄────────  GET /agent/link   ◄────────  deliver()     ◄─────────  POST /message, /decide,
  <channel source=       (event stream)               (or state.pending          /close, /reopen,
   "board" kind=…>                                     while away)               /scribble, /pad/send
  notifications/
  claude/channel

  permission_request ─►  POST /agent/permission ───►  a card: Allow / Deny ──►  GET /events
              ◄────────  …/channel/permission  ◄────  deliver()     ◄─────────  POST /decide
```

- **Agent to board:** MCP tool calls. The channel process forwards each as `POST /agent/tool {id, instance, name, args}`; the hub runs it (`runTool`), changes the state and pushes the whole state to every page. `publish_asset` is the one tool that does its work in the channel process (it encrypts there). The answer to a tool call is a line of text, often with advice ("this is a lot to read", "you now have 4 open questions").

- **Board to agent:** events. The hub writes `{method, params}` onto the session's open `GET /agent/link` stream; the channel process hands it to Claude Code as an MCP notification. If the session is away, the event waits in `state.pending` (at most 100 per session, 30 days) and is sent when it links again. Nothing acknowledges an event.

- **Human to board:** the browser's routes (section 5). The page holds no state of its own except what is put off for later, unsent text and the theme.

- **A second kind of agent:** `dev/session.mjs` puts a script or subagent on the board without Claude Code. It uses the same two routes (`/agent/link`, `/agent/tool`), gets no instructions and no schemas, and reads its events from a log file (`data/sessions/<id>.log`) when asked.

### What a Claude Code channel allows underneath

| Piece | What it is | What follows for us |
| --- | --- | --- |
| Capabilities | `experimental: { "claude/channel": {}, "claude/channel/permission": {} }` beside `tools` | Claude Code must be started with `--dangerously-load-development-channels`; channels are a research preview. |
| `instructions` | One string at `initialize`, 39 sentences today | The only place to tell the agent how to behave. Helper sessions never see it. |
| `notifications/claude/channel` | `{ content: string, meta: { <key>: string } }`; the agent sees `<channel source="board" key="value">content</channel>` | Meta values are strings only: lists travel comma-separated (`choices`, `files`, `elements`), booleans as `"1"`, and anything longer (notes on options) has to be lines of the content. |
| `…/channel/permission_request` | From Claude Code: `{request_id, tool_name, description, input_preview}` | Becomes a card `kind: permission`. Asked once; the channel process retries five times while the hub changes hands. |
| `…/channel/permission` | To Claude Code: `{request_id, behavior: "allow" \| "deny"}` | Claude Code decides whether the terminal or the board answered first. |
| What a channel does not carry | The model's thinking, its tool calls, terminal output, streamed text | The board shows only what the agent sends on purpose. Files travel as paths, never as bytes. |
| Timing | A notification sent before the MCP handshake is finished is lost | The channel process holds events until `initialized`. |

## 2. Agent to board: the tools

Status: **used** = the hub acts on it and, where it is meant to be seen, the web client shows it. **not shown** = accepted and stored, but no web client reads it. **planned** = not built. "Shown where" names the places of the web client: the inbox row, the question card (the Focus window), the conversation.

### The question fields

Shared by `create_decision`, `revise_card` and `merge_cards`; `create_info` takes `title`, `body`, `sections` (without `key`, `label`, `recommended`, `picture`), `text`, `html`, `attachments`, `urgency`, `urgency_reason`. A question is given as `body` + `options`, or as `sections`, or as `text`: one of the three. `*` marks what the schema requires.

| Parameter | Type | Meaning | Stored as | Shown where | Status |
| --- | --- | --- | --- | --- | --- |
| `title` * | string | The question, one line | `card.title` | inbox row, question card, conversation marker | used |
| `body` | string | Context the human needs to decide | `card.body` | question card; inbox row (shortened) | used |
| `html` | string | Optional rich layout shown under the words, at its place, in the house style | `card.html` | question card, in a sandboxed frame; the inbox row only names it ("a table") | used |
| `options` | list of object | The choices offered. Give options (with body), or sections, or text: one of the three. | `card.options[]` | inbox row (two short options answer there), question card | used |
| `options[].key` * | string | Stable identifier returned to you, e.g | `options[].key`; comes back as `choice` / `choices` | nowhere by design: it is the machine name | used |
| `options[].label` * | string | What the human sees on the button, at most about four words | `options[].label` | inbox row, question card, the "Answered" marker | used |
| `options[].detail` | string | Optional consequence of this choice | `options[].detail` | inbox row, question card; read aloud | used |
| `sections` | list of object | Instead of body and options | `card.sections[]`; `body`, `options`, `recommended` are derived from it | question card: each paragraph tied to its option | used |
| `sections[].text` * | string | The paragraph, markdown | `sections[].text` | question card | used |
| `sections[].key` | string | Flags the block as an option | `sections[].key` and `options[].key` | nowhere by design | used |
| `sections[].label` | string | Required with key: the short name of the option on its tile, at most about four words | `sections[].label` and `options[].label` | question card, inbox row | used |
| `sections[].html` | string | A rich layout shown under this paragraph (see html) | `sections[].html` | question card, under its paragraph | used |
| `sections[].recommended` | boolean | true: you would pick this one; several only with multiple: true | `sections[].recommended`, mirrored in `card.recommended` | question card, inbox row: the marker on the advice | used |
| `sections[].picture` | string or integer | An attachment of this card that belongs to this option | `sections[].picture` (always stored as an index into `attachments`) | question card: the picture shown with its option | used |
| `text` | string | The same as sections, written as one text block | parsed into `card.sections`; the string itself is not kept | question card | used |
| `attachments` | list of string or object | Files to show on the card, each an absolute path or { path, page, title } | `card.attachments[]`; files copied to `data/files/` | question card: gallery; inbox row: a count ("2 pictures"). A file named `<x>-<key>.png` is shown with that option | used |
| `attachments[].path` * | string | Absolute path of the file | `attachment.name`, `url`, `kind`, `image`, `size` | question card | used |
| `attachments[].page` | string | The page this picture was rendered from, so the human can open and try it under the picture | `attachment.page {url, kind}` | nowhere: no web client reads `page` | not shown |
| `attachments[].title` | string | A short caption | `attachment.title` | nowhere: captions show the file name | not shown |
| `urgency` | low / normal / high / critical | Position in the stack | `card.urgency`; decides the place in `state.queue` | inbox row and question card (colour, corner tab); conversation marker on a change | used |
| `urgency_reason` | string | What is waiting on this, one short phrase | `card.urgency_reason` | inbox row byline, question card; read aloud | used |
| `multiple` | boolean | true: the human may tick several options and sends them together; the decision then also carries choices, all chosen keys comma-separated. Default … | `card.multiple` | inbox row and question card: tick boxes instead of one tap | used |
| `recommended` | string or list of string | The key of the option you would pick yourself | `card.recommended` (a key, a list, or null) | inbox row, question card: the marker on the advice; it is what Trust takes | used |

### `reply`

A chat message. Result: `sent`, plus what the cleaner removed from HTML and which picture found its page.

| Parameter | Type | Meaning | Stored as | Shown where | Status |
| --- | --- | --- | --- | --- | --- |
| `text` * | string | The message to show in the chat | `message.text` (fenced blocks cleaned) | conversation; the question card's thread when `card_id` is set; read aloud | used |
| `html` | string | Optional rich layout shown under the words, at its place, in the house style | `message.html` (cleaned by `richhtml.mjs`) | conversation, in a sandboxed frame under the words | used |
| `details` | string | Optional longer material shown collapsed under the message | `message.details` | conversation, collapsed under "Details"; question card thread | used |
| `attachments` | list of string or object | Absolute paths of files to show with the message | `message.attachments[]`; each file copied to `data/files/` | conversation: gallery, player or download | used |
| `attachments[].path` * | string | Absolute path of the file | `attachment.name`, `url`, `kind`, `image`, `size` | conversation | used |
| `attachments[].page` | string | The page this picture was rendered from, so the human can open and try it under the picture | `attachment.page {url, kind}`; an HTML file is copied to `data/files/` | nowhere: no web client reads `page` | not shown |
| `attachments[].title` | string | A short caption | `attachment.title` | nowhere: captions show the file name | not shown |
| `card_id` | string | When you answer a question the human asked back about a card (a chat message that carried card_id) | `message.card_id`; clears `card.with_agent` | question card: the thread under the question | used |

### `create_decision`

A question card (`kind: decision`). Result: the card id, its number and place in the stack, and reminders (too long, too many open questions, a question about looks without a picture).

Plus all the question fields above.

### `create_info`

A card to read (`kind: info`), no options. The human closes it; the agent hears `info_read`.

Plus, of the question fields: `title`, `body`, `sections[].text`, `sections[].html`, `text`, `html`, `attachments`, `urgency`, `urgency_reason`.

### `revise_card`

Rewrites an open card in place; a change of wording is a new version. Works on questions and infos (the description says "decision cards").

| Parameter | Type | Meaning | Stored as | Shown where | Status |
| --- | --- | --- | --- | --- | --- |
| `card_id` * | string |  | finds the card; nothing stored | nowhere | used |
| `note` | string | One short line telling the human what changed, shown in the conversation | `card.revision_note`, the text of the `revised` marker, `versions[].note` | conversation marker; question card: version bar and thread | used |

Plus all the question fields above.

### `merge_cards`

Replaces two or more open questions by one new card. Infos and approvals are refused.

| Parameter | Type | Meaning | Stored as | Shown where | Status |
| --- | --- | --- | --- | --- | --- |
| `card_ids` * | list of string | The open cards this one replaces, at least two | new card: `merged_from [{id, number, title}]`; old cards: `status: done`, `merged_into`, `summary` | inbox row byline "replaces N questions"; conversation markers. `merged_into` is not read | used |

Plus all the question fields above.

### `set_urgency`

Moves an open card in the stack. Also works on an info.

| Parameter | Type | Meaning | Stored as | Shown where | Status |
| --- | --- | --- | --- | --- | --- |
| `card_id` * | string |  | finds the card | nowhere | used |
| `urgency` * | low / normal / high / critical |  | `card.urgency` | inbox row, question card, conversation marker | used |
| `reason` | string | Why the urgency changed, one short phrase shown to the human | `card.urgency_reason`, the text of the `urgency` marker | inbox row byline, question card, conversation marker | used |

### `withdraw_card`

Takes an open card off the stack. Also works on an info.

| Parameter | Type | Meaning | Stored as | Shown where | Status |
| --- | --- | --- | --- | --- | --- |
| `card_id` * | string |  | `card.status: done` | the card leaves the inbox | used |
| `reason` | string | One line on why the answer is no longer needed | `card.summary`, the text of the `done` marker ("Withdrawn: …") | conversation marker; history ("Result") | used |

### `close_card`

Marks a card done. The hub does not check the status: it also closes a card that is still open.

| Parameter | Type | Meaning | Stored as | Shown where | Status |
| --- | --- | --- | --- | --- | --- |
| `card_id` * | string |  | `card.status: done` | the card moves from answered to done | used |
| `summary` | string | One line on what you did | `card.summary`, the text of the `done` marker | conversation marker; history ("Result") | used |

### `set_status`

One status line per work stream. `label` is required for a new line although the schema does not say so.

| Parameter | Type | Meaning | Stored as | Shown where | Status |
| --- | --- | --- | --- | --- | --- |
| `id` * | string | Stable identifier of the work stream, e.g | `task.id` (one line per agent and id) | nowhere: it is the key of the line | used |
| `label` | string | Short name the human sees, two or three words | `task.label` | sessions list and sessions table: a pill per line | used |
| `state` * | decision / working / done | decision = red, waiting on the human | `task.state` | the pill's colour; a working line marks the session as running | used |
| `detail` | string | One line on where it stands | `task.detail` | the pill: "label: detail" | used |
| `card_id` | string | For state "decision": the card that holds the question. The line turns yellow by itself once the human answers it. | `task.card_id`; the hub turns the line to `working` when that card is answered | nowhere: no client links the line to its card | not shown |

### `clear_status`

Removes one line, or all of this session's lines.

| Parameter | Type | Meaning | Stored as | Shown where | Status |
| --- | --- | --- | --- | --- | --- |
| `id` | string |  | removes `task` | the pill disappears | used |

### `introduce`

Model, task and symbol of the session.

| Parameter | Type | Meaning | Stored as | Shown where | Status |
| --- | --- | --- | --- | --- | --- |
| `model` * | string | The model you are running as, e.g | `agent.model` (200 characters) | sessions table ("Model"), session header | used |
| `task` | string | What you are working on in this session, one line | `agent.task` (200 characters) | sessions list and table, session header | used |
| `icon` | string | The name of the drawing that fits your task | `agent.icon = "draw:<name>"`, `agent.icon_by = "agent"`; refused if the name is unknown, kept out if the human chose one | everywhere the session has its mark. `icon_by` is not read | used |

### `create_voiceover`

Text to an MP3 through the speech service. Returns the path on the hub's machine.

| Parameter | Type | Meaning | Stored as | Shown where | Status |
| --- | --- | --- | --- | --- | --- |
| `text` * | string | What to say, up to about 4000 characters | an MP3 in `data/speech/<hash>.mp3`; the path is the result | nowhere, until the agent attaches the file | used |
| `style` | string | Optional delivery instruction in plain words, e.g | passed to the speech service as `instructions` | nowhere | used |

### `list_cards`

No parameters. Returns JSON: per card `id`, `number`, `kind`, `status`, `urgency`, `urgency_reason`, `queue_position`, `title`, `version`, `multiple`, `choice`, `choices`, `note`, and when they apply `trusted`, `shredded`, `answered_version`, `with_agent`, `revised`, `merged_from`, `merged_into`; open cards also `body`, `html`, `options`, `recommended`, `sections`. Not returned: `option_notes`, `note_attachments`, `attachments`, `draft`, `summary`.

### `publish_asset`

Runs in the channel process, not on the hub: it encrypts there and uploads ciphertext (`POST /agent/asset`). Needs `path` or `content`; the schema marks neither as required.

| Parameter | Type | Meaning | Stored as | Shown where | Status |
| --- | --- | --- | --- | --- | --- |
| `path` | string | Absolute path of the file to publish | encrypted beside the agent; ciphertext in `data/assets/<id>` | the asset viewer `/a/<id>#<key>` | used |
| `content` | string | The asset itself as a string, e.g | the same, from a string | the asset viewer | used |
| `type` | html / image / video / audio / file | How the viewer shows it | inside the envelope; `asset.type` and `message.asset.type` unless silent | conversation: the label on the asset card | used |
| `title` | string | Shown above the asset and on the board | inside the envelope; `asset.title`, `message.asset.title` unless silent | conversation, question card (links), history, the viewer | used |
| `note` | string | Optional line shown with the link on the board, e.g | `message.asset.note` and a line of `message.text` | conversation: the line under the title | used |
| `silent` | boolean | true: do not show the asset on the board. The hub then never sees the key or the title; the returned link is the only copy. | `asset.silent`; type, title, note and key never reach the hub | nowhere by design | used |
| `keep` | boolean | true: keep until revoked. Default: deleted after 30 days. | `asset.keep`: exempt from the 30-day cleanup | nowhere | used |

### `list_assets`

No parameters. Returns JSON: `id`, `type`, `title`, `bytes`, `created`, `expires`, `silent`, `link` (null for a silent asset).

### `revoke_asset`

Ends a link.

| Parameter | Type | Meaning | Stored as | Shown where | Status |
| --- | --- | --- | --- | --- | --- |
| `id` * | string | The asset id returned by publish_asset | deletes blob and record; the message keeps only the title (`asset.gone`) | conversation: "no longer available" | used |

## 3. Board to agent: the events

Every event on the channel is `notifications/claude/channel` with a `content` string and string-valued `meta`. `kind` says what it is.

### `kind="chat"`

|  |  |
| --- | --- |
| When | The human sent a chat message. |
| Fired by | `POST /message` |
| Content | the message; when the human sent only files, a sentence naming them |
| `meta.kind` | always `chat` |
| `meta.card_id` (sometimes) | set when the human asks back about an open card instead of answering it; answer with reply and the same card_id |
| `meta.handback` (sometimes) | "1" when the human handed that card back to you to be reworked: revise it with revise_card, which presents it again |
| `meta.explain` (sometimes) | "1" when the human pressed "Explain" on that card |
| `meta.files` (sometimes) | absolute paths of the files and pictures the human attached, comma-separated; open them |
| `meta.image_path` (sometimes) | the first attached picture, when there is one |
| Expected of the agent | Answer with `reply`. With `card_id`: answer with the same `card_id`, and rework the card with `revise_card` when it was handed back or unclear. Open the files named in `files` first. |

```text
<channel source="board" kind="chat">Please check the logs first.</channel>
```

### `kind="decision"`

|  |  |
| --- | --- |
| When | The human answered a decision card. |
| Fired by | `POST /decide` |
| Content | the human's note, or a sentence naming the card and the chosen key; when the human wrote notes on single options, a blank line and "Notes on options:" follow, with one line "- Label [key], chosen: note" or "- Label [key], not chosen: note" per note, in the order of the options |
| `meta.kind` | always `decision` |
| `meta.card_id` | the card |
| `meta.choice` | key of the chosen option; of several, the first |
| `meta.choices` (sometimes) | only for a card made with multiple: true: every chosen key, comma-separated, in the order of the options |
| `meta.trust` (sometimes) | "1" when the human left the decision to you: choice is then the option you recommended, or empty if you recommended none; decide, say what you chose with reply and the card_id, and close the card |
| `meta.option_notes` (sometimes) | only when the human wrote notes on single options: the keys that have one, comma-separated; the notes themselves are in the content |
| `meta.files` (sometimes) | absolute paths of what the human attached to the note of the answer, comma-separated |
| `meta.image_path` (sometimes) | the first attached picture, when there is one |
| Expected of the agent | Act on the choice, then `close_card` with a summary. With `trust="1"`: decide yourself, say what you chose with `reply` and the `card_id`, then `close_card`. Read the option notes in the content. |

```text
<channel source="board" kind="decision" card_id="a1b2c3d4" choice="tonight">After the backup, please.</channel>
```

### `kind="decision_reopened"`

|  |  |
| --- | --- |
| When | The human took an answer back; the card is open again. |
| Fired by | `POST /reopen` on an answered, trusted or shredded card |
| Content | a sentence saying which answer was taken back |
| `meta.kind` | always `decision_reopened` |
| `meta.card_id` | the card |
| `meta.previous_choice` | key of the answer that no longer holds |
| `meta.previous_choices` (sometimes) | only for a card made with multiple: true: every key that was chosen, comma-separated |
| `meta.trust` (sometimes) | "1" when what is taken back is the human leaving the decision to you |
| `meta.shredded` (sometimes) | "1" when the human took a card back out of the shredder; previous_choice is then empty |
| Expected of the agent | Stop acting on the old choice, undo what is safe to undo, say so with `reply`, wait for the new answer. With `shredded="1"` there is nothing to undo: the card is simply open again. |

```text
<channel source="board" kind="decision_reopened" card_id="a1b2c3d4" previous_choice="tonight">…</channel>
```

### `kind="shredded"`

|  |  |
| --- | --- |
| When | The human threw a question (or an info) away unanswered. |
| Fired by | `POST /shred` (in the code since today; the running hub did not have it yet when this was written) |
| Content | a sentence saying so and what to do: do not ask again, carry on with your own judgement or drop the matter; then the human's note, if they wrote one |
| `meta.kind` | always `shredded` |
| `meta.card_id` | the card |
| Expected of the agent | Do not ask again, in these or other words. Carry on with your own judgement or drop the matter; if nothing can proceed without an answer, say so once in a `reply`. |

```text
<channel source="board" kind="shredded" card_id="a1b2c3d4">The human threw the question "Which font?" away unanswered. …</channel>
```

### `kind="info_read"`

|  |  |
| --- | --- |
| When | The human read an info card (create_info) and closed it. Nothing is expected of you. |
| Fired by | `POST /close` |
| Content | a sentence naming the card |
| `meta.kind` | always `info_read` |
| `meta.card_id` | the card |
| Expected of the agent | Nothing. |

```text
<channel source="board" kind="info_read" card_id="a1b2c3d4">The human read "How the nightly migration works" and closed it.</channel>
```

### `kind="scribble"`

|  |  |
| --- | --- |
| When | The human drew on the canvas and pressed send. |
| Fired by | `POST /scribble` |
| Content | the caption, or a sentence explaining the two pictures |
| `meta.kind` | always `scribble` |
| `meta.scribble_id` | this moment of the canvas |
| `meta.image_path` | PNG of what the human was looking at |
| `meta.canvas_path` | PNG of the whole canvas |
| `meta.canvas_doc` | the drawing as JSON |
| Expected of the agent | Read `image_path` (what the human looked at), then `canvas_path` if the surroundings matter. A chat message often follows. |

```text
<channel source="board" kind="scribble" scribble_id="9f2c41d07a3e" image_path="/…/scribbles/9f2c41d07a3e.png" canvas_path="/…/scribbles/canvas-api.png" canvas_doc="/…/scribbles/canvas-api.json">This button, further left.</channel>
```

### `kind="pad"`

|  |  |
| --- | --- |
| When | The human selected elements on the pad and sent them to this session. |
| Fired by | `POST /pad/send` |
| Content | the words of the selected notes and spoken notes in reading order, or a sentence pointing at the picture |
| `meta.kind` | always `pad` |
| `meta.pad` | which pad: global |
| `meta.message_id` | the message in the conversation that shows the selection |
| `meta.elements` | ids of the selected elements, comma-separated |
| `meta.image_path` | PNG of exactly the selection, on white |
| Expected of the agent | Read `image_path`; the content already holds the words of the selected notes. |

```text
<channel source="board" kind="pad" pad="global" message_id="5e1f09ab" elements="0muqnb5cchmsr9cse,0muqnb7k2p1d4xw3a" image_path="/…/files/pad-9f2c41d07a3e.png">Ship the pad prototype</channel>
```

### `notifications/claude/channel/permission`

|  |  |
| --- | --- |
| When | The human answered an approval card. Claude Code decides whether this or the terminal came first. |
| Fired by | `POST /decide` on an approval card |
| `request_id` | the id from the request |
| `behavior` | allow or deny |
| Expected of the agent | Nothing: Claude Code takes the verdict, and decides whether the terminal or the board came first. |

```text
{ "request_id": "abcde", "behavior": "allow" }
```

### `notifications/claude/channel/permission_request` (from Claude Code)

|  |  |
| --- | --- |
| When | Claude Code wants approval for a tool call. It becomes a card with Allow and Deny, always on top of the stack. |
| Fired by | Claude Code, before a tool call that needs approval |
| `request_id` | echoed in the verdict |
| `tool_name` | e.g. Bash |
| `description` | what the tool does |
| `input_preview` | the arguments, shortened |
| Expected of the agent | Sent by Claude Code, not by the agent. The channel process turns it into a card `kind: permission`, always first in the stack. |

```text
{ "request_id": "abcde", "tool_name": "Bash", "description": "Run shell command", "input_preview": "{\"command\":\"npm test\"}" }
```

### `initialize` (from Claude Code)

|  |  |
| --- | --- |
| When | Once, when the MCP connection starts. The name appears as "Program" in the sessions overview. |
| Fired by | the MCP handshake |
| `clientInfo.name` | the program on the other end of stdio |
| `clientInfo.version` | its version |
| Expected of the agent | Sent by Claude Code once. `clientInfo` becomes `agent.client` ("Program" in the sessions table). |

```text
{ "clientInfo": { "name": "claude-code", "version": "2.1.0" } }
```

Besides events, the agent gets the text result of each tool call, and on the link the frames `{hello, ping, dedicated}` and a comment line every 15 seconds, which only the channel process reads.

## 4. The records

What the hub keeps and pushes to every page. "Read by" is the web client (`client/web/js/`).

### Card

`state.cards[]`, built by `addCard`

| Field | Shape | Set by | Read by | Status |
| --- | --- | --- | --- | --- |
| `id` | 8 hex characters | hub | everything that names a card | used |
| `agent` | session id | hub | scope, sender on the row | used |
| `number` | integer, counts up per board | hub | inbox row, question card ("Question 12") | used |
| `kind` | `decision` / `info` / `permission` | hub (from the tool, or an approval request) | inbox, question card | used |
| `status` | `open` / `decided` / `done` / `shredded` | hub | everywhere; `shredded` only in the question window so far | used |
| `shredded` | timestamp or null | hub, on `/shred` | retention; the question window shows the strip "Shredded" from its own memory | used |
| `title`, `body`, `html` | strings (markdown; cleaned HTML) | agent | inbox row, question card | used |
| `options[]` | `{key, label, detail}` | agent (hub for an approval: Allow / Deny) | inbox row, question card | used |
| `sections[]` | `{text, html?}` or `{key, label, text, html?, recommended, picture?}` | agent | question card | used |
| `attachments[]` | see Attachment | agent | question card, inbox row (count) | used |
| `urgency`, `urgency_reason` | `low` / `normal` / `high` / `critical`; a phrase | agent (`create_*`, `revise_card`, `set_urgency`) | inbox row, question card | used |
| `multiple` | boolean | agent | inbox row, question card | used |
| `recommended` | key, list of keys, or null | agent | inbox row, question card | used |
| `version` | integer from 1 | hub, +1 with every rewording | question card (time machine) | used |
| `versions[]` | see Version; at most 20 | hub | question card (time machine) | used |
| `revised` | timestamp of the live wording | hub | `store.js` sends it back with an answer; row note "revised" | used |
| `revisions` | integer, `version - 1` | hub | nobody | not shown |
| `revision_note` | string | agent (`revise_card.note`) | nobody directly: the same words are in the `revised` marker | not shown |
| `choice`, `choices` | key or null; list of keys | human (`/decide`), or the agent's advice on Trust | inbox (answered pile), conversation, history | used |
| `note` | string | human | history ("Your note") | used |
| `option_notes` | `{key: text}` | human (`/decide notes`) | nobody in the web client (the iOS model reads it) | not shown |
| `note_attachments[]` | see Attachment | human (`/decide attachments`) | nobody in the web client | not shown |
| `trusted` | boolean | human (`/decide trust`) | inbox: "Trusted: <advice>" | used |
| `answered_version` | integer or null | hub | nobody | not shown |
| `draft` | see Draft | human (`/draft`), hub on `/reopen` | question card | used |
| `with_agent` | timestamp | hub, on hand-back or "What??" | `store.js`: the pile "With the agent" | used |
| `summary` | string | agent (`close_card`, `withdraw_card`), hub on merge and session end | history only | used |
| `created`, `decided` | timestamps | hub | age on the row, order, history | used |
| `read` | timestamp or null (info only) | hub, on `/close` | inbox ("Read") | used |
| `merged_from` | `[{id, number, title}]` | hub | row note "replaces N questions" (only the length) | used |
| `merged_into` | card id | hub | nobody | not shown |
| `request_id` | string (approval only) | Claude Code | nobody; the hub echoes it in the verdict | not shown |

### Message

`state.messages[]`, built by `addMessage` and `addEvent`

| Field | Shape | Set by | Read by | Status |
| --- | --- | --- | --- | --- |
| `id`, `agent`, `ts` | 8 hex; session id; timestamp | hub | conversation | used |
| `from` | `user` / `agent` / `event` | hub | conversation | used |
| `text` | markdown | agent, human, or the hub for a marker | conversation | used |
| `html`, `details` | strings | agent | conversation, question card thread | used |
| `attachments[]` | see Attachment | agent (paths) or human (uploads, scribble, pad selection) | conversation, question card thread | used |
| `card_id` | card id | agent (`reply.card_id`), human (`/message card_id`), hub (markers) | question card thread; markers open their card | used |
| `kind` | `asked` / `info` / `revised` / `urgency` / `decided` / `done` / `read` / `reopened` / `shredded` (markers only) | hub | conversation; `info`, `read` and `shredded` have no label of their own and show as "Board" | used |
| `version`, `again` | integer; true after a hand-back (on a `revised` marker) | hub | question card thread: "version 3 presented" | used |
| `trusted` | true (on a `decided` marker) | hub | nobody: the text says "Trusted: your call" | not shown |
| `handback`, `explain` | true | human (`/message`) | nobody: only `card.with_agent` is read | not shown |
| `asset` | `{id, type, title, note, url, size}`, later `{id, type, title, gone}` | hub, from `publish_asset` | conversation (asset card), question card (links), history | used |

### Session (agent)

`state.agents[]`, built by `register`; the list order is the sidebar order

| Field | Shape | Set by | Read by | Status |
| --- | --- | --- | --- | --- |
| `id` | slug of the name, `-2`, `-3` for more of the same | hub | everywhere | used |
| `name` | string: `BOARD_AGENT` or the folder name | the channel process (`/agent/link`) | sidebar, rows (as the fallback under `label`) | used |
| `cwd`, `host`, `platform` | strings | the channel process | sessions table: Folder, Machine | used |
| `instance` | random hex per process | the channel process | nobody; it is pushed to every page all the same | not shown |
| `client` | "claude-code 2.1.0" | Claude Code (`initialize`), relayed by `/agent/profile` | sessions table: Program | used |
| `model`, `task` | strings | agent (`introduce`) | sessions list and table, session header | used |
| `icon` | `draw:<name>` | agent (`introduce`) or human (`/session`) | the session's mark | used |
| `icon_by` | `agent` / `human` | hub | nobody | not shown |
| `label` | string, 60 characters | human (`/session`) | the session's shown name | used |
| `group` | string or null | human (`/session`) | sessions shown as one | used |
| `starred` | boolean | human (`/star`) | inbox order, star | used |
| `archived` | boolean | human (`/session`); cleared when the session links again | sidebar; its open cards leave the queue | used |
| `position` | index in the list | hub | `store.js` (order) | used |
| `online` | boolean | hub | everywhere | used |
| `joined`, `connected`, `seen` | timestamps | hub | sessions table | used |

### Status line

`state.tasks[]`, written by `set_status`

| Field | Shape | Set by | Read by | Status |
| --- | --- | --- | --- | --- |
| `agent`, `id` | session id; the agent's name for the line | agent | key of the pill | used |
| `label`, `detail` | strings | agent | the pill: "label: detail" | used |
| `state` | `decision` / `working` / `done` | agent; hub sets `working` when the card is answered | colour of the pill; "running" on the session | used |
| `card_id` | card id or null | agent | nobody | not shown |
| `updated` | timestamp | hub | nobody | not shown |

### Attachment

on messages, cards, versions; built by `storeAttachment` (agent) and `storeUploads` (human)

| Field | Shape | Set by | Read by | Status |
| --- | --- | --- | --- | --- |
| `name` | file name | hub, from the path or the upload | caption, download name | used |
| `url` | `/files/<id>.<ext>` | hub | everywhere a file shows | used |
| `kind`, `image` | `image` / `video` / `audio` / `file`; boolean | hub, from the extension | how it is drawn | used |
| `size` | bytes | hub | shown with files | used |
| `title` | string, 200 characters | agent (`{path, title}`) | nobody | not shown |
| `page` | `{url, kind: "file" \| "link"}` | agent (`{path, page}`), or the hub when `foo.html` lies beside `foo.png` | nobody | not shown |
| `kind: scribble`, `id` | variant for a sent drawing: `{kind: "scribble", id, name, url: "/scribbles/<id>.png", image}` | hub | conversation: opens the canvas | used |
| `pad` | variant for a pad selection: `{kind: "image", name: "From the pad", url, image, size, pad}` | hub | conversation | used |

### Version

`card.versions[]`, pushed by `revise_card` when the wording changed

| Field | Shape | Set by | Read by | Status |
| --- | --- | --- | --- | --- |
| `n`, `at` | version number; when it was presented | hub | question card: "Version 2 of 4 · as it was …" | used |
| `title`, `body`, `html`, `options`, `sections`, `recommended`, `multiple`, `attachments`, `urgency` | as on the card at that time | hub | question card, read-only | used |
| `note` | the agent's note that version came with | agent | question card: version bar | used |

### Draft

`card.draft`, only on an open question; the agent never sees it

| Field | Shape | Set by | Read by | Status |
| --- | --- | --- | --- | --- |
| `keys` | list of option keys | human (`/draft`) | question card: the ticks | used |
| `note` | string, kept as typed | human | question card: the composer | used |
| `notes` | `{key: text}` | human | question card: the line on each option | used |
| `ts` | timestamp | hub | question card: adopt a newer draft from another device | used |

### Asset

`state.assets[]`, built by `storeAsset`; the ciphertext is `data/assets/<id>`

| Field | Shape | Set by | Read by | Status |
| --- | --- | --- | --- | --- |
| `id` | 22 base64url characters | the channel process | `ui.js`: finds the record for a link | used |
| `type`, `title` | null and empty for a silent asset | agent | label and title of a link | used |
| `agent`, `size`, `created` | session id; bytes of ciphertext; timestamp | hub | nobody in the app (`list_assets` returns them) | not shown |
| `keep`, `silent` | booleans | agent | nobody; the hub's cleanup reads `keep` | not shown |
| `wrapped_key` | always null | hub | nobody: a place kept for the room key | planned |

### Pad element

`data/pad.db` through `server/pad.mjs`; not part of the state

| Field | Shape | Set by | Read by | Status |
| --- | --- | --- | --- | --- |
| `id`, `pad` | ids; the pad is `global` today | the pad page | the pad page (`client/web/pad/`; not checked field by field) | used |
| `type` | `stroke` / `image` / `text` / `voice` | the pad page | the pad page | used |
| `x`, `y`, `w`, `h`, `rotation`, `z`, `group` | numbers; group id or null | the pad page | the pad page | used |
| `data`, `blob` | the element's own content; id of its bytes (`/pad/blobs/<id>`) | the pad page | the pad page | used |
| `rev`, `seq`, `created`, `updated` | the page's revision; the hub's running number and clock | page (`rev`, `created`), hub (`seq`, `updated`) | sync | used |
| `author` | `human` today | the pad page | a session id once agents place elements | planned |
| `sent[]` | `{session, at, message_id, rev}`, at most 50 | hub, on `/pad/send` | the pad page: where a selection went | used |
| `deleted` | true on a tombstone | the pad page | sync | used |

### State

the object every page gets on `GET /events`, whole, on every change

| Field | Shape | Set by | Read by | Status |
| --- | --- | --- | --- | --- |
| `agents`, `messages`, `cards`, `tasks`, `assets` | the lists above | hub | `store.js` | used |
| `queue` | ids of open cards in the order the human sees them | hub | inbox, question card | used |
| `speech` | boolean: a speech key is set | hub | microphone and read-aloud are offered | used |
| `hub` | id of the session that is the hub | hub | nobody in the app | not shown |
| `next_number` | integer | hub | nobody | not shown |
| `pending` | events waiting for sessions that are away | hub | never sent to a page | used |

## 5. Human to board: the browser's routes

Every request needs the login cookie (`board_<port>`, set once by `GET /?t=<token>`); every request that is not a GET must come from the page's own origin. Errors are `{error}` with 400, 409 (stale answer, already decided) or 404.

| Route | Body or query | What it does | Status |
| --- | --- | --- | --- |
| `GET /events` |  | Event stream: the whole state as one JSON frame, on connect and on every change. | used |
| `POST /message` | `{text, agent, card_id?, handback?, explain?, attachments?: [{name, data}]}` | Chat to one session; with `card_id` a question back about an open card; `handback` / `explain` put the card with the agent. Files as base64 data URLs, at most 12 and 96 MB. | used |
| `POST /decide` | `{card_id, key \| keys, note?, notes?: {key: text}, revised?, attachments?}` | Answers a question or an approval. 409 when the card was reworded meanwhile. | used |
| `POST /decide` | `{card_id, trust: true, note?, revised?}` | Leaves an open question to the agent. The inbox row has the button; the question window has none yet. | used |
| `POST /draft` | `{card_id, keys?, note?, notes?}` | Keeps what is ticked and written but not sent; the whole draft every time, an empty one clears it. | used |
| `POST /close` | `{card_id}` | Closes an info: read. | used |
| `POST /shred` | `{card_id, note?}` | Throws an open question or info away unanswered; the agent is told not to ask again. In the code and in the question window since today. | used |
| `POST /reopen` | `{card_id}` | Takes an answer, a trust, a "read" or a shredding back. | used |
| `POST /session` | `{agent, label?, icon?, archived?, group?, before?}` | The human's name, symbol, group and place for a session; archiving one that is away. | used |
| `POST /star` | `{agent, starred}` | Marks a session whose questions lead the inbox. | used |
| `GET /canvas?agent=` |  | The lasting drawing of one session, as JSON. | used |
| `POST /canvas` | `{agent, doc}` | Saves it while the human draws. | used |
| `POST /scribble` | `{agent, doc, png, view?, text?}` | Sends the drawing to the session. The web client never sends `text` (the caption). | used |
| `GET /scribbles/<id>.png\|json` |  | A sent drawing. | used |
| `POST /speech/live` |  | Starts a dictation; the answer is an event stream (`ready`, `delta`, `final`, `error`). | used |
| `POST /speech/live/<id>` | PCM16 mono 16 kHz, raw | Audio in small pieces. | used |
| `POST /speech/live/<id>/stop` |  | Ends the dictation; the whole recording is transcribed once more. | used |
| `POST /speech/transcribe` | audio, raw | One recording to text (voice notes on the pad). | used |
| `POST /speech/say` | `{text, lang?}` | Text to audio, for read-aloud. | used |
| `GET /speech/card/<id>` |  | A whole card as audio. `store.js` exports the address; nothing calls it. | not shown |
| `GET /files/<name>` |  | An attachment, with Range requests; an HTML file is served sandboxed. | used |
| `GET /a/<id>, /a/<id>/blob, /a/-/…` |  | The asset viewer and the ciphertext. No login: the link is the permission. | used |
| `GET /pad/elements?pad=&since=` |  | All elements of the pad, or what changed after a running number. | used |
| `POST /pad/elements` | `{pad, client_id, elements: [...]}` | Create and change; per element the higher `rev` wins. | used |
| `DELETE /pad/elements/<id>` | `?rev=&client_id=` | A tombstone. | used |
| `PUT, GET /pad/blobs/<id>` | bytes | Pictures and voice notes of the pad, up to 30 MB. | used |
| `GET /pad/events?pad=&since=` |  | The pad's own stream: only what changed. | used |
| `POST /pad/send` | `{session, pad?, elements: [{id}], png, text?, client_id?}` | Sends a selection to a session: a message with the picture, and the event `pad`. | used |
| `GET /api/tools` |  | `{version, retention_days, max_asset_mb, tools (with example), drawings, events}` for the help page. The page reads `tools` and `events`; nothing reads `drawings`. | used |
| `POST /admin/api/login, logout` | `{key}` | The admin key for an admin session cookie. | used |
| `GET /admin/api/overview, cleanup, log, diagnose, export` |  | What the admin page shows; `export` is the state as a file, secrets removed. | used |
| `POST /admin/api/links` |  | The login links. | used |
| `POST /admin/api/sessions/forget` | `{id, data?, confirm: id}` | Removes a session that is away, with or without its data. | used |
| `POST /admin/api/sessions/clear-queue` | `{id, confirm: id}` | Drops what waits for a session. | used |
| `POST /admin/api/purge, orphans, token/rotate` | `{confirm: "purge" \| "orphans" \| "rotate"}` | Cleanup now; delete unreferenced files; replace the login token. | used |

### The agents' door

Loopback only, not through a proxy, header `x-board-token`. Used by channel processes and by `dev/session.mjs`.

| Route | Body or query | What it does |
| --- | --- | --- |
| `GET /agent/link` | `?name&cwd&host&platform&id&instance` | Registers the session and stays open: first `{hello: id, ping, dedicated}`, then one `{method, params}` per event. |
| `POST /agent/tool` | `{id, instance, name, args}` | Runs a tool on the hub; answers `{text}`. |
| `POST /agent/asset` | query `id`, `instance`; header `x-asset` = base64url of `{id, keep, silent, type?, title?, note?, key?}`; body = ciphertext | Stores a published asset. |
| `POST /agent/profile` | `{id, instance, fields: {client}}` | What Claude Code said about itself. |
| `POST /agent/permission` | `{id, instance, params: {request_id, tool_name, description, input_preview}}` | An approval request becomes a card. |

## 6. What we want next

| What | Why | What it needs | From | State |
| --- | --- | --- | --- | --- |
| Trust in the question window | The hub takes `/decide {trust}` and the inbox row has the button; the window where a question is read has none, and a trusted card with no advice does not say that it waits for the agent's choice. | A button and a key in `focus.js`; a state "the agent is choosing" for `trusted` with empty `choices`; an event or field when the agent has said what it chose (today only a `reply` with `card_id`). | being built today; contract section 9 | half built |
| Sub-sessions: `open_session` | A subagent should be a session of its own on the board, opened by its parent, instead of posting under a placeholder name through `dev/session.mjs`. | A tool `open_session {name, task, icon}` that returns a credential for the helper; `agent.parent`; a first-connect proposal of the team (`group`); events routed to the helper. Blocked: the change was refused by the permission check and waits for Christopher's explicit approval. | `TODO.md`; card Nr. 119 | blocked |
| Pad tools: `pad_get`, `pad_list`, `pad_put` | An agent can only receive a selection as a picture and words. It cannot look again, read what lies near it, or put an answer on the pad. | `pad_get(ids)`, `pad_list({pad, box})`, `pad_put({pad, type, text \| path, near \| x, y, reply_to})` in `TOOLS`; `author` = the session id; a rule that an agent changes only its own elements. | `docs/pad.md` section 3 | designed |
| Bytes instead of paths for files | Attachments travel as absolute paths in both directions (`attachments`, `files`, `image_path`, `canvas_path`, voiceover), so agent and hub must share a disk. That ties every session to the hub's machine. | Upload from the channel process (as `/agent/asset` already does for assets) and a download route for the agent, or files inside the envelope; the channel process writes them to a local file for Claude Code. | `docs/architecture.md` section 3; `docs/operations.md` | wanted |
| Delivery acknowledgements | An event counts as delivered once it is written to the link. A session that dies in that moment loses it, and nothing tells the human whether the agent got the answer. | An id per event, an ack from the channel process, a `deliveries` table (exists in `server/store/`, unused), and a mark on the card ("received"). | `docs/architecture.md` section 2; `docs/storage.md` | designed |
| Message log with running numbers | Every change pushes the whole state to every page. A client cannot fetch what it missed, and nothing guards against a message arriving twice. | A sequence number and a client id on every message; `GET /events?since=`; the store in `server/store/` behind the hub. | `TODO.md`; decided as the next server work (card Nr. 80) | designed |
| Stable agent ids | The id is the slug of the folder name plus a per-process `instance`. Claude's own session id changes on resume, `/compact` and fork. | An id bound to a key file (pairing section 6); `agent.claude_session` as a changing extra, read from a `SessionStart` hook. | `TODO.md`; card Nr. 80 (ticked); `docs/pairing.md` section 6 | decided |
| Pairing and one credential per member | One token is the browser login and every agent's credential. A phone or an agent cannot be shut out alone. | Invite links, a member list, a key per device and agent (`crypto/hub.mjs` exists, without HTTP routes). | `docs/pairing.md`; card Nr. 80 (ticked) | decided |
| Encryption envelopes | The hub reads everything. Planned: content as AES-256-GCM ciphertext under one room key, each message signed by the sending device; the channel process checks the signature before Claude Code sees anything. | The envelope (header in clear text: room, epoch, sender, number, card id, status, urgency, answer time); `asset.wrapped_key` filled; a decision bound to the hash of the card version it answers. | `docs/krypto-konzept.md` sections 5 and 6 | designed |
| Live state of a session | The board knows only what the agent says with `set_status`. "Working / waiting / blocked" should be true without the agent's help. | `agent.live` read from herdr (`HERDR_SOCKET_PATH`, `HERDR_PANE_ID`); hooks alone are not reliable. | `TODO.md`; `docs/gelernt.md` | wanted |
| Live trace: what the agent is doing | A channel carries only what the agent sends on purpose: no thinking, no tool calls, no terminal output. | A second road beside the channel: hooks or the Agent SDK, and a message kind for it. | `TODO.md`; `README.md` | wanted |
| The page of a picture, and its caption | Agents already send `{path, page, title}` and the hub stores and serves the page. No client shows "Open page" or the caption. | Client only: read `attachment.page` and `attachment.title` (contract section 8). | contract section 8 | hub built |
| Notes on options and files of an answer, after sending | The human's notes on single options and the files attached to an answer are stored (`option_notes`, `note_attachments`) and reach the agent, but the web client never shows them again. | Client only: show them on answered cards and in the history. | contract section 2 | hub built |
| A status line that leads to its card | `set_status.card_id` is stored and used by the hub; the README promises that the red line jumps to the card. | Client only: read `task.card_id`. | `README.md` | hub built |
| One list of drawings | The agent picks its symbol from `drawings.json` (52 names), which is written from the list in `ui.js`. Nothing shows who chose a symbol. | The page reads `drawings` from `/api/tools` instead of its own copy; show `icon_by`. | contract section 7 | hub built |
| "Later" on the hub | A card put off for later lives in the browser's `localStorage`; another device still shows it in front. | `card.later` (or a per-human list) on the hub, set by a route. | found while reading `store.js` | wanted |
| Agents joined by a link | A session joins by an entry in `.mcp.json` and the flag `--dangerously-load-development-channels`. | An invite link pasted into the prompt (pairing section 8.3); a plugin once channels need no developer flag. | `TODO.md` | wanted |
| Push for urgent cards | An urgent card waits until the human opens the board. | A device registration and a push when a `high` or `critical` card enters the queue. | `TODO.md` | wanted |
| The hub checks what the schema promises | The tool schemas are advice to the model; the hub accepts a `reply` without text and a question without a title, and helper sessions (`dev/session.mjs`) never see a schema. | Validate `required` and types in `runTool`. | found while reading `runTool` | wanted |

## 7. Mismatches found

### Sent or stored, read by no web client

| What | Where |
| --- | --- |
| `attachment.page` and `attachment.title`: stored on every attachment an agent sends that way, and the page is served under `/files/`; no client shows either. | `storeAttachment`; `client/web/js/*` |
| `card.option_notes` and `card.note_attachments`: kept on the answered card, never shown again in the web client (iOS reads both). | `decide()`; `history.js`, `inbox.js` |
| `task.card_id` and `task.updated`. | `set_status`; `agents.js`, `table.js` |
| `card.answered_version`, `card.revisions`, `card.revision_note`, `card.merged_into`, `card.request_id`; `message.trusted`, `message.handback`, `message.explain`; `agent.icon_by`, `agent.instance`; `state.hub`, `state.next_number`; `asset.agent`, `size`, `created`, `keep`, `silent`, `wrapped_key`. | pushed to every page with each state |
| `drawings` in `GET /api/tools`: the help page reads `tools` and `events` only; the symbol picker uses the list in `ui.js`. | `help.js`, `ui.js` |
| `GET /speech/card/<id>`: `store.js` exports `cardAudioUrl`, nothing calls it. Read-aloud uses `POST /speech/say`. | `store.js`, `speech.js` |
| The markers `info`, `read` and `shredded` in the conversation have no label and no icon of their own: they show as "Board" with the question icon. | `chat.js` (`EVENT_LABEL`, `ICONS`) |

### Expected by one side, not sent by the other

| What | Where |
| --- | --- |
| `POST /scribble` takes `text` (a caption, which becomes the content of the event); the web client sends `{doc, png, view, agent}` only, so the agent always gets the stock sentence. | `storeScribble`; `store.js` `sendScribble` |
| "Later" is state the client needs and the hub does not have: it lives in `localStorage` per browser. | `store.js` (`LATER_KEY`) |
| The picture on the help page names four event kinds (`chat`, `decision`, `decision_reopened`, `scribble`); the hub sends six (`info_read` and `pad` are missing). The list under the picture is read from the hub and is complete. | `help.js` |

### Documented, but different

| What | Where |
| --- | --- |
| The schemas' `required` is not checked by the hub: `reply` without `text` stores an empty message, `create_decision` without `title` an untitled card. The other way round, `set_status` needs `label` for a new line and `publish_asset` needs `path` or `content`, and neither schema says so. | `TOOLS`; `runTool` |
| `close_card` is described as "move a decided card to Done", but the hub does not look at the status: called on an open question or info it closes it, and no answer will come. | `runTool`, case `close_card` |
| `revise_card`, `set_urgency` and `withdraw_card` say "decision card" in their descriptions; all three work on info cards too. | `TOOLS`; `runTool` |
| `set_status` says the strip is "at the top of the board"; the web client draws the lines as pills in the sessions list and table. | `TOOLS`; `agents.js`, `table.js` |
| `README.md`, "Was der Agent bekommt": no `info_read`, no `pad`, none of `handback`, `explain`, `trust`, `option_notes`, `files`, `image_path`; the scribble row lacks `canvas_path` and `canvas_doc`. `reply` is listed without `html`. And: "with `card_id` the red line jumps to the card", which no client does. | `README.md` |
| `TODO.md` lists "file upload by the human" as open; it is built (`/message` and `/decide` take `attachments`). It also says events for absent agents live only in memory; they are in `state.pending` in `state.json`. | `TODO.md` |
| `docs/question-contract.md` has two sections numbered 6 (rich content, info cards); the shape of a version's attachments in section 5 lacks `title` and `page`, which section 8 adds. | `docs/question-contract.md` |
| `docs/architecture.md` (written this morning) does not know `create_info`, `/close`, trust, or `html` on `reply`. | `docs/architecture.md` |
| The running hub is older than the code: on 2 October it offered `create_info` and trust, but not yet `/shred` and the `shredded` event. Whatever this document says is true of the code; a hub shows it after a restart. | `GET /api/tools` on the live hub |
| The MCP server calls itself `board`, version `0.1.0`; the package is Trommi 1.0.0. The name is what the agent sees as `source="board"`. | `new Server(...)` |
