# Thikra on the phone — what is there, and what is not

Written after reading every line of `mobile/` (616 lines, 12 files) against the finished web app.

## What already works

Not a blank slate. These are real and working:

| | |
|---|---|
| Sign in | Phone + SMS code, session kept in the phone's secure storage |
| Chat list | Family circles on top, unread badges, mute, pull to refresh |
| Chat | Text messages, author colours, system notices, time stamps |
| Photos | Picking from the library and sending |
| Voice | Playing a voice message (recording one is not possible) |
| Invite | Share a link, pick from contacts, with the privacy note |
| Account | Name, sign out, delete account, support cases |
| Live updates | The same WebSocket gateway the web uses, with polling as the safety net |

The hard parts of a phone app — auth, the socket, upload — are done.

## What is missing

### 1. In the chat itself
Reply, react, star, forward, delete, edit. Read receipts (the ticks). Day dividers.
Grouping consecutive messages. **Recording** a voice note. Video and file attachments
(images only today). Captions on an attachment. A media gallery. Search inside a chat.
The long-press menu that opens all of this.

### 2. Screens that do not exist at all
- **Archive** — the documented events of a circle
- **Memory** — the timeline across every circle
- **The story book** — the printable family story
- **Sealed letters** — write today, delivered on the day
- **Settings** — appearance, wallpaper, text size, notifications, privacy, language
- **Circle settings** — the agent toggle and sensitivity, members, invite policy
- **Starting things** — new chat, new circle, new group, join by code
- **WhatsApp import**
- **Starred messages**
- **Admin**

The archive and the agent are the reason the product exists, and the phone cannot see them.

### 3. Underneath
- **Push notifications** — nothing at all; a family would never know a message arrived
- **Languages** — Arabic and English only, against 21 on the web
- **Dark mode** — none
- **RTL** — the language is detected, but the layout does not mirror

## What does not need building again

`core/` is shared TypeScript and already runs on the phone unchanged: the archive agent,
the excerpt helper, the email check, the reactions list. The server API is the same one the
web calls. This is screens and interaction work, not a second back end.

## Suggested order

1. **Foundation** — design tokens to match the web, shared controls, the three-tab shell
2. **The chat** — reply, react, star, forward, delete, ticks, day dividers, grouping
3. **Voice and media** — recording, video, files, captions, the gallery
4. **Archive and Memory** — the product's reason to exist
5. **Circle settings** — the agent toggle, sensitivity, members, invites
6. **Settings** — appearance, notifications, privacy, languages, RTL, dark mode
7. **Sealed letters and the story book**
8. **Push notifications**

Each is a ticket's worth of work, the same shape as the eight the web had.
