# Web UI Overhaul — Ticket Plan

**Epic:** Thikra Web — Visual & Interaction Overhaul
**Owner:** Rizwan
**Created:** 5 November 2026
**Scope:** Web app only (`web/src`). Mobile is a separate epic, to start after the web is complete.
**Estimate:** ~10 working days / 2 weeks
**Approved by:** Rakan Al Nsour — web first, then mobile.

---

## Why this epic exists

The web app works but looks unfinished. This is measurable, not a matter of taste. Across all 15 screens and 4,951 lines:

| Measure | Count |
|---|---|
| `className=` usages | 1,379 |
| CSS animations | **0** |
| CSS transitions | **1** |
| Shadows / elevation | **0** |
| Hover states | 13 |
| Focus styles | 1 |
| Skeleton loaders | **0** |
| Loading states of any kind | **0** |

There is no motion, no depth, no feedback on interaction, and nothing shown while data loads.

## What we are NOT doing

**We are not replacing the theme.** The existing design tokens in `web/src/styles.css` are good and stay as they are:

- Colour tokens with a full dark theme, both verified for WCAG AA contrast in `web/contrast.test.ts`
- Tajawal typeface, RTL-safe logical properties (`border-inline-start`, `inset-inline-start`)
- Text scaling for accessibility (`html[data-text="large"]`)
- A motion kill-switch (`html[data-motion="off"]`) and a `prefers-reduced-motion` query — **both already wired, with no motion to switch off**

The palette stays: green `#1f4d3f`, gold `#c79a3b`, paper `#f5f1e8`. We are adding motion, depth and polish on top of a system that already exists.

## This is also not a bug-fixing epic

Functional bugs are tracked separately. Mixing "make it look good" with "make it work" in one ticket makes both impossible to review.

---

## Definition of Done — applies to EVERY ticket

A ticket is not done until all six are true:

1. **Light and dark both correct** — `pnpm test` still passes, including the contrast tests
2. **Arabic RTL correct** — Arabic is the primary language, not an afterthought
3. **Works at phone width** — the web app is an installable PWA; 360px is the floor
4. **Respects `data-motion="off"`** and `prefers-reduced-motion` — no exceptions
5. **Keyboard accessible** — visible focus ring on every interactive element
6. **No regressions** — `pnpm test` (277 tests), `pnpm typecheck` and `pnpm build` all pass

---

# The 8 tickets

## THK-1 — Design foundation: motion, depth and focus

**Priority:** P0 · **Estimate:** 1.5 days · **Depends on:** nothing · **Blocks:** everything else

Create the system the other seven tickets apply. Nothing visual should be invented ad hoc after this ticket.

**Scope**
- Motion tokens: a duration scale (instant / fast / normal / slow) and easing curves, as CSS custom properties in the `@theme` block
- A small keyframe library: fade, slide-in, scale-in, shimmer, pulse
- An elevation scale: 3 shadow levels that work in **both** light and dark (dark needs lighter borders rather than heavier shadows)
- A focus-ring treatment applied globally — there is exactly 1 focus style in the app today
- Hover and active states for every interactive primitive: `.btn`, `.btn-ghost`, `.field`, `.card`, list rows
- Wire all of it into the existing `html[data-motion="off"]` switch

**Acceptance criteria**
- Motion tokens exist in `styles.css` and are used by name, never hardcoded durations
- Every button, field, card and list row has hover, active and focus states
- Turning on "reduce motion" in You → Appearance disables every animation added
- Contrast tests pass in both themes

**Files:** `web/src/styles.css`

---

## THK-2 — Loading, empty and error states

**Priority:** P0 · **Estimate:** 1 day · **Depends on:** THK-1

The app currently shows nothing at all while data loads. The only `loading` references in the codebase are `loading="lazy"` attributes on images.

**Scope**
- A reusable `Skeleton` component using the shimmer keyframe from THK-1
- Skeleton variants for: chat list rows, memory timeline items, album grid tiles, admin table rows
- Pending state on buttons (spinner + disabled, so a double submit is impossible)
- A designed empty state — icon, heading, one line of explanation, and a clear action
- A designed error state with a retry action
- A toast/notice pattern for transient feedback

**Acceptance criteria**
- No screen in the app ever shows a blank area while loading
- Every empty list has a designed empty state, not bare text
- Every failed request shows an error with a retry, never a silent blank

**Files:** new `web/src/Skeleton.tsx`, `web/src/Notices.tsx`, `web/src/styles.css`

---

## THK-3 — Login and OTP

**Priority:** P1 · **Estimate:** 0.5 days · **Depends on:** THK-1, THK-2

The first screen anyone sees, and small enough to prove the new system works before touching the big screens.

**Scope**
- Replace the raw native `<select>` language picker — it renders as an unstyled OS dropdown
- Style the country-code picker properly (currently a bare control next to the phone field)
- A proper OTP entry field — individual digit boxes, auto-advance, paste support
- Animated transition between the phone step and the code step
- Pending state on "Next" while the code is being sent
- Clear, specific error messages — not one generic failure

**Acceptance criteria**
- No unstyled native form controls remain on this screen
- Phone → code transition is animated
- Entering a bad number gives a specific message, not a generic one

**Files:** `web/src/Login.tsx` (271 lines), `web/src/LangPicker.tsx` (18 lines)

---

## THK-4 — Chat list

**Priority:** P1 · **Estimate:** 1 day · **Depends on:** THK-1, THK-2

**Scope**
- Redesign the row: avatar, name, preview, timestamp, unread badge — proper hierarchy and spacing
- Hover and press states on rows
- Family circles visually distinguished from ordinary chats (they already sort to the top; make that visible)
- Row actions (pin, mute, archive) revealed on hover on desktop, swipe on touch
- Skeleton rows on first load, from THK-2
- Designed empty state for a new user with no chats
- Animate list changes — new chat arriving, chat being archived

**Acceptance criteria**
- Unread state is obvious at a glance
- Row actions reachable by both mouse and touch
- List changes animate rather than jumping

**Files:** `web/src/ChatList.tsx` (254 lines)

---

## THK-5 — Chat view, media and album

**Priority:** P1 · **Estimate:** 2.5 days · **Depends on:** THK-1, THK-2

The biggest ticket — `CircleView.tsx` alone is 1,280 lines. Album is included because the media grid lives inside the chat; splitting them would mean editing the same files twice.

**Scope**
- Bubble polish: spacing, tails, grouping of consecutive messages, timestamp placement
- Animate message send and receive — new messages should arrive, not appear
- Animated typing indicator
- Smooth scroll-to-bottom, and a "jump to latest" affordance when scrolled up
- Composer polish: auto-grow, attachment menu, voice-record state
- Media grid and lightbox with open/close transitions
- Upload progress — currently only a bare text counter
- Reactions, reply and quote given proper visual treatment

**Acceptance criteria**
- Sending a message is visibly animated
- Media opens and closes with a transition, not a jump cut
- Uploads show real progress
- Works at phone width with the keyboard open

**Files:** `web/src/CircleView.tsx` (1,280 lines), `web/src/Album.tsx` (107 lines)

---

## THK-6 — Memory timeline and Sealed letters

**Priority:** P1 · **Estimate:** 1.5 days · **Depends on:** THK-1, THK-2

**This is the product's differentiator — it should be the best-looking part of the app.** Nothing here resembles WhatsApp, so it is where the design can be most distinctive.

**Scope**
- Timeline: reveal events on scroll, animate the dots, give year and month dividers real weight
- Treat each event card as a memory object, not a list row
- Sealed letters: an envelope treatment that feels physical — wax seal, and an opening animation when a letter unseals
- A countdown or date treatment for letters not yet open
- Make the distinction between open and sealed immediately obvious
- Skeleton states for both

**Acceptance criteria**
- The timeline animates as it is scrolled
- Opening a sealed letter is a moment, not a state change
- Dark mode is treated as the showcase, since it is the default theme

**Files:** `web/src/Memory.tsx` (70 lines), `web/src/Sealed.tsx` (230 lines), `web/src/styles.css` (existing `.timeline` and `.envelope` rules)

---

## THK-7 — You / Settings

**Priority:** P2 · **Estimate:** 1 day · **Depends on:** THK-1, THK-2

**Scope**
- Group settings into clear sections with consistent row patterns
- Proper toggle, radio and select components — no native controls
- Live preview when picking a theme or chat wallpaper (the wallpapers already exist in CSS)
- Animate section expand and collapse
- Give destructive actions (delete account) a distinct, careful treatment

**Acceptance criteria**
- No unstyled native controls
- Theme and wallpaper changes preview immediately
- Destructive actions are visually separated from the rest

**Files:** `web/src/You.tsx` (391 lines)

---

## THK-8 — Admin panel

**Priority:** P3 · **Estimate:** 1 day · **Depends on:** THK-1, THK-2

Staff-facing, so the polish bar is lower than the customer screens. It is the second-largest file, so it still needs a pass. **Can be moved to a later sprint if time runs short** — no customer ever sees it.

**Scope**
- Consistent table styling: sticky headers, zebra rows, sensible density
- Filter and search controls using the new components
- Skeleton rows while data loads
- Clear status badges for reports and decisions
- Confirmation dialogs for moderation actions

**Acceptance criteria**
- Tables are readable at a glance with many rows
- Every moderation action is confirmed before it runs
- Works in dark mode

**Files:** `web/src/Admin.tsx` (1,094 lines)

---

# Order of work

```
THK-1  Foundation ───┬──► THK-3  Login
                     ├──► THK-4  Chat list
THK-2  States ───────┼──► THK-5  Chat view + media
                     ├──► THK-6  Memory + Sealed
                     ├──► THK-7  You / Settings
                     └──► THK-8  Admin
```

THK-1 and THK-2 must be finished first. After that the six screen tickets are independent and can be done in any order, or in parallel if anyone joins.

**Suggested sequence:** 1 → 2 → 3 → 4 → 5 → 6 → 7 → 8
THK-3 is deliberately third: it is small, so it proves the foundation works before the 1,280-line chat view.

---

# Estimates

| Ticket | Days |
|---|---|
| THK-1 Foundation | 1.5 |
| THK-2 Loading, empty, error | 1.0 |
| THK-3 Login and OTP | 0.5 |
| THK-4 Chat list | 1.0 |
| THK-5 Chat view, media, album | 2.5 |
| THK-6 Memory and Sealed | 1.5 |
| THK-7 You / Settings | 1.0 |
| THK-8 Admin | 1.0 |
| **Total** | **10 days** |

---

# Verification on every ticket

```bash
pnpm test        # 277 tests, includes WCAG AA contrast in both themes
pnpm typecheck   # must stay at zero errors
pnpm build       # must stay clean
```

Check each screen in four states before closing a ticket: **light / dark × English LTR / Arabic RTL**, at both desktop and phone width.
