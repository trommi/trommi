// Writes the board the app shows as its demo and the tests use as their fixture:
// Trommi/Resources/demo-state.json and TrommiTests/Fixtures/demo-state.json (the same file twice).
// The shape is what server.mjs sends over /events. Times are fixed, so the files only
// change when this script does; the app moves them to "now" when it starts the demo.
//   node client/ios/tools/demo-state.mjs
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const now = 1790920558695
const min = 60000
const image = name => ({ name, url: `/files/${name}`, kind: 'image', image: true, size: 48000 })
const card = (id, agent, number, o) => ({
  id, agent, number, kind: 'decision', status: 'open', urgency: 'normal', urgency_reason: '', title: '', body: '', options: [], attachments: [],
  multiple: false, choice: null, choices: [], note: '', summary: '', decided: null, recommended: null, ...o,
})
const session = (id, name, o) => ({
  id, name, cwd: `/home/demo/${id}`, host: 'workstation', platform: 'Linux x64', model: 'Claude Opus 5.5', client: 'claude-code 2.1.0', task: '',
  online: true, archived: false, joined: now - 400 * min, connected: now - 120 * min, seen: now - 120 * min, ...o,
})

const agents = [
  session('web-frontend', 'web-frontend', { label: 'Web frontend', task: 'Finish the mobile view' }),
  session('api', 'api', { label: 'API', starred: true, task: 'Prepare migration and deploy', host: 'build-box' }),
  session('infrastructure', 'infrastructure', { label: 'Infrastructure', online: false, seen: now - 5 * min, task: 'Backups and monitoring', model: 'Claude Sonnet 5' }),
  session('docs', 'docs', { group: 'g-docs', icon: 'docs:3', task: 'Write the handbook' }),
  session('docs-review', 'docs', { group: 'g-docs', cwd: '/home/demo/docs-review', task: 'Review the handbook' }),
  session('old-spike', 'spike', { online: false, archived: true, seen: now - 3000 * min, task: 'Try the other queue' }),
]

const cards = [
  card('c-port', 'infrastructure', 1, {
    title: 'Which port should the server use?', status: 'done', created: now - 400 * min, decided: now - 395 * min,
    choice: '8790', summary: 'Port 8790 set as the default',
    options: [{ key: '8790', label: '8790', detail: '' }, { key: '3000', label: '3000', detail: '' }],
  }),
  card('c-name', 'infrastructure', 2, {
    title: 'Name of the project?', status: 'done', created: now - 300 * min, decided: now - 290 * min,
    choice: 'agent-board', summary: 'Folder and package.json renamed',
    options: [{ key: 'agent-board', label: 'Agent Board', detail: '' }, { key: 'herd', label: 'Herd', detail: '' }],
  }),
  card('c-db', 'api', 3, {
    title: 'Which database?', status: 'decided', created: now - 95 * min, decided: now - 80 * min,
    choice: 'pg', choices: ['pg'], note: 'with Docker', option_notes: { sqlite: 'fine for the tests, not for production' }, body: 'SQLite is enough for the prototype, Postgres would be closer to production.', recommended: 'pg',
    options: [{ key: 'sqlite', label: 'SQLite', detail: '' }, { key: 'pg', label: 'Postgres', detail: '' }],
  }),
  card('c-next', 'web-frontend', 4, {
    title: 'What do I build next?', created: now - 30 * min, urgency: 'low',
    options: [
      { key: 'several-agents', label: 'Several agents', detail: 'One board for several sessions' },
      { key: 'encryption', label: 'Encryption', detail: 'End to end between browser and agent' },
      { key: 'live-log', label: 'Live log', detail: 'Shows what the agent is doing right now' },
    ],
  }),
  card('c-theme', 'web-frontend', 5, {
    title: 'Which default theme?', created: now - 22 * min, recommended: 'system',
    // The agent reworded it once after asking.
    revised: now - 20 * min, revisions: 1,
    body: 'Both themes are finished. I only need the default for new users.',
    options: [
      { key: 'light', label: 'Light', detail: 'Easier to read in daylight' },
      { key: 'dark', label: 'Dark', detail: 'Fits terminal and IDE' },
      { key: 'system', label: 'Follow the system', detail: 'Goes by the setting of the device' },
    ],
    attachments: [image('thema-hell.png'), image('thema-dunkel.png')],
  }),
  card('c-phone', 'web-frontend', 6, {
    title: 'How should the board start on a phone?', created: now - 15 * min, urgency: 'high',
    urgency_reason: 'I am building the mobile view right now',
    body: 'On a phone only one view fits the screen.',
    options: [
      { key: 'conversation', label: 'With the conversation', detail: 'Like a chat app' },
      { key: 'questions', label: 'With the questions', detail: 'Open questions first' },
      { key: 'last', label: 'Where I was last', detail: 'Remembers the last view' },
    ],
    attachments: [image('phone-gespraech.png'), image('phone-entscheidungen.png')],
  }),
  card('c-migrate', 'api', 7, {
    title: 'Run the migration on the production database?', created: now - 4 * min, urgency: 'critical',
    urgency_reason: 'The deploy waits, every further step depends on it', recommended: 'tonight',
    body: 'The migration `2026_10_02_add_urgency` adds a column and backfills **48,210 rows**. Estimated time: 40 seconds, the table is locked meanwhile.\n\n```\nALTER TABLE cards ADD COLUMN urgency text NOT NULL DEFAULT \'normal\';\n```',
    options: [
      { key: 'run-now', label: 'Run it now', detail: 'A short lock, the deploy goes through afterwards' },
      { key: 'tonight', label: 'Tonight at 2', detail: 'No user affected, the deploy waits until tomorrow' },
      { key: 'batch', label: 'In steps without a lock', detail: 'About two hours of work on the script' },
      { key: 'cancel', label: 'Do not run it', detail: 'I take the change back' },
    ],
  }),
  card('c-perm', 'api', 8, {
    kind: 'permission', urgency: 'critical', request_id: 'abcde', created: now - 1 * min,
    title: 'Approval: Bash', body: 'Run the test suite\n\n{"command":"npm test -- --coverage"}',
    options: [{ key: 'allow', label: 'Allow', detail: '' }, { key: 'deny', label: 'Deny', detail: '' }],
  }),
  card('c-nav', 'web-frontend', 9, {
    title: 'Shall I delete the old navigation?', created: now - 12 * min, recommended: 'delete',
    body: 'Nothing uses it any more since the tab bar is in.',
    options: [{ key: 'delete', label: 'Delete', detail: 'Removes 240 lines' }, { key: 'keep', label: 'Keep', detail: '' }],
  }),
  card('c-backup', 'infrastructure', 10, {
    title: 'How long should backups be kept?', created: now - 8 * min, urgency: 'low',
    // Many short options: the card shows them as small tags.
    options: ['7', '14', '30', '60', '90', '180', '365'].map(days => ({ key: days, label: `${days} days`, detail: '' })),
  }),
  card('c-ship', 'docs', 11, {
    title: 'Publish the handbook as it is?', created: now - 7 * min, recommended: 'yes',
    options: [{ key: 'yes', label: 'Yes', detail: '' }, { key: 'no', label: 'No', detail: '' }],
  }),
  card('c-parts', 'docs', 13, {
    title: 'Which chapters go into the first release?', created: now - 6 * min, multiple: true, recommended: ['start', 'board'],
    // Handed in as one structured text (sections); body and options are what the hub derives from it.
    body: 'Tick every chapter that should be in. The others follow later.\n\n**Getting started**: Install, link a session, answer the first question.\n\n**The board**: Inbox, sessions, the card page.\n\n**Writing agents**: Still rough: the tool reference is complete, the examples are not.\n\n**Administration**',
    options: [
      { key: 'start', label: 'Getting started', detail: '' },
      { key: 'board', label: 'The board', detail: '' },
      { key: 'agents', label: 'Writing agents', detail: '' },
      { key: 'admin', label: 'Administration', detail: '' },
    ],
    sections: [
      { text: 'Tick every chapter that should be in. The others follow later.' },
      { key: 'start', label: 'Getting started', text: 'Install, link a session, answer the first question.', recommended: true },
      { key: 'board', label: 'The board', text: 'Inbox, sessions, the card page.', recommended: true },
      { key: 'agents', label: 'Writing agents', text: 'Still rough: the tool reference is complete, the examples are not.', recommended: false },
      { key: 'admin', label: 'Administration', text: '', recommended: false },
    ],
    // It replaces two earlier questions, and the human has ticked one chapter and written on another without sending.
    merged_from: [{ id: 'c-ch-start', number: 14, title: 'Is "Getting started" ready to publish?' }, { id: 'c-ch-board', number: 15, title: 'Is "The board" ready to publish?' }],
    draft: { keys: ['start'], note: '', notes: { agents: 'only once the examples are in' }, ts: now - 5 * min },
  }),
  card('c-spike', 'old-spike', 12, {
    title: 'Keep the spike branch?', created: now - 3000 * min,
    options: [{ key: 'keep', label: 'Keep', detail: '' }, { key: 'drop', label: 'Drop', detail: '' }],
  }),
]

const assetUrl = '/a/q3n0XWb1kq0lYb6m3v8K2A#b5cTqk0yq0yF4o7yq1m3v8K2Aq3n0XWb1kq0lYb6m3v'
const messages = [
  { id: 'm1', agent: 'api', from: 'user', text: 'Finish the mobile view and prepare the deploy.', ts: now - 100 * min },
  { id: 'm2', agent: 'api', from: 'agent', attachments: [], ts: now - 99 * min,
    text: 'Will do. Plan:\n\n- settle the **database**\n- mobile view with tabs\n- write the migration and prepare the deploy\n\nI put questions on the board for you.' },
  { id: 'm3', agent: 'api', from: 'event', kind: 'asked', card_id: 'c-db', text: 'Which database?', ts: now - 95 * min },
  { id: 'm4', agent: 'api', from: 'event', kind: 'decided', card_id: 'c-db', text: 'Postgres', ts: now - 80 * min },
  { id: 'm5', agent: 'api', from: 'agent', attachments: [], ts: now - 60 * min,
    text: 'Postgres runs in the container. Connection tested with:\n\n```\ndocker compose exec db psql -U board -c "select 1"\n```' },
  { id: 'w1', agent: 'web-frontend', from: 'agent', attachments: [], ts: now - 40 * min,
    text: 'I am finishing the **mobile view**. The tab bar is in.',
    details: 'What I tried:\n\n- a drawer: too many taps\n- a tab bar: one tap, always visible\n\n`npm test`: 42 of 48 pass.' },
  { id: 'm6', agent: 'web-frontend', from: 'event', kind: 'asked', card_id: 'c-next', text: 'What do I build next?', ts: now - 30 * min },
  { id: 'm7', agent: 'web-frontend', from: 'event', kind: 'asked', card_id: 'c-theme', text: 'Which default theme?', ts: now - 22 * min },
  { id: 'm8', agent: 'web-frontend', from: 'agent', attachments: [image('board-desktop.png')], ts: now - 16 * min,
    text: 'This is what the desktop view looks like right now. The mobile view is next.' },
  { id: 'm9', agent: 'web-frontend', from: 'event', kind: 'asked', card_id: 'c-phone', text: 'How should the board start on a phone?', ts: now - 15 * min },
  { id: 'w2', agent: 'web-frontend', from: 'event', kind: 'asked', card_id: 'c-nav', text: 'Shall I delete the old navigation?', ts: now - 12 * min },
  { id: 'm9b', agent: 'web-frontend', from: 'event', kind: 'urgency', card_id: 'c-phone', text: 'Urgent: I am building the mobile view right now', ts: now - 10 * min },
  { id: 'i1', agent: 'infrastructure', from: 'agent', attachments: [], ts: now - 9 * min, text: 'Backups run, monitoring is set up.' },
  { id: 'i2', agent: 'infrastructure', from: 'event', kind: 'asked', card_id: 'c-backup', text: 'How long should backups be kept?', ts: now - 8 * min },
  { id: 'd1', agent: 'docs', from: 'agent', attachments: [], ts: now - 8 * min,
    text: `**Handbook, draft** (HTML page)\n\nAll chapters in one page.\n\nhttp://localhost:8790${assetUrl}`,
    asset: { id: 'q3n0XWb1kq0lYb6m3v8K2A', type: 'html', title: 'Handbook, draft', note: 'All chapters in one page.', url: assetUrl, size: 20480 } },
  { id: 'd2', agent: 'docs', from: 'event', kind: 'asked', card_id: 'c-ship', text: 'Publish the handbook as it is?', ts: now - 7 * min },
  { id: 'd3', agent: 'docs', from: 'user', card_id: 'c-ship', text: 'Does it cover the admin page?', ts: now - 6.5 * min },
  { id: 'd4', agent: 'docs', from: 'agent', card_id: 'c-ship', attachments: [], text: 'Yes, as its own chapter, **Administration**.', ts: now - 6.2 * min },
  { id: 'd5', agent: 'docs', from: 'event', kind: 'asked', card_id: 'c-parts', text: 'Which chapters go into the first release?', ts: now - 6 * min },
  { id: 'r1', agent: 'docs-review', from: 'agent', attachments: [], ts: now - 7 * min, text: 'Two chapters read, no objections so far.' },
  { id: 'm10', agent: 'api', from: 'user', text: 'Looks good. How far is the deploy?', ts: now - 6 * min },
  { id: 'm11', agent: 'api', from: 'agent', attachments: [], ts: now - 5 * min,
    text: 'Almost done. Only the migration on the production database is missing, and for that I need your answer.' },
  { id: 'm12', agent: 'api', from: 'event', kind: 'asked', card_id: 'c-migrate', text: 'Run the migration on the production database?', ts: now - 4 * min },
  { id: 'm13', agent: 'api', from: 'user', text: 'Okay, I will have a look.', ts: now - 1 * min },
]

const tasks = [
  { agent: 'api', id: 'deploy', label: 'Deploy', state: 'decision', detail: 'Waits for the answer on the migration', card_id: 'c-migrate', updated: now - 4 * min },
  { agent: 'web-frontend', id: 'mobile', label: 'Mobile view', state: 'working', detail: 'Tab bar is in, start view open', card_id: null, updated: now - 9 * min },
  { agent: 'api', id: 'tests', label: 'Tests', state: 'working', detail: '42 of 48 pass', card_id: null, updated: now - 2 * min },
  { agent: 'infrastructure', id: 'db', label: 'Database', state: 'done', detail: 'Postgres runs in the container', card_id: null, updated: now - 60 * min },
  { agent: 'docs-review', id: 'review', label: 'Review', state: 'working', detail: 'Chapter 3 of 7', card_id: null, updated: now - 7 * min },
]

// The stack as server.mjs orders it: approvals, then by urgency, then oldest first; nothing of an archived session.
const queue = ['c-perm', 'c-migrate', 'c-phone', 'c-theme', 'c-nav', 'c-ship', 'c-parts', 'c-next', 'c-backup']
const state = { agents, messages, cards, tasks, assets: [], queue, next_number: cards.length + 1, hub: 'api', speech: false }
const text = JSON.stringify(state, null, 2) + '\n'
for (const file of ['Trommi/Resources/demo-state.json', 'TrommiTests/Fixtures/demo-state.json']) fs.writeFileSync(path.join(here, '..', file), text)
console.log(`${agents.length} sessions, ${cards.length} cards, ${messages.length} messages`)
