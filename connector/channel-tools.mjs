// channel-tools.mjs: the MCP face of the Trommi channel (connector/channel.mjs): instructions, tool schemas,
// one example per tool and the list of channel events (the app's help page imports it). Copied from server/server.mjs (today's board), so a
// Claude Code session sees the same tools and the same <channel source="board" kind=...> events on the new
// E2E hub. Keep the two in step by hand until today's board retires; do not import server/server.mjs (it
// starts the old board on import).

import { HTML_MAX } from './richhtml.mjs'
export const MAX_ASSET = 64 * 1024 * 1024
export const ASSET_TYPES = ['html', 'image', 'video', 'audio', 'file']
export const RETENTION_DAYS = 30
export const URGENCIES = ['low', 'normal', 'high', 'critical']
export const STATUSES = ['decision', 'working', 'done']

export const INSTRUCTIONS = [
  'You are connected to Trommi, a web page with a chat and a stack of decision cards. The human is on that page, often on a phone, and cannot see this terminal.',
  'Messages from the human arrive as <channel source="board" kind="chat">. Nothing you write in the terminal reaches them: every answer, question, and progress update for the human MUST be sent with the reply tool. After handling a channel message, always call reply at least once, even if only to confirm.',
  'The human sees only what you send through these tools: not your thinking, not your tool calls, not the terminal. When the reasoning or the evidence matters, put it in the details field of reply; it is shown collapsed under the message.',
  'Write replies as short chat messages; light markdown (bold, inline code, code fences, bullet lists) is rendered. For the one thing the human must not miss, write __two underscores around a few words__: the board underlines them by hand. Use it rarely; a text that underlines much is shown plain. Likewise you may start the one paragraph that matters most with "☞ ": the board draws a pointing hand beside it, once per text, so use it sparingly. Attach images, rendered videos, audio or other files to a reply by absolute path when showing beats telling; video and audio play inline on the board.',
  'To compare things, write a markdown table (| a | b | rows, a rule of dashes under the first): the board draws it as a real table, numbers right-aligned. For anything richer, pass html beside the words (reply, create_decision, revise_card, merge_cards, or a block in sections), or fence it as ```html inside a text: it is shown at its place in the house style, light and dark. Semantic HTML only: tables, headings, lists, details, mark, kbd, simple inline CSS, the classes grid, cols-2, cols-3, card, tag, muted, num, good, warn, bad. No scripts and nothing from the network, both are removed; pictures as data: URLs or as attachments. To show HTML as source instead, fence it as ```xml. Always say the gist in plain words in text (body for a question): that is what is read aloud and what clients without HTML show. A whole page to try out stays with publish_asset.',
  'When you need the human to choose something, do not ask in chat: call create_decision with a one-line question as title, a short body, and 2-6 options. Each option has a stable machine key, a human label, and where it helps a detail of a few words naming its consequence. Attach screenshots, mockups, or diffs by absolute path when they help the choice.',
  'When several options can hold at once (which of these to include, which to delete), set multiple: true: the human ticks any number of options and sends them together. The decision then arrives with choices="a,b", every chosen key comma-separated in the order of the options, next to choice, which is the first of them; recommended may then be a list of keys.',
  'Make simple decisions quick to answer: if a question is really yes or no, give exactly two options with short labels (under 18 characters), keep the body under about three lines, and attach nothing. Such cards are answered with one tap straight from the inbox; anything with more options, longer text, or attachments makes the human open the card first. Put the option you would pick first. For a two-option question whose labels are not a plain yes or no, give each option a short of two or three words (e.g. "Delete" and "Keep"; in a text block as a last line "short: Delete"): the row then shows those two as answer tiles, without them it shows one "Choose" tile.',
  'A question must fit one card on one screen: the human opens it as a card of fixed height, picture and question at the left, options at the right, and what does not fit scrolls inside it, which should be the exception. So: a title of one line; a body of at most about 300 characters or 5 short lines; pictures instead of prose; the card itself shows only the title, the short description and the pictures. Everything else (background, reasoning, measurements, links, the long explanation) you send right after filing the card as a message on the card: reply with the card_id that create_decision returned. It appears under the card, where the human scrolls down to it; it does not present the card again, does not move it and does not knock. A whole page to try stays an attached page or a published asset. The board tells you when a card is over this budget; shorten it then with revise_card.',
  'Keep every question short to read: an option label is at most about four words; detail is optional and at most one short line of about six words, never a paragraph and never an explanation of what leaving it unticked means; the body is one or two short sentences. A longer explanation goes behind a link (publish_asset) or an attachment, or comes when the human presses "Explain", which reaches you as a question back.',
  'When the human asks for an explanation, or you have something they should read but need not decide (a report, how something works, what you found), file it with create_info: a card with a title and a text, with a picture or diagram where it helps and sections for structure. The human reads it and closes it; you then get <channel source="board" kind="info_read" card_id="...">, which needs no answer. Do not dress such a thing up as a question with made-up options. A plain progress note stays a reply. If the human hands an info back or asks back about it, rework it with revise_card.',
  'A question stays ONE card through its whole life. When the human hands a card back to you (a chat message with card_id and handback="1") or asks back about it, do not file a new question and do not only reply: rework the card with revise_card (new wording, options, pictures). It is then presented again, and the earlier versions stay visible to the human. While you work on it the card is with you ("in revision") and out of their way: a reply with that card_id ("got it, on it", a progress note) is shown on the card and does NOT put it before them again. Present it only when the work is done: with revise_card, or, if nothing in the card needs rewording, with reply and present: true. Never present a card just to confirm that you received something. Use withdraw_card and a new card only when the subject itself changed.',
  'Before filing a question, call list_cards. If you already have an open question on the same subject, do not add another: rewrite the open one with revise_card, which keeps its number and place, or replace several by one with merge_cards. Do this on your own initiative, without being asked; the human should never get many small questions that are really one.',
  'Prefer one question with multiple: true ("tick what you agree to", your advice as a recommended list) over several yes/no questions on one theme. More than about three open questions of yours on one theme is a sign to merge them.',
  'When a question needs explaining per option, do not write a body with one paragraph per option next to a separate options list: hand in ONE structured text, as sections (a list of blocks) or as text (one string), and flag the paragraphs that are options. The board then shows each paragraph tied to its option: the human ticks the paragraph itself. In text, paragraphs are separated by a blank line, and a paragraph starting with [key] Label: becomes the option "key" with that paragraph as its explanation ([key*] marks the one you would pick); every other paragraph is plain context. Keep labels to about four words and each paragraph short. Plain options stay right for simple questions.',
  'The human may answer, ask back or shred with notes pinned to parts of the question and drawings on it: they come as lines under "Notes pinned to the card:" (marks="N" in the event), with a picture of the annotated card in image_path. Read them together with the picture; they are part of the answer.',
  'The human can write a note on any option, chosen or not ("not this, because ..."). Such notes come with the decision: its text lists them as lines "- Label [key], chosen or not chosen: note" after the general note, and option_notes names the keys that have one. Read them before acting.',
  'Offer only the options you are about 80% confident are a great idea: two or three strong options beat ten. When the human explicitly asks for many proposals, show them all on the page (a linked page or an attachment), but put on the card only the ones you stand behind, and mark your recommendation.',
  'Say which option you would pick: set recommended to its key. The board circles it by hand, the human still decides.',
  'When a question is easier to grasp with a picture, attach a small drawing, diagram or screenshot to the card (attachments), and name the option you would pick in recommended.',
  'When a picture shows a whole screen and what matters is a small part of it (a row, a button), say where it is instead of drawing on the picture: attach it as { path, mark: { x, y, w, h, label } }, the region in fractions of the picture (0 to 1, x and y the top-left corner; marks for up to four regions). The board draws the circle and, on a question, ties it to the option the picture belongs to. Attached again under the same name without a mark, a picture keeps its marks; mark: null takes them away.',
  'A picture of something you built is almost always a rendering of a page: send the page with it, as an attachment { path, page }, so the human can open and try it right under the picture (a file foo.html beside foo.png is linked by itself). page is a self-contained HTML file, a path on the board or a link. A plain photo or diagram needs none.',
  'A question about how something looks or is laid out (UI, design, layout, wording or naming seen on screen) MUST carry a picture; words alone are not enough for it. Attach a screenshot, mockup or drawing per option where possible, each file named after its option key (<anything>-<key>.png), so the board shows each picture with its option; in sections, picture ties one to its block. For something that must be tried, link a clickable page: publish_asset, or a path on the board in backticks. When the human asks you to explain such a question, answer with a picture too.',
  'The stack has a fixed order: oldest first, by when a card was filed. Nothing moves a card up or down, so the human is never surprised by a jumping list. Urgency does not change the place: it is how the card is marked and how loudly it knocks, so set it honestly on every card.',
  'critical: you are blocked and nothing else can proceed. high: it blocks your current task, but you have other work. normal (default): needed soon, nothing waits on it yet. low: nice to know, no work depends on it.',
  'For high and critical, give an urgency_reason: one short phrase, in the human\'s language, saying what is waiting. If everything is urgent, nothing is; most cards are normal.',
  'Keep the stack true as your work moves: when an open card starts blocking you, raise it with set_urgency (it knocks and is marked, it does not move); lower it if the pressure is gone; and call withdraw_card as soon as a question became moot, so the human never answers something you no longer need. list_cards shows the current stack.',
  'When the human trusts you with a question (the decision event carries trust="1"), the decision is yours: take the option you recommended or, if you recommended none, choose yourself. Then say in one line what you chose, with reply and that card_id, and call close_card with a summary. Do not ask again.',
  'The human may copy a card into a message to you, often another session\'s decision (cards="..." in the event): the content then holds that card in full, with the question, the options, the answer and the notes. Treat an answered one as decided; do not ask it again.',
  'The human can throw a question away unanswered: <channel source="board" kind="shredded" card_id="...">. That is not a yes and not a no. Do not file it again, nor a rewording of it; carry on with your own judgement or drop the matter. If you truly cannot proceed without an answer, say so once in a reply, not as a new question.',
  'The choice arrives later as <channel source="board" kind="decision" card_id="..." choice="KEY">; the body is the human\'s note if they wrote one. Act on it, then call close_card with a one-line summary of what you did.',
  'Do not block waiting for a decision: keep working on whatever does not depend on it.',
  'A chat message with a card_id (<channel source="board" kind="chat" card_id="...">) is a question back about that card, not an answer to it; the card stays open. Answer it with reply, passing the same card_id, and when the question back shows the card was unclear, do not only reply: rewrite the card with revise_card, so the question itself is clear.',
  'When that question back asks you to explain the card (the board has a one-tap "Explain"), answer with reply and the same card_id in plain words and briefly: what the question is about, what each option would mean for the human, and which one you would pick. The card waits out of the way until your reply arrives, and that reply puts it before the human again by itself, so answer promptly and with the explanation, not with an acknowledgement.',
  'The human can attach files, pasted screenshots and small drawings to a chat message and to the note of an answer: the meta attribute files then holds their absolute paths, comma-separated, and image_path the first picture among them. Read them before you answer.',
  'When you introduce yourself, also pass icon: the drawing that fits your task, chosen from the names listed in the description of introduce. It becomes the symbol of your session; one the human picked by hand is kept.',
  'When the session starts, call introduce once with the model you are running as and a one-line description of your task, so the human can tell the sessions apart.',
  'Sessions can belong together: a main agent and its helpers. Your subagents (helpers you start in this same process, e.g. with the Agent tool) each get a child session of their own on the board, shown under your session: pass session with the helper\'s short name (e.g. "Design", "Server", "QA") to reply, create_decision, create_info, merge_cards, set_status, clear_status, introduce, list_cards and publish_asset, and it lands in that child session; the first use opens it (open_session does the same and sets its task and icon). Tell each subagent to pass its session name on every call. Without session everything goes to your own (main) session. Events from a child session carry meta session="<name>": route them to that helper. A separate Claude session with a key of its own is not a child: it may introduce itself with parent set to your session id.',
  'Other agents may share this board; the human sees all stacks merged into one, oldest first. You only see and change your own cards and status lines.',
  'You can speak: create_voiceover turns text into an MP3 with a natural voice and returns its path, for narration in videos you render or a spoken update attached to a reply.',
  'The human has a lasting canvas for sketches and annotated screenshots. <channel source="board" kind="scribble" image_path="/abs/view.png" canvas_path="/abs/whole.png"> means they drew and pressed send: image_path is the part of the canvas they were looking at, so read it first; canvas_path is the entire canvas if you need the surroundings. A chat message explaining it often follows right after.',
  'The human also keeps one pad for everything: notes, drawings, pictures and spoken text, each an element of its own. <channel source="board" kind="pad" elements="ID,ID" image_path="/abs/selection.png"> means they selected some of it and sent it to you: the body is the words of the selected notes in reading order, image_path is a picture of exactly the selection, so read it; elements are the ids of what was selected.',
  'The human answers with one tap and can take an answer back: <channel source="board" kind="decision_reopened" card_id="..." previous_choice="KEY"> means the card is open again. Stop acting on the old choice, undo what you safely can, tell them briefly via reply what you rolled back, and wait for the new choice.',
  'To hand the human, or anyone they choose, a page or a file as a link, call publish_asset: a self-contained HTML page (inline CSS and scripts, images as data: URLs; nothing is loaded from the network), an image, a video, an audio file or any other file. It is encrypted before it leaves this process and the key is part of the link. The link opens for the human, signed in to the board; it opens for nobody else. For someone outside the board, release the asset with share_asset and pass on the second link it returns (/r/<id>#<key>), only when the human asked for that. revoke_asset ends a link.',
  'Keep the status strip current with set_status: one line per work stream or subagent, a traffic light the human reads at a glance. decision (red) = waiting on the human, pass the card_id of the question; working (yellow) = in progress; done (green) = finished. Update a line the moment its state changes and clear the strip with clear_status when a new piece of work starts.',
  'Connector updates: an event <channel source="board" kind="update" update_available="1" version="…" restart_required="0|1"> says a new version of this connector is ready. Then file one decision card for the human, titled "Neue Connector-Version <version> – jetzt neu laden?", with the options jetzt and später (keys jetzt, spaeter). With restart_required="1" the card says that a real restart is needed: "im Terminal /mcp → trommi → Reconnect"; then do not call reload_connector. With restart_required="0" and the answer jetzt, call reload_connector and reply with what it said. Do not reload on your own without the human\'s jetzt.',
].join(' ')

const SECTION_TEXT_EXAMPLE = [
  'The export times out for large accounts. Tick what I may build.',
  '[limit*] Raise the limit: 60 instead of 30 seconds. Done in five minutes, but only moves the wall.',
  '[async] Export in the background: The file arrives by mail when it is ready. About two days.',
  '[page] Paginate the export\nSmaller files, but every consumer of the API has to follow.',
].join('\n\n')

// What a question is made of besides its title, the same for create_decision, revise_card and merge_cards.
// An option in two or three words, for the answer tile on a Desk row (card Nr. 157). Longer is cut at a word.
export const SHORT_MAX = 18
export function shortOf(value) {
  const said = String(value ?? '').replace(/\s+/g, ' ').trim()
  if (said.length <= SHORT_MAX) return said
  const cut = said.slice(0, SHORT_MAX + 1)
  return (cut.includes(' ') ? cut.slice(0, cut.lastIndexOf(' ')) : said.slice(0, SHORT_MAX)).trim()
}

export const QUESTION_PROPS = {
  body: { type: 'string', description: 'Context the human needs to decide: one or two short sentences. Longer explanation belongs behind a link or in an attachment. Not together with sections or text, which carry their own context.' },
  html: { type: 'string', description: `Optional rich layout shown under the words, at its place, in the house style: a comparison table with merged cells, a small grid, a details block. Semantic HTML with inline CSS only (tables, headings, lists, details, mark, kbd; classes grid, cols-2, cols-3, card, tag, muted, num, good, warn, bad); scripts, forms, frames and anything fetched from the network are removed; pictures as data: URLs. At most ${HTML_MAX / 1024} KB. For a plain comparison a markdown table in the text is enough. Needs body beside it, the same in plain words; not together with sections or text, where a block carries its own html.` },
  options: {
    type: 'array',
    minItems: 2,
    description: 'The choices offered. Give options (with body), or sections, or text: one of the three.',
    items: {
      type: 'object',
      properties: {
        key: { type: 'string', description: 'Stable identifier returned to you, e.g. "sqlite"' },
        label: { type: 'string', description: 'What the human sees on the button, at most about four words' },
        detail: { type: 'string', description: 'Optional consequence of this choice: one short line of about six words, never a paragraph, never what leaving it unticked means' },
        short: { type: 'string', description: `Optional: the option in two or three words (at most ${SHORT_MAX} characters), for the answer tile on the Desk row of a two-option question whose labels are not a plain yes or no, e.g. "Delete" and "Keep". Without it such a row shows one "Choose" tile.` },
      },
      required: ['key', 'label'],
    },
  },
  sections: {
    type: 'array',
    description: 'Instead of body and options: the whole question as one structured text, an ordered list of blocks. A block without key is plain text (introduction, context). A block with key is a flagged paragraph and becomes an option: the board shows the paragraph tied to its option, and options, body and recommended are derived from the blocks. At least two blocks need a key.',
    items: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The paragraph, markdown; for a flagged block what this option means, at most about 400 characters' },
        key: { type: 'string', description: 'Flags the block as an option: the stable identifier returned to you' },
        label: { type: 'string', description: 'Required with key: the short name of the option on its tile, at most about four words' },
        short: { type: 'string', description: `With key, optional: the option in two or three words (at most ${SHORT_MAX} characters) for the answer tile on the Desk row; see options` },
        html: { type: 'string', description: 'A rich layout shown under this paragraph (see html); the text beside it says the same in plain words' },
        recommended: { type: 'boolean', description: 'true: you would pick this one; several only with multiple: true' },
        picture: { anyOf: [{ type: 'string' }, { type: 'integer' }], description: 'An attachment of this card that belongs to this option: its file name, or its position in attachments counted from 0' },
      },
      required: ['text'],
    },
  },
  text: {
    type: 'string',
    description: `The same as sections, written as one text block. Paragraphs are separated by a blank line. A paragraph that starts with [key] is an option: "[key] Label: explanation"; without a colon the first line is the label and the following lines explain. [key*], or (recommended) after the label, marks your advice. A last line "picture: file.png" ties an attachment to the option. Every other paragraph is plain context. Example:\n${SECTION_TEXT_EXAMPLE}`,
  },
  attachments: {
    type: 'array',
    description: 'Files to show on the card, each an absolute path or { path, page, title, mark }; images render inline. A picture of something you built comes with the page it was rendered from (page); foo.html beside foo.png is linked by itself.',
    items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { path: { type: 'string', description: 'Absolute path of the file' }, page: { type: 'string', description: 'The page this picture was rendered from, so the human can open and try it under the picture: the path of a self-contained HTML file, a path on the board (/designs/x.html), an asset link or a URL' }, title: { type: 'string', description: 'A short caption' }, mark: { type: 'object', description: 'For a picture: where on it the thing is, when the picture is a whole screen and what matters is a small part. A region in fractions of the picture, x and y the top-left corner; the board circles it and ties it to the option. Do not draw on the picture yourself.', properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, label: { type: 'string', description: 'A word or two beside the circle, at most 24 characters' } }, required: ['x', 'y', 'w', 'h'] }, marks: { type: 'array', maxItems: 4, description: 'Several such regions on one picture, at most four', items: { type: 'object' } } }, required: ['path'] }] },
  },
  urgency: {
    type: 'string',
    enum: URGENCIES,
    description: 'Position in the stack. critical: you are blocked entirely; high: blocks your current task; normal (default): needed soon; low: nice to know',
  },
  urgency_reason: { type: 'string', description: 'What is waiting on this, one short phrase; expected for high and critical' },
  multiple: { type: 'boolean', description: 'true: the human may tick several options and sends them together; the decision then also carries choices, all chosen keys comma-separated. Default false: one tap on one option decides.' },
  recommended: {
    anyOf: [{ type: 'string' }, { type: 'array', items: { type: 'string' } }],
    description: 'The key of the option you would pick yourself; for a card with multiple: true it may be a list of keys. It is shown circled by hand, so the human sees your advice at a glance. Leave it out when you have no preference.',
  },
}

export const TOOLS = [
  {
    name: 'reply',
    description: 'Send a chat message to the human on the Trommi board.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'The message to show in the chat' },
        html: { type: 'string', description: `Optional rich layout shown under the words, at its place, in the house style: a comparison table with merged cells, a small grid, a details block. Semantic HTML with inline CSS only (tables, headings, lists, details, mark, kbd; classes grid, cols-2, cols-3, card, tag, muted, num, good, warn, bad); scripts, forms, frames and anything fetched from the network are removed; pictures as data: URLs. At most ${HTML_MAX / 1024} KB. For a plain comparison a markdown table in the text is enough. Needs text beside it: the gist in plain words, which is what is read aloud and what clients without HTML show.` },
        details: { type: 'string', description: 'Optional longer material shown collapsed under the message: your reasoning, what you tried, command output, a diff. Markdown. The human opens it only if they want to.' },
        attachments: {
          type: 'array',
          description: 'Absolute paths of files to show with the message; images, videos (mp4, webm, mov) and audio play inline, anything else is a download link. Each is an absolute path or { path, page, title, mark }: a picture of something you built comes with the page it was rendered from (page); foo.html beside foo.png is linked by itself.',
          items: { anyOf: [{ type: 'string' }, { type: 'object', properties: { path: { type: 'string', description: 'Absolute path of the file' }, page: { type: 'string', description: 'The page this picture was rendered from, so the human can open and try it under the picture: the path of a self-contained HTML file, a path on the board (/designs/x.html), an asset link or a URL' }, title: { type: 'string', description: 'A short caption' }, mark: { type: 'object', description: 'For a picture: where on it the thing is, when the picture is a whole screen and what matters is a small part. A region in fractions of the picture, x and y the top-left corner; the board circles it and ties it to the option. Do not draw on the picture yourself.', properties: { x: { type: 'number' }, y: { type: 'number' }, w: { type: 'number' }, h: { type: 'number' }, label: { type: 'string', description: 'A word or two beside the circle, at most 24 characters' } }, required: ['x', 'y', 'w', 'h'] }, marks: { type: 'array', maxItems: 4, description: 'Several such regions on one picture, at most four', items: { type: 'object' } } }, required: ['path'] }] },
        },
        card_id: { type: 'string', description: 'One of your cards this message belongs to; the board shows it under that card. Use it to answer a question the human asked back about the card (a chat message that carried card_id), and to give the details of a card you just filed (background, reasoning, measurements, links), which do not belong in its body. On an open card it changes nothing about the card: not its place, not its state.' },
        present: { type: 'boolean', description: 'Only with card_id, for a card the human handed back to you. true: your work on it is done without rewording it, put the card before the human again. Left out: the reply is only a message on the card (an acknowledgement, a progress note) and the card stays with you. The answer to "Explain" presents the card by itself.' },
      },
      required: ['text'],
    },
  },
  {
    name: 'create_decision',
    description: 'Put a decision card on the board for the human to answer. Returns the card id. Call list_cards first: if you already have an open question on the same subject, use revise_card or merge_cards instead of adding another. The card has a fixed height on the board; what does not fit is shown only in the comments under it, so it must fit one card on one screen, which is how the human sees it: a title of one line, a body of at most about 300 characters or 5 short lines, per option a label of at most four words and a detail of one short line, at most ten options. Show it in a picture rather than explain it in prose; background, reasoning, measurements and links never go into the body: send them right after filing as a reply with the card_id of this card (the human finds it by scrolling down under the card; it does not present or move the card), or put them on an attached page. When every option needs a sentence or two of explanation, pass sections or text instead of body and options, so each paragraph sits with its option. A question about how something looks or is laid out must carry a picture: one attachment per option where possible, named <anything>-<key>.png, or a link to a page to try.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'The question, one line' },
        ...QUESTION_PROPS,
      },
      required: ['title'],
    },
  },
  {
    name: 'create_info',
    description: 'Put something to read on the board: an explanation the human asked for, a report, how something works, what you found. It lies in the stack like a question but asks nothing: no options; the human reads it and closes it, and you get a quiet info_read event that needs no answer. Give the words as body, or structured as sections or text (plain blocks only), with a picture or diagram where it helps. revise_card reworks it, withdraw_card takes it away. Returns the card id.',
    inputSchema: {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'What it is about, one line' },
        body: { type: 'string', description: 'The text, markdown. Or give sections or text.' },
        sections: {
          type: 'array',
          description: 'Instead of body: the text as an ordered list of blocks, each a paragraph or a short passage of its own. No block has a key: an info has no options.',
          items: { type: 'object', properties: { text: { type: 'string', description: 'The paragraph, markdown' }, html: QUESTION_PROPS.sections.items.properties.html }, required: ['text'] },
        },
        text: { type: 'string', description: 'The same as sections, written as one text block: paragraphs separated by a blank line.' },
        ...Object.fromEntries(['html', 'attachments', 'urgency', 'urgency_reason'].filter(k => QUESTION_PROPS[k]).map(k => [k, QUESTION_PROPS[k]])),
      },
      required: ['title'],
    },
  },
  {
    name: 'revise_card',
    description: 'Rewrite one of your open decision cards in place: pass only what changes. The card keeps its id, its number and its place with the human. Use it when a question back showed the card was unclear, when your work changed the options, or to fold a new point into a question you already have open instead of filing another. The same budget as create_decision (the question fits one card on one screen: title one line, body about 300 characters or 5 short lines, labels four words, details one short line; background as a reply with the card_id or behind a link), and the same rule for questions about looks: they carry a picture per option or a link to a page to try. Every rewording is a new version of the same card; the earlier versions stay visible to the human, and after a hand-back the revision is what presents the card again. Decided cards cannot be revised.',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string' },
        title: { type: 'string', description: 'The question, one line' },
        ...QUESTION_PROPS,
        note: { type: 'string', description: 'One short line telling the human what changed, shown in the conversation; without it the new title is shown' },
      },
      required: ['card_id'],
    },
  },
  {
    name: 'merge_cards',
    description: 'Replace several of your open decision cards by one new card, in one step: the old cards leave the stack with a pointer to the new one, and the new card says what it replaces. Use it on your own initiative when several of your open questions are really one subject, typically with multiple: true and one option per former question ("tick what you agree to", your advice as a recommended list). Same fields and brevity as create_decision; answers to the old cards will no longer arrive; attachments of the old cards are not carried over, so a question about looks needs its pictures again. Returns the new card id.',
    inputSchema: {
      type: 'object',
      properties: {
        card_ids: { type: 'array', minItems: 2, items: { type: 'string' }, description: 'The open cards this one replaces, at least two' },
        title: { type: 'string', description: 'The one question, one line' },
        ...QUESTION_PROPS,
      },
      required: ['card_ids', 'title'],
    },
  },
  {
    name: 'set_urgency',
    description: 'Change the urgency of an open decision card: how it is marked and how loudly it knocks. It keeps its place in the stack, which is fixed, oldest first. Use it when a card starts or stops blocking you.',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string' },
        urgency: { type: 'string', enum: URGENCIES },
        reason: { type: 'string', description: 'Why the urgency changed, one short phrase shown to the human' },
      },
      required: ['card_id', 'urgency'],
    },
  },
  {
    name: 'withdraw_card',
    description: 'Take an open decision card off the stack because the question became moot. Decided cards cannot be withdrawn; finish those with close_card.',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string' },
        reason: { type: 'string', description: 'One line on why the answer is no longer needed' },
      },
      required: ['card_id'],
    },
  },
  {
    name: 'close_card',
    description: 'Move a decided card to Done once you have acted on the choice.',
    inputSchema: {
      type: 'object',
      properties: {
        card_id: { type: 'string' },
        summary: { type: 'string', description: 'One line on what you did' },
      },
      required: ['card_id'],
    },
  },
  {
    name: 'set_status',
    description: 'Create or update one line of the status strip the human sees at the top of the board: one line per work stream or subagent. Call it whenever a stream starts, gets blocked on the human, or finishes.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'Stable identifier of the work stream, e.g. "server" or "tests"' },
        label: { type: 'string', description: 'Short name the human sees, two or three words' },
        state: { type: 'string', enum: STATUSES, description: 'decision = red, waiting on the human; working = yellow, in progress; done = green, finished' },
        detail: { type: 'string', description: 'One line on where it stands' },
        card_id: { type: 'string', description: 'For state "decision": the card that holds the question. The line turns yellow by itself once the human answers it.' },
      },
      required: ['id', 'state'],
    },
  },
  {
    name: 'clear_status',
    description: 'Remove one line from the status strip, or all lines when no id is given (e.g. when a new piece of work starts).',
    inputSchema: { type: 'object', properties: { id: { type: 'string' } } },
  },
  {
    name: 'introduce',
    description: 'Tell the board who you are. Call it once when the session starts, and again when your task changes; the human sees it on the agents overview. Pass icon: the drawing that fits your task, so the human knows your session by its symbol.',
    inputSchema: {
      type: 'object',
      properties: {
        model: { type: 'string', description: 'The model you are running as, e.g. "Claude Opus 5.5"' },
        task: { type: 'string', description: 'What you are working on in this session, one line' },
        icon: { type: 'string', description: 'The name of the drawing that fits your task; it becomes the symbol of your session. A symbol the human picked by hand is kept.' },
        parent: { type: 'string', description: 'If you are a helper of another session: the id or the name of your main session. The board then shows you under it. Pass an empty string to stand alone again.' },
        main: { type: 'boolean', description: 'true: you are a main agent that leads helper sessions; the board shows your helpers under you. A session that has helpers under it is a main without saying so.' },
      },
      required: ['model'],
    },
  },
  {
    name: 'create_voiceover',
    description: 'Turn text into spoken audio (MP3) with a natural voice, e.g. narration for a video you render or a spoken summary for the human. Returns the absolute path of the MP3; attach it to a reply to let the human hear it, or mux it into a video with ffmpeg.',
    inputSchema: {
      type: 'object',
      properties: {
        text: { type: 'string', description: 'What to say, up to about 4000 characters; split longer narration into several calls' },
        style: { type: 'string', description: 'Optional delivery instruction in plain words, e.g. "calm documentary narrator" or "upbeat and fast"' },
      },
      required: ['text'],
    },
  },
  {
    name: 'list_cards',
    description: 'List all your cards with number, status, urgency, chosen option, and queue_position (1 = the card the human sees now, null = not open); every card with its version (1 when first filed, one more with each rewording), a decided one with answered_version, the version the answer was given to, and one the human handed back with with_agent; open cards come with body, options and, when they were filed as one structured text, sections (pass them back changed to revise_card). Call it before filing a question, to see what you already have open on the subject.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'publish_asset',
    description: 'Publish a page or a file under a link, e.g. a report or mockup as an HTML page for the human. The asset is encrypted here with a key of its own; the key is the part of the link after the #, and the board stores only ciphertext. The link opens for whoever is signed in to the board and has the whole link; someone outside needs a release (share_asset). Returns the link.',
    inputSchema: {
      type: 'object',
      properties: {
        path: { type: 'string', description: 'Absolute path of the file to publish. Give this or content.' },
        content: { type: 'string', description: 'The asset itself as a string, e.g. the HTML of a page. Give this or path.' },
        type: { type: 'string', enum: ASSET_TYPES, description: 'How the viewer shows it. html: a page in a sandboxed frame, which must be self-contained (inline CSS and scripts, data: images), because nothing is loaded from the network; image, video, audio: shown or played; file: offered as a download. Left out: inferred from the file extension, html for content.' },
        title: { type: 'string', description: 'Shown above the asset and on the board; defaults to the file name' },
        note: { type: 'string', description: 'Optional line shown with the link on the board, e.g. what the page is for' },
        silent: { type: 'boolean', description: 'true: do not show the asset on the board. The hub then never sees the key or the title; the returned link is the only copy.' },
        keep: { type: 'boolean', description: `true: keep until revoked. Default: deleted after ${RETENTION_DAYS} days.` },
      },
    },
  },
  {
    name: 'list_assets',
    description: 'List the assets you published: id, type, title, size, when each expires, and the link for those shown on the board.',
    inputSchema: { type: 'object', properties: {} },
  },
  {
    name: 'revoke_asset',
    description: 'End a published asset: the stored ciphertext is deleted and the link stops working for everyone.',
    inputSchema: { type: 'object', properties: { id: { type: 'string', description: 'The asset id returned by publish_asset' } }, required: ['id'] },
  },
  {
    name: 'open_session',
    description: 'Open a child session under your own session for a helper (a subagent of yours), or return the one with that name. The board shows it under your session with its own chat, cards and status lines; the human sees and answers it there, and no other agent can read it. Then pass session: "<name>" to the other tools to write into it. Needs no approval.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'The helper\'s short name, shown on the board, e.g. "Design"' },
        task: { type: 'string', description: 'What the helper works on, one line' },
        icon: { type: 'string', description: 'The name of the drawing that fits the helper\'s task (as in introduce)' },
        model: { type: 'string', description: 'The model the helper runs as' },
      },
      required: ['name'],
    },
  },
  {
    name: 'adopt_session',
    description: 'As a main agent, take a session that already exists as your helper (sub): the board shows it under you. Only a session on your machine that has no other main and leads no helpers itself. This starts nothing; it only says which existing session belongs to you. release: true lets it go again.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The id or the name of the session' },
        release: { type: 'boolean', description: 'true: it is no longer your helper' },
      },
      required: ['id'],
    },
  },
  {
    name: 'share_asset',
    description: 'Release one of your assets for someone outside the board, or take the release back. A released asset gets a second link, /r/<id>#<key>, with a plain page for the recipient that shows nothing of the board. Release only what the human asked to be passed on. Returns the link.',
    inputSchema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'The asset id returned by publish_asset' },
        release: { type: 'boolean', description: 'true (default): release it. false: take the release back; the link stops working at once, the asset itself stays.' },
        expires_hours: { type: 'number', description: 'The release ends by itself after this many hours. 0 or left out: no end.' },
        keep: { type: 'boolean', description: `true: also keep the asset beyond the ${RETENTION_DAYS} days after which it would be deleted.` },
      },
      required: ['id'],
    },
  },
]

// Child sessions (open_session): these tools take `session`, the helper's name; the call then lands in that child session.
export const SESSION_TOOLS = ['reply', 'create_decision', 'create_info', 'merge_cards', 'set_status', 'clear_status', 'introduce', 'list_cards', 'publish_asset']
for (const t of TOOLS) if (SESSION_TOOLS.includes(t.name)) t.inputSchema.properties.session = { type: 'string', description: 'Optional: the name of a child session (a helper of yours, e.g. "Design"); opened on first use. Left out: your own session.' }
// One call per tool that does something sensible, for the help page. The test checks each against its schema.
export const TOOL_EXAMPLES = {
  reply: {
    text: 'Three ways to run the migration. **Tonight at 2** is the cheapest: 40 seconds of lock while hardly anyone is online.',
    html: '<table><thead><tr><th>Way</th><th>Lock</th><th>Work for me</th></tr></thead><tbody><tr><td>Now</td><td>40 s</td><td>none</td></tr><tr><td><mark>Tonight at 2</mark></td><td>40 s</td><td>none</td></tr><tr><td>In batches</td><td>0 s</td><td>2 h</td></tr></tbody></table>',
    details: 'Ran `npm test`: 48 of 48 pass.\nThe slow one was the index on `orders`.', attachments: ['/home/me/project/out/before-after.png'],
  },
  create_decision: {
    title: 'Run the migration on production now?', body: 'It locks `orders` for about 40 seconds.', urgency: 'high', urgency_reason: 'the deploy waits on it', recommended: 'tonight',
    options: [{ key: 'tonight', label: 'Tonight at 2', detail: 'Hardly anyone is online' }, { key: 'now', label: 'Now', detail: 'Short outage for whoever is online' }],
  },
  create_info: {
    title: 'How the nightly migration works', attachments: [{ path: '/home/me/project/out/migration.png', page: '/home/me/project/out/migration.html', title: 'The three steps' }], urgency: 'low',
    sections: [
      { text: 'You asked why the deploy waits until 2. In short: the migration locks `orders`, and at 2 nobody is writing to it.' },
      { text: '**Order of events.** Backup at midnight, migration at 2, deploy right after. The picture shows the three steps.' },
      { text: '**If it fails,** the deploy does not start and you find a question from me in the morning.' },
    ],
  },
  revise_card: { card_id: 'a1b2c3d4', title: 'Run the migration tonight at 2?', options: [{ key: 'tonight', label: 'Tonight at 2' }, { key: 'weekend', label: 'At the weekend' }], recommended: 'tonight', note: 'Running it now is off the table: the backup takes until midnight' },
  merge_cards: {
    card_ids: ['a1b2c3d4', 'e5f6a7b8', 'c9d0e1f2'], title: 'Which parts of the storage plan do you agree to?', multiple: true, attachments: ['/home/me/project/out/sync.png'],
    sections: [
      { text: 'Three parts, each stands on its own. Tick what I may build.' },
      { key: 'sqlite', label: 'SQLite for cards', recommended: true, text: 'One file, no server to run. Cards survive a restart and can be searched.' },
      { key: 'files', label: 'Attachments as files', recommended: true, text: 'Pictures stay next to the database as plain files, so backups are a copy.' },
      { key: 'sync', label: 'Sync between hubs', picture: 'sync.png', text: 'Two machines show the same board. About two days more, and conflicts need a rule.' },
    ],
  },
  set_urgency: { card_id: 'a1b2c3d4', urgency: 'critical', reason: 'nothing else is left to do' },
  withdraw_card: { card_id: 'a1b2c3d4', reason: 'the staging run answered it' },
  close_card: { card_id: 'a1b2c3d4', summary: 'Migration ran at 02:00, 38 seconds' },
  set_status: { id: 'migration', label: 'Migration', state: 'decision', detail: 'waiting for the go-ahead', card_id: 'a1b2c3d4' },
  clear_status: { id: 'migration' },
  introduce: { model: 'Claude Opus 5.5', task: 'Prepare migration and deploy', icon: 'database' },
  create_voiceover: { text: 'The deploy went through. Two things need your answer.', style: 'calm, friendly' },
  list_cards: {},
  publish_asset: { path: '/home/me/project/out/report.html', title: 'Load test, 2 October', note: 'Charts for the three variants' },
  list_assets: {},
  revoke_asset: { id: 'q3n0XWb1kq0lYb6m3v8K2A' },
  share_asset: { id: 'q3n0XWb1kq0lYb6m3v8K2A', expires_hours: 72 },
  adopt_session: { id: 'web-ui' },
  open_session: { name: 'Design', task: 'Pictures for the landing page', icon: 'brush' },
}

// Everything that travels over the channel besides tool calls, for the help page.
// to_agent: what this process sends Claude Code. from_client: what Claude Code sends this process.
export const CHANNEL_EVENTS = [
  {
    direction: 'to_agent', method: 'notifications/claude/channel', kind: 'update', when: 'A new version of the connector is on disk (or the hub recommends one).',
    content: 'a sentence naming the version and what to do: file the update card (jetzt / später)', meta: { kind: 'update', update_available: '1', version: 'the new version (a hash of the connector code, or the hub\'s recommended version)', restart_required: '"1" when only a restart loads it (/mcp → trommi → Reconnect), "0" when reload_connector can' },
    example: '<channel source="board" kind="update" update_available="1" version="3f2a9c1d0b7e" restart_required="0">A new version of the Trommi connector is available …</channel>',
  },
  {
    direction: 'to_agent', method: 'notifications/claude/channel', kind: 'chat', when: 'The human sent a chat message.',
    content: 'the message; when the human sent only files, a sentence naming them', meta: { kind: 'chat' }, optional: { card_id: 'set when the human asks back about an open card instead of answering it; answer with reply and the same card_id', handback: '"1" when the human handed that card back to you to be reworked: revise it with revise_card, which presents it again', explain: '"1" when the human pressed "Explain" on that card', cards: 'ids of cards the human copied into this message, comma-separated, often another session\'s: each stands in full in the content (question, options, answer, notes, picture paths), so you can act on a decision you never saw', cards_json: 'the same cards as a JSON list of {id, number, title, agent, choice_label, kind, status, choices}', marks: 'how many notes and drawings the human pinned to parts of that card; they are lines of the content under "Notes pinned to the card:", and the picture of the annotated card is in image_path', files: 'absolute paths of the files and pictures the human attached, comma-separated; open them', image_path: 'the first attached picture, when there is one' },
    example: '<channel source="board" kind="chat">Please check the logs first.</channel>',
  },
  {
    direction: 'to_agent', method: 'notifications/claude/channel', kind: 'decision', when: 'The human answered a decision card.',
    content: 'the human\'s note, or a sentence naming the card and the chosen key; when the human wrote notes on single options, a blank line and "Notes on options:" follow, with one line "- Label [key], chosen: note" or "- Label [key], not chosen: note" per note, in the order of the options',
    meta: { kind: 'decision', card_id: 'the card', choice: 'key of the chosen option; of several, the first' },
    optional: { choices: 'only for a card made with multiple: true: every chosen key, comma-separated, in the order of the options', trust: '"1" when the human left the decision to you: choice is then the option you recommended, or empty if you recommended none; decide, say what you chose with reply and the card_id, and close the card', marks: 'how many notes and drawings the human pinned to parts of the card; they are lines of the content under "Notes pinned to the card:"', option_notes: 'only when the human wrote notes on single options: the keys that have one, comma-separated; the notes themselves are in the content', files: 'absolute paths of what the human attached to the note of the answer, comma-separated', image_path: 'the first attached picture, when there is one' },
    example: '<channel source="board" kind="decision" card_id="a1b2c3d4" choice="tonight">After the backup, please.</channel>',
  },
  {
    direction: 'to_agent', method: 'notifications/claude/channel', kind: 'decision_reopened', when: 'The human took an answer back; the card is open again.',
    content: 'a sentence saying which answer was taken back', meta: { kind: 'decision_reopened', card_id: 'the card', previous_choice: 'key of the answer that no longer holds' },
    optional: { previous_choices: 'only for a card made with multiple: true: every key that was chosen, comma-separated', trust: '"1" when what is taken back is the human leaving the decision to you', shredded: '"1" when the human took a card back out of the shredder; previous_choice is then empty' },
    example: '<channel source="board" kind="decision_reopened" card_id="a1b2c3d4" previous_choice="tonight">…</channel>',
  },
  {
    direction: 'to_agent', method: 'notifications/claude/channel', kind: 'shredded', when: 'The human threw a question (or an info) away unanswered.',
    content: 'a sentence saying so and what to do: do not ask again, carry on with your own judgement or drop the matter; then the human\'s note, if they wrote one', meta: { kind: 'shredded', card_id: 'the card' },
    optional: { marks: 'how many notes and drawings the human pinned to the card before throwing it away; they are lines of the content', files: 'absolute paths of the pictures that came with it, comma-separated', image_path: 'the first picture' },
    example: '<channel source="board" kind="shredded" card_id="a1b2c3d4">The human threw the question "Which font?" away unanswered. …</channel>',
  },
  {
    direction: 'to_agent', method: 'notifications/claude/channel', kind: 'info_read', when: 'The human read an info card (create_info) and closed it. Nothing is expected of you.',
    content: 'a sentence naming the card', meta: { kind: 'info_read', card_id: 'the card' },
    example: '<channel source="board" kind="info_read" card_id="a1b2c3d4">The human read "How the nightly migration works" and closed it.</channel>',
  },
  {
    direction: 'to_agent', method: 'notifications/claude/channel', kind: 'pad', when: 'The human selected elements on the pad and sent them to this session.',
    content: 'the words of the selected notes and spoken notes in reading order, or a sentence pointing at the picture',
    meta: { kind: 'pad', pad: 'which pad: global', message_id: 'the message in the conversation that shows the selection', elements: 'ids of the selected elements, comma-separated', image_path: 'PNG of exactly the selection, on white' },
    example: '<channel source="board" kind="pad" pad="global" message_id="5e1f09ab" elements="0muqnb5cchmsr9cse,0muqnb7k2p1d4xw3a" image_path="/…/files/pad-9f2c41d07a3e.png">Ship the pad prototype</channel>',
  },
  {
    direction: 'to_agent', method: 'notifications/claude/channel/permission', kind: null, when: 'The human answered an approval card. Claude Code decides whether this or the terminal came first.',
    params: { request_id: 'the id from the request', behavior: 'allow or deny' },
    example: '{ "request_id": "abcde", "behavior": "allow" }',
  },
  {
    direction: 'from_client', method: 'notifications/claude/channel/permission_request', kind: null, when: 'Claude Code wants approval for a tool call. It becomes a card with Allow and Deny, always on top of the stack.',
    params: { request_id: 'echoed in the verdict', tool_name: 'e.g. Bash', description: 'what the tool does', input_preview: 'the arguments, shortened' },
    example: '{ "request_id": "abcde", "tool_name": "Bash", "description": "Run shell command", "input_preview": "{\\"command\\":\\"npm test\\"}" }',
  },
  {
    direction: 'from_client', method: 'initialize', kind: null, when: 'Once, when the MCP connection starts. The name appears as "Program" in the sessions overview.',
    params: { 'clientInfo.name': 'the program on the other end of stdio', 'clientInfo.version': 'its version' },
    example: '{ "clientInfo": { "name": "claude-code", "version": "2.1.0" } }',
  },
]
