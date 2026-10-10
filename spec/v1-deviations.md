# Trommi protocol: where plain MLS is not enough

`v1.md` uses MLS (RFC 9420) as it stands for everything that has to do with who is in a group and which keys a group
shares. This file lists the few places where the standard has no mechanism for what the product needs, in plain
words, with the vanilla alternative that was weighed. The owner approved all five on 9 October 2026; their bytes and
rules are in `v1.md` under the headings marked (D1) to (D5).

The product needs that cause all of them, and that MLS deliberately does not serve:

- **N1** A newly added device, and the recovery code when every device is lost, read the whole history.
- **N2** The hub is the long-term store: it pages chats, sorts the Desk, rings devices and prunes old bodies, without
  reading content.
- **N3** An agent reads its own session and nothing else.

| | Subject | State | Specified in |
| --- | --- | --- | --- |
| D1 | Recovery code and key backup | approved 2026-10-09 | `v1.md` section 8 |
| D2 | Stored content as Trommi's own envelope | approved 2026-10-09 | section 9 |
| D3 | Files and share links | approved 2026-10-09 | section 11 |
| D4 | The six emoji when a device joins | approved 2026-10-09 | section 12.1 |
| D5 | Signing in to the hub, the wake-up push | approved 2026-10-09 | sections 12.3, 15 |

What is **not** on this list because it is done with MLS's own mechanisms: adding, removing and updating devices; the
two kinds of group; helper groups founded by an agent; handing old keys to a new device or to an agent that takes a
session over (an ordinary MLS message in the group); the live pieces of a stroke and the terminal work trail (ordinary
MLS messages); roles and the agent list (a group extension). Trommi's rules on top (who may commit what, in which
group) are policy carried in MLS's own fields, not cryptography; they are sections 4 and 5 of `v1.md`. One feature is
taken from the MLS working group's extensions draft, as OpenMLS implements it: the mark on a reusable "last resort"
key package (RFC 9420 allows the reuse, the draft defines the mark).

## D1. Recovery code and key backup (approved)

- **Need.** You lose every device and still read everything; and you sign in on a new laptop with password or passkey
  and see the whole history.
- **The vanilla way.** A "recovery device" that is a real member of every group, with keys that follow from the
  code, and that replays every group change ever made when it is needed. It works. Its price: recovery then depends on replaying years of group
  history through the library without one missing or unreadable step (one lost step loses everything after it); the
  hub may never drop a group's history; the library's random source has to be replaced to make keys from a code;
  and changing the code makes older history unrecoverable unless a sealed copy is added after all. Without any such
  thing: lose all devices, lose everything.
- **Proposed.** A recovery code (opened by password or passkey, and by the Emergency Kit words). For every
  group and key period the device that starts the period stores that period's content key at the hub, sealed for the
  recovery key with HPKE (RFC 9180, the same sealing MLS uses inside). A device that holds the code opens them all, and
  joins the room and its live sessions by MLS's own "external commit", which the others accept because it carries a
  signature of the recovery key. Each sealed row carries an authentication tag under a third key that
  follows from the code and that only your own devices hold, so that a hub cannot hand a device that signs in a room
  or a history of its own making (HPKE sealing alone is anonymous). The sealed
  copies of the code in the account keep their own fixed labels (`trommi/v1/…`).
- **Cost and risk.** One small sealed row per group and key period (about 150 bytes), each readable on its own.
  Whoever has the code reads everything: that is its purpose. Non-MLS pieces: the sealed rows with their tag, the recovery
  signature, one sealed link when the code is replaced, the account's sealed copies. The tag key lies on every one of
  your devices: after a device is stolen the code should be replaced, and the app asks for it.
- **Recommendation.** As proposed: recovery is the last line of defence and should not hang on a replay.
- **Covers:** recovery, sign-in on a new device, the account.
- **Extensions, approved 2026-10-09.** (1) The authentication tag (`recovery_mac`) on every sealed row and on the
  sealed link, with the message that hands its key to a new device (`v1.md` 7.4, 8.3, 8.5). (2) The join from
  outside under the recovery signature also for session groups, not only for the room group (8.4, 5.2.7).
- **Extension, approved 2026-10-10.** The Emergency Kit for accounts without an e-mail: the salt of the kit's keys
  is then a hash of the account id (16 bytes the hub mints) under a label of its own, everything behind it as for
  an account with an e-mail, whose bytes do not change; the id is printed on every kit (`v1.md` 8.8).

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
  Trommi's envelope: a readable header (who, which chat or card, state, urgency, push), the body
  encrypted with that content key, the device's signature, and a link to the sender's previous envelope so that gaps
  show. Built only from the suite's own parts and MLS's own labelled signing and hashing; encoded like MLS messages.
  A pruned envelope keeps header, hash and signature.
- **Cost and risk.** This is the one large piece of own cryptography. Old content stays readable for whoever has the old keys: no forward secrecy
  for history, by N1.
- **Recommendation.** As proposed. One chain for everything stored; content under exported keys.
- **Covers:** every stored content type, the hub's content tables and routes, push.

## D3. Files and share links

- **Need.** Pictures, videos and published pages up to 64 MiB; a link you can give to someone without an account.
- **The vanilla way.** MLS only knows messages. A file inside messages would be thousands of them, the hub could not
  serve a part of a video or free space, and an outsider would need the app, an account and a group of their own.
- **Proposed.** Each file is encrypted with a random key of its own, in 64 KiB pieces, and uploaded apart.
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
- **Proposed.** Both devices show six emoji computed from what they exchanged, and you compare them. The new
  device's MLS key package is part of what the emoji cover. Three short signed messages (offer, request, reveal) and a
  secret in the link.
- **Cost and risk.** A small ceremony with own messages; 36 bits, one try per invite.
- **Recommendation.** As proposed.
- **Covers:** joining by link (humans and agents). Joining by signing in (D1) does not need it.
- **Change, approved 2026-10-10.** The Offer is bound to the link. Before, the new device checked that the Offer
  it fetched named its room and invite, had not expired and was signed by the inviter the Offer itself named;
  nothing it held pinned that key. A hub could therefore serve an Offer of its own (its own inviter key and
  commitment) under the invite id it knows, sign the matching Reveal, and take the new device into a room of its
  making; the six emoji then agreed between the new device and the hub's fake inviter, and the real inviter never
  saw a Request. Now the inviter publishes a MAC over the Offer and its signature, under a key from the link's
  secret, and the new device refuses an Offer without it before it does anything else. The link also carries
  its deadline (10 minutes for a human device, 15 for an agent device), which enters every key the secret gives,
  so a copied link is of no use after the deadline plus 2 minutes, by the joining device's clock. What remains:
  within the deadline, whoever holds the whole link together with a hostile hub can still forge an Offer; the six
  emoji compared with the real inviter's screen protect there (`v1.md` 12.1, 17).

## D5. Signing in to the hub, the wake-up push

- **Need.** The hub must know which device is asking before it hands out ciphertext, and must be able to wake a phone.
- **The vanilla way.** MLS says nothing about either; any established sign-in would do, this one needs no second
  secret.
- **Proposed.** A device signs a random challenge of the hub with its device key (MLS's labelled signature)
  and gets a short-lived token. A push carries no content: a number to fetch, for the iPhone sealed under a key the
  phone gave the hub at registration.
- **Cost and risk.** Small; neither touches content keys.
- **Recommendation.** As proposed.
- **Covers:** every hub route with a token; push.

## Other decisions and why

Section numbers refer to `v1.md`.

1. Suite 0x0003: the browser runs Rust in WASM, where ChaCha20-Poly1305 is constant-time without hardware help.
2. The device id is the signature key: one value, nothing to derive or compare.
3. Roles from group state, not from the credential: one source of truth; a credential cannot lie about a role.
4. Session groups are tied to the room by `room_epoch` in the Commit's authenticated data and a public check, not
   by a PSK: agents are not in the room group and could not know one.
5. A join from outside always needs the recovery signature, in the room group and in session groups: a stolen
   device signature key alone opens no group that way. A device without the code is added by a device that is in.
6. One content key per group and epoch, straight from the exporter: no key derivation of Trommi's own.
7. No archive chain: old keys travel in an MLS message, and the recovery copy is sealed
   straight to the recovery key (D1). A copied device state therefore opens no later epoch.
8. Stroke pieces and the work trail are plain MLS messages: they need no history. A device added later does not see
   old trails.
9. Goals stay where they are today: the Desk's register, and a human-written copy in the session, because an agent
   cannot read the room.
10. An Artifact is a versioned object like a card; only a Share link expires.
11. One write route and one `envelopes` table for everything stored; the hub's index tables carry the app's names
    (`cards`, `notes`, `permission_requests`, `artifacts`, `chats`, `boards`, `registers`): app-true names and one
    uniform object (hub-api.md).
12. The register id is random per writer and name, so the hub can later keep "the last value" without learning a
    name.
13. Takeover always removes the previous agent device; an opener may add and remove helper devices in its own
    helper sessions and nothing else (owner, 9 October 2026).
14. The account keeps its own fixed construction (8.9); an account without an e-mail salts its kit with its account id (8.8.2).
15. Sealed keys carry a MAC under a key from the recovery code, and name the GroupInfo they belong to: HPKE sealing
    alone is anonymous, and a device signing in must be able to tell the real room from a hub's (amendment of D1).
16. The recovery authorisation is a detached signature over the join and the hash of its Commit: it cannot be moved
    to another Commit. A recovery ends with a new code, because the old `recovery_mac` lay on the lost devices.
17. Lost state means a new device with a new key, everywhere: a signature key alone never opens a group.
    Bad input from the hub is not lost state.
18. Removal and takeover are several Commits; staleness (5.2.8) is what holds in between, and any human device
    finishes what another began. A takeover starts in the room group so that the old agent's helper sessions freeze.
19. Object state is a rule over signed header fields (`object_ref`), so the hub and the clients agree on what is
    answered and what may be pruned. Notes are never pruned.
20. Every lifetime is ten years; the hub's 90 days decide which KeyPackage is fresh. OpenMLS checks the lifetime of
    every inherited leaf when a device joins by Welcome or from outside (both skipped, section 3), whenever an
    observer starts from a GroupInfo (never skipped) and, for an added KeyPackage, whenever its Commit is processed;
    agent leaves are not renewed by updates. Ten years keep all three out of the way.
21. No Commit is ever withdrawn (14.7): a rollback across devices is worse than the rare loss it would repair.
22. Chains are verified from number 1 through pruned envelopes; an agent's start is not left to the hub.

## Later (not normative)

- **Deletion.** The principle: what someone deletes is really gone; the content is removed, a signed marker may
  stay. The pruned envelope makes this possible without a format change. Open then: when content is removed where
  people expect undo; old board snapshots that still hold erased shapes; local copies on devices; the hub's backups;
  single Chat messages; registers keeping only their last value per writer.
- **Board limits and tiles**: a board split into fields with a snapshot each.
- **Sharing a room or one session with other people**: their devices join the room group or one session group; the
  roles of section 4 then need an owner per device. Nothing here blocks it.
- **Post-quantum**: a suite switch (ReInit) once OpenMLS ships a suite the project accepts.
- **Agent-side updates**, MLS's safe application interface (draft-ietf-mls-extensions) in place of plain labels.
