# Thekra (ذكرى) — Developer Handover

> **ملخّص بالعربية:** هذا الملف للمطوّر الذي سيكمل المشروع. فيه ما هو التطبيق، كيف يعمل، كيف يُشغَّل ويُختبَر ويُنشَر، القرارات التي اتخذها المالك، وقائمة صريحة بما هو **غير مكتمل** مرتبة بالأولوية. باقي الوثائق في `docs/` بالعربية في معظمها وهي المرجع التفصيلي؛ هذا الملف هو المدخل إليها.
>
> State of the code: commit `871ce61` on `main` (GitHub `naser-blip/thikra`, private), also what is live at `https://thikra-naser1966.replit.app` (Replit Reserved VM). 277 automated tests pass on both SQLite backends. Last updated 2026-10-22.

---

## 1. What this is

A **private family-messaging app** whose differentiator is memory, not chat: the conversation is the interface, the family archive is the product.

- Messaging: family "circles", plain groups, direct chats; text, voice, photos, video, files; reactions, replies, edits, delete rules, read receipts, search (Arabic-aware), pins, stars, mute/archive.
- **The agent** (`core/agent.ts`, deterministic, no LLM): reads *new* messages in a circle (only if the circle turned it on) and documents important family events (births, weddings, graduations…) into a searchable archive, with strict sensitivity rules.
- **Sealed messages**: a letter (text/voice/video) that opens on a date, at an event, or after the author's death (the agent concludes it from circle messages; waiting period; can be stopped).
- **Family story / yearly book**, WhatsApp history import (read on the device, only ticked items uploaded), WhatsApp album import (zip read client-side), data export.
- **Admin panel** for ONE operator + an **operations agent** (see §6).
- **Storage plans + Stripe subscriptions** (test mode, see §10).
- **21 languages**, follows the device language like WhatsApp (see §7).

Product rules the owner insists on (do not break them): honest labelling (never claim something that is not built), privacy first (admins and the ops agent never read family message content), Arabic + English as the first-class languages with proper RTL, nothing is published/deployed unless the owner says so.

## 2. Stack and layout

| Layer | Tech |
|---|---|
| Server | Node ≥ 20, TypeScript run by `tsx` (no build step), **Hono** + `@hono/node-server`, `ws` (WebSocket) |
| DB | **SQLite** (`node:sqlite` on Node ≥ 22.13, automatic fallback to `node-sqlite3-wasm` on Replit's Node 20); versioned migrations |
| Web | React 19, Vite 8, Tailwind v4, PWA (service worker in `web/public/sw.js`) |
| Mobile | Expo / React Native, early skeleton in `mobile/` (independent of the pnpm workspace) |
| Package manager | pnpm |
| Tests | `node --test` (+ `tsx`), no extra framework |

```
core/        Pure logic with no I/O: agent, sealed rules, WhatsApp parser/importer, album, phone, timeline
server/
  index.ts          composition only (re-exports names tests use)
  app.ts            Hono app, security headers, env (PROD, ADMIN_PHONES…)
  db.ts             SQLite wrapper (one()/all()/run()/tx()), migration runner
  migrations/       0001 baseline (never edit) … 0019 payments. New change = new file
  routes/           one file per area, each registers its routes (order matters: auth middleware first)
  lib/              business logic per area; RULE: lib never imports routes (test enforces it)
  live.ts, ws.ts    WebSocket rooms, presence, cross-node bus seam
  state.ts          ports: RateLimiter, KeyValue(TTL), Bus (in-memory impls now; Redis later)
  storage.ts        BlobStore seam (local disk / Replit App Storage)
  backup.ts, offsite*.ts, pending-restore.ts   backups, off-server snapshots, staged restore
  sms.ts, push.ts   SMS providers (console, twilio), web-push
  routes.snapshot.json   expected route list (a test fails if routes change; refresh: UPDATE_ROUTES=1 pnpm test)
web/src/     Login, ChatList, CircleView, Memory, Sealed, Album, Import, You, Admin, Notices, i18n.tsx, lang/*.json
docs/        All documentation (mostly Arabic). openapi.json is generated: pnpm openapi
scripts/     backup, demo-seed, openapi, scale-test (100k users seed)
bench/       latency benchmark
```

## 3. Run, test, build

```bash
pnpm install
pnpm dev:server          # tsx watch, http://localhost:8787
pnpm dev:web             # vite on 5173, proxies /api to 8787
pnpm build               # web -> dist/ (served by the server)
pnpm start               # production-like: server + built web
pnpm typecheck           # tsc --noEmit
pnpm test                # 277 tests
THIKRA_SQLITE=wasm pnpm test   # the same suite on the WASM SQLite (must pass too)
pnpm openapi             # regenerate docs/openapi.json (a test checks it is current)
pnpm demo                # fake data + fake numbers for a demo
pnpm tsx scripts/scale-test.ts 100000   # admin screen behaviour with 100k users, ~2M messages
```

Rules the tests enforce (read them before changing things):
- route list snapshot; every mutating `/api/admin/*` route must write an **audit row** (fixtures in `server/admin.test.ts`, must be self-contained and run alphabetically); every admin list route must have a `LIMIT`; `lib` never imports `routes`; `docs/openapi.json` current; contrast tests for the web colours; language packs valid (see §7).
- CI: `.github/workflows/ci.yml` runs on Node 20 and 24, plus a `security` job (`pnpm audit --prod --audit-level high` and a gitleaks secret scan over the whole history). The security job is **in the workflow now**; pushing a change to `.github/workflows/` needs a token with the `workflow` scope.

Local dev: with `THIKRA_SMS_PROVIDER=console` (default) the sign-in code is printed in the server log and shown in the UI **outside production only**.

## 4. Key architecture facts

- **Auth:** phone + OTP; sessions are an HttpOnly cookie (`thikra_session`, token stored hashed). Optional 6-digit PIN (two-step), optional TOTP for admins. `requireAuth` also enforces maintenance mode (503) and frozen families (423). Suspended users are rejected in HTTP and WebSocket.
- **Admin auth:** `requireAdmin(permission, {stepUp})`. Roles: owner / moderator / support (permission matrix in `server/lib/admin.ts`). In production an admin needs the PIN enabled (`admin_requires_pin`). Optional step-up TOTP (`THIKRA_ADMIN_REQUIRE_TOTP=1`), optional IP allow-list.
- **Append-only audit log** (`admin_audit`, SQL triggers abort UPDATE/DELETE). Sensitive reads are audited too.
- **Live delivery:** WebSocket gateway, sequence numbers per circle, idempotent sends (`client_msg_id`), resync after reconnect. Bench: ~31 ms delivery on one box.
- **Scale seams:** migrations, `state.ts` ports, `createLive(bus)`, `BlobStore`, `region` columns (stored, unused). Single process today. Daily/rolling stats are **rollups** (`daily_stats`, `circle_usage`, totals in `settings`): small DBs compute inline, big DBs serve stored values and refresh in chunks (`THIKRA_ROLLUP_*`).
- **Jobs:** `trackJob` registry + `ops_errors` log; schedulers for briefs (09:00/20:00 Gulf), quota alerts, broadcasts (resumable cursor), rollups, backups, off-server snapshots. All visible in the admin "Operations" tab.
- **Backups:** nightly local backup (keeps 7), `pnpm backup*`, off-server snapshot to Replit App Storage (or `dir:`), automatic restore at boot if local disk is older, **staged restore** from admin applied at next boot (old DB kept with its WAL).
- **System notices in chats** ("X joined the circle") are stored as a code `sys:{"k":"joined","a":{…}}` and rendered per reader by `systemText()` in `web/src/i18n.tsx`. Older notices stored as Arabic text still display as they were.
- **Server-written texts per language:** `server/lib/texts.ts` (push: new message / family space / support reply) and `server/sms.ts` (OTP). Unknown language → English (Arabic only when nothing is known).
- **Untrusted text to the model:** the ops agent labels people-written text as `untrusted_text_inside` and its system prompt (rule 8) says it is data, never instructions.

## 5. Configuration (environment)

Set as Replit Secrets (or env). **Owner rule: the owner enters every API key/secret himself and never pastes it in chat.**

Minimum for production: `NODE_ENV=production`, `THIKRA_ADMIN_PHONES` (admins by phone), a **real SMS provider** (`THIKRA_SMS_PROVIDER=twilio` + `TWILIO_ACCOUNT_SID`, `TWILIO_AUTH_TOKEN`, `TWILIO_FROM` or `TWILIO_MESSAGING_SERVICE_SID`), `THIKRA_SMS_ALLOWED_CODES` (e.g. `966,971,962`), `THIKRA_SMS_DAILY_CAP`, `THIKRA_TRUST_PROXY=1` behind a proxy, `THIKRA_DB`, `THIKRA_BLOBS`, `THIKRA_BACKUPS`.

| Variable | Purpose |
|---|---|
| `PORT` (8787), `THIKRA_LOG`, `THIKRA_FRAME_ANCESTORS`, `THIKRA_PUSH_SUBJECT` | basics (see `docs/DEPLOY.md`) |
| `THIKRA_SQLITE=wasm` | force the WASM SQLite |
| `THIKRA_OFFSITE` (`off` / `replit` / `dir:/path`), `THIKRA_OFFSITE_MINUTES` | off-server snapshots |
| `THIKRA_BACKUP=0` | stop nightly backup |
| `THIKRA_OWNER_CODE` | **stop-gap**: a fixed sign-in code (≥ 6 digits) accepted only for admin phones, only after a code was requested, with the 5-attempt limit. Remove once a real SMS provider works |
| `THIKRA_ADMIN_REQUIRE_PIN`, `THIKRA_ADMIN_REQUIRE_TOTP`, `THIKRA_ADMIN_IPS` | admin hardening |
| `THIKRA_AI_PROVIDER=anthropic`, `ANTHROPIC_API_KEY`, `THIKRA_AI_MODEL` | language model for the ops agent (and story writer). Not set today |
| `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `THIKRA_PUBLIC_URL` | payments (not set today) |
| `THIKRA_REGION` | stored on new users/circles (data-residency seam) |
| `THIKRA_DEATH_WAIT_HOURS` | wait before "after death" letters open (default 72) |
| `THIKRA_ROLLUP_SMALL_LIMIT`, `THIKRA_ROLLUP_CHUNK`, `THIKRA_ROLLUP_TTL_MS`, `THIKRA_BROADCAST_PAGE` | scale tuning |
| `THIKRA_DEMO_MODE=1` | **demo project only**: shows the code on screen for the five fake demo numbers |
| `THIKRA_NO_LISTEN`, `THIKRA_NET_*`, `THIKRA_PROP_*`, `THIKRA_CRASH_ROUNDS`, `UPDATE_ROUTES` | test harness only |

Important security behaviour: on a published (production) deployment no sign-in code is ever shown on screen. **Never publish a build with real data and no real SMS provider** except through the owner code stop-gap.

## 6. Admin panel and operations agent

`web/src/Admin.tsx`; routes `server/routes/admin*.ts`; side menu tabs: Agent, Overview, Support, Storage, Analytics, Reports, People, Families, Announcements, Operations, Security, Audit, Staff, Settings. Designed for **one operator + the AI agent**. Details: `docs/ADMIN-PLAN.md`, `docs/AGENT-OPS.md`, `docs/adr/0007-admin-scale.md`.

The ops agent (`server/lib/opsagent.ts`) has three non-negotiable rules: metadata only (phones masked, no family message text; only what people wrote *to support*), it **proposes, a human approves** (approval re-runs the real admin endpoint under the approver's session and audit), it can never propose permanent ban / erase message / delete family. It works **without a model** (rules, ready commands); with `THIKRA_AI_PROVIDER=anthropic` it reasons over the tools. The model path is tested only against a fake endpoint.

The admin UI and ops agent are Arabic/English only by design.

## 7. Languages

- `dict.ar` and `dict.en` in `web/src/i18n.tsx` are **hand-written and are the legal originals**.
- 19 machine-translated packs in `web/src/lang/*.json` (ur, hi, tl, fr, ml, bn, fa, tr, es, ru, zh, de, it, pt, nl, pl, uk, el, sv): flat `"a.b[2]": "text"` overlays on top of English, lazy-loaded chunks, a missing key falls back to English. A pack can only replace existing strings (`overlay()`), never change structure. Each pack carries `legalNote` ("machine translation; the Arabic or English original is the legal text and prevails"), shown on login, profile, sealed letters, and consent notices (`MachineNote`).
- Language choice: saved choice (device + account) wins → first device language we support (`pickLang`) → English. RTL for ar/ur/fa only.
- **Add a language:** add the code to `Lang`, `SUPPORTED`, `LANG_INFO`, `PACKS`, `speechLocale` in `i18n.tsx`; to `LANGS` in `server/lib/lang.ts`; an OTP template in `server/sms.ts`; a `words` entry in `server/lib/texts.ts`; the pack JSON (translate the keys of `fr.json`, including `sys.*` and `legalNote`); update the expected list in `web/lang.test.ts` and `server/lang.test.ts`.
- Admin/ops strings are intentionally not in the packs.

## 8. Deployment (current reality)

Production = **Replit Reserved VM** (`.replit`: `run = pnpm install && pnpm build && pnpm start`, Node 20 → WASM SQLite). Routine, always on the owner's explicit say-so:
1. Make a DB backup copy (`data/backups/…`) first.
2. In the Replit workspace: **Tools → Git → Fetch → Pull** (the shell `git pull` fails with credentials; the panel sometimes shows a "Pass GitHub Credentials" dialog that the owner must allow).
3. **Republish** (publish takes ~5–6 min). Verify: `GET /healthz` → `{"ok":true}`, the asset hash in `/` changed, then log in and check data is intact.
4. Run does not publish; the *published* deployment and the *workspace* are different runtimes.

Caveats: Replit's disk can be replaced on republish (off-server snapshot mitigates it — create an App Storage bucket); one earlier Republish failed with "Build cancelled" for an unknown reason and succeeded on retry with the same code; Docker files exist but were **never built/tested**.

## 9. Owner decisions already made (do not re-litigate)

- E2EE vs agent: stay with server-readable text for now so the agent works; honest disclosure to users (ADR 0001, "accepted temporarily by the owner's mandate"). E2EE remains a later phase.
- The platform admin is set by phone in `THIKRA_ADMIN_PHONES` (and `.replit`).
- Plans/sizes/prices are editable from admin; suggestions: free 5 GB, family 100 GB, legacy 2 TB.
- Death-triggered sealed letters: > 3 messages from ≥ 3 members (or 2 when only 3 others remain), then 3-day wait, can be stopped; nothing opens if the agent never concludes.
- Legal texts in translations must state that the Arabic/English original prevails and that the translation is machine-made.
- Publishing only when the owner says so.

## 10. INCOMPLETE / NOT DONE — prioritized

**Blockers before real families (P0)**
1. **Real SMS provider is untested.** Twilio code exists and is tested with a fake provider only. Needs an account, a sender, `SMS_ALLOWED_CODES`, a real sign-in test, then **remove `THIKRA_OWNER_CODE`**. Without it production sign-in relies on the stop-gap.
2. **Legal review.** `docs/PRIVACY-DRAFT.md` and `docs/TERMS-DRAFT.md` contain `[bracketed]` decisions for the owner/lawyer; nothing published. Human legal review of the *translated* legal texts (sealed-letter disclosure, deletion, consent) is also missing. See `docs/COMPLIANCE.md`.
3. **External security review / pen test** not done. `docs/THREAT-MODEL.md` is the starting point.
4. **Single server.** Rate limits, live presence, metrics are process-local behind the `state.ts` ports. Horizontal scale needs a Redis implementation of `RateLimiter`/`KeyValue`/`Bus` (contract tests already exist in `server/state.test.ts`), plus Postgres (ADR 0002 — SQLite is the single-file DB; the `Db` seam exists but no Postgres adapter, and migrations are SQLite SQL).
5. **Data safety on Replit:** media/DB on local disk; off-server snapshot needs the App Storage bucket confirmed; no real restore drill on production data yet beyond the tested flows.

**Payments (built, not proven)**
6. Stripe is implemented in **test mode** with a fake Stripe in tests (`server/payments.test.ts`, `docs/PAYMENTS.md`). Never exercised against the real sandbox. Owner must add `STRIPE_SECRET_KEY`, `STRIPE_WEBHOOK_SECRET`, `THIKRA_PUBLIC_URL`, create the webhook `…/api/stripe/webhook` (events: `checkout.session.completed`, `invoice.paid`, `invoice.payment_failed`, `customer.subscription.deleted`, `charge.refunded`) and enable the customer portal; then verify the admin "Storage → Payments" card end to end. Currency of the plan table should probably be AED (sandbox is AED). Apple/Google in-app purchases (needed for the mobile apps) not started.

**AI**
7. `ANTHROPIC_API_KEY` not set; the model path (ops agent, literary story writer) has only run against a fake endpoint. Check real token costs against the budget view in the Operations tab.
8. No per-message translation. Discussed, not built: an opt-in "translate" button (privacy-preserving: only the tapped message leaves) or on-device translation. Needs the model key and a disclosure line.
9. Admin broadcasts are written by the admin in Arabic + English; everyone else gets English. Auto-translating them needs the model key.

**Mobile**
10. `mobile/` is an early Expo skeleton: sign-in, chat list, text chat, photo/voice playback, live updates. Missing: PIN, voice recording, albums/archive/sealed/memory, native push, offline storage, store accounts (Apple $99/yr, Google $25), `eas build`, and IAP. Not run on a real phone by the previous author. ADR 0005.

**Product / UX gaps** (see `docs/BACKLOG.md`, `docs/UX-PARITY.md`, `docs/READINESS.md`)
11. Visual QA of every screen in every language is incomplete — only login screens of ur/hi were checked by eye. Persian/Urdu RTL layout and long German/Russian strings need a pass.
12. Translations are **machine only**; at least the top 2–3 languages for the owner's markets should get a native-speaker review (Polish wait-phrase "(okres: {wait})" and similar plural workarounds in pl/ru/uk are known compromises).
13. Dates/numbers use `Intl` with the language code; `fil` is mapped for Filipino; speech-recognition locales are guesses (`speechLocale`).
14. Service worker/PWA offline behaviour is basic; no native-grade offline queue beyond the resync logic.
15. Group/circle member limits, invite abuse controls, and large-file upload resume are not hardened for scale.
16. CI security job (`pnpm audit`, gitleaks) not enabled; Dependabot config exists.
17. Docker image never built.
18. Data residency (ADR 0004): `region` columns exist but are not used for routing.

**Known operational oddities**
- Replit shell `git pull` fails with "Invalid username or token"; use the Git panel.
- Replit's publish panel sometimes shows "Something went wrong" even after a successful publish; trust `/healthz` + the asset hash.
- `docs/STATUS.md` is the older, Arabic, owner-facing status (as of 2026-10-20, 161 tests) and is behind the code; **this file and the git log are current**. `docs/BACKLOG.md` has the original numbered backlog.

## 11. Where to read next

| Topic | File |
|---|---|
| Vision, honest status, launch phases | `docs/WHITEPAPER.md`, `docs/MASTER-PLAN.md`, `docs/LAUNCH-PLAN.md`, `docs/STATUS.md` |
| Deploy/env/Replit/backups | `docs/DEPLOY.md`, `docs/RUNBOOKS.md`, `docs/CI.md` |
| Admin + agent | `docs/ADMIN-PLAN.md`, `docs/AGENT-OPS.md` |
| Payments | `docs/PAYMENTS.md` |
| Protocol / API | `docs/PROTOCOL.md`, `docs/openapi.json`, `docs/api-notes.json` |
| Security & compliance | `docs/THREAT-MODEL.md`, `docs/COMPLIANCE.md`, `docs/PRIVACY-DRAFT.md`, `docs/TERMS-DRAFT.md`, `docs/AI-GATE.md` |
| Decisions | `docs/adr/` (0001–0007) |
| UX rules / design | `docs/UX-RULES.md`, `docs/UX-PARITY.md`, `docs/DESIGN-SYSTEM.md` |
| WhatsApp import | `docs/WHATSAPP-IMPORT.md` |

## 12. First-day checklist for the new developer

1. `pnpm install && pnpm typecheck && pnpm test && THIKRA_SQLITE=wasm pnpm test && pnpm build` — all green.
2. `pnpm demo` then `pnpm start`; log in with a demo number (`THIKRA_DEMO_MODE=1`); click through chat, memory, sealed letters, admin (needs `THIKRA_ADMIN_PHONES` set to your demo phone).
3. Read the tests named in §3 — they are the guardrails.
4. Ask the owner for: Replit access, GitHub access, and decisions on SMS provider, Stripe, Anthropic key, legal counsel, target markets/languages.
5. Start with P0 items 1–2, then 6 (payments end to end), then 7.
