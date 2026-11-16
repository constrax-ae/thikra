// Renames the built page away from `index.html`, as the last step of `pnpm build`.
//
// On a panel host (Plesk, cPanel) the web server is handed a document root and serves anything it
// finds there ITSELF, before the app is ever asked. A page served that way arrives without the
// headers server/app.ts sets - no Content-Security-Policy, no X-Frame-Options - and because the
// first document's CSP governs the whole single-page session, losing it on `/` loses it everywhere.
// Measured on tamtim.com: every route carried the policy except the one address people actually type.
//
// A directory with no index file falls through to the app, so naming the page something no server
// will choose as a directory index puts it back in the app's hands, on any host, with no web-server
// configuration to remember. server/index.ts serves it for every address the SPA owns.
import { rename, access } from 'node:fs/promises';

const from = new URL('../dist/index.html', import.meta.url);
const to = new URL('../dist/app.html', import.meta.url);

try {
  await access(from);
} catch {
  // Already sealed (a repeated build, or a build that emitted nothing) - leave it alone.
  process.exit(0);
}
await rename(from, to);
console.log('sealed: dist/index.html -> dist/app.html (the app serves the page, so it keeps its headers)');
