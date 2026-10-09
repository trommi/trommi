# The specification

What every Trommi implementation shares: the bytes, and the known answers each one is checked against. The web app's
client core (`app/web/core/`) is the reference these files are written beside; the hubs, the connector and the iOS app
are built against them.

How the data hangs together (room, member log, keys, room level, sessions, objects, files) is drawn as a tree in the
repository's [README](../README.md); this folder says what the bytes are.

| File | What |
| --- | --- |
| [`FORMAT.md`](FORMAT.md) | the whole specification: primitives, encoding, labels, the member log, invites, envelopes, key epochs, session keys, the account, what a hub must refuse, what a client must keep, known limits |
| `vectors.json` | deterministic vectors of format version 1 (one room played through, Ed25519 and X25519 edge cases). Made and compared byte for byte by `node app/web/core/crypto/crypto-test.mjs` |
| `account-vectors.json` | known answers for the account: the labels, the email rule, the pinned key derivation, the sealed copies under a password, the Emergency Kit and a passkey, and what must not open. Made with `node:crypto` and compared by `node app/web/core/account-test.mjs` |
| `strokes.json` | sample Scribble Board strokes with their packed points. Checked by `node app/web/core/scribble-test.mjs` |

`npm test` at the repository root runs all three checks.

The labels in the formats (`trommi/v1/…`) are bytes that are signed and hashed: they do not change.

Not in this repository: a hub and its HTTP routes and JSON bodies (FORMAT.md, section 22). The tags R1 to R9, v1.1 and
v1.1.1 in FORMAT.md name the security rule a line implements.
