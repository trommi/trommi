# Operating a Trommi hub

How to run the hub as a dedicated, always-on process instead of "the first session is the hub". Everything named here lives in `deploy/`. What was tested and what was not is at the end.

## The picture

```
 phone / laptop in the tailnet                 your machine (Arch, user session)
┌──────────────────────────┐         ┌──────────────────────────────────────────────────────────┐
│ browser or iOS app       │  HTTPS  │ tailscaled                                               │
│ cookie board_8790=<token>│────────▶│  tailscale serve :443 (tailnet only, Let's Encrypt cert) │
└──────────────────────────┘ tailnet │        │ plain HTTP, arrives from 127.0.0.1              │
                                     │        ▼                                                 │
 browser on the machine itself ─────▶│ trommi-hub.service        node server/server.mjs         │
   http://localhost:8790             │  BOARD_HUB_ONLY=1         127.0.0.1:8790                 │
                                     │   pages  /  /css /js      (cookie, same-origin POSTs)    │
                                     │   live   /events          (SSE, whole state per change)  │
                                     │   agents /agent/*         (loopback + x-board-token)     │
                                     │        ▲                          │                      │
                                     │        │ HTTP + SSE on loopback   ▼                      │
                                     │ Claude Code session ─stdio─ server.mjs (spoke)   data/   │
                                     │ Claude Code session ─stdio─ server.mjs (spoke)           │
                                     └──────────────────────────────────────────────────────────┘
```

| Process | Started by | Listens on | Talks to |
| --- | --- | --- | --- |
| Hub: `node server/server.mjs` with `BOARD_HUB_ONLY=1` | systemd user manager (`trommi-hub.service`) | `BOARD_HOST:BOARD_PORT`, default here `127.0.0.1:8790` | the data directory; Tinfoil over HTTPS if speech is on |
| Spoke: the same file without the flag | every Claude Code session that loads the channel (`.mcp.json`) | nothing while a hub holds the port | the hub at `http://127.0.0.1:BOARD_PORT/agent/*`, Claude Code over stdio |
| `tailscale serve` | `tailscaled` (system service) | `https://MACHINE.TAILNET.ts.net:443`, tailnet only | the hub on loopback |

Where the secrets live:

| Secret | Place | Who needs it |
| --- | --- | --- |
| Access token | `data/token` (0600), or `BOARD_TOKEN` | every browser (in the login link, then as a cookie) and every spoke (reads the file) |
| Admin key | `data/admin-token` (0600), or `BOARD_ADMIN_TOKEN` | whoever opens `/admin.html` |
| Speech key | `data/tinfoil.key` (0600), or `TINFOIL_API_KEY` in `hub.env` | the hub |
| Login links | `data/url.txt` (0600), rewritten at every start; contains the token | you, once per browser |
| Service settings | `~/.config/trommi/hub.env` (0600), hidden from the hub process itself | systemd |

The data directory holds every conversation, card and attachment in clear text. Whoever reads it, or a backup of it, reads the board.

## 1. The hub as a systemd user service

```bash
deploy/install-user-service.sh            # writes the unit and hub.env, starts nothing
deploy/install-user-service.sh --enable   # the same, then daemon-reload and enable --now
```

The script is idempotent and prints each step. It writes `~/.config/systemd/user/trommi-hub.service` (rendered from `deploy/systemd/trommi-hub.service` with the checkout path, the node binary and the data directory filled in) and, once, `~/.config/trommi/hub.env` from `deploy/hub.env.example`. It creates the data directory if it is missing and says so. It does not enable lingering; it reports the state and prints `loginctl enable-linger $USER`, which is what makes the hub start at boot and survive logout. `--dry-run` changes nothing, `--uninstall` removes the unit and keeps settings and data.

Decisions built into it:

- **Data directory:** the checkout's `data/` by default, because the sessions of this checkout read the token from there. With `--data DIR` elsewhere, every session needs `BOARD_DATA=DIR` in its environment (in `.mcp.json`: `"env": {"BOARD_DATA": "…"}`), or it cannot link.
- **Node:** `/usr/bin/node` if it runs, else the `node` on `PATH`, tested in a bare environment. A mise shim fails there (it did on this machine), which is why the unit names an absolute binary.
- **Bind address:** `hub.env` sets `BOARD_HOST=127.0.0.1`. The server's own default is `0.0.0.0`, which also offers plain HTTP to the LAN. With `tailscale serve` in front nothing needs that.
- **No socket unit.** Socket activation would need the server to accept a listening socket from systemd; it calls `listen(port)` itself. The hub is cheap to keep running, so there is nothing to gain.

### Standard input

A channel process is a child of Claude Code and exits when its stdin closes. A service has no stdin (`StandardInput=null` reads end-of-file at once). The mechanism that solves this is `BOARD_HUB_ONLY=1`, which the unit sets:

- the process does not attach the MCP transport to stdin and installs no exit-on-close handlers, so `/dev/null` on stdin is fine;
- it registers no agent session for itself (`state.hub` is `null`, the sidebar shows only real sessions);
- when the port is taken it does not link as a spoke; it tries for the port again every two seconds.

Without the flag, with the same command line: the process takes the port, registers itself as an agent named after the working directory (`trommi`), reads end-of-file and exits with status 0 within a second. `Restart=on-failure` would not restart it, and each attempt leaves a dead session in the sidebar. The unit therefore refuses to start against a `server.mjs` that does not contain `BOARD_HUB_ONLY` (`ExecStartPre`). For such an old checkout the only way is the one used by hand so far, stdin held open by a pipe (`sleep infinity | node server/server.mjs`); do not build a service on that.

No server change is needed for stdin. The changes that are needed are listed under "For the server".

### Sandbox

The unit runs with `NoNewPrivileges`, `ProtectSystem=strict` and `ProtectHome=read-only` with the data directory as the only `ReadWritePaths`, `PrivateDevices`, the `Protect*` kernel options, `RestrictAddressFamilies` (inet, unix, netlink), `SystemCallFilter=@system-service`, an empty capability set and `UMask=0077`. `systemd-analyze --user security` rates it 2.0.

Two things are deliberately open. The hub copies attachments from the absolute paths agents name, so it must be able to read your home directory and the real `/tmp`: no `PrivateTmp`, no `ProtectHome=yes`. Instead `~/.ssh`, `~/.gnupg`, `~/.aws`, `~/.1password`, `~/.password-store` and `~/.config/trommi` are made inaccessible, so no attachment can be one of those. `MemoryDenyWriteExecute` is off because V8 needs writable, executable memory. In a user unit the mount options work through an implicit user namespace.

### Commands

```bash
systemctl --user start|stop|restart trommi-hub
systemctl --user status trommi-hub
journalctl --user -u trommi-hub -f           # the hub's stderr; the admin page shows the last 200 lines too
systemctl --user edit trommi-hub             # local overrides, kept across re-installs
cat data/url.txt                             # login links (contain the token)
ss -ltnp 'sport = :8790'                     # which process holds the port
```

### Moving from the hand-started hub

1. `deploy/install-user-service.sh --enable`. The service starts and waits, because the old hub holds the port.
2. End the old hub (the `sleep 86400 | BOARD_AGENT=Hub node server/server.mjs` process). Sessions lose their link and link again to whoever has the port next.
3. `journalctl --user -u trommi-hub -n 5` must show `hub on 127.0.0.1:8790 without a session of its own`. If it does not, a session took the port first: see "A session holds the port" below.
4. The old hub's own session "Hub" stays in the sidebar as away; forget it on the admin page.

## 2. Container

```bash
docker compose -f deploy/compose.yaml up -d --build
docker compose -f deploy/compose.yaml exec hub cat /data/url.txt
```

`deploy/Dockerfile` builds in two stages on `node:24-alpine` (dependencies with `npm ci --omit=dev`, then only `server/server.mjs`, `client/web` and `node_modules`), runs as the unprivileged user `node`, keeps state in the volume `/data`, and has a health check: any answer below 500 on `/` counts, because no route answers without a login. `deploy/Dockerfile.dockerignore` keeps `data/` out of the build context. `compose.yaml` adds a read-only root, no capabilities, `no-new-privileges`, and publishes the port on the host's loopback only. The image is about 270 MB, of which the node binary is 125 MB.

**What a containerised hub can do today: serve the board to browsers. What it cannot: be linked by agent sessions outside the container.** Three things stand in the way, all in `server.mjs`:

1. The hub accepts `/agent/*` only from a loopback address. A published port arrives from the bridge address, so a session on the host gets 403 (measured).
2. A spoke connects to `127.0.0.1:BOARD_PORT` and nowhere else, and reads the token from its own `BOARD_DATA/token`.
3. Attachments travel as paths: the agent names a file and the hub copies it from its own filesystem. Scribbles go the other way as a path under the hub's data directory.

For sessions on the same machine, `deploy/compose.host.yaml` works around 1 and 2 (host networking, the checkout's `data/` as a bind mount) and 3 by mounting the directories agents attach from. It needs rootful Docker or rootless Podman; with rootless Docker, which this machine runs, "host" networking is not the machine's network. On one machine the systemd service is the better choice: the container buys nothing there and loses attachments.

**Sessions on other machines** need changes to the server; none of this is implemented:

- a hub address for spokes (`BOARD_HUB_URL=https://hub.example.ts.net`) instead of loopback, and a spoke mode that never tries to take the port;
- the loopback rule on `/agent/*` replaced by a credential per agent;
- attachments, scribbles and voice-overs sent as bytes instead of paths (the upload route for assets, `/agent/asset`, already works that way);
- TLS between spoke and hub, which `tailscale serve` provides.

The security side is the reason not to do this with today's token. One shared token is both the browser login and the agent credential, so every phone that has the link could register as an agent, read what you write to it and put cards in front of you; and a hub that reaches agents on other machines can put text in front of Claude and answer its permission prompts there. The crypto concept (`docs/krypto-konzept.md`) describes the fix: its step 1 is exactly this fixed hub with every channel process as an ordinary client; step 3 replaces the token with a key pair per device and agent, enrolled by an invitation link that carries a role, and makes an agent act only on commands signed by a human's device (section 6); section 8 replaces token and cookie with a signed challenge. Until step 3, keep remote spokes, if you build them, inside the tailnet and treat every machine that holds the token as able to drive every agent.

## 3. The web client from its own origin

Why: whoever delivers the JavaScript can use the keys and read the clear text (crypto concept, section 9). Once content is encrypted end to end, a hub that also serves the client can serve a different client. A client from a fixed address of its own takes that away from the hub.

A minimal, concrete setup on this machine, with files prepared but not switched on:

```bash
TROMMI_DIR=$PWD TROMMI_HUB_ORIGIN=https://MACHINE.TAILNET.ts.net \
  caddy run --config deploy/Caddyfile.client --adapter caddyfile     # static files on 127.0.0.1:8792
deploy/tailscale-serve.sh --client 8792                              # https://MACHINE.TAILNET.ts.net:8444/
```

Caddy rather than `tailscale serve <directory>`, because the page needs two things a bare file server lacks: the application paths (`/s/…`, `/inbox`, `/agents`) must answer with `index.html`, and the client must come with a strict Content Security Policy.

What must change before a page loaded from there works:

| Where | Change |
| --- | --- |
| Client | A configured hub address in front of every request (today all are relative: `/events`, `/message`, `/files/…`). Fonts served locally and the two inline scripts in `index.html` moved into files, or the policy cannot be strict. |
| Hub: CORS | Answer `OPTIONS` preflights before the login check (today: 401). Send `Access-Control-Allow-Origin` with the one configured client origin (never `*`), `Vary: Origin`, `Access-Control-Allow-Headers: Authorization, Content-Type`. Replace the same-origin rule for POSTs (`Origin` host equals `Host`; a foreign origin gets 403 today) with a comparison against that configured origin, e.g. `BOARD_CLIENT_ORIGIN`. |
| Hub: login | The cookie does not survive the move. As a cross-origin credential it would need `SameSite=None; Secure` plus `Access-Control-Allow-Credentials`, and browsers block third-party cookies; and because cookies ignore ports, a client on another port of the same host name would be sent the hub's cookie, which defeats the separation. The concept's answer (section 8): no cookie; the device signs a challenge and gets a ten-minute token it sends in the `Authorization` header. |
| Hub: SSE | `EventSource` cannot set headers. The client reads `/events` with `fetch` and a stream reader and sends the token in `Authorization`; reconnecting is the client's job anyway. The hub keeps the endpoint and adds the CORS headers. |
| Hub: files | `/files/…` and `/canvas` need the same token; images and video load through `fetch` and blob addresses instead of plain `src`, or through short-lived signed addresses. |

Recommendation: **not now, and decide the address early.** Before device keys exist (step 3 of the concept), the hub sees all clear text anyway and a separate origin protects nothing. It is step 6 of the concept's plan. But browser keys are bound to the origin that created them, so the address the client will have must be fixed before the first device is enrolled in step 3; moving later means enrolling every browser again. Another port on the same tailnet name is enough to separate script origins once the cookie is gone. A client on a different machine or host name is the stronger form, because then a hub that is taken over cannot touch the files either.

## 4. Tailscale

```bash
deploy/tailscale-serve.sh              # prints the commands and the resulting addresses, runs nothing
deploy/tailscale-serve.sh --apply      # runs: tailscale serve --bg --https=443 http://127.0.0.1:8790
deploy/tailscale-serve.sh --off        # prints how to take it down
tailscale serve status
```

Then put the printed name into `hub.env` as `BOARD_PUBLIC_URL=https://MACHINE.TAILNET.ts.net` and restart the hub, so `data/url.txt` and the admin page show a link a phone can open. The serve configuration is kept by `tailscaled` across reboots (`--bg`). It needs MagicDNS and HTTPS certificates enabled for the tailnet.

- **Serve, not funnel.** Serve answers only devices in your tailnet. Funnel publishes the same port to the whole internet, and all that stands between the internet and "type into Claude and approve its tool use on your machine" would be one long-lived token that sits in a link, with no rate limit and no way to revoke a single device. Do not funnel this board until per-device keys exist.
- **HTTPS is what unlocks the microphone.** Browsers give `getUserMedia` (dictation) only to secure contexts: HTTPS or `localhost`. Over `http://192.168.…:8790` a phone shows no working microphone. The tailnet name has a real certificate, so the phone's browser treats it as secure. The same holds later for WebCrypto, which the crypto concept depends on.
- **A side effect to know.** Requests that come through `tailscale serve` reach the hub from `127.0.0.1`. The rule "agents only from this machine" therefore does not hold for the tailnet: any tailnet device that knows the token can call `/agent/*`. A request with a forwarding header and the token passed the check in the test. The token still guards it; the fix is under "For the server".

## 5. Backups, restore, upgrades, rotation

**What to back up:** the data directory, nothing else. `pad.db` (SQLite: sessions, messages, cards, queue and the Scratchpad), `files/` (attachments), `scribbles/`, `assets/`, `speech/`, `sessions/`, `admin-log.jsonl`, and the secrets `token`, `admin-token`, `tinfoil.key`. Plus `~/.config/trommi/hub.env` if you changed it.

```bash
deploy/backup.sh                       # ~/.local/state/trommi/backups/trommi-data-<date>.tar.gz, mode 0600
deploy/backup.sh --to /mnt/nas/trommi --keep 14
deploy/backup.sh --no-secrets          # without token, admin key and speech key
```

**The script knows SQLite (card Nr. 175) and runs while the hub runs.** The hub keeps the board in `data/pad.db` in WAL mode, with `pad.db-wal` and `pad.db-shm` beside it. A raw copy of those three files taken while the hub writes can be torn, or lack what still sits in the WAL, so the script never copies them: `deploy/sqlite-snapshot.mjs` opens the database read-only and lets SQLite write the copy (`VACUUM INTO`), which is the database as it was at one moment, WAL content included, as one file. The copy is checked with `PRAGMA integrity_check`; if the snapshot or the check fails, no archive is written. The live database is only read. It needs a node with `node:sqlite` (22.5 or newer; `BOARD_NODE` names another binary).

The order is: database first, then the files. Every attachment the snapshot refers to is in the archive; a file that arrived a moment later comes along unreferenced (the admin page lists such files as orphans).

In the archive: `pad.db` (the snapshot), `files/`, `assets/`, `pad/`, `scribbles/`, `sessions/`, `agents/`, `speech/`, `admin-log.jsonl`, the old `state.json` where it still lies there, and the secrets `token`, `admin-token`, `tinfoil.key` (mode 0600 inside the archive; the archive itself is 0600). Never in it: `url.txt` (it spells out the token and is written again at every start), logs, half-written files, `pad.db-wal`, `pad.db-shm`. **The secrets are needed for a restore that keeps every browser signed in, and they open the board to whoever reads the archive**: keep it where the data directory may be, or use `--no-secrets`. Passkeys (public keys only) are in the database.

No timer and no service are installed: it is a script to run by hand (or from a cron line of your own) until 1.0.

`state.json` is the old file: read once when the board moved, never written since, left in place as a backup of that day (the marker `state.in-sqlite` says so). A second way to a copy is the export as JSON:

```bash
node server/board-store.mjs export data data/state-export.json   # the state as JSON, hub running
node deploy/sqlite-snapshot.mjs --counts data/pad.db             # records per kind and rows per table, read-only
```

The export holds the board (cards, messages, sessions, status lines, assets, waiting events), not the Scratchpad's elements; those are only in `pad.db`. To start a hub from an export, put it in place as `state.json` in a data directory without `pad.db` and without the marker; `node server/board-store.mjs back data` does the same in place, with the hub stopped.

The script prints paths, counts (records per kind, rows per table) and sizes, never file contents and never a secret.

**Restore:**

```bash
# stop the hub (systemctl --user stop trommi-hub, or end the process that holds port 8790)
deploy/restore.sh ~/.local/state/trommi/backups/trommi-data-<date>.tar.gz --data data --replace
# start the hub again
```

`restore.sh` fills an empty or new directory; with `--replace` it first moves what is there aside as `data.before-restore-<date>` (nothing is deleted). It refuses an archive that `backup.sh` did not make, and, on Linux, a directory whose `pad.db` a process still has open. Afterwards it checks the database and prints the same counts as the backup did, to compare. The restored `pad.db` is one file; the hub makes `-wal` and `-shm` again. By hand it is the same three steps: move `data` aside, `mkdir -m 700 data`, `tar -C data -xzf <archive> --strip-components=1`.

Stop the hub first and make sure no session takes the port in between (`ss -ltnp 'sport = :8790'`), or that session writes its state over the restored one. After a restore without secrets the hub mints a new token and admin key: open the new link from `data/url.txt` in every browser. Running sessions pick the new token up from the file.

**Upgrade:**

```bash
deploy/backup.sh
git pull && npm ci --omit=dev
deploy/install-user-service.sh         # only rewrites the unit if the template changed
systemctl --user daemon-reload && systemctl --user restart trommi-hub
```

State migrations run inside the server when it loads the state (missing numbers, urgencies and the queue are filled in); there is no separate step and no way back, which is what the backup before the pull is for. With `BOARD_STORE=json`, a state file the server cannot read is put aside as `data/state.broken-<time>.json` and the hub starts empty: stop, restore, look at the journal. Sessions keep running the `server.mjs` they started with until they are restarted; the link protocol tolerates an older spoke, but restart sessions after an upgrade that changes tools. Container: `docker compose -f deploy/compose.yaml up -d --build`.

**Rotate the access token:** on `/admin.html` under Access. The hub writes a new `data/token`, every browser and app must open the new link, linked sessions adopt the new token from the file by themselves. Without the page: stop the hub, delete `data/token`, start it. If the token is pinned with `BOARD_TOKEN`, the page refuses; change the value in `hub.env` and in the environment of every session, then restart both.

**Rotate the admin key:** there is no button. Stop the hub, delete `data/admin-token`, start it, and read the new key from the file. A restart also ends every admin login. If pinned with `BOARD_ADMIN_TOKEN`, change it in `hub.env` and restart.

## 6. Troubleshooting

| Symptom | Cause and way out |
| --- | --- |
| Service is `active` but the journal shows no `hub on …` line | **Port taken.** The service waits for the port. `ss -ltnp 'sport = :8790'` names the holder. If it is not Trommi, stop it or set another `BOARD_PORT` in `hub.env` (and in every session's environment, and run `tailscale-serve.sh` again). |
| The holder is a `node …/server.mjs` that belongs to a Claude Code session | **A session holds the port** (it took over while the service was down, or was there first). The board works, with that session as hub, on the same data directory. To hand the port back, end or restart that session. With several sessions running another one may take over first, because a spoke tries again after 150 to 650 ms and the service only every 2 s; then end them one after another or all at once. This is the gap the first server change closes. |
| Board shows old state, or two boards disagree | **Stale or second hub.** A hub left over from before (`sleep … \| node server/server.mjs`, a `dev/` script) holds the port, or a hub on another port uses another data directory. Check the holder's pid and its `BOARD_DATA` (`tr '\0' '\n' < /proc/<pid>/environ \| grep BOARD_`). Never run two hubs on one data directory with different ports: both write the same `pad.db`. |
| A session never appears, its tools answer "the board did not answer" or ask to retry | **Spoke cannot link.** In order: is the hub up (`curl -s -o /dev/null -w '%{http_code}' http://127.0.0.1:8790/` gives 401)? Same `BOARD_PORT`? Same data directory, so the same `token` file? Is the hub in a container without host networking (403 for every agent call)? The session's stderr says `linked to the hub on port … as "…"` when it works. |
| Sessions get 403, browsers get "Access only through the link in data/url.txt" | **Token mismatch.** A browser holds a cookie from before a rotation: open the current link from `data/url.txt`. A session read a different token: it has another `BOARD_DATA`, or `BOARD_TOKEN` is pinned on one side only. A session re-reads `data/token` after a refusal, so a mismatch that persists is a configuration difference, not timing. |
| Service fails at once, `status=1` from `ExecStartPre` | The checkout's `server.mjs` predates `BOARD_HUB_ONLY`. Update the checkout. |
| Service fails with `226/NAMESPACE` | The sandbox could not be set up: the data directory in `ReadWritePaths` does not exist, or unprivileged user namespaces are off. Run the install script again; it creates the directory. |
| `status=203/EXEC` | The node binary in the unit is gone (a version manager removed it). Run the install script again, or pass `--node`. |
| Attachment refused with `ENOENT` or `EACCES` although the file exists | The path is one the sandbox hides (`~/.ssh` and the others), or the hub runs in a container and does not see the host's files. |
| No microphone on the phone | The page was opened over plain HTTP. Use the `https://…ts.net` link. No microphone anywhere: no speech key. |
| Hub stops when you log out | Lingering is off: `loginctl enable-linger $USER`. |

## For the server

Nothing below is implemented; `deploy/` works without it, with the gaps named above.

1. **Let the fixed hub keep the port.** In `/agent/link` the hub's hello becomes `{ hello: id, ping: PING, dedicated: HUB_ONLY }`. A spoke that received `dedicated: true` remembers it, and in `joinHub()`'s `retry` it calls `joinHub()` again instead of `start()`, so it never listens. And in `start()`, the hub-only wait becomes `setTimeout(start, 200)` instead of 2000. Measured today: after the hub stopped, a linked spoke took the port when the successor came 1 s later; the successor won only when started immediately.
2. **`GET /healthz` without login**, answering `200 {"ok":true}` and nothing else, placed before the token check. The container's health check and any monitor can then tell "serving" from "answers 401 for another reason".
3. **Do not trust loopback behind a proxy.** In `agentRoute`, refuse when the request carries `x-forwarded-for` or `tailscale-user-login`. A direct spoke never sends them; `tailscale serve` always does.
4. **Create the data subdirectories with mode 0700** (`files`, `scribbles`, `assets`, `speech`); today they are 0755 outside the service, whose umask already covers it.
5. Later, with the crypto steps: a route to rotate the admin key; the CORS and login changes of section 3; the remote-spoke changes of section 2.

## What was tested

On the author's machine, without touching the live hub on port 8790 or the repository's `data/`:

- **Unit:** rendered by the install script into a temporary HOME; `systemd-analyze --user verify` passes, `systemd-analyze --user security` rates it 2.0. The install script was run twice against the temporary HOME (second run: everything unchanged).
- **The unit's command line:** `/usr/bin/node server/server.mjs` in a bare environment with `BOARD_HUB_ONLY=1`, stdin from `/dev/null`, a temporary data directory, port 8842: stays up, answers 401 without login, 302 for the login link, 200 with the cookie, streams `/events`, ends on SIGTERM leaving a valid `state.json`. The same without the flag exits with status 0 within a second.
- **Port race** on port 8843 with a hub and one spoke, as described in "For the server".
- **Container:** image built with rootless Docker, run on port 8844 with the options from `compose.yaml`: answers, health check turns healthy, an agent call from the host gets 403, stops cleanly. Both compose files parse (`docker compose config`).
- **Backup:** in `server/test.mjs` ("backup and restore"): a hub running on a throwaway data directory is backed up, the archive holds one `pad.db` and no `-wal`/`-shm`/`url.txt`, secrets are 0600, the output names no secret and no content; restored into another directory, records per kind are those of the moment of the snapshot (what was written afterwards is not in it), attachment and asset ciphertext are byte-equal, a hub started on the restored directory serves the cards and messages and accepts the old cookie; `--no-secrets`, `--keep`, `--replace`, refusal of a foreign archive, of a non-data directory and of a directory with an open database. One real run against the live `data/` on 3 Oct 2026 (read only, archive written elsewhere): 174 MB, 1274 files, 154 cards, 1180 messages, 111 assets; restored copy had the same counts.
- **Tailscale helper:** printing only.

Not tested: the unit actually started by systemd (so the sandbox directives are checked for syntax, not for effect on a running hub); `--enable` and `--uninstall` of the install script; `compose.host.yaml`; `Caddyfile.client` (caddy is not installed); `tailscale-serve.sh --apply`; a restore into a live hub; behaviour after a reboot.
