# Thekra web app: full QA audit

**Date:** 2026-11-05 · **Build:** local dev (`pnpm dev:web` on :5173, server on :8787) · **Scope:** web app (`web/`), server behaviour behind it, and a code-level check of what is real vs. stubbed.

## How this was tested

1. **In the browser (Claude in Chrome):** every screen clicked through at desktop width (1440px) and phone width (400px), in English and Arabic, light and dark theme.
2. **Code check:** every integration (SMS, payments, AI, push, storage, encryption, mobile) traced in the source to see whether it is real, partial, or a stub. All `api()` calls in `web/src` were checked against the server's routes. All of them exist.
3. **Safety:** nothing destructive was done on the real account (no delete account, leave circle, regenerate invite code, or payments). Creating and sending was tested on a separate **test account** made for this audit, opened on `http://[::1]:5173` so it has its own login.

| Test account | Value |
|---|---|
| Phone | `+92 300 0000101` |
| Name | QA Tester |
| PIN (two-step) | `246813` |
| Test data it created | circle "QA Family" (#4), group "QA Group" (#5), 5 messages, 2 archive events, 1 sealed letter, 1 support case, 1 storage-plan request |

> The admin account is user #1 ("rizwan"). The account used day to day (#2) is **not** an admin, so the **admin panel was not tested in the browser** (see the code check below).

---

## 1. Feature status

Key: ✅ works · 🟡 works with limits / partly fake · 🔴 dummy or not built · ⚪ not tested in browser

### Sign-in and account
| Feature | Status | Notes |
|---|---|---|
| Phone sign-up / sign-in | 🟡 | Flow works end to end. **No SMS is sent**: the code is shown on screen with a "Fill" button (dev only). In production with no provider the code only goes to the server log, so **nobody could sign in**. |
| SMS provider | 🔴 | Only `console` (fake) and `twilio` exist. Twilio was only tested against a fake endpoint. **The DreamSoft provider the CEO chose does not exist yet.** |
| Name step, language picker on login | ✅ | |
| Two-step PIN (turn on / change / off) | ✅ | Tested on test account. |
| Change phone number | ⚪ | Needs a second SMS code; not tested. |
| Export my data (zip) | ✅ | Returns a real zip (`application/zip`). |
| Delete account | ⚪ | Not clicked (destructive). |
| "My rights over my data" requests | 🟡 | Sends a request to the team; a human has to act on it. |

### Chats
| Feature | Status | Notes |
|---|---|---|
| Chat list, sections, filters (All / Unread / Favourites / Groups), search, ⌘K | ✅ | |
| New family circle, new group | ✅ | |
| New 1-to-1 chat by phone | 🟡 | Works only if the person already has an account. Otherwise shows "This number is not registered". There is no "invite them by SMS/WhatsApp" step. |
| Join with invite code | 🟡 | Bad code gives a clear error. A real join needs a second live account, so it was **not clicked**; it is covered by the server's automated tests. |
| Send text, live delivery | ✅ | |
| Reply, react, star, pin (24h / 7d / 30d), edit, delete, forward | ✅ | Star, pin and search tested; the menu offers all actions. |
| In-chat search, starred panel, media panel | ✅ | |
| Photos, video, files in chat | ✅ | Seen working in the real account. Upload was not re-tested (needs a file picker). |
| Voice notes | 🟡 | Recording and playback work. **Transcription is browser-only** (Chrome's speech API), with no server speech-to-text. Recording was not re-tested (needs microphone permission). |
| Mute (8h / week / always), favourite, archive chat, mark unread | ✅ | |
| Read receipts toggle | ✅ | |
| Drafts saved per chat | ✅ | Local to the device only. |

### Family memory (the core product)
| Feature | Status | Notes |
|---|---|---|
| Archive agent (circle mode) | 🟡 | **Rules and keyword weights, no AI.** Works well in **Arabic**: the Arabic birth message was filed as "birth". **Weak in English**: "Our daughter Sara was born today" was **not** filed, while "Ahmed graduated…" was. |
| Archive tab: search, timeline, remove | ✅ | |
| Memory page (all circles' timeline) | ✅ | Event **titles are the raw message cut at a fixed length**, sometimes mid-word ("…congratul"). |
| Printable family story book | 🟡 | Works and prints. Without an AI key it is a **rules-based draft**, and the page says so. Text glitches: quotes cut mid-word, and "Barely a week passed" written between two events on the **same day**. |
| "Ask the literary writer" (AI story) | 🔴 | **Off**: needs `THIKRA_AI_PROVIDER=anthropic` and `ANTHROPIC_API_KEY`. The button explains this honestly. |
| Edit story chapters by hand | ✅ (code) | |
| Albums, WhatsApp import | ⚪ | Not tested (needs an export file). The code is real. |
| Birthday / "on this day" banner | ⚪ | Needs dated data. |

### Sealed messages
| Feature | Status | Notes |
|---|---|---|
| Write and seal a letter (date) | ✅ | "Message sealed", and the circle shows "1 sealed letter waiting". |
| Event / after-death triggers | 🟡 | Real logic, but **detection is keyword matching** on messages. |
| Encryption | 🔴 | **None.** Stored as plain text; only access rules protect it. The page says so honestly ("Thekra's team could technically read it"). |
| Voice / video letters | ⚪ | Need camera or microphone. |

### Settings, storage, payments
| Feature | Status | Notes |
|---|---|---|
| Storage bar, plans dialog | 🟡 | Plan **prices are placeholders** (`server/billing.ts:14`): Free 5 GB, Family 100 GB $1.99/mo, Heritage 2 TB $9.99/mo. |
| Buy a plan (Stripe) | 🔴 not switched on | The Stripe code is real but needs `STRIPE_SECRET_KEY` and a webhook secret, and has **never been run against live Stripe**. Without keys the UI falls back to "Request this plan". |
| Request a plan (manual) | ✅ | "Your request arrived; the team will contact you." An admin approves it by hand. |
| Circle settings: agent mode, sensitivity, invite policy, invite on/off | ✅ | |
| Invite card: code, copy, share link | ✅ | |
| Pick from phone contacts | 🟡 | Only in Chrome on Android; elsewhere it falls back to sharing the link. |

### You page
| Section | Status | Notes |
|---|---|---|
| Starred, Privacy, Appearance (language, theme, wallpaper, bubble colour, animations, data saver, photo quality) | ✅ | Dark theme and Arabic RTL checked. |
| Notifications | 🟡 | **Browser web-push only.** Real sending with auto-generated keys, but never tested with a real push service. Contact email is still `admin@thikra.invalid`. No native phone push. |
| Chats | 🟡 | Only one sentence ("Drafts are saved…"); no real settings. |
| Storage and data | 🔴 | **Placeholder:** one sentence pointing to circle settings. |
| Install the app (PWA) | ✅ | Install prompt on Android, instructions on iOS. |
| Help / support cases | ✅ | Sent a ticket and saw it listed as "Open". The Help text still says "**Prototype version**". |
| Invite a friend | ✅ | Opens the share sheet or copies the link. |
| Sign out | ✅ (code) | |

### Admin panel
| | Status | Notes |
|---|---|---|
| 14 sections (overview, users, families, reports, support, storage, analytics, announce, audit, security, staff, agent, ops, settings) | ⚪ in browser · ✅ in code | All call real server routes. Not clickable with the daily account (not an admin). |
| Opening `#/admin` without access | 🟡 | Shows a **blank page** instead of a "no access" message. |

---

## 2. Bugs found

### Fixed during this audit
| # | Bug | Fix |
|---|---|---|
| 1 | Desktop: jumping to a search result shifted the whole layout ~20px sideways (sidebar cut off). The pinned bar was 40px too wide. | `styles.css` docked-pane children get `width:auto`; the desktop shell uses `overflow-clip`. |
| 2 | Phone + Arabic: chat header squeezed the chat name to almost nothing ("y ع") because of the agent and sealed badges. | Badges hidden below the `sm` breakpoint (`CircleView.tsx`). |
| 3 | English messages in Arabic mode had punctuation on the wrong side ("!today"). | Message text uses `dir="auto"`. |

### Still open
| # | Severity | Bug |
|---|---|---|
| 4 | Medium | **English event detection**: "…was born today…" is not archived. The agent's dictionary is mostly Arabic. |
| 5 | Low | Archive / Memory titles and book quotes are cut mid-word. |
| 6 | Low | Story book says "Barely a week passed" between same-day events. |
| 7 | Low | After creating the first circle, the sidebar keeps showing "Start with your family" until its 8-second refresh. |
| 8 | Low | An error from a closed dialog (e.g. "Invalid invite code") stays shown above the chat list. |
| 9 | Low | Media panel inside a chat does not close with Escape. |
| 10 | Low | First run: the right pane says "Pick a conversation" when there are none. |
| 11 | Low | `#/admin` without access shows a blank page. |
| 12 | Low (design) | The Sealed messages page still uses the browser's plain dropdowns and checkbox, not the themed ones. |

---

## 3. What is dummy, fake or missing (from the code)

| Area | Reality | What is needed |
|---|---|---|
| **SMS** | Fake (code on screen in dev). Twilio adapter untested. **No DreamSoft adapter.** | Write the DreamSoft adapter in `server/sms.ts` (`providerFromEnv`), then test a real sign-in. |
| **Payments** | Real Stripe code, never run live. Prices are placeholders. | Stripe keys, webhook secret, `THIKRA_PUBLIC_URL`, portal enabled, final prices. |
| **AI story writer** | Off without a key; rules-based draft instead. | `ANTHROPIC_API_KEY` (+ `THIKRA_AI_PROVIDER=anthropic`); check the default model ID. |
| **Archive agent** | Rules and weights only, no AI. | Better English keywords, or an optional model check. |
| **Voice transcription** | Browser only. | A server speech-to-text provider. |
| **Push** | Web push only, untested live. | Real contact email (`THIKRA_PUSH_SUBJECT`); native push for the phone app. |
| **Encryption** | None, neither end-to-end nor for sealed letters. | Listed as a launch blocker. |
| **Media storage** | Local disk only; an off-server copy exists only on Replit. | Object storage (S3 or similar) for production. |
| **Database** | SQLite file `data/thikra.db`, one server only. | Fine for a pilot; Postgres if it must run on several servers. |
| **Hosting** | Nothing live. `Dockerfile` / `docker-compose.yml` are marked "NOT TESTED". | Pick a host, build the image once, set the env vars in `docs/DEPLOY.md`. |
| **Mobile app** (`mobile/`) | ~430-line shell: login, chat list, basic chat, invite, account/support. | Missing vs. web: voice recording, archive/memory, story, sealed letters, albums, search, pins and stars, import, circle settings, storage, payments, push. |

**Out-of-date docs:** `docs/STATUS.md` (2026-10-20) says payments are "not started", the admin panel lacks analytics, SMS and feature flags, and mobile is "not started". The code now has all of those (mobile partly).

---

## 4. Not tested (and why)

- Admin panel in the browser: the daily account is not an admin.
- Real two-person flows (invite → join, 1-to-1 between two users, read receipts between people): need two accounts logged in at once.
- Voice / video recording, file upload, WhatsApp import: need microphone, camera or files.
- Push notifications: need the browser permission prompt.
- Delete account, leave circle, regenerate invite code: destructive, deliberately not clicked.
- Real payments: Stripe not configured.

## 5. Before real families can use it (launch blockers)

1. Real SMS (DreamSoft adapter), with on-screen codes off.
2. Hosting chosen and the Docker build actually tested.
3. Off-server media storage and backups.
4. Encryption decision (sealed letters at minimum).
5. Final plan prices and live Stripe test, or keep the manual "request" flow.
6. Security and legal review (`docs/PRIVACY-DRAFT.md`, `docs/TERMS-DRAFT.md` are drafts).
7. Remove "Prototype version" from Help and fill or remove the placeholder **Storage and data** and **Chats** sections.
