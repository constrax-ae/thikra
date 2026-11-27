# Brief for the independent security reviewer: Tamtim end-to-end encryption

Status: **not audited.** Everything here was written with an AI assistant and checked by tests and by AI reviews only. The MLS library `ts-mls` states it has not had a formal audit. Switched off by default (`THIKRA_E2EE`).

## What Tamtim is
A family chat app (Hono + SQLite server, React web app). Option B: private chats and ordinary groups are end-to-end encrypted; **family circles are not** (the server reads them on purpose, for memory features).

## Scope: please review
1. `core/e2ee.ts` (~260 lines): thin wrapper over `ts-mls` 1.6.4 (MLS RFC 9420, ciphersuite 1: X25519, AES-128-GCM, SHA-256, Ed25519), device identity, key packages, groups, safety number, device endorsements.
2. `web/src/e2ee/engine.ts` (~1200 lines): where the trust decisions are: directory checks, who may join a chat (`audit`, `mustWaitFor`, `vouched`), commits, reading oldest first, hand-over of history (`link.ts`, `qr.ts`), recovery backup (`backup.ts`), storage (`kv.ts`, sealed with a non-extractable WebCrypto key).
3. Server: `server/routes/keys.ts` (key directory, devices, endorsement, hand-over parts, backup), `server/routes/e2ee.ts` (commits, welcomes, messages, minimum epoch), `server/lib/e2ee.ts`, and every path that must NOT read text of an encrypted chat (`insertMessage` is the backstop).
4. The library at the pinned version, and how it is used (validateCredential/authService, key retention settings in `configFor`).

## Threat model
- **Server (and its operators/backups) is untrusted for content.** It sees: who talks to whom, when, sizes, kind marker, key epoch, members, mentioned user ids, group name/photo/system notices, which chats are encrypted. It must never see text, files, names, cards, reactions, votes.
- A hostile server may list fake devices, swap keys, withhold or reorder commits, relabel senders.
- A malicious group member may post commits (add/remove devices) and try to bring a device in for everyone.
- A stolen or lost device; a stale backup restored; two browser tabs.
- Out of scope: a compromised browser/page (XSS), malware on the device, the family circle (plain by design), push providers' metadata.

## Design of trust (the part most worth attacking)
Document: `docs/superpowers/specs/2026-11-19-encryption-plan.md` (decision, hardening step, gaps step with the table of what is automatic, asked, and never silent). Short version: a person's first device in a chat is trusted on first sight; a later device is added without asking only if a device of that person that we already trust signed for it; otherwise it is asked, and a device that another member added by hand is marked unconfirmed and this device stops sending in that chat until its person decides. The safety number is made from the MLS group's own member keys.

## Red-team step (2026-11-19, branch `feat/e2ee-redteam`): read `docs/RED-TEAM-REPORT.md` first
A second Claude session (not independent) attacked the encryption with 41 automated attacks (`server/e2ee-attacks.test.ts`, `web/e2ee-attacks.test.ts`) and fixed twelve weaknesses, among them: the server now reads the plain MLS header of every posted message, commit and welcome and refuses anything that is not what it claims to be (`server/lib/e2ee.ts headerProblem`, `core/e2ee.ts describeMessage`, `checkKeyPackage`); a removed member's open socket is dropped (`live.evict`); a device remembers which chats are encrypted so a hostile server cannot make the app send readable text (`web/src/e2ee/known.ts`); another member's payload is bounded and rebuilt (`web/src/e2ee/payload.ts`); deleted messages leave no copy on devices; the short device code is 12 digits. Please look hardest at what stays open there: a hostile member stalling or kicking others with a valid-looking commit (O1), first-sight trust and a never-seen chat's "encrypted" flag (O2, O10), a server hiding newest messages or colluding with a removed member (O3), stale-backup nonce reuse (O6).

## Known open (not hidden)
First-sight trust (a fake first device; also a new device's first sight of its own person's devices at join); the authenticated sender leaf is not available from ts-mls (the sender check relies on the payload's `from` plus the server's user id); a commit's content is not validated by the server; delete/expiry leaves some local copies; stale backup may reuse ratchet state; sealed store falls back silently without WebCrypto key; a hostile member can pause a chat; the 8-digit short device code; hand-over not resumable; details in the plan's "Still open" lists.

## Library and audit status
`ts-mls` 1.6.4, MIT, one main author, TypeScript only; README: "has not undergone a formal security audit". Primitives: noble curves, WebCrypto, `@hpke/core`. We did not re-run its upstream MLS test vectors (a CI job for that is planned). Fallback if it is rejected: swap the library inside `core/e2ee.ts` (the server only moves opaque bytes).

## How to run it
```bash
pnpm install
pnpm typecheck
pnpm test                                    # all; encryption: server/e2ee.test.ts, web/e2ee.test.ts, core/e2ee.test.ts (real MLS, no mocks)
node --import tsx --test web/e2ee.test.ts    # engine against the real server in-process
pnpm build
THIKRA_DB=/tmp/review.db THIKRA_E2EE=1 THIKRA_BACKUP=0 PORT=8791 pnpm start   # app with the flag on; sign in with any phone (the dev code is returned by /api/auth/request)
```
Use different hostnames (localhost, 127.0.0.1, name.localhost) to run several people in one browser. Please report with a failing test where you can.
