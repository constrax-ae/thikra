import { app } from '../app.ts';
import { audit, requireAdmin } from '../lib/admin.ts';
import { appConfig, costSettings, overview, saveAppConfig, saveCostSettings } from '../lib/opsinfo.ts';
import { stageRestore } from '../backup.ts';
import { cancelPending } from '../pending-restore.ts';
import { dbFile } from '../db.ts';

// The machine room, for the owner: background jobs, errors, outside services, cost against a budget, the minimum app version, and restoring a backup (staged, applied at the next start).
const text = (v: unknown, max: number) => (typeof v === 'string' ? v.trim().slice(0, max) : '');

/** What apps read at start: the oldest version that still works, the newest one, and a message to show when an update is needed. No sign-in needed. */
app.get('/api/app-config', c => c.json(appConfig()));

app.get('/api/admin/ops', requireAdmin('metrics'), c => c.json(overview()));

app.post('/api/admin/ops/costs', requireAdmin('metrics'), async c => {
  const b = await c.req.json().catch(() => ({}));
  const hostingUSD = Number(b.hostingUSD), smsEachUSD = Number(b.smsEachUSD), budgetUSD = Number(b.budgetUSD);
  if (![hostingUSD, smsEachUSD, budgetUSD].every(n => Number.isFinite(n) && n >= 0) || hostingUSD > 1e6 || smsEachUSD > 10 || budgetUSD > 1e7) return c.json({ error: 'invalid_value' }, 400);
  const before = costSettings();
  saveCostSettings({ hostingUSD, smsEachUSD, budgetUSD });
  audit(c, 'ops.set_costs', { type: 'ops', id: 'costs' }, { from: before, to: { hostingUSD, smsEachUSD, budgetUSD } });
  return c.json({ ok: true });
});

/** The rule apps follow: below `minVersion` they ask the person to update. Versions look like 1.2.3 (or empty for "no rule"). */
app.post('/api/admin/ops/app-config', requireAdmin('metrics'), async c => {
  const b = await c.req.json().catch(() => ({}));
  const ver = (v: unknown) => (typeof v === 'string' && /^\d{1,4}(\.\d{1,4}){0,2}$/.test(v.trim()) ? v.trim() : v === '' || v === undefined ? '' : null);
  const minVersion = ver(b.minVersion), latestVersion = ver(b.latestVersion);
  if (minVersion === null || latestVersion === null) return c.json({ error: 'invalid_value' }, 400);
  const before = appConfig();
  saveAppConfig({ minVersion, latestVersion, messageAr: text(b.messageAr, 200), messageEn: text(b.messageEn, 200) });
  audit(c, 'ops.set_app_config', { type: 'ops', id: 'app_config' }, { from: { min: before.minVersion, latest: before.latestVersion }, to: { min: minVersion, latest: latestVersion } });
  return c.json({ ok: true });
});

/** Stage a restore: the backup must verify; nothing changes until the server restarts, and the current database is kept beside the restored one. Needs `confirm: "RESTORE"`. */
app.post('/api/admin/backups/:id/restore', requireAdmin('backups'), async c => {
  const id = String(c.req.param('id'));
  const b = await c.req.json().catch(() => ({}));
  if (b.confirm !== 'RESTORE') return c.json({ error: 'confirm_required' }, 400);
  const r = await stageRestore(id, c.get('user').name);
  audit(c, 'backup.restore_stage', { type: 'backup', id }, { ok: r.ok, problems: r.problems.slice(0, 3) });
  return r.ok ? c.json({ ok: true, appliesAt: 'next start', db: dbFile }) : c.json({ error: 'backup_invalid', problems: r.problems }, 409);
});
app.post('/api/admin/restore/cancel', requireAdmin('backups'), c => {
  cancelPending(dbFile);
  audit(c, 'backup.restore_cancel', { type: 'backup', id: 'pending' });
  return c.json({ ok: true });
});
