# fuzz: randomised tests for the Trommi hub and clients

Model-based fuzzing of the real thing: the thin hub (`hub/server.mjs`, own port, throwaway data dir, in the same
process) and real `client/core` clients (human devices, agents) with the real crypto library. Nothing is mocked
except the network, which is fetch with injected faults. Never touches `127.0.0.1:8790` or `data/`.

```sh
node fuzz/run.mjs --quick                                   # CI: < 60 s, exits 1 on a failure
node fuzz/run.mjs --workers 20 --minutes 120 --seed night1  # hard run, one hub per seed, shrinks every new failure
node fuzz/run.mjs --hub https://hub.trommi.com --workers 2 --minutes 60   # against the deployed hub
node fuzz/model.mjs --seed 7 --steps 200 --mode strict --trace            # one seed, readable
node fuzz/model.mjs --replay fuzz/failures/<file>.json                     # replay a saved (shrunk) failure
```

Options: `--mode strict|chaos|hostile` (default: rotate), `--root DIR` (code under test; use a pinned clone,
`git -C DIR pull` between runs), `--steps N`, `--noshrink`, `--lead FILE` (also append findings there).

## Design

| Part | File | What |
| --- | --- | --- |
| generator | `lib/actions.mjs` `Gen` | action list as a pure function of the seed (never looks at outcomes): found, invite human/agent (right code, wrong code, stolen link), remove, recover, cards (create, revise, withdraw, close, merge), answer/read/shred/trust/decide again/stale answer, messages (hand back, explain, present), permission request and verdict, registers (human and agent), memos, canvas (strokes, erase, move, send away, snapshot), attachments (up to 256 KiB, chunked, Range), crash (also mid-send) and restart, duplicate posts, network faults (delay, lost response, offline), dropped streams, hub restart, retention prune, forgeries |
| executor | `lib/actions.mjs` `Runner` | real client calls; every accepted action also feeds the oracle; a name that no longer resolves makes the action a skip (so shrinking can drop any subset) |
| world | `lib/world.mjs` | hub (local or `--hub URL`), rooms, devices with fenced storage (a crashed process writes nothing), fault-injecting fetch (seeded per device), `quiesce()` |
| oracle | `lib/oracle.mjs` | independent plain model of what every member should see, written from the README rules, not from the reducer |
| checks | `lib/check.mjs` | oracle equality (strict), convergence of all human devices and of agents on their own objects, timeline contents (loaded through the real paging), removed devices hold nothing newer than the cut, forged/foreign content shown nowhere, commands executed once, hub: no 5xx, derived tables (`objects`, `timelines`) rebuild identically, **no plaintext marker anywhere in the hub's data dir** |
| forgeries | `lib/forge.mjs` | malicious members with valid signatures: foreign object versions, foreign closes, foreign registers, wrong timelines, answers addressed wrong, agent writes human keys/desks, bit-flipped / garbage / BOM / oversize / stolen envelopes |
| malicious hub | `lib/adversary.mjs` | man in the middle per device: withhold, reorder, replay, fork (two devices see different histories), bit flips, stale member list. Checks safety (nothing shown or executed that members did not send, member list never rolls back, tampering raises an alert) and then whether clients recover once the hub is honest again |
| shrinker | `lib/shrink.mjs` | ddmin over the action list; failure signature = kind + normalised message |
| runner | `run.mjs`, `worker.mjs` | worker threads, rotating seeds, new failures shrunk and written to `failures/<seed>.json`, `FINDINGS.md`, `failures/known.md`; hung workers are terminated and reported |

Modes: **strict** = one action at a time, quiesce after each, exact oracle comparison. **chaos** = rounds of
concurrent actions from many devices, convergence and safety checks. **hostile** = strict actions through a malicious hub.

`failures/known.md` lists behaviours the harness already knows and keeps running through (each is also in
`FINDINGS.md` with its status); a `known` entry is reported once per run, not as a failure.

## Remote mode

`--hub https://hub.trommi.com` runs the same clients against the deployed hub in throwaway rooms (device name
register `FZ ...`; the hub never sees names). The hub allows 10 rooms per address and hour: the runner keeps a ledger
(`fuzz/remote-rooms.jsonl`, one line per room) and stays below 6 per hour. Local-only actions (hub restart, prune,
recover) and the local-only checks (derived tables, plaintext scan) are skipped. A health poller records `/healthz`
latency and errors as findings. Malicious-hub mode is local only. The hub has no delete route for rooms, so the rooms of
a remote run are listed in `fuzz/remote-rooms.jsonl` for later cleanup (see the end of this file).

## Throughput

(filled in at the end of the night, see below)
