# Trommi v2: where plain MLS is not enough

`v2.md` uses MLS (RFC 9420) as it stands for everything that has to do with who is in a group and which keys a group
shares. This file lists the few places where the standard has no mechanism for what the product needs, in plain
words, with the vanilla alternative that was weighed. The owner approved all five on 9 October 2026; their bytes and
rules are in `v2.md` under the headings marked (D1) to (D5).

The product needs that cause all of them, and that MLS deliberately does not serve:

- **N1** A newly added device, and the recovery code when every device is lost, read the whole history.
- **N2** The hub is the long-term store: it pages chats, sorts the Desk, rings devices and prunes old bodies, without
  reading content.
- **N3** An agent reads its own session and nothing else.

| | Subject | State | Specified in |
| --- | --- | --- | --- |
| D1 | Recovery code and key backup | approved 2026-10-09 | `v2.md` section 8 |
| D2 | Stored content as Trommi's own envelope | approved 2026-10-09 | section 9 |
| D3 | Files and share links | approved 2026-10-09 | section 11 |
| D4 | The six emoji when a device joins | approved 2026-10-09 | section 12.1 |
| D5 | Signing in to the hub, the wake-up push | approved 2026-10-09 | sections 12.3, 15 |

What is **not** on this list because it is done with MLS's own mechanisms: adding, removing and updating devices; the
two kinds of group; helper groups founded by an agent; handing old keys to a new device or to an agent that takes a
session over (an ordinary MLS message in the group); the live pieces of a stroke and the terminal work trail (ordinary
MLS messages); roles and the agent list (a group extension). Trommi's rules on top (who may commit what, in which
group) are policy carried in MLS's own fields, not cryptography; they are sections 4 and 5 of `v2.md`. One feature is
taken from the MLS working group's extensions draft, as OpenMLS implements it: the mark on a reusable "last resort"
key package (RFC 9420 allows the reuse, the draft defines the mark).

## D1. Recovery code and key backup (approved)

- **Need.** You lose every device and still read everything; and you sign in on a new laptop with password or passkey
  and see the whole history.
- **The vanilla way.** A "recovery device" that is a real member of every group, with keys that follow from the
  code, and that replays every group change ever made when it is needed. The proof built it and it works (202 room
  and 20 session changes replayed in about 50 ms). Its price: recovery then depends on replaying years of group
  history through the library without one missing or unreadable step (one lost step loses everything after it); the
  hub may never drop a group's history; the library's random source has to be replaced to make keys from a code;
  and changing the code makes older history unrecoverable unless a sealed copy is added after all. Without any such
  thing: lose all devices, lose everything.
- **Proposed.** As today: a recovery code (opened by password or passkey, and by the Emergency Kit words). For every
  group and key period the device that starts the period stores that period's content key at the hub, sealed for the
  recovery key with HPKE (RFC 9180, the same sealing MLS uses inside). A device that holds the code opens them all, and
  joins the room and its live sessions by MLS's own "external commit", which the others accept because it carries a
  signature of the recovery key. Each sealed row carries an authentication tag under a third key that
  follows from the code and that only your own devices hold, so that a hub cannot hand a device that signs in a room
  or a history of its own making (added 9 October after the proof; HPKE sealing alone is anonymous). The sealed
  copies of the code in the account stay as in v1 (its labels already read `trommi/v1/…`).
- **Cost and risk.** One small sealed row per group and key period (about 150 bytes), each readable on its own.
  Whoever has the code reads everything: that is its purpose. Non-MLS pieces: the sealed rows with their tag, the recovery
  signature, one sealed link when the code is replaced, the account's sealed copies. The tag key lies on every one of
  your devices: after a device is stolen the code should be replaced, and the app asks for it.
- **Recommendation.** As proposed: recovery is the last line of defence and should not hang on a replay.
- **Covers:** recovery, sign-in on a new device, the account.

## D2. Stored content as Trommi's own envelope

- **Need.** A chat message, a card, a note, a stroke lies at the hub for years. Any of your devices, also one added
  later, reads it at any time and again after a reload; the hub sorts the Desk by urgency, pages a chat and removes a
  closed card's text after 30 days; nobody can drop or reorder something unnoticed.
- **The vanilla way.** Send content as MLS application messages. MLS then uses a fresh key for every message and throws
  it away after reading, on purpose, so that old messages cannot be read later. For the product this means: the hub is
  only a mailbox; history lives on each device (a browser that clears its storage loses it); a new device gets history
  only if an old device copies all of it over; recovery restores a backup file, as fresh as the last backup; the
  iPhone's notification extension and a second browser tab cannot read a message the app already read. The hub can
  still sort by cleartext labels beside the message, but it cannot prove who wrote one, and a pruned message leaves no
  proof that it existed. A fair summary: it is a different product (local-first), and the web app is the weak spot.
- **Proposed.** MLS hands out one content key per group and key period through its standard exporter. Content is
  Trommi's envelope, as today but smaller: a readable header (who, which chat or card, state, urgency, push), the body
  encrypted with that content key, the device's signature, and a link to the sender's previous envelope so that gaps
  show. Built only from the suite's own parts and MLS's own labelled signing and hashing; encoded like MLS messages.
  A pruned envelope keeps header, hash and signature.
- **Cost and risk.** This is the one large piece of own cryptography that stays (about what today's envelope is, minus
  member-log fields and the `seen` list). Old content stays readable for whoever has the old keys: no forward secrecy
  for history, by N1.
- **Recommendation.** As proposed. It is what was agreed on 9 October (one chain for everything stored; content under
  exported keys).
- **Covers:** every stored content type, the hub's content tables and routes, push.

## D3. Files and share links

- **Need.** Pictures, videos and published pages up to 64 MiB; a link you can give to someone without an account.
- **The vanilla way.** MLS only knows messages. A file inside messages would be thousands of them, the hub could not
  serve a part of a video or free space, and an outsider would need the app, an account and a group of their own.
- **Proposed.** As today: each file is encrypted with a random key of its own, in 64 KiB pieces, and uploaded apart.
  The file's key travels inside the encrypted body of the message, card or Artifact that shows it. A share link is a
  plain link: the hub knows a share id and an expiry; the file's key is the part after the `#`, which a browser never
  sends to a server.
- **Cost and risk.** One small, conventional construction (chunked AEAD). Whoever has the whole link can fetch that one
  file until it expires or is revoked; what was fetched stays readable.
- **Recommendation.** As proposed.
- **Covers:** attachments, Artifacts, board pictures and snapshots, share links.

## D4. The six emoji when a device joins

- **Need.** When you add a device or an agent by link, a hostile hub must not be able to slip its own device in.
- **The vanilla way.** MLS leaves "is this key really that device" to the application, by design (its "authentication
  service"). Without a check, the hub is trusted with it; with certificates, whoever issues them is: both are a
  trust decision, not a technical gap.
- **Proposed.** As today: both devices show six emoji computed from what they exchanged, and you compare them. The new
  device's MLS key package is part of what the emoji cover. Three short signed messages (offer, request, reveal) and a
  secret in the link, unchanged in shape.
- **Cost and risk.** A small ceremony with own messages; 36 bits, one try per invite.
- **Recommendation.** As proposed.
- **Covers:** joining by link (humans and agents). Joining by signing in (D1) does not need it.

## D5. Signing in to the hub, the wake-up push

- **Need.** The hub must know which device is asking before it hands out ciphertext, and must be able to wake a phone.
- **The vanilla way.** MLS says nothing about either; any established sign-in would do, this one needs no second
  secret.
- **Proposed.** As today: a device signs a random challenge of the hub with its device key (MLS's labelled signature)
  and gets a short-lived token. A push carries no content: a number to fetch, for the iPhone sealed under a key the
  phone gave the hub at registration.
- **Cost and risk.** Small; neither touches content keys.
- **Recommendation.** As proposed.
- **Covers:** every hub route with a token; push.
