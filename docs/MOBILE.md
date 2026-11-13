# The phone app (`mobile/`)

Expo SDK 58, React Native 0.88, a development build (`app.thekra.family`). It talks to the same server as
the web app, so server-side settings (SMS provider, AI model, Stripe) need nothing here.

## Settings

All of the app's settings are in **`mobile/.env.example`**: copy it to `mobile/.env` (ignored by git) and fill it in.

| Setting | What it is | Not set |
|---|---|---|
| `EXPO_PUBLIC_API_URL` | The server the app talks to, no trailing slash | Development: `http://localhost:8787`. Release: no server, and the app logs that it was built without one |

- **Blank means not set**, as on the server (`server/env.ts`). An empty line used to become an empty address.
- The placeholder `https://REPLACE-WITH-YOUR-PUBLIC-SERVER` in `eas.json` also counts as not set.
- Everything `EXPO_PUBLIC_*` is **inside the installed app**. Never put a secret here; keys belong on the server.
- Expo reads `.env` when it bundles: restart Metro after changing it.

## Running it locally

```
cd Thikra && pnpm start                                  # the server, http://localhost:8787
cd Thikra/mobile && npx expo start                       # Metro (reads mobile/.env)
cd Thikra/mobile && npx expo run:ios                     # build + install the dev app (after adding a native module)
```

Never start Metro with `CI=1`: it turns off file watching and edits never reach the app.

## Store builds (EAS)

`mobile/eas.json` has three profiles:

| Profile | For | Server address |
|---|---|---|
| `development` | The dev app on the iOS Simulator | `http://localhost:8787` |
| `preview` | Test installs on real phones (Android APK, internal iOS) | Replace the placeholder |
| `production` | The App Store / Play Store | Replace the placeholder |

Before a `preview` or `production` build, replace `https://REPLACE-WITH-YOUR-PUBLIC-SERVER` with the real
server, or set `EXPO_PUBLIC_API_URL` as an EAS environment variable. Build with `eas build --profile production`.

## The Xcode 26 compile fix

`expo-modules-jsi` 58.0.x does not compile with Xcode 26.1 (Swift 6.2: "sending 'slot' risks causing data
races"). `mobile/scripts/patch-expo-modules-jsi.mjs` applies a two-line fix and runs automatically after every
`npm install` (`postinstall`):

- It is safe to run any number of times.
- If a newer Expo changes that code, it only warns, because the upstream fix may have landed.
- CI checks that the fix was applied.

## Checks

`npm run typecheck` and `npm test` in `mobile/`. CI (`.github/workflows/ci.yml`, job **Phone app**) also bundles the
iOS JavaScript as a release would, and fails on a HIGH or CRITICAL advisory in the app's production
dependencies, the same bar as the server.
