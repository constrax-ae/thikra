import './env.ts';   // FIRST: turns blank settings into absent ones before anything reads them (see the file)
import { type Context } from 'hono';
import { SYNC_PAGE, messagesChanged, messagesSince, sendText } from './lib/moments.ts';
import { app } from './app.ts';
import { attachGateway } from './ws.ts';
import { createBackup, listBackups, pruneBackups } from './backup.ts';
import { startOffsite } from './offsite.ts';
import { checkQuotaAlerts } from './lib/capacity.ts';
import { isFrozen, limited, markRead, membership } from './lib/helpers.ts';
import { maintenanceNow, runBroadcasts } from './lib/announce.ts';
import { trackJob } from './lib/jobs.ts';
import { attachCalls, callFrame } from './lib/calls.ts';
import { briefTick } from './lib/briefs.ts';
import { refreshAll } from './lib/rollups.ts';
import { one } from './db.ts';
import { serve } from '@hono/node-server';
import { startupMode } from './lib/mode.ts';
import { serveStatic } from '@hono/node-server/serve-static';

// The server is assembled here. Route files register themselves on import, so the ORDER of these imports is the order of the routes
// (it is pinned by server/routes.test.ts). Declarations live in lib/, routes in routes/.
import './app.ts';
import './lib/helpers.ts';
import './lib/auth.ts';
import './lib/pin.ts';
import './lib/circles.ts';
import './lib/storage.ts';
import './lib/messages.ts';
import './lib/moments.ts';
import './lib/attachments.ts';
import './lib/albums.ts';
import './lib/push.ts';
import './lib/sealed.ts';
import './lib/safety.ts';
import './lib/pins.ts';
import './lib/export.ts';
import './lib/book.ts';
import './lib/stars.ts';
import './lib/receipts.ts';
import './lib/presence.ts';
import './lib/groups.ts';
import './lib/polls.ts';
import './lib/linkpreview.ts';
import './lib/cards.ts';
import './lib/uploads.ts';
import './lib/gifs.ts';
import { purgeExpired, purgeViewOnce } from './lib/deletes.ts';
import { purgeStaleTransfers } from './lib/e2ee.ts';
import './lib/archive.ts';
import './lib/admin.ts';
import './routes/auth.ts';
import './routes/pin.ts';
import './routes/circles.ts';
import './routes/requests.ts';
import './routes/storage.ts';
import './routes/lists.ts';
import './routes/moments.ts';
import './routes/attachments.ts';
import './routes/albums.ts';
import './routes/search.ts';
import './routes/push.ts';
import './routes/sealed.ts';
import './routes/safety.ts';
import './routes/pins.ts';
import './routes/export.ts';
import './routes/book.ts';
import './routes/handoff.ts';
import './routes/avatar.ts';
import './routes/stars.ts';
import './routes/receipts.ts';
import './routes/presence.ts';
import './routes/groups.ts';
import './routes/polls.ts';
import './routes/uploads.ts';
import './routes/sharing.ts';
import './routes/privacy.ts';
import './routes/keys.ts';
import './routes/e2ee.ts';
import './routes/calls.ts';
import './routes/deletes.ts';
import './routes/archive.ts';
import './routes/admin.ts';
import './routes/admin-people.ts';
import './routes/admin-capacity.ts';
import './routes/admin-announce.ts';
import './routes/admin-ops.ts';
import './routes/admin-security.ts';
import './routes/payments.ts';
import './routes/plans.ts';
import './routes/today.ts';
import './routes/support.ts';
import './routes/agent.ts';

export { app } from './app.ts';
export { insertMessage, markDelivered, markRead, announce, announceUpdate, poke } from './lib/helpers.ts';
export { setSmsProvider } from './lib/auth.ts';
export { purgeDeletedCircles } from './lib/circles.ts';
export { sendText, SYNC_PAGE, messagesSince, messagesChanged, messagesAfter } from './lib/moments.ts';
export { releaseDueSealed } from './lib/sealed.ts';

// ---- static web app -----------------------------------------------------------

// Caching: files under /assets have a content hash in their name, so they never change and can be kept forever.
// Everything else (the page itself, the service worker) must be re-checked every time, otherwise a browser
// keeps showing an old version of the app after an update.
const caching = (path: string, c: Context) => {
  c.header('Cache-Control', path.includes('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
};
// An unknown API address is a JSON 404, never the web page (a client must not mistake the page for data).
app.all('/api/*', c => c.json({ error: 'not_found' }, 404));
app.use('/*', serveStatic({ root: './dist', onFound: caching }));
// The page is app.html, not index.html: a panel host's web server serves whatever index file it finds in the
// document root by itself, and the page would then arrive without the headers above - losing the CSP for the
// whole session, since the first document's policy is the one that governs an SPA. scripts/seal-html.mjs
// renames it at the end of the build so the request has to come here.
app.get('*', serveStatic({ path: './dist/app.html', onFound: caching }));
/** HTTP + the live gateway on one port. Exported so tests can start it on a free port. */
export function startServer(port: number, onListening?: (port: number) => void, hostname?: string) {
  const server = serve({ fetch: app.fetch, port, ...(hostname ? { hostname } : {}) }, i => onListening?.(i.port)) as import('node:http').Server;
  // A backup a day (and one shortly after start if the newest is older than 20 hours), keeping seven. THIKRA_BACKUP=0 turns it off.
  if (process.env.THIKRA_BACKUP !== '0') {
    const nightly = trackJob('backup', 24 * 3600_000, async () => { await createBackup(); await pruneBackups(7); console.log('[backup] done'); });
    setTimeout(async () => {
      const newest = (await listBackups().catch(() => []))[0];
      if (!newest || Date.now() - Date.parse(newest.createdAt) > 20 * 3600_000) await nightly();
    }, 2 * 60_000).unref();
    setInterval(nightly, 24 * 3600_000).unref();
  }
  // Managers are warned at 80, 95 and 100 percent of a family's space (shortly after start, then hourly).
  const quota = trackJob('quota.alerts', 3600_000, async () => { const n = await checkQuotaAlerts(); if (n) console.log(`[quota] warned ${n} family(ies)`); });
  setTimeout(quota, 5 * 60_000).unref();
  setInterval(quota, 3600_000).unref();
  // Disappearing messages and view-once files go when their time comes (checked every 30 seconds; the web also hides an expired message at once).
  setInterval(trackJob('expiry', 30_000, async () => { await purgeExpired(); await purgeViewOnce(); purgeStaleTransfers(); }), 30_000).unref();
  // Scheduled push broadcasts go out when they are due (checked every minute).
  setInterval(trackJob('broadcasts', 60_000, async () => { const n = await runBroadcasts(); if (n) console.log(`[broadcast] sent ${n}`); }), 60_000).unref();
  // The agent writes the morning and evening summaries and pushes to the owner only for NEW serious items (checked every 30 minutes).
  const brief = trackJob('agent.brief', 30 * 60_000, () => briefTick());
  setTimeout(brief, 3 * 60_000).unref();
  setInterval(brief, 30 * 60_000).unref();
  // The numbers the admin screen shows (daily rows, archive size per family, totals) are rebuilt in the background every hour, so opening it never scans the big tables.
  const rollups = trackJob('rollups', 3600_000, () => refreshAll());
  setTimeout(rollups, 20_000).unref();
  setInterval(rollups, 3600_000).unref();
  startOffsite();   // a copy of the data off this server's disk (only when configured, or on a published deployment)
  attachGateway(server, {
    // The live gateway obeys the same rules as the HTTP routes: a frozen family and maintenance stop new messages, but a retry of one already stored is still accepted.
    sendText: (circleId, userId, body, cmid, replyTo, mentions, preview) => {
      if (!(cmid && one('SELECT 1 FROM messages WHERE circle_id = ? AND user_id = ? AND client_msg_id = ?', circleId, userId, cmid))) {
        if (maintenanceNow()) throw Object.assign(new Error('maintenance'), { code: 'maintenance' });
        if (isFrozen(circleId)) throw Object.assign(new Error('circle_frozen'), { code: 'circle_frozen' });
      }
      return sendText(circleId, userId, body, cmid, replyTo, 0, mentions, preview);
    },
    membership, limited, messagesSince, messagesChanged, syncPage: SYNC_PAGE, markRead,
    calls: { attach: attachCalls, frame: callFrame },
    known: (circleId, userId, cmid) => !!one('SELECT 1 FROM messages WHERE circle_id = ? AND user_id = ? AND client_msg_id = ?', circleId, userId, cmid),
  });
  return server;
}
if (process.env.THIKRA_NO_LISTEN !== '1') {
  const mode = startupMode();
  console.log(mode.line);
  startServer(Number(process.env.PORT ?? 8787), p => console.log(`Tamtim API on http://localhost:${p}`), mode.localOnly ? '127.0.0.1' : undefined);
}

