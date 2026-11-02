# Thekra (ذكرى): design prompts for Gemini

How to use: open Gemini, paste the **Shared brief** once, then paste one **Direction** and one **Screen** prompt at a time. Ask for "mobile screen, 9:16, high fidelity UI mockup". Bring the images you like back to Claude Code, which will turn the chosen one into real code (colours, fonts, spacing, components).

## Shared brief (paste first)

> You are a senior product designer. Design the mobile app **Thekra (ذكرى)**: a private family messaging app that keeps the family's memory. Core ideas: WhatsApp-level familiar chat basics, plus an AI agent that documents family events (births, weddings, achievements, farewells), a "Memory" thread across all circles, a printable **yearly family book**, and **sealed letters** (text, voice, video, photo) that open on a date, an occasion, or after the author's passing.
> Audience: Arabic-speaking families, many living abroad; all ages, including grandparents (large readable text). Arabic first, **right-to-left**, with English as a second language.
> Feel: modern, warm, intelligent, creative, trustworthy. Not corporate, not childish, not a copy of WhatsApp. Avoid stock-photo clichés and generic purple AI gradients.
> Requirements: contrast WCAG AA, touch targets 48px or more, an Arabic typeface with real character (for example Readex Pro, IBM Plex Sans Arabic, or Noto Kufi), consistent icons, light and dark variants.

## Directions (pick one)

**A. Dark luxe**: deep ink background (#0E1512), warm gold accent (#E8A33D), soft green for success, thin glass-like cards, a glowing amber letter "ذ" mark. Cinematic, like a private archive at night.

**B. Warm paper**: off-white paper background (#FAF6EE), deep green ink (#1F4D3A), gold highlights, subtle paper grain, hand-drawn touches, serif-style Arabic headings. Like a family album you hold.

**C. Living memory**: light or dark, a soft aurora of green and amber behind content, rounded "memory bubbles", timeline that grows like a tree, animated agent presence (a small calm orb that "listens"). Futuristic but gentle.

## Screens (one prompt each)

1. **Chat list**: search, tabs (All, Unread, Favourites, Groups), family circles with avatars, last message, unread badges, bottom navigation (Chats, Memory, You).
2. **Conversation**: bubbles, voice message with waveform, photo grid, a pinned banner, and an inline **agent card** "تم توثيق حدث: زواج أحمد" with a view-in-archive action.
3. **Memory**: one thread across all circles, grouped by month, event cards with photos, people chips, a search bar that understands questions ("متى سافر جدي؟").
4. **Yearly book**: cover ("ذكريات سنة 2026"), foreword written by the agent, events index, a spread page with photo and text, a Print / Save PDF button.
5. **Sealed letters**: create flow (record voice or video or write; choose When it opens: date / occasion / after my passing), the envelope list showing progress without content, and an honest disclosure line. Emotional but calm, no morbid imagery.
6. **Agent settings**: on/off with a clear explanation of what the agent reads and never does, plus a "stop" control.

## What to send back

Three images per chosen direction (screens 1, 2, 4) are enough to decide. Tell Claude Code the direction letter and what to change.
