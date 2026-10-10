# The specification

What every Trommi implementation shares.

| File | What | State |
| --- | --- | --- |
| [`v1.md`](v1.md) | **the protocol**: how Trommi uses MLS (RFC 9420) through OpenMLS, the groups and their rules, content, recovery, joining, what a hub must do and sees, limits, errors, the vectors the core must produce | normative; written before the code |
| [`v1-deviations.md`](v1-deviations.md) | the five places where plain MLS is not enough (D1 to D5), in plain words, each with the vanilla alternative, and the other decisions with their reasons | the reasons behind v1.md |
| [`hub-api.md`](hub-api.md) | the hub's routes and tables | normative |
| `vectors/*.json` | the known answers of v1.md that `trommi-core` produces with a seeded random source (v1.md section 19): `account.json`, `board.json`, `envelope.json`, `files.json`, `hub_auth.json`, `invite.json`, `recovery.json`, `trail.json` | checked by the core's tests and in every binding |
| `account-vectors.json`, `strokes.json` | known answers of the account (v1.md 8.9) and of a stroke's packed points (10.6) | valid under v1.md |
| `vectors.json` | known answers of the earlier format, before MLS | read only by the web app's old crypto test (`app/web/core/crypto/crypto-test.mjs`); goes with it |

How to read v1.md: the two trees at the top say what exists and what protects it; sections 3 to 7 are plain MLS with
Trommi's rules; a heading marked (D1) to (D5) is a construct of Trommi's own. Every numbered line is a MUST. Where
v1.md and RFC 9420 seem to disagree, the RFC is right and v1.md has a bug. The code follows the specification, not the
other way round: `trommi-core` is written against v1.md and produces `vectors/*.json`.

Labels: the protocol uses MLS's labelled functions with labels starting `Trommi` or `trommi`; the account keeps its
`trommi/v1/…` labels, which are bytes, not the protocol's version number (v1.md 8.9).
