import { Platform } from 'react-native';

/**
 * Where the Thekra server is: EXPO_PUBLIC_API_URL, read from mobile/.env (see mobile/.env.example)
 * or from the build's environment. Expo bakes it into the app when the JavaScript is bundled.
 *
 * Blank means NOT SET, as on the server (server/env.ts): a ".env" line left empty gives an empty
 * string, and "" used to win over the default, so the app called "/api/…" on no host at all.
 * Unset, a development build talks to this Mac's server (the iOS Simulator shares its localhost);
 * a release build has no default on purpose — it must be built with the real address, and says so
 * in the log rather than quietly talking to some old demo server.
 *
 * In a browser (the web build) the app is served by the same server as the API, so the address is
 * empty and the browser keeps the session cookie itself.
 */
const DEV_DEFAULT = 'http://localhost:8787';

// eas.json ships "https://REPLACE-WITH-YOUR-PUBLIC-SERVER" as the store builds' address until the real one is known: that
// placeholder counts as not set too, so a build made before it was replaced says so instead of calling a host that cannot exist.
const given = (process.env.EXPO_PUBLIC_API_URL ?? '').trim();
const raw = /REPLACE-WITH/i.test(given) ? '' : given;
export const API_CONFIGURED = Platform.OS === 'web' || raw !== '';
export const API_URL = Platform.OS === 'web' ? '' : (raw || (__DEV__ ? DEV_DEFAULT : '')).replace(/\/+$/, '');

if (!API_CONFIGURED) {
  console.warn(__DEV__
    ? `[config] EXPO_PUBLIC_API_URL is not set: using ${DEV_DEFAULT}. Copy mobile/.env.example to mobile/.env to change it.`
    : '[config] EXPO_PUBLIC_API_URL was not set when this build was made: the app has no server to talk to.');
}
