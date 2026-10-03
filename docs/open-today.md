# Open today: what Christopher asked for since the hub restart, and where it stands

Read on 3 October 2026, 17:35 CEST. Sources: his 89 messages on the board since the restart of 09:58
(`node server/board-store.mjs export data`, up to message #1024), his 14 lines in the Claude Code chat of the day,
cards Nr. 148 to 165, the status lines, the STATUS files and the code on `trommi-board` (uncommitted edits counted
as built). Read only. The clicks "Back to you" and "Explain this question" are not listed on their own; they belong
to the request beside them. Times are CEST. `#n` is the message number on the board, "chat" is the terminal.

States: **lost** (asked, nothing built and nobody visibly on it), **unclear**, **in progress** (a status line or a
promise of the last minutes), **waits on him**, **waits for restart** (built, the live hub still runs the code of
09:58), **done**.

Nothing he asked for today is lost outright. Two remainders have no owner, and two things are unclear.

## Lost and unclear

| Time | His words | What it means | State | Evidence |
|---|---|---|---|---|
| 16:58 | "Generell muss die Seite mal technisch echte Seiten haben … Steuerung und Klick" (#985) | Everything one navigates with is a real link | **lost (remainder, no owner)**: the switches Conversation / Scribble / Files, the jump hits in the menu and everything inside the opened card are still not links | #1009 names them as "liegt bei den jeweiligen Workern"; status line `web-ui links` says done; no other line holds it |
| 16:58 | "Chat fließt auf der ganzen Seite … Überschrift nach oben links" (#985) | Session page without the head band | **lost (remainder, no owner)**: built for wide windows only, the phone is as before | `client/web/css/session.css:9` (`min-width: 861px`); #1007 "Am Handy ist es noch wie vorher"; status line `layout session` done |
| 17:33 | "Notizzettel … überall leben, verschieben … gelber Memo-Stapel … auf das Canvas ziehen" (#1024) | The memo slip becomes a movable note that stays, simpler (no scrollbar, Memo and To in one line, no time, a symbol for tear off and send), a yellow memo pile at the Desk's foot, lives on the paper when dragged there | **unclear**: one minute old when read, no reply and no status line yet | board #1024; last reply is #1023 |
| 16:03 | "dann öffne 2 weitere hauptagenten damit man sieht wie die auch ne krone haben" (#840) | Two more main agents, to see several crowns | **unclear**: shown only in the design pages (three mains with subs); on the real board no second main exists, so after the restart at most Trommi has a group | `client/web/designs/crown.html`, card Nr. 160; no session with `main` in the export |

## In progress

| Time | His words | What it means | State | Evidence |
|---|---|---|---|---|
| 17:33 | "Mein kritischer Agent soll mal die Abstände überarbeiten" (#1022) | Heading of the current view larger, Desk box spacing, pill not over text | in progress | status line `layout spacing` (17:33); #1023 |
| 17:31 | "… dass das dann noch weg sollte. Die Zeichnung wird vom Zeichenbrett gelöscht" (#1016) | What was sent from the paper disappears from it | in progress (promised #1019 with the pad toolbar; nothing in `client/web/pad/pad.js` yet). The praise itself is kept: memory `trommi-pad-send-selection-is-a-keeper.md` | #1019; status line `web-ui deskpad` |
| 17:30 | "bei dem Whiteboard-Tool noch ein kleines Textsymbol" (#1012) | Text tool in the paper's toolbar | in progress | #1017; status line `web-ui deskpad` "Werkzeugleiste neu" |
| 17:29 | "Stiftfarbe auf den Stift … Bildsymbol durch Anhangsymbol" (#1011) | Second click on the pen gives the colour; paperclip for pictures | in progress | #1014; status line `web-ui deskpad` |
| 17:29 | "Next, please. Dafür fünf Designvorschläge" (#1011) | Five proposals for the heading: smaller, left, clear of the menu | in progress, no card yet | status line `design nextplease`; `client/web/designs/nextplease.html` |
| 16:26 | "Das Notizfeld für die Kronen ist nicht immer im Vordergrund, wenn man innerhalb einer Karte ist" (#898) | The memo slip must lie over an open card | in progress: the slip is on top (z-index 2600), the memo button over the card page is still being built | `STATUS-focus-scribble.md:129`; status line `focus-scribble card` |
| 16:37 | "Kringel bis auf das Bild … Agenten die Position mitgeben" (#930) | Agents name a region of a picture, the board circles it and the arrow starts there | in progress on the card page, server part waits for restart. The second idea (render a mini HTML instead of a screenshot) was put aside on purpose and said so (#932) | `focus.js:133-154` `circleMarks`; `server.mjs:682-713`; status line `focus-scribble card` |

## Waits on him

| Time | His words | What it means | State | Evidence |
|---|---|---|---|---|
| all day | (every server feature below) | Restart the hub at the PC | waits on him | status line `server restart` (decision); #998 |
| 16:50 | "trommi.com gekauft" (card 159) | Rename the board from Trommi to Trommi | waits on him: #970 asked for a "ja"; only the menu is called Trommi (his word in the chat, 16:52), the title is still Trommi | `client/web/index.html:7`; `bar.js:63` |
| 10:09 chat | "schick agent los der das handydesign perfekt testet" | Phone design tested and fixed | done by QA (50 finds, 45 fixed); seven checks on the real iPhone wait on him | #786; `docs/qa-phone-design.md` |

## Waits for the hub restart (built)

| Time | His words | What it means | State | Evidence |
|---|---|---|---|---|
| 16:03, 16:21, 17:30 | "die krone sollte der hauptagent sich selbst geben und die untertanen darunter" (#840); "Stapel dahinter kombinieren mit Klammer" (#883); "Task, der die Gruppierung in der Sidebar bestimmt … verschwunden" (#1012) | Main agent with crown, its subs as a stack that unfolds into a bracket | waits for restart, **and then the sessions must still be assigned**: nobody has made Web UI, Focus & Scribble, Design, Server, QA, Layout, Keyboard subs of Trommi. No status line holds that step (promised in #1017) | card Nr. 160 "combo"; `client/web/js/agents.js:220-272, 346-356, 399-451, 476-486`; `client/web/css/crowns.css`; `server/server.mjs:376-409, 303, 3327` |
| 10:12 chat | "mach dieses asset mitsenden technisch perfekt … freigeben und an dritte senden" | Release one asset with its own link, take it back, expiry, counter | waits for restart | `docs/asset-sharing.md`; #753, #773; card 154 shredded by him ("nur dev") |
| 10:22 | card 149 "Im Desk-Menü" | Several desks, switched in the Desk menu | waits for restart | #768, #781; `bar.js:262-354`; `server.mjs:3351` |
| 16:17 | "Eine Bestätigung … ist noch kein Grund, mir das wieder vorzulegen" (#858) | A mere reply does not present a card again | waits for restart | #878 |
| 15:54, 16:29 | "keine worte drunter" → card 157 "Kurzwort" | Short word of the agent on the tiles of the Desk row | client done (shows "Choose" until then), `short` waits for restart | #960; `inbox.js:63`; `server.mjs:1438` |
| 16:40 | "Die älteste Entscheidung soll immer oben sein … Reihenfolge ist fix" (#940) | Fixed order, a marker when something knocks out of sight | client done and measured, the hub's own order waits for restart | #961; `STATUS-server.md:34` |
| 16:56 | "soll der Agent in den Chatverlauf die Details geben" (#979) | Details as a reply under the card, not on it | waits for restart | `server.mjs:898`; `STATUS-server.md:35` |
| 16:32 | "der Agent hat die Anweisung, die Entscheidung auf die Höhe so einer Karte zu bringen" (#919) | Budget for a question; the hub warns | waits for restart | `server.mjs:898, 1515` |
| 17:01 | "Create fünf Fake Decisions" (#990) | Menu item that throws test cards on the Desk | waits for restart (menu shows "Needs the hub restart") | `bar.js:222-256`; `server.mjs:413-438` |

## Done

| Time | His words | What it means | State | Evidence |
|---|---|---|---|---|
| 09:49 chat | "passkey login statt Access only through the link" | Passkey login | done (live since the restart) | #736; `server/passkey.mjs` |
| 10:00 | "5 Handy UIs vorschlagen lassen ist zu überladen" (#738) | Five calmer phone layouts | done | card 153 "calm"; #782 |
| 10:10 | "auch mal die änderung im bild markieren?" (#742) | Circle the changed spot | done, kept as a rule | cards 148 to 150; memory `trommi-mark-the-change-in-pictures.md`; `server.mjs:910` |
| 10:11 | "send mal als vide" (card 148) | The two fields as a video | done; he shredded the card, so "no Send button" is closed | #751; card 148 shredded |
| 10:23 | "Der WHAT?? Button fehlt mir!" (#760) | What?? back on the card | done | #774; `focus.js:789` |
| 10:22 | card 150 "Ja, zuklappbar" | Folded sidebar (rail) | done | #778; `bar.js:167` |
| 10:28 | "anderes Logo und 10 deutsch klingende Namen" (#776) | Logo without Z, names | done: hand-drawn counter bell built in; name Trommi | cards 155, 156, 159; `css/logo.css`; #964 |
| 15:33 to 16:48 | "welche domains", "zeig nur .com", "30 vorschläge die BALLERN", "wie es im Englischen klingt", "auf Vokale enden", "TROMMI" (cards 156, 159) | Name rounds | done | card 159 withdrawn "Erledigt: Name Trommi" |
| 16:26 | "Die Hörproben funktionieren nicht" (card 159) | Listen buttons | repaired, never tried on the iPhone; moot since the name is chosen | #909, #910 |
| 15:34 | card 158 "Agents-Knopf weicht" | Narrow phone bar | done | #801 |
| 15:48 | "jetzt muss man wie ein affe scrollen" (#810) | All options in sight | done | #851 |
| 15:51, 16:50 | "10 vorschläge wie whatever button" (#813); "hier sollte nur whatever stehen" (#968) | Whatever as the alternative to deciding | done: "or" and one line with the word alone | card 163 "oder"; `focus.js:932`; `STATUS-focus-scribble.md:128` |
| 15:52 | "entscheidungsbuttons nach rechts … links gallerie … beim hovern wechseln" (#815) | Options right, stage left | done | #851 |
| 15:56 | "zzz auf die karte neben titel und uhrsymbol weg" (#825) | Snooze on the row | done | #832 |
| 15:59 | "innerhalb der karte scrollen" (#830) | Title stays, the middle scrolls | done, then replaced by the card page | #851 |
| 16:00, 16:28, 16:32 | "wie fizzy: karte zentral, feed drunter" (#833); "nicht als Pop-up, sondern als neue Seite" (#906); "Keine zwei Ansichten" (#919) | One page per card, the walk is the same page | done | #1004, #1008 |
| 16:03, 16:09 | "10 vorschläge in revision" (#839, picture: the "In revision" list); "In Revision, Answer und Shreddit gleichwertig" (#846) | The piles at the Desk's foot as one system | done (first misread as "ten proposals per hand-back", settled by #846) | card 162 |
| 16:05 | "5 vorschläge für ein menü das schwebt" (#843) | Floating menu | done | card 161 "pille"; #942 |
| 16:13 chat | "mehr Superagenten", "Echte Screenshots will ich schon" | Parallel agents, real screenshots | done, kept as a rule | #848; memory `trommi-real-screenshots-and-parallel-agents.md` |
| 16:11, 16:15 chat | "Die Entscheidung jetzt vor", "klopft.com ist frei?" | Cards now; is the domain free | done | #850 |
| 16:24 | "vollständig verloren gegangen, dass … Bild … mit einem Pfeil verbunden ist" (#894) | The drawn arrow from picture to option | done | #1008; `focus.js:519` |
| 16:26 | "nicht in den Kommentarfeldern … wurde überarbeitet" (#897) | A revision is an entry in the feed | done | #1006; `focus.js:1624, 1720` |
| 16:29 | "neue Entscheidungen … nicht mein Fenster verschieben" (#911) | Nothing moves under eye and pointer | done (measured 176 px → 0) | #961 |
| 16:30 | "Der Link geht manchmal nicht" (#913) | Paths like /designs/… always clickable | done | #944 |
| 16:33 | "riesen Mega-Screenshot … sollten einzelne sein" (#920) | One picture per option | done for cards 155 and 163; rule of the main thread, not in the hub's instructions | #925, #931 |
| 16:33, 17:29 | "Canvas-Button nach oben rechts" (#921); "Whiteboard-Button kann jetzt weg" (#1011) | Pad button moved, then removed | done | #942; `css/deskpad.css:15` |
| 16:38, 16:50, 16:51, 16:57, 17:29 | "er fächert auf" (card 162); "design überarbeiten" (#969); "wenige Stapel … drei Richtungen" (#971); "Einfach zwei Stapel" (#983); "unter den Karten" (#1011) | Piles at the Desk's foot | done: two piles Later and Done, under the cards. The promised card with three variants (#972, #973) never came; his "Einfach zwei Stapel" replaced it | #999, #1020; `css/piles.css`, `js/piles.js` |
| 16:39 | "Tischglocke aber handgezeichnet" (card 155) | Bell in the sidebar's pen | done | card 155 "klingel" |
| 16:43, 16:52 chat | "brauchen wir das links nicht mehr" (#950); "Doch wieder den Desk links … Menü heißt dann Dromi" | Desk box out, then back; menu "Trommi" | done (his last word) | #992 |
| 16:52 chat | "in der UI wird nur wenig gezeigt als gerade laufende Bearbeitung" | Running work visible | done: status lines set and kept by the workers (the line `trommi lead` is stale since 16:52) | #976; memory `trommi-show-running-work-on-the-board.md` |
| 16:54 | card 164 "Zeichnung am Rand" | Session mark beside each row | done | #993 |
| 16:56 | "erst Titel, dann Kurzbeschreibung, dann Galerie … falsches Scroll-Level" (#979) | Order on the card; opens at the top | done | #1008 |
| 16:58, 17:30 | "5 neue zeichnungen vom desk" (#986) | Desk drawing | done: desk with lamp | card 165 "lamp"; #1021; `ui.js:901` |
| 16:59 | "mache einfach den Desk zu einem Scratchpad" (#987) | Paper under the decisions | done | #1001; `client/web/pad/STATUS.md` |
| 17:30 | "statt Krone … ein gelbes Notizzettel-Symbol" (#1012) | Memo button is a yellow note | done | `js/quicksend.js:30-33` |
| 16:05 | card 151, all three ticked | Three dictations read right | done (nothing to build) | card 151 |

## Yesterday's list (`docs/open-from-chat.md`): what was picked up today

Picked up: several desks (card 149), rail (card 150), no Send button (card 148, shredded by him), the three
unclear dictations (card 151), Shift turns Snooze into Shred (`inbox.js:584`), copy a decision
(`STATUS-keys.md:43`), conversation column drag and fold (`STATUS-layout.md:76`), message log with `since`
(`server.mjs:309`), the name (Trommi replaces "name for America").

No trace of work today (no message, no status line): the drawn hand for what the agent calls important; own ring
and card colours; the counts that disagree with the walk; the red hand with nothing open; toast top left; the
typeface that changes; stable agent ids; pairing wired into the hub; agents opening helper sessions
(`open_session`, blocked on his release sentence); push to the phone. "Where Scribble lives" is overtaken by the
Desk as paper.

## The sidebar grouping

It is in the tree and intact after the later edits (real links in `agents.js`, Desk box out and back): the rows
are built from `agent.parent` (`agents.js:346-350`), a main gets the crown as fold switch and its subs as coloured
edges behind it, unfolded they stand under it in a drawn bracket; `node --check` passes, `crowns.css` is linked
(`index.html:25`), the Agents page has the picker "Main agent: …" (`ledger.js:251-262`).

He does not see it for two reasons. The live hub does not send `parent` or `main` (no session in the export has
them). And no session has a main yet: after the restart the hub sends `main: false` for everyone, so the crown on
Trommi even disappears (the starred session then shows only the small gold memo dot) until a sub is assigned.

To assign after the restart, per worker session: `POST /session {agent: "<id>", parent: "trommi"}`, or on the
Agents page "Main agent: Trommi", or when linking `node dev/session.mjs link "<Name>" --parent trommi`; the main
session can also take them itself with the tool `adopt_session`. Ids: `web-ui`, `focus-scribble`, `design`,
`server`, `qa`, `layout`, `keyboard`.

Other grouping in the sidebar: pairs (sessions dropped on each other, loop and scissors) are older and live; desks
wait for the restart. No further grouping request of today is unbuilt, except the two extra main agents above.
