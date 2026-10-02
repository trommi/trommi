# Marketing: first pass

Written 2 October 2026. The landing page draft is `client/web/designs/landing.html` (pictures `landing.png`, `landing-phone.png`). The positioning line is asked on the board; until it is answered the page shows the recommended one.

Two things are open elsewhere and this document works under either outcome of both:

- **The name** (card Nr. 133, `docs/naming.md` section 6). All copy uses the name as a noun in one place. On the page it is one constant; `landing.html?name=Knockfirst` shows the page under another name.
- **Open source or not.** No line here says "open source", "source available" or "proprietary". The trust lines used are true in both cases ("your hub, your machine").

How to read the sources: **verified today** means fetched or run on 2 October 2026. **Search summary** means a web search result said it and I did not open the vendor's own page. **From memory** means not checked.

## 1. Who it is for

Ranked by how well the product serves them today, not by market size.

### 1. A solo developer who runs three or more Claude Code sessions at once

The product was built by this person for this person, and it fits nobody else as well yet.

- The pain: each session stops and waits whenever it has a question or needs a permission. With several sessions the human cycles through terminals to find out which one is stuck. The human is the bottleneck, and the tools show transcripts, not questions.
- Evidence the pain is common: Anthropic shipped "agent view" as a research preview, a terminal screen that groups background sessions under "Needs input", "Working" and "Completed" (verified today, code.claude.com/docs/en/agent-view). A vendor builds that only when many users have the problem. Third-party session managers have real followings: Claude Squad about 8,400 GitHub stars, Conductor at version 0.89 (search summary and conductor.build, today).
- Evidence from this repository: the board that builds Trommi has passed card Nr. 136, in a repository whose first commit is 21 July 2026.
- What they need to hear: all questions in one list, the blocking ones first, answered in one tap, from the phone too.
- What stops them today: the setup needs a development flag (section 4), and there is no push notification.

### 2. People who already use a remote or approval tool for agents and have hit its limit

They have the habit and some already pay.

- What they use: Claude Code Remote Control, Happy, Pushary, AgentsRoom, Omnara (section 2).
- The limit they hit: those tools mirror one session's transcript to a phone, or relay approve/deny. With five sessions that is five transcripts to read. None of them makes the agent do the work of asking a good question.
- Evidence that people pay: Pushary charges 9.99 and 19.99 dollars a month for phone approvals (verified today, pushary.com). Its own comparison page lists fourteen tools in the category (verified today).
- What they need to hear: "A question, not a transcript."

### 3. Small teams with several people and many agents

The largest budgets and the worst fit today. Do not aim the launch at them.

- Evidence of budgets: HumanLayer charges 100 dollars per user per month for Pro, Conductor about 50 dollars a month for Pro (verified today on humanlayer.dev; Conductor's price is a search summary).
- Why not yet: Trommi is one hub per person. There are no accounts, no roles, no shared desk, no audit trail. On Claude Team and Enterprise plans an owner must switch channels on before any channel works (verified today, code.claude.com/docs/en/channels).
- Keep them warm with one line on the waitlist form later ("How many people would use it?"), nothing more.

## 2. What exists, and how this differs

| Product | What it is | Price | How Trommi differs | Source |
|---|---|---|---|---|
| Claude Code agent view (Anthropic) | Terminal screen listing background sessions by state; peek at a question and type a reply. Research preview. Terminal only, this machine only, background sessions only. | In the Claude plan | Trommi works from a browser and a phone, and holds structured cards (options, advice, pictures, versions) instead of the last line of a transcript. | verified today |
| Claude Code Remote Control (Anthropic) | Drive one local session from claude.ai or the Claude phone app; push notification when it needs a decision. | In the Claude plan (which plans: search summary, conflicting) | One session at a time, as a transcript. No list across sessions, no ordering by urgency. | verified today |
| Claude Code channels: Telegram, Discord, iMessage (Anthropic) | Chat bridges into a running session. Research preview. | In the Claude plan | A chat per session in a chat app. Trommi is itself a channel, built on the same mechanism. | verified today |
| Hiloop (hi-loop.com) | Hosted inbox for agents: prioritised feed, decisions, reports, forms; SDKs and an MCP server; says content is end-to-end encrypted. Beta. | Not stated | **The closest in idea.** It is a general inbox for any agent with SDKs. Trommi is narrower and deeper for coding sessions: Revise, Whatever, Shred, the crown, notes and pen on the card, the walk. Watch it. | verified today |
| Pushary | Phone approvals for Claude Code, Codex, Cursor and others; confirm, select from 2 to 6, or free text; policies and audit trail. Hosted. | 9.99 and 19.99 dollars a month | Approval-first and notification-first. No desk, no versions of a question, no pictures per option. Has push, which Trommi lacks. | verified today |
| Happy (slopus/happy) | Free phone and web client for Claude Code and Codex; relay server forwards encrypted data. | Free | A mirror of the session. Stronger than Trommi on encryption and on Codex. | search summary today; MIT licence per Pushary's page |
| Omnara | Now "the open-source alternative to Claude Managed Agents", a platform for running agents. Its earlier phone remote is how others still describe it. | Free, usage-based credits | Moved away from this problem. | verified today |
| HumanLayer | Was the approvals SDK; now an IDE and cloud "control plane" for teams. | Free to 3 people, then 100 dollars per user per month | Team product, different buyer. | verified today |
| Conductor | Mac app that runs Claude Code, Codex and Cursor in parallel in isolated workspaces and reviews their diffs. | Free; Pro price is a search summary | It starts and isolates agents. Trommi does not start anything; it is where they ask. The two can sit side by side. | verified today |
| Claude Squad | Terminal manager for several agents in tmux. AGPL. | Free | Same as Conductor: runs agents, shows terminals. | search summary |
| Vibe Kanban | Kanban board for agents; the company behind it closed in April 2026, now community-maintained. | Free | A task board, not a question desk. | search summary |
| AgentsRoom, Forge Remote, Onepilot, Fleetify and others | Phone mirrors and command centres. | Free to about 10 dollars a month | Not opened individually. | Pushary's list, verified today as a list only |

**The honest summary.** The category "see my agents from my phone" is crowded and partly free, and Anthropic is building it into Claude Code. Trommi should not compete there. Its one distinct idea is that **the unit is a question, not a session**: the agent has to hand in a card a person can answer in seconds, and all cards of all sessions lie in one ordered list. Only Hiloop is built on a similar idea, and it is general where Trommi is specific.

**The largest risk** is Anthropic adding options and a phone view to agent view. The answer is not to be faster at mirroring but to be better at the question: the contract in `docs/question-contract.md` is the asset.

## 3. The promise

**One sentence:**

> Trommi puts every question from every coding agent on one desk, so you answer in a tap and they keep working.

**Three alternates:**

1. Your agents ask. You answer. Next, please.
2. One desk for every question your agents ask.
3. Stop babysitting terminals.

The headline choice is on the board. My recommendation is the first: it is the product's own voice, it is the name of its main button, and the screenshot under it says the same two words. It needs the sub-line to say what the product is, which the page does.

A fourth line, "Agents that knock first", was left off the card. It only becomes strong if the product is renamed Knockfirst, and it pulls the story towards approvals, where Pushary already stands.

## 4. Five proof points that are true today

Each one checked against the code or the documents on 2 October 2026.

1. **One list for all sessions, ordered by the hub.** Permission requests first, then by urgency, then oldest first; the crowned session's questions lead. (`README.md`, "Reihenfolge und Dringlichkeit" and "The web UI"; seen in the demo hub today with four sessions and eight cards.)
2. **A question is a structured card.** Options, the agent's recommendation marked by hand, pictures tied to options, several answers allowed, a note per option, writing and drawing on the card. A yes or no is answered by a thumb in the list. (`docs/question-contract.md` sections 1 and 2; `create_decision` in the tool list.)
3. **Four ways besides answering, each of which can be taken back.** Snooze, Revise (the same card comes back reworded, up to 20 versions kept), Whatever (the agent takes its own advice), Shred (the agent is told not to ask again). (`client/web/help.html`; `/decide {trust}`, `/shred`, `/reopen` in `README.md`.) Whether they stay four is still open in `TODO.md`.
4. **It works with real Claude Code sessions, permission prompts included.** A session connects through an MCP server with the channel extension; 16 tools (counted today from `GET /api/tools`); tool approvals arrive as Allow / Deny cards; messages to a session that is away wait for it.
5. **It runs on your machine and is small.** One Node process, state in one SQLite file, two dependencies (`@modelcontextprotocol/sdk`, `zod`), a web client without a build step, a test file of 2,700 lines. Reached from other devices over the user's own private network. The whole app works from the keyboard.

Two more that are true but need care in wording:

- **Voice.** Dictation and reading a card aloud exist, but only with the user's own Tinfoil key. Say "voice in and out, with your own key", or leave it for the recording.
- **Encrypted links.** A page or file an agent publishes is encrypted with AES-256-GCM beside the agent before it reaches the hub, and the key sits in the link's fragment. That is true for published assets only. See section 5.

## 5. What not to say

| Do not say | Why |
|---|---|
| "End-to-end encrypted", "the hub cannot read your data" | Only published assets are encrypted. Chat and cards are plain on the hub; the README says so itself. The room key is designed, not built. |
| "Works with Codex, Cursor, any agent", "any MCP client" | Only Claude Code, through its channel extension. An ordinary MCP client cannot receive the answers pushed back. |
| "Install in one command", "plug and play" | A custom channel needs `--dangerously-load-development-channels`. During Anthropic's research preview `--channels` accepts only plugins on Anthropic's allowlist (verified today). The word "dangerously" will be the first comment under any post, so name it first. |
| "Get notified on your phone", "push" | Not built (`TODO.md`). The page says the desk opens on the phone, which is true. |
| "See what your agents are doing live" | The channel carries only what the agent sends on purpose: no thinking, no tool calls, no terminal output. |
| "iOS app", "native apps" | iOS is parked. The Linux client has never run on a real screen. |
| "Sign up", "hosted", "cloud", "start free" | There is no hosted hub and no accounts. The page says "waitlist" and "being worked out". |
| "For teams", "multiplayer" | One hub per person. |
| "Orchestrates your agents", "runs agents in parallel" | Trommi starts nothing and isolates nothing. It is where agents ask. |
| "Secure", without a qualifier | The hub speaks plain HTTP and is only defensible inside a private network (`TODO.md`, TLS). |
| "Open source" or "closed" | Undecided. The repository carries the O'Saasy licence today; that is a fact, not a message. |
| "Official", "Claude's inbox", the Claude logo | Not affiliated. The footer says so. |
| "AI-powered", "10x", "supercharge", "seamless" | The product's voice is an office from 1985. It says Desk, Ledger, Knock, Shred. |
| Counts of users, hours saved, testimonials | There are none yet. |

## 6. Pricing and packaging

**Everything in this section is a hypothesis.** Nothing has been tested with a buyer. The anchors are the prices verified in section 2.

- **H1: people pay for the hub being somewhere else, not for the software.** A hosted hub removes the three things a stranger cannot be asked to do: run a service, set up a private network, keep it reachable from a phone. This fits Christopher's own reading that the infrastructure is the product.
- **H2: one flat price per person, about 9 to 12 dollars or euros a month.** Pushary and AgentsRoom sit at 9.99, Pushary Pro at 19.99. Remote Control and Happy are free, so more than about 12 needs a reason a mirror cannot give.
- **H3: never meter questions or sessions.** The product is better the more the agents ask. A price per question would teach users to make agents ask less. If a limit is needed for a free tier, limit connected sessions (for example three), not cards.
- **H4: push notifications and the phone are the first paid reasons.** They need a server that is always on, which is the hosted hub.
- **H5: a team tier comes later and is a different product** (shared desk, who may answer what, audit trail). Do not price it now.
- **H6: a hosted hub needs the encryption first, or a plain statement of what the hub can read.** Agents send code, migrations and screenshots. "We could read it but do not" is a weak line for this audience; Happy and Hiloop both sell on "we cannot read it".

How the two outcomes of the open-source question change the packaging, without changing the price:

| | If the hub stays closed | If the hub is open |
|---|---|---|
| Free | A hosted hub with a session limit | Run it yourself, unlimited |
| Paid | Hosted, unlimited, with push | Hosted, with push, backups and the relay |
| Trust line | "The part beside your agent is small and yours to read" (the channel process runs on the user's machine in both cases) | "Read all of it" |
| The risk | A developer audience distrusts a closed relay for its code | Someone else hosts it (the current licence forbids exactly that) |

One point for the open-source question, not a decision: the channel process necessarily runs on the user's machine as a Node file, next to the agent. It cannot be kept secret in any meaningful sense, and it is where the asset encryption happens. The secret, if there is one, can only be the hub and the clients.

## 7. Launch sequence

For one person. Each step lists what must be true first. Nothing here has been posted, registered or sent.

### Step 0: before anything is shown

- The name is decided (card Nr. 133). If it changes, a trademark look-up for the new name comes first (`docs/naming.md` could not do one).
- The four ways besides answering are settled, and the opened card's layout stops moving (`TODO.md`, "Noch im Fluss"). A recording of a screen that changes next week is wasted.
- English demo data exists in the repository. `dev/demo-state.mjs` and `dev/fake-agent.mjs` are German; the screenshots on the landing page came from a throwaway English hub that is gone.

### Step 1: the 60-second recording

The one asset every later step uses. No voice needed; captions carry it. Every shot is a real screen.

| Seconds | Screen | Caption |
|---|---|---|
| 0 to 6 | Four terminal panes, each with a Claude Code session stopped at a prompt | "Four agents. All four are waiting for you." |
| 6 to 14 | The Desk, eight cards, a Knock on top | "Their questions, on one desk. The blocking one first." |
| 14 to 24 | Thumb on a yes/no in the row, then Choose on the migration card, the marked recommendation, tap | "Yes or no is a thumb. The agent says what it would pick." |
| 24 to 34 | "Next, please": three cards answered one after the other | "Next, please." |
| 34 to 44 | Revise with one typed line, the same card returns reworded; then Whatever; then Shred | "Ask me better. Your call. Don't ask again." |
| 44 to 52 | A terminal pane: the session continues by itself after the answer | "They keep working." |
| 52 to 60 | The phone, the same desk; then "Desk is clear." | "Clear your desk. Let them work." |

Must be true first: step 0; a scripted demo so the take can be repeated; the terminal shots are real sessions answering through the channel, not mock-ups.

### Step 2: the waitlist page

`landing.html` on the product's domain, with the recording in place of the hero screenshot.

Must be true first:

- The domain is his (`docs/naming.md`: `trommi.com` was registered on 21 July 2026 through Hetzner, the holder is not visible).
- The form stores addresses somewhere he controls, with double opt-in.
- An imprint and a privacy notice exist. From memory: a German operator needs both even for a single-page waitlist. Have this checked; it is not legal advice.
- The page states the development flag and "Claude Code only", as the draft does.

### Step 3: X, building in public

Short clips cut from the recording, one idea each: the walk, Revise, Whatever, the crown. One post a week, each linking the waitlist.

Must be true first: step 2, so that attention has somewhere to go. The words Knock, Shred and Whatever are the hook; show them, do not explain them.

### Step 4: Claude Code communities

r/ClaudeAI and r/ClaudeCode, the Claude developers' Discord, the awesome-claude-code list (these names are from memory and from today's search results; their posting rules were not checked).

Must be true first:

- A stranger can install it in under five minutes from a README in English. Today's README is German and assumes this machine.
- The flag question has an answer: either the channel is a plugin that loads without the development flag (`TODO.md`), or the post says in its first paragraph why the flag is needed and what it does.
- The open-source question is decided, because the first reply will ask for the repository.

### Step 5: Show HN

Last, and once.

Must be true first:

- Something people can run that day. From memory: Show HN is for things people can try, and a waitlist or landing page does not qualify. Check the current rules before posting.
- Steps 0 to 4.
- A written answer to the three comments that will come: "Anthropic's agent view does this", "why the dangerous flag", "what can your hub read". Sections 2 and 5 are the raw material.
- A free day to answer comments.

### What to watch between the steps

- Whether Anthropic's channels leave research preview, and whether custom channels can be listed. This decides the install story.
- Hiloop: pricing, and whether it grows a Claude Code channel of its own.
- Waitlist sign-ups per post. Below about a hundred after step 4, the message is wrong, not the reach.

## 8. What I did and did not check

- **Run today:** a throwaway hub on its own port with four made-up English sessions and eight cards; screenshots of the Desk, an opened card, the session list and the phone view; the tool count from `/api/tools`. The hub and its sessions were stopped afterwards.
- **Fetched today:** omnara.com, hi-loop.com, pushary.com and its comparison page, conductor.build, humanlayer.dev, happy.engineering (only its headline came back), and Anthropic's pages for channels, Remote Control and agent view.
- **Search summaries only:** Claude Squad, Vibe Kanban, Crystal, Conductor's Pro price, Happy's details, which Claude plans include Remote Control.
- **Not checked:** any competitor by using it; community rules; Show HN's current rules; trademark and legal questions; whether anyone would pay.
