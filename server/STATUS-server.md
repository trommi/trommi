# Server status log

2 Oct 2026, session "Server". Nothing committed.

- Part 0: `POST /session` takes `archived` (refused with 409 while online, cleared on reconnect, cards leave `queue`) and `group` (max 40 chars, null clears). Tested.
- English: every human-facing string the server makes (urgency labels Blocking/Urgent/Normal/Whenever, "Withdrawn", "Approval: …", Allow/Deny, session-ended summary, 401 text, speech errors, admin log details, `[removed]`). Left as is: the German clock fix-ups in `cardScript` (they act on the card's own text).
- Hub-only: `BOARD_HUB_ONLY=1`, no agent record, no MCP, no exit on stdin end, waits for a taken port. Tested with a spoke.
- Part 1: `publish_asset`, `list_assets`, `revoke_asset`; `/agent/asset` for spokes; `/a/<id>`, `/a/<id>/blob`, `/a/-/{asset.js,asset.css,tokens.css,frame.html}` without login; purge, forget, orphans, overview know `data/assets/`. Viewer: `client/web/a.html`, `js/asset.js`, `css/asset.css`.
- Part 2: `client/web/help.html`, `css/help.css`, `js/help.js`; `GET /api/tools`; `demo/channel-api.png`.
- Later additions: app paths `/s/…`, `/agents`, `/inbox` and a login redirect that keeps path and query; ask-back (`card_id` on `/message` and `reply`); multi-select (`multiple`, `keys`, `choices`); instruction lines for pictures on cards.
- Part 3: published on a demo board (port 8798, gone after 300 s): the help picture page, `layouts.html`, the diagram PNG. All three opened in the viewer.
- Open for others: `client/web/js/admin.js` does not count orphaned assets yet (the server removes them with the rest); `dev/session.mjs call … publish_asset` cannot work, because it calls the hub directly and the tool encrypts in the MCP process.
- Ops fixes: `/agent/*` refuses proxied requests (`X-Forwarded-For`, `Tailscale-User-Login`); hello carries `dedicated`, spokes of a hub of its own relink instead of taking the port, hub-only poll 200 ms; `GET /healthz`; data subfolders created 0700 (existing folders keep their mode).
- Static route: any regular file under `client/web/` of the page kinds, folder index, no dotfiles, links or traversal; routes go first.
- Last: three green runs of `server/test.mjs` in a row.
