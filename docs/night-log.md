# Night log, 4 October 2026: hub + app + crypto

Running log of the night build (brief: thin hub on hub.trommi.com, static E2E app on app.trommi.com, agents as E2E members).

## Shipped

- 01:35–02:40 Protocol v1 → v1.1 in README (commits 39160d0 … 811725e): objects/timelines/registers/projections, seven kinds, timeline_kind+timeline_id, no plaintext names, derived tables, then the security rules R1–R9 from the two reviews (Claude, Codex). Info cards Nr. 214 (reviews) and 215 (research) on the PC board.
- Streams running: A hub+crypto+deploy, B client core (`client/core/`, API in its README, b15ab91), C app (trommi/trommi), D agent channel, E verifier "Superkind", G admin (Tailscale login + password).

- Protocol v1 drafted in `README.md` ("Hub v1: the wire protocol"), awaiting two independent security reviews before freezing.

## Open issues / requests for the morning

- Owner: confirm "rotation on agent join" (assumed yes, R6).
- Admin auth confirmed by the owner (Tailscale login + extra password); stream G was blocked once by the permission classifier before that confirmation.

## Numbers
