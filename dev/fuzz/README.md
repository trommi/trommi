# fuzz: randomised tests for the Trommi hub and clients

Model-based fuzzing of the real thing: the thin hub (`hub/server.mjs`, own port, throwaway data dir, in the same
process) and real `shared/` clients (human devices, agents) with the real crypto library. Nothing is mocked
except the network, which is fetch with injected faults. Never touches `127.0.0.1:8790` or `data/`.

```sh
node dev/fuzz/run.mjs --quick                                   # CI: < 60 s, exits 1 on a failure
node dev/fuzz/run.mjs --workers 20 --minutes 120 --seed night1  # hard run, one hub per seed, shrinks every new failure
node dev/fuzz/run.mjs --hub https://hub.trommi.com --workers 2 --minutes 60   # against the deployed hub
node dev/fuzz/model.mjs --seed 7 --steps 200 --mode strict --trace            # one seed, readable
node dev/fuzz/model.mjs --replay dev/fuzz/failures/<file>.json                     # replay a saved (shrunk) failure
```

Options: `--mode strict|chaos|hostile` (default: rotate), `--root DIR` (code under test; use a pinned clone,
`git -C DIR pull` between runs), `--steps N`, `--noshrink`, `--lead FILE` (also append findings there).

## Design

| Part | File | What |
| --- | --- | --- |
| generator | `lib/actions.mjs` `Gen` | action list as a pure function of the seed (never looks at outcomes): found, invite human/agent (right code, wrong code, stolen link), remove, recover, cards (create, revise, withdraw, close, merge), answer/read/shred/trust/decide again/stale answer, messages (hand back, explain, present), permission request and verdict, registers (human and agent), notes, canvas (strokes, erase, move, send away, snapshot), attachments (up to 256 KiB, chunked, Range), crash (also mid-send) and restart, duplicate posts, network faults (delay, lost response, offline), dropped streams, hub restart, retention prune, forgeries |
| executor | `lib/actions.mjs` `Runner` | real client calls; every accepted action also feeds the oracle; a name that no longer resolves makes the action a skip (so shrinking can drop any subset) |
| world | `lib/world.mjs` | hub (local or `--hub URL`), rooms, devices with fenced storage (a crashed process writes nothing), fault-injecting fetch (seeded per device), `quiesce()` |
| oracle | `lib/oracle.mjs` | independent plain model of what every member should see, written from the README rules, not from the reducer |
| checks | `lib/check.mjs` | oracle equality (strict), convergence of all human devices and of agents on their own objects, timeline contents (loaded through the real paging), removed devices hold nothing newer than the cut, forged/foreign content shown nowhere, commands executed once, hub: no 5xx, derived tables (`objects`, `timelines`) rebuild identically, **no plaintext marker anywhere in the hub's data dir** |
| forgeries | `lib/forge.mjs` | malicious members with valid signatures: foreign object versions, foreign closes, foreign registers, wrong timelines, answers addressed wrong, agent writes human keys/desks, bit-flipped / garbage / BOM / oversize / stolen envelopes |
| malicious hub | `lib/adversary.mjs` | man in the middle per device: withhold, reorder, replay, fork (two devices see different histories), bit flips, stale member list; always: the hub's void flag dropped (a refused answer then counts from its header: the accepted H2, its cards alone are left out of the end comparison and the run reports it as known). Checks safety (nothing shown or executed that members did not send: a card never stands at a higher version than its owner has `object_version` envelopes in the hub's own database; member list never rolls back, tampering raises an alert) and then whether clients recover once the hub is honest again |
| shrinker | `lib/shrink.mjs` | ddmin over the action list; failure signature = kind + normalised message |
| runner | `run.mjs`, `worker.mjs` | worker threads, rotating seeds; worker 0 first replays the hand-kept traces in `regress/` (each was a finding once, in the product or in the harness; a failing one is a failure `regress/<name>: ...`), new failures shrunk and written to `failures/<seed>.json`, `FINDINGS.md`, `failures/known.md`; hung workers are terminated and reported |

Modes: **strict** = one action at a time, quiesce after each, exact oracle comparison. **chaos** = rounds of
concurrent actions from many devices, convergence and safety checks. **hostile** = strict actions through a malicious hub.

`regress/*.json` are short fixed traces (`{ seed, mode, about, actions }`; the seed picks the attack of a hostile one), replayed
at the start of every local run, also `--quick`: what random seeds of quick size hardly ever reach is met there every time.
`{ "t": "wait", "ms": N }` exists for them alone (the generator never writes it): hostile mode does not quiesce, and a stream's
reconnect or an owner's re-send needs its moment. An agent's wait for a re-key after a removal (`Client.rekey_wait_ms`, a
minute by default) is 3 s in the fuzz world.

`failures/known.md` lists behaviours the harness already knows and keeps running through (each is also in
`FINDINGS.md` with its status); a `known` entry is reported once per run, not as a failure.

## Remote mode

`--hub https://hub.trommi.com` runs the same clients against the deployed hub in throwaway rooms (device name
register `FZ ...`; the hub never sees names). The hub allows 10 rooms per address and hour: the runner keeps a ledger
(`dev/fuzz/remote-rooms.jsonl`, one line per room) and stays below 6 per hour. Local-only actions (hub restart, prune,
recover) and the local-only checks (derived tables, plaintext scan) are skipped. A health poller records `/healthz`
latency and errors as findings. Malicious-hub mode is local only. The hub has no delete route for rooms, so the rooms of
a remote run are listed in `dev/fuzz/remote-rooms.jsonl` for later cleanup (see the end of this file).

## Throughput

Measured on this PC (24 cores), 20 to 22 worker threads, current main, strict + chaos + hostile mixed:

| | |
| --- | --- |
| actions | about 300 to 520 per second in total (one action = one real client call incl. its checks) |
| envelopes accepted by the hub | 140 to 230 per second (envelope counts exclude hub restarts' lost databases) |
| HTTP requests | 1,000 to 10,000 per second (SSE streams, catch-ups, fault retries) |
| night total (local, this harness version family) | about 3.1 million actions, 17,000 seeds, 1.56 million envelopes, 121 million HTTP requests in 4.5 hours of wall time over all rounds |
| quick mode | 30 to 40 seconds, 8 workers, about 40 seeds |

Keep `node dev/fuzz/run.mjs --quick` in CI: it exits 1 on a failure that is not matched by a pattern in `dev/fuzz/known-open.json`
(currently empty; known behaviours are tracked as `known`, see FINDINGS.md). Pin the code under test with `dev/fuzz/sync-target.sh`
and `--root`.

## Rooms created on hub.trommi.com by `--hub` runs (no delete route exists; for later cleanup)

- 3f8a8af2868f3ba44df9d5bd22a835be7f9c89022d64745e7ec2bb141186e453
- f87160f394d64bf5045a887e36712cb73bbf49b54a59cbb083919db074c7518a
- 850b00156a5a055489ea8c746e68bc1c97a53b4f354c539dba52666293686890
- 6466d3d6a3a61a885d18bb453fb64c569e1692cca3e0321a30a88a44982bbdf0
- 1ad5581fa96b4c1725c485ccfb8a6fa0ffddade10204db85a8a49a35659ce567
- 650f7a59c3a25602302bcb8c65f5261a79c185e4c0aa199f8d9ff9acc2f1b937
- 242acbb8499a471af633eebfabb98c6b64c616804368060f3570ab71c3b7eee9
- cf0e88f687fb4a493c7600ef94432ece646cf53cf028f9a2d7ae1feadbbe76bd
- d2747e6eb75d9a7ed5662cb5abd32080910cb72b4927ce6666d8473f7dd08615
- 782683aafac4f8385b53da14f75d96dc8c57e9ef716906e22c2dbebeda001e3a
- 76261143bf2f55240b262f90c28dfba7cdcc81d99907bd07774f894568f11678
- aaeb3bf50771b0c6fba5961e0073cbe4543c51172dbdeed2f64fe16d38983bc5


