# Voice calls: what they cost (note for the owner)

Date: 2026-11-19. These are estimates from the audio settings, not measurements from real calls. Check the real numbers in the first test with the relay switched on.

## What costs money and what does not

- **A direct call costs us nothing.** The voice goes straight between the two phones/browsers. Our server only passes the small set-up messages (a few kilobytes per call).
- **A relayed call costs bandwidth.** When the two sides cannot reach each other directly (strict Wi-Fi routers, many mobile carriers with carrier NAT, some company networks), the voice goes through a relay server (TURN). Then the relay carries the voice in both directions.

How many calls need the relay? Commonly quoted: roughly 10 to 20 out of 100 calls on mixed networks, more on mobile data. For the Gulf we do not know: that is one of the things the trial must measure.

## Bandwidth per minute of relayed call

Voice uses the Opus codec, usually 24 to 40 kbit/s per direction (WebRTC default is around 32 kbit/s for speech), plus about 20 to 30 kbit/s of packet overhead (headers, encryption). Call it **about 50 to 60 kbit/s per direction**.

A relay carries both directions, so it receives and sends: per minute of call about 2 x 55 kbit/s x 60 s = 6.6 Mbit = **about 0.8 MB in and 0.8 MB out** (roughly **1.6 MB of relay traffic per minute**, or about **100 MB per hour of relayed talking**).

Examples (every call relayed, worst case): 1,000 calls a day of 5 minutes = 5,000 minutes = about 8 GB a day = about 240 GB a month. If only 20 % need the relay: about 50 GB a month.

Most hosting counts only outgoing traffic: about half of the figures above (0.8 MB per minute).

## Hosting options for the relay (TURN)

The prices and free allowances below are from memory and were NOT checked online; confirm them before deciding.

| Option | Idea | Rough cost (check current prices) |
|---|---|---|
| **Your own coturn on a small VPS** (Hetzner, DigitalOcean, a Gulf region VPS) | Free open-source software; our server already hands out short-lived credentials in the coturn format (`use-auth-secret`). Run it on port 443 with TLS (`turns:`), which passes more filters. | A VPS of 5 to 10 USD a month usually includes 1 to 20 TB of traffic (Hetzner includes 20 TB in Europe); some providers charge per GB beyond the plan. Needs someone to maintain it. |
| **Cloudflare Realtime TURN** | Managed relay; the first 1,000 GB a month are free at the time of writing, then a small price per GB. No server to run. Would need a small change here to fetch credentials from their API. | Free for a trial; per GB after the free part. |
| **Twilio Network Traversal, Metered, Xirsys** | Managed relay with an API that returns ICE servers. | Per GB, a few cents a GB; check each price page. |

Recommendation for the trial: start with **no relay** (works now, costs nothing) to see how many calls fail; then add **one small coturn VPS** or Cloudflare's free tier and compare. Place the relay near the users (Gulf region or Europe) because the relay adds its distance to every call.

## Protect the relay from misuse

Any signed-in person can ask for relay credentials (30 times per 10 minutes) and they last an hour. On coturn set `user-quota`, `total-quota` and `max-bps`, and `denied-peer-ip` for private address ranges, so one account cannot use the relay as a free proxy or run up the bill.

## Settings to switch the relay on

On the server: `THIKRA_TURN_URLS` (for example `turn:turn.example.com:3478,turns:turn.example.com:443?transport=tcp`), `THIKRA_TURN_SECRET` (the same value as coturn's `static-auth-secret`), optionally `THIKRA_TURN_TTL` (seconds, default 3600) and `THIKRA_STUN_URLS`. Nothing else changes in the app.

## Not verified

Whether carriers in the Gulf restrict or block voice-over-internet calls (they do in some countries) cannot be tested from here. A relay on port 443 with TLS is the form most likely to pass such filters, but only a test on the real carriers will say.
