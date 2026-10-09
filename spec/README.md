# The specification

What every Trommi implementation shares.

| File | What | State |
| --- | --- | --- |
| [`v2.md`](v2.md) | **the protocol**: how Trommi uses MLS (RFC 9420) through OpenMLS, the groups and their rules, content, recovery, joining, what a hub must do and sees, limits, errors, the vectors the core must produce | normative; written before the code |
| [`v2-deviations.md`](v2-deviations.md) | the five places where plain MLS is not enough (D1 to D5), in plain words, each with the vanilla alternative; all approved | the reasons behind v2.md |
| [`hub-api.md`](hub-api.md) | the v2 hub's routes and tables | normative |
| [`v1.md`](v1.md) | today's wire format | superseded by v2; kept until every part has moved. Its section 16 (the account) stays in force |
| `vectors.json`, `account-vectors.json`, `strokes.json` | known answers of v1 (`npm test`). `account-vectors.json` and `strokes.json` stay valid under v2 | |

How to read v2: the two trees at the top say what exists and what protects it; sections 3 to 7 are plain MLS with
Trommi's rules; a heading marked (D1) to (D5) is a construct of Trommi's own. Every numbered line is a MUST. Where
v2.md and RFC 9420 seem to disagree, the RFC is right and v2.md has a bug. The code follows the specification, not the
other way round: `trommi-core` is written against v2.md and produces `v2-vectors.json`.

Labels: v2 uses MLS's labelled functions with labels starting `Trommi` or `trommi`; the account keeps its
`trommi/v1/…` labels.
