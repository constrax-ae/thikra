import { Icon } from './icons';
import { useEffect, useState } from 'react';
import { api, ApiError, type Me } from './api';
import { useI18n } from './i18n';
import { Dialog } from './Dialog';
import { TableSkeleton, Badge } from './States';

interface Stats { users: number; circles: number; activeCircles: number; messages: number; archived: number; byCategory: Array<{ category: string; n: number }> }
interface Lat { n: number; p50: number | null; p95: number | null }
interface Health { uptimeSeconds: number; gauges: { connections: number }; latency: Record<string, Lat> }
interface Backup { id: string; createdAt: string; dbBytes: number; counts: { messages: number }; files: number }
interface AdminCircle { id: number; name: string; sensitivity: string; agentActive: number; members: number; archived: number }

function Overview({ role }: { role: Role }) {
  const { t } = useI18n();
  const [off, setOff] = useState<{ kind: string; ready: boolean; lastSnapshotAt: string | null; lastError: string | null; restoredAt: string | null } | null>(null);
  useEffect(() => { if (role === 'owner') api<NonNullable<typeof off>>('/admin/offsite').then(setOff).catch(() => {}); }, [role]);
  const [stats, setStats] = useState<Stats>();
  const [circles, setCircles] = useState<AdminCircle[]>([]);
  const [health, setHealth] = useState<Health>();
  const [backups, setBackups] = useState<Backup[]>([]);
  const [verdict, setVerdict] = useState<Record<string, string>>({});
  const [busy, setBusy] = useState(false);
  const loadBackups = () => api<Backup[]>('/admin/backups').then(setBackups).catch(() => {});
  useEffect(() => {
    api<Stats>('/admin/stats').then(setStats).catch(() => {});
    if (role !== 'support') api<AdminCircle[]>('/admin/circles').then(setCircles).catch(() => {});
    if (role === 'owner') { loadBackups(); const load = () => api<Health>('/admin/metrics').then(setHealth).catch(() => {}); load(); const timer = setInterval(load, 10_000); return () => clearInterval(timer); }
    return undefined;
  }, []);
  if (!stats) return <TableSkeleton rows={4} cols={3} />;

  const tiles: Array<[string, number]> = [
    [t.users, stats.users], [t.circles, stats.circles], [t.activeCircles, stats.activeCircles],
    [t.messages, stats.messages], [t.archivedCount, stats.archived],
  ];
  return (
    <div className="space-y-4">
      <p className="text-sm text-muted">{t.adminNote}</p>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
        {tiles.map(([label, n]) => (
          <div key={label} className="card p-3 text-center"><div className="text-2xl font-bold text-green">{n}</div><div className="text-xs text-muted">{label}</div></div>
        ))}
      </div>
      {health && (
        <div className="space-y-2">
          <h3 className="font-bold text-green">{t.healthTitle}</h3>
          <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">
            {([[t.msgStore, health.latency.store_ms], [t.msgFanout, health.latency.fanout_ms], [t.httpTime, health.latency.http_ms]] as Array<[string, Lat | undefined]>).map(([label, l]) => (
              <div key={label} className="card p-3 text-center">
                <div className="text-lg font-bold text-green" dir="ltr">{l ? `${l.p50 ?? '–'} / ${l.p95 ?? '–'}` : '–'}</div>
                <div className="text-xs text-muted">{label}</div>
              </div>
            ))}
            <div className="card p-3 text-center"><div className="text-lg font-bold text-green">{health.gauges.connections}</div><div className="text-xs text-muted">{t.liveConnections}</div></div>
            <div className="card p-3 text-center"><div className="text-lg font-bold text-green">{Math.round(health.uptimeSeconds / 60)}</div><div className="text-xs text-muted">{t.uptime}</div></div>
          </div>
          <p className="text-xs text-muted">{t.healthNote}</p>
        </div>
      )}
      <section className="space-y-2">
        {role === 'owner' && <h3 className="font-bold text-green">{t.backupsTitle}</h3>}
        <p className="text-xs text-muted">{t.backupNote}</p>
        {off && (
          <p role="status" className={`text-sm rounded-lg p-2 ${off.ready && !off.lastError ? 'bg-green-soft text-green' : 'bg-gold/15 text-gold-dark'}`}>
            {off.ready ? `${t.offReady}${off.lastSnapshotAt ? ` · ${t.offLast}: ${off.lastSnapshotAt.replace('T', ' ').slice(0, 16)} UTC` : ` · ${t.offWaiting}`}` : t.offNot}{off.lastError ? ` · ${off.lastError}` : ''}{off.restoredAt ? ` · ${t.offRestored}` : ''}
          </p>
        )}
        <button className="btn btn-ghost" disabled={busy} onClick={async () => { setBusy(true); try { await api('/admin/backups', { method: 'POST', body: {} }); await loadBackups(); } finally { setBusy(false); } }}>{t.backupNow}</button>
        {backups.length === 0 ? <p className="text-sm text-muted">{t.backupNone}</p> : (
          <ul className="card divide-y divide-line">
            {backups.map(b => (
              <li key={b.id} className="p-3 flex items-center gap-2 text-sm">
                <span className="flex-1 min-w-0"><b dir="ltr" className="block truncate">{b.id}</b><span className="text-xs text-muted">{b.counts.messages} · {b.files} {t.backupFiles} · {Math.round(b.dbBytes / 1024)} KB</span></span>
                {verdict[b.id] && <span className={verdict[b.id] === 'ok' ? 'text-green' : 'text-danger'}>{verdict[b.id] === 'ok' ? t.backupVerified : t.backupFailed}</span>}
                <button className="btn btn-ghost !py-1 text-sm" onClick={async () => { const r = await api<{ ok: boolean }>(`/admin/backups/${encodeURIComponent(b.id)}/verify`, { body: {} }); setVerdict(v => ({ ...v, [b.id]: r.ok ? 'ok' : 'bad' })); }}>{t.backupVerify}</button>
              </li>
            ))}
          </ul>
        )}
      </section>
      <ul className="card divide-y divide-line">
        {circles.map(c => (
          <li key={c.id} className="p-3 flex items-center gap-3">
            <b className="flex-1 truncate">{c.name}</b>
            <span className="text-xs text-muted">{c.members} {t.members} · {c.archived} {t.archivedCount}</span>
            <Badge tone={c.agentActive ? 'warn' : 'neutral'}>
              {c.agentActive ? t.agentOn : t.agentOff}
            </Badge>
          </li>
        ))}
      </ul>
    </div>
  );
}

type Role = 'owner' | 'moderator' | 'support';
type Tab = 'security' | 'ops' | 'announce' | 'families' | 'agent' | 'support' | 'storage' | 'overview' | 'analytics' | 'reports' | 'users' | 'audit' | 'staff' | 'settings';
/** What each role sees (the server enforces it; this only hides what would be refused). */
const TABS: Record<Role, Tab[]> = { owner: ['agent', 'overview', 'support', 'storage', 'analytics', 'reports', 'users', 'families', 'announce', 'ops', 'security', 'audit', 'staff', 'settings'], moderator: ['agent', 'overview', 'support', 'analytics', 'reports', 'users', 'families', 'security', 'audit', 'staff'], support: ['overview', 'support', 'users', 'security', 'staff'] };

interface Report { id: number; reason: string; note: string | null; snapshot: string | null; status: 'open' | 'escalated' | 'resolved'; action: string | null; resolution: string | null; createdAt: string; reporter: string | null; reported: string | null; resolvedBy: string | null; messageId: number | null; reportedUserId: number | null }
interface Person { lastActive?: string | null; familiesOf?: Array<{ id: number; name: string; role: string; frozen: boolean }>; notes?: Array<{ id: number; body: string; createdAt: string; author: string | null }>; openReportsAgainst?: number; supportCases?: number; id: number; name: string; phone: string; phoneFull?: string; lang: string; region: string | null; createdAt: string; role: Role | null; suspended: boolean; suspendedUntil: string | null; suspendedReason: string | null; circles: number; messages?: number; reportsAgainst?: number; activeSessions?: number; hasPin?: boolean; banned?: boolean }
interface AuditRow { id: number; actor: string | null; actorRole: string | null; action: string; targetType: string | null; targetId: string | null; detail: Record<string, unknown> | null; createdAt: string }

const useFail = () => { const { t } = useI18n(); return (e: unknown) => t.errors[e instanceof ApiError ? e.code : 'generic'] ?? t.errors.generic; };

function ReportsTab() {
  const { t } = useI18n();
  const fail = useFail();
  const [list, setList] = useState<Report[]>([]);
  const [open, setOpen] = useState<number | null>(null);
  const [action, setAction] = useState('dismiss');
  const [note, setNote] = useState('');
  const [days, setDays] = useState('');
  const [error, setError] = useState('');
  const load = () => api<Report[]>('/admin/reports').then(setList).catch(() => {});
  useEffect(() => { load(); }, []);
  async function decide(r: Report) {
    setError('');
    try { await api(`/admin/reports/${r.id}/action`, { body: { action, note, ...(action === 'suspend_user' && Number(days) > 0 ? { days: Number(days) } : {}) } }); setOpen(null); setNote(''); setDays(''); load(); }
    catch (e) { setError(fail(e)); }
  }
  const chip: Record<string, string> = { open: 'bg-gold/20 text-gold-dark', escalated: 'bg-danger-soft text-danger', resolved: 'bg-green-soft text-green' };
  return (
    <section className="space-y-2">
      <p className="text-xs text-muted">{t.admReportsNote}</p>
      {list.length === 0 ? <p className="text-sm text-muted">{t.noReports}</p> : (
        <ul className="card divide-y divide-line">
          {list.map(r => (
            <li key={r.id} className="p-3 space-y-1">
              <div className="flex flex-wrap items-center gap-2 text-xs text-muted">
                <span className={`px-2 py-0.5 rounded-full ${chip[r.status]}`}>{t.admStatus[r.status]}</span>
                <span>{t.reportedBy}: {r.reporter ?? '—'} · {t.reportedUser}: {r.reported ?? '—'} · {t.reportReasons[r.reason]}</span>
                {r.action && <span>→ {t.admActions[r.action] ?? r.action}{r.resolvedBy ? ` (${r.resolvedBy})` : ''}</span>}
              </div>
              {r.snapshot && <p className="whitespace-pre-wrap break-words">{r.snapshot}</p>}
              {r.note && <p className="text-sm text-muted">{r.note}</p>}
              {r.resolution && <p className="text-sm text-muted flex items-start gap-1.5"><Icon name="pen" className="w-4 h-4 shrink-0 mt-0.5" />{r.resolution}</p>}
              {r.status !== 'resolved' && (open === r.id ? (
                <div className="space-y-2 pt-1">
                  <select className="field" value={action} onChange={e => setAction(e.target.value)} aria-label={t.admAction}>
                    {['dismiss', 'warn', 'remove_message', 'suspend_user', 'ban', 'escalate'].map(a => <option key={a} value={a}>{t.admActions[a]}</option>)}
                  </select>
                  {action === 'suspend_user' && <input className="field" inputMode="numeric" placeholder={t.admDays} value={days} onChange={e => setDays(e.target.value.replace(/\D/g, ''))} />}
                  <input className="field" placeholder={t.admNote} maxLength={500} value={note} onChange={e => setNote(e.target.value)} />
                  {action === 'ban' && <p className="text-xs text-danger">{t.admBanWarn}</p>}
                  {error && <p role="alert" className="text-sm text-danger">{error}</p>}
                  <div className="flex gap-2"><button className="btn flex-1" onClick={() => decide(r)}>{t.admApply}</button><button className="btn btn-ghost" onClick={() => setOpen(null)}>{t.cancel}</button></div>
                </div>
              ) : <button className="btn btn-ghost !py-1 text-sm" onClick={() => { setOpen(r.id); setError(''); }}>{t.admDecide}</button>)}
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}

interface Note { id: number; body: string; createdAt: string; author: string | null }
interface Family { periodEnd?: string | null; id: number; name: string; kind: string; members: number; archived: number; openReports: number; lastActivity: string | null; frozen: boolean; frozenReason: string | null; plan: string; status: string; usedGB: number; quotaGB: number; percent: number; bonusGB?: number; agentActive?: boolean; membersList?: Array<{ id: number; name: string; phone: string; role: string; suspended: boolean }>; notes?: Note[]; history?: Array<{ action: string; createdAt: string; actor: string | null }>; supportCases?: number }

/** Two taps for anything that cannot be undone: the first arms the button, the second does it. */
function useArm() {
  const [armed, setArmed] = useState('');
  return { armed, tap: (key: string, go: () => void) => { if (armed === key) { setArmed(''); go(); } else setArmed(key); } };
}

function NotesBox({ type, id, notes, reload }: { type: 'user' | 'circle'; id: number; notes: Note[]; reload: () => void }) {
  const { t } = useI18n();
  const fail = useFail();
  const [body, setBody] = useState('');
  const [err, setErr] = useState('');
  async function add() { if (!body.trim()) return; setErr(''); try { await api('/admin/notes', { body: { type, id, body } }); setBody(''); reload(); } catch (e) { setErr(fail(e)); } }
  return (
    <div className="space-y-2">
      <b className="text-sm">{t.ppNotes}</b>
      <div className="flex gap-2"><input className="field" placeholder={t.ppNotePh} value={body} maxLength={1000} onChange={e => setBody(e.target.value)} /><button className="btn shrink-0" onClick={add}>{t.ppAddNote}</button></div>
      {err && <p role="status" className="text-sm text-danger">{err}</p>}
      <ul className="space-y-1.5">{notes.map(n => <li key={n.id} className="text-sm card p-2"><div>{n.body}</div><div className="text-[11px] text-muted">{n.author ?? '—'} · {n.createdAt}</div></li>)}</ul>
    </div>
  );
}

function Chips({ value, options, onPick }: { value: string; options: Record<string, string>; onPick: (k: string) => void }) {
  return <div className="flex gap-1.5 overflow-x-auto pb-1">{Object.entries(options).map(([k, label]) => <button key={k} type="button" aria-pressed={value === k} onClick={() => onPick(k)} className={`px-3 py-1.5 rounded-full text-xs whitespace-nowrap border transition-[background-color,border-color,color] duration-[var(--dur-instant)] ease-[var(--ease-standard)] ${value === k ? 'bg-brand text-white border-brand font-bold' : 'border-line text-muted hover:border-green/50 hover:text-green'}`}>{label}</button>)}</div>;
}

function UsersTab({ role, onFamily }: { role: Role; onFamily: (id: number) => void }) {
  const { t } = useI18n();
  const fail = useFail();
  const arm = useArm();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [list, setList] = useState<Person[] | null>(null);
  const [more, setMore] = useState(false);
  const [sel, setSel] = useState<Person | null>(null);
  const [reason, setReason] = useState('');
  const [days, setDays] = useState('');
  const [msg, setMsg] = useState('');
  const query = (f: string, before?: number) => `/admin/users?q=${encodeURIComponent(q.trim())}${f !== 'all' ? `&filter=${f}` : ''}${before ? `&before=${before}` : ''}`;
  const search = (f = filter) => api<Person[]>(query(f)).then(r => { setList(r); setMore(r.length === 50); }).catch(() => setList([]));
  const loadMore = () => list?.length && api<Person[]>(query(filter, list[list.length - 1].id)).then(r => { setList([...list, ...r]); setMore(r.length === 50); }).catch(() => {});
  useEffect(() => { search(); }, []);
  const open = (id: number, reveal = false) => api<Person>(`/admin/users/${id}${reveal ? '?reveal=1' : ''}`).then(setSel).catch(e => setMsg(fail(e)));
  async function act(path: string, body: unknown = {}) {
    if (!sel) return; setMsg('');
    try { await api(`/admin/users/${sel.id}/${path}`, { body }); if (path === 'delete') { setSel(null); } else await open(sel.id); search(); setMsg(t.admDone); } catch (e) { setMsg(fail(e)); }
  }
  const canAct = role !== 'support';
  return (
    <section className="space-y-3">
      <form className="flex gap-2" onSubmit={e => { e.preventDefault(); setSel(null); search(); }}>
        <input className="field" placeholder={t.admSearchPeople} value={q} onChange={e => setQ(e.target.value)} />
        <button className="btn shrink-0">{t.search}</button>
      </form>
      <Chips value={filter} options={t.ppPeopleFilters} onPick={k => { setFilter(k); setSel(null); search(k); }} />
      <p className="text-xs text-muted">{t.admPeopleNote}</p>
      {sel ? (
        <div className="card p-3 space-y-3">
          <div className="flex items-center gap-2"><b className="flex-1 truncate">{sel.name}</b>{sel.banned && <Badge tone="bad">{t.ppBannedTag}</Badge>}<button className="btn btn-ghost !py-1 text-sm" onClick={() => setSel(null)}>{t.back}</button></div>
          <div className="text-sm text-muted space-y-0.5">
            <div dir="ltr">{sel.phoneFull ?? sel.phone}</div>
            <div>{t.admCircles}: {sel.circles} · {t.admMessages}: {sel.messages ?? '—'} · {t.admReportsAgainst}: {sel.reportsAgainst ?? '—'} ({t.ppOpenReports}: {sel.openReportsAgainst ?? 0})</div>
            <div>{t.admSessions}: {sel.activeSessions ?? '—'} · {t.admPin}: {sel.hasPin ? <Icon name="check" className="w-4 h-4 inline text-green" /> : '—'} · {sel.role ? t.admRoles[sel.role] : ''} · {t.ppSupportCases}: {sel.supportCases ?? 0}</div>
            <div>{t.ppLastActive}: {sel.lastActive ?? '—'}</div>
            {sel.suspended && <div className="text-danger">{t.admSuspended}{sel.suspendedUntil ? ` → ${sel.suspendedUntil}` : ''}{sel.suspendedReason ? `: ${sel.suspendedReason}` : ''}</div>}
          </div>
          {(sel.familiesOf?.length ?? 0) > 0 && (
            <div className="space-y-1"><b className="text-sm">{t.ppFamilies}</b>
              <div className="flex flex-wrap gap-1.5">{sel.familiesOf!.map(f => <button key={f.id} className="btn btn-ghost !py-1 text-xs" onClick={() => onFamily(f.id)}>{f.name}{f.frozen && <Icon name="snow" className="w-3.5 h-3.5" />}</button>)}</div></div>
          )}
          {role !== 'support' && !sel.phoneFull && <button className="btn btn-ghost !py-1 text-sm" onClick={() => open(sel.id, true)}>{t.admReveal}</button>}
          {canAct && (
            <div className="space-y-2 pt-1">
              {sel.suspended
                ? <button className="btn btn-ghost w-full" onClick={() => act('unsuspend')}>{t.admUnsuspend}</button>
                : <div className="flex gap-2"><input className="field" placeholder={t.admNote} value={reason} onChange={e => setReason(e.target.value)} /><input className="field !w-24" inputMode="numeric" placeholder={t.admDays} value={days} onChange={e => setDays(e.target.value.replace(/\D/g, ''))} /><button className="btn shrink-0" onClick={() => act('suspend', { reason, days: Number(days) || 0 })}>{t.admSuspend}</button></div>}
              <button className="btn btn-ghost w-full" onClick={() => act('revoke-sessions')}>{t.admRevoke}</button>
              {sel.banned
                ? <button className="btn btn-ghost w-full" onClick={() => act('unban')}>{t.ppUnban}</button>
                : <button className={`btn btn-ghost w-full text-danger ${arm.armed === 'ban' ? 'btn-armed' : ''}`} onClick={() => arm.tap('ban', () => act('ban', { reason }))}>{arm.armed === 'ban' ? t.ppTapAgain : t.ppBan}</button>}
              {role === 'owner' && <button className={`btn btn-ghost w-full text-danger ${arm.armed === 'del' ? 'btn-armed' : ''}`} onClick={() => arm.tap('del', () => act('delete', { confirm: true, reason }))}>{arm.armed === 'del' ? t.ppTapAgain : t.ppDelete}</button>}
              {role === 'owner' && (
                <div className="flex items-center gap-2"><span className="text-sm flex-1">{t.admRole}</span>
                  <select className="field !w-auto" value={sel.role ?? ''} onChange={e => act('role', { role: e.target.value || null })}>
                    <option value="">{t.admNoRole}</option>{(['owner', 'moderator', 'support'] as Role[]).map(r => <option key={r} value={r}>{t.admRoles[r]}</option>)}
                  </select></div>
              )}
            </div>
          )}
          <NotesBox type="user" id={sel.id} notes={sel.notes ?? []} reload={() => open(sel.id)} />
          {msg && <p role="status" className="text-sm text-muted">{msg}</p>}
        </div>
      ) : list === null ? <TableSkeleton rows={6} cols={3} /> : list.length === 0 ? <p className="text-sm text-muted">{t.admNoPeople}</p> : (
        <>
          <ul className="card divide-y divide-line">
            {list.map(u => (
              <li key={u.id}><button className="row-interactive w-full p-3 text-start flex items-center gap-2" onClick={() => { setMsg(''); open(u.id); }}>
                <span className="flex-1 min-w-0"><b className="block truncate">{u.name}</b><span className="text-xs text-muted" dir="ltr">{u.phone}{u.lastActive ? ` · ${u.lastActive}` : ''}</span></span>
                {u.role && <Badge tone="warn">{t.admRoles[u.role]}</Badge>}
                {u.suspended && <Badge tone="bad">{t.admSuspended}</Badge>}
              </button></li>
            ))}
          </ul>
          {more && <button className="btn btn-ghost w-full" onClick={loadMore}>{t.ppMore}</button>}
        </>
      )}
    </section>
  );
}

function FamiliesTab({ role, focus }: { role: Role; focus: number | null }) {
  const { t } = useI18n();
  const fail = useFail();
  const arm = useArm();
  const [q, setQ] = useState('');
  const [filter, setFilter] = useState('all');
  const [list, setList] = useState<Family[] | null>(null);
  const [more, setMore] = useState(false);
  const [sel, setSel] = useState<Family | null>(null);
  const [reason, setReason] = useState('');
  const [bonus, setBonus] = useState('');
  const [planSel, setPlanSel] = useState('free');
  const [until, setUntil] = useState('');
  const [planReason, setPlanReason] = useState('');
  const [msg, setMsg] = useState('');
  const query = (f: string, before?: number) => `/admin/families?q=${encodeURIComponent(q.trim())}${f !== 'all' ? `&filter=${f}` : ''}${before ? `&before=${before}` : ''}`;
  const search = (f = filter) => api<Family[]>(query(f)).then(r => { setList(r); setMore(r.length === 50); }).catch(() => setList([]));
  const loadMore = () => list?.length && api<Family[]>(query(filter, list[list.length - 1].id)).then(r => { setList([...list, ...r]); setMore(r.length === 50); }).catch(() => {});
  const open = (id: number) => api<Family>(`/admin/families/${id}`).then(f => { setSel(f); setBonus(String(f.bonusGB ?? 0)); setPlanSel(f.plan); setUntil(f.periodEnd ?? ''); setPlanReason(''); }).catch(e => setMsg(fail(e)));
  useEffect(() => { search(); }, []);
  useEffect(() => { if (focus) open(focus); }, [focus]);
  async function act(path: string, body: unknown) {
    if (!sel) return; setMsg('');
    try { await api(`/admin/families/${sel.id}/${path}`, { body }); await open(sel.id); search(); setMsg(t.admDone); } catch (e) { setMsg(fail(e)); }
  }
  async function saveBonus() { if (!sel) return; setMsg(''); try { await api(`/admin/circles/${sel.id}/plan`, { body: { plan: planSel, until: planSel === 'free' ? null : until || null, bonusGB: Number(bonus) || 0, reason: planReason } }); await open(sel.id); setMsg(t.admDone); } catch (e) { setMsg(fail(e)); } }
  const bar = (f: Family) => <div className="h-1.5 rounded-full bg-line overflow-hidden"><div className={`h-full ${f.percent >= 95 ? 'bg-danger' : f.percent >= 80 ? 'bg-gold' : 'bg-green'}`} style={{ width: `${Math.min(100, f.percent)}%` }} /></div>;
  return (
    <section className="space-y-3">
      <form className="flex gap-2" onSubmit={e => { e.preventDefault(); setSel(null); search(); }}>
        <input className="field" placeholder={t.ppSearchFam} value={q} onChange={e => setQ(e.target.value)} />
        <button className="btn shrink-0">{t.search}</button>
      </form>
      <Chips value={filter} options={t.ppFamFilters} onPick={k => { setFilter(k); setSel(null); search(k); }} />
      {sel ? (
        <div className="card p-3 space-y-3">
          <div className="flex items-center gap-2"><b className="flex-1 truncate">{sel.name}</b>{sel.frozen && <Badge tone="warn">{t.ppFrozen}</Badge>}<button className="btn btn-ghost !py-1 text-sm" onClick={() => setSel(null)}>{t.back}</button></div>
          <div className="text-sm text-muted space-y-1">
            <div>{sel.members} {t.ppMembers} · {sel.archived} {t.ppArchived} · {t.ppOpenReports}: {sel.openReports} · {t.ppSupportCases}: {sel.supportCases ?? 0}</div>
            <div>{t.ppStorage}: {sel.usedGB} / {sel.quotaGB} GB ({sel.plan}{sel.status === 'readonly' ? ` · ${t.ppReadonly}` : ''})</div>
            {bar(sel)}
            {sel.frozenReason && <div className="text-gold-dark">{sel.frozenReason}</div>}
          </div>
          {role !== 'support' && (
            <div className="space-y-2">
              {sel.frozen
                ? <button className="btn btn-ghost w-full" onClick={() => act('freeze', { on: false })}>{t.ppUnfreeze}</button>
                : <div className="flex gap-2"><input className="field" placeholder={t.ppReason} value={reason} onChange={e => setReason(e.target.value)} /><button className="btn shrink-0" onClick={() => arm.tap('freeze', () => act('freeze', { on: true, reason }))}>{arm.armed === 'freeze' ? t.ppTapAgain : t.ppFreeze}</button></div>}
              {role === 'owner' && (
                <div className="card p-2 space-y-2">
                  <div className="text-xs text-muted">{t.capStatus[sel.status] ?? sel.status}{sel.periodEnd ? ` · ${sel.periodEnd}` : ''}</div>
                  <div className="flex gap-2 items-center"><span className="text-sm w-20">{t.capPlan}</span><select className="field !py-1" value={planSel} onChange={e => setPlanSel(e.target.value)}>{['free', 'family', 'heritage'].map(p => <option key={p} value={p}>{t.plans[p]}</option>)}</select></div>
                  {planSel !== 'free' && <div className="flex gap-2 items-center"><span className="text-sm w-20">{t.capUntil}</span><input className="field !py-1" type="date" dir="ltr" value={until} onChange={e => setUntil(e.target.value)} /></div>}
                  <div className="flex gap-2 items-center"><span className="text-sm flex-1">{t.ppBonus}</span><input className="field !w-24 !py-1" inputMode="decimal" value={bonus} onChange={e => setBonus(e.target.value.replace(/[^\d.]/g, ''))} /></div>
                  <input className="field !py-1" placeholder={t.capReasonPh} value={planReason} onChange={e => setPlanReason(e.target.value)} />
                  <button className="btn w-full" onClick={saveBonus}>{t.capSave}</button>
                  <p className="text-[11px] text-muted">{t.capGraceNote}</p>
                </div>
              )}
            </div>
          )}
          <div className="space-y-1.5">
            <b className="text-sm">{t.ppMembers}</b>
            <ul className="card divide-y divide-line">
              {(sel.membersList ?? []).map(m => (
                <li key={m.id} className="p-2 flex items-center gap-2 text-sm">
                  <span className="flex-1 min-w-0"><b className="block truncate">{m.name}</b><span className="text-xs text-muted" dir="ltr">{m.phone}</span></span>
                  <span className="text-[11px] text-muted">{m.role === 'owner' ? t.ppOwner : m.role === 'admin' ? t.ppAdminRole : t.ppMemberRole}</span>
                  {role !== 'support' && m.role !== 'owner' && <>
                    <button className="btn btn-ghost !py-0.5 text-xs" onClick={() => arm.tap(`own${m.id}`, () => act('transfer', { userId: m.id, reason }))}>{arm.armed === `own${m.id}` ? t.ppTapAgain : t.ppMakeOwner}</button>
                    <button className="btn btn-ghost !py-0.5 text-xs text-danger" onClick={() => arm.tap(`rm${m.id}`, () => act('remove-member', { userId: m.id, reason }))}>{arm.armed === `rm${m.id}` ? t.ppTapAgain : t.ppRemove}</button>
                  </>}
                </li>
              ))}
            </ul>
          </div>
          <NotesBox type="circle" id={sel.id} notes={sel.notes ?? []} reload={() => open(sel.id)} />
          {(sel.history?.length ?? 0) > 0 && <div className="space-y-1"><b className="text-sm">{t.ppHistory}</b><ul className="text-xs text-muted space-y-0.5">{sel.history!.map((h, i) => <li key={i}>{h.createdAt} · {h.action} · {h.actor ?? '—'}</li>)}</ul></div>}
          {msg && <p role="status" className="text-sm text-muted">{msg}</p>}
        </div>
      ) : list === null ? <TableSkeleton rows={6} cols={3} /> : list.length === 0 ? <p className="text-sm text-muted">{t.ppNoFamilies}</p> : (
        <>
          <ul className="card divide-y divide-line">
            {list.map(f => (
              <li key={f.id}><button className="w-full p-3 text-start space-y-1.5" onClick={() => { setMsg(''); open(f.id); }}>
                <span className="flex items-center gap-2"><b className="flex-1 truncate">{f.name}</b>{f.frozen && <Badge tone="warn">{t.ppFrozen}</Badge>}{f.openReports > 0 && <Badge tone="bad">{f.openReports}</Badge>}</span>
                <span className="block text-xs text-muted">{f.members} {t.ppMembers} · {f.usedGB}/{f.quotaGB} GB · {f.plan}{f.lastActivity ? ` · ${f.lastActivity.slice(0, 10)}` : ''}</span>
                {bar(f)}
              </button></li>
            ))}
          </ul>
          {more && <button className="btn btn-ghost w-full" onClick={loadMore}>{t.ppMore}</button>}
        </>
      )}
    </section>
  );
}

function AuditTab() {
  const { t } = useI18n();
  const [rows, setRows] = useState<AuditRow[]>([]);
  const [more, setMore] = useState(true);
  const load = (before?: number) => api<AuditRow[]>(`/admin/audit?limit=50${before ? `&before=${before}` : ''}`).then(r => { setRows(p => before ? [...p, ...r] : r); setMore(r.length === 50); }).catch(() => setMore(false));
  useEffect(() => { load(); }, []);
  return (
    <section className="space-y-2">
      <p className="text-xs text-muted">{t.admAuditNote}</p>
      {rows.length === 0 ? <p className="text-sm text-muted">{t.admNoAudit}</p> : (
        <ul className="card divide-y divide-line">
          {rows.map(r => (
            <li key={r.id} className="p-3 text-sm">
              <div className="flex flex-wrap gap-x-2"><b dir="ltr">{r.action}</b><span className="text-muted">{r.actor ?? '—'}{r.actorRole ? ` (${r.actorRole})` : ''}</span>{r.targetType && <span className="text-muted" dir="ltr">{r.targetType} {r.targetId}</span>}</div>
              <div className="text-xs text-muted" dir="ltr">{r.createdAt}{r.detail ? ` · ${JSON.stringify(r.detail)}` : ''}</div>
            </li>
          ))}
        </ul>
      )}
      {more && rows.length > 0 && <button className="btn btn-ghost w-full" onClick={() => load(rows[rows.length - 1].id)}>{t.admMore}</button>}
    </section>
  );
}

function StaffTab() {
  const { t } = useI18n();
  const [list, setList] = useState<Array<{ id: number; name: string; role: Role }>>([]);
  useEffect(() => { api<Array<{ id: number; name: string; role: Role }>>('/admin/staff').then(setList).catch(() => {}); }, []);
  return (
    <section className="space-y-2">
      <p className="text-xs text-muted">{t.admStaffNote}</p>
      <ul className="card divide-y divide-line">
        {list.map(s => <li key={s.id} className="p-3 flex items-center gap-2"><b className="flex-1 truncate">{s.name}</b><Badge tone="warn">{t.admRoles[s.role]}</Badge></li>)}
      </ul>
    </section>
  );
}

interface Analytics { days: Array<{ d: string; signups: number; dau: number; messages: number; circles: number }>; wau: number; mau: number; trackingSince: string | null; retention: Record<'d1' | 'd7' | 'd30', { cohort: number; kept: number; rate: number | null }>; sealed: Record<string, number>; archivedLast30: number }

/** A row of 30 thin bars: a quick read of a trend, with no chart library. */
function Bars({ values, label }: { values: number[]; label: string }) {
  const max = Math.max(1, ...values);
  return (
    <div className="space-y-1">
      <div className="flex justify-between text-xs text-muted"><span>{label}</span><span dir="ltr">{values[values.length - 1]} · max {max}</span></div>
      <div className="flex items-end gap-[2px] h-12" dir="ltr" aria-hidden>{values.map((v, i) => <span key={i} className="flex-1 bg-green rounded-sm" style={{ height: `${Math.max(4, (v / max) * 100)}%`, opacity: i === values.length - 1 ? 1 : 0.55 }} />)}</div>
    </div>
  );
}

function AnalyticsTab() {
  const { t } = useI18n();
  const [a, setA] = useState<Analytics | null>(null);
  useEffect(() => { api<Analytics>('/admin/analytics').then(setA).catch(() => {}); }, []);
  if (!a) return null;
  const tiles: Array<[string, string | number]> = [[t.admWau, a.wau], [t.admMau, a.mau], [t.admRetD1, a.retention.d1.rate === null ? '–' : `${a.retention.d1.rate}%`], [t.admRetD7, a.retention.d7.rate === null ? '–' : `${a.retention.d7.rate}%`], [t.admRetD30, a.retention.d30.rate === null ? '–' : `${a.retention.d30.rate}%`]];
  return (
    <section className="space-y-3">
      <p className="text-xs text-muted">{t.admAnalyticsNote}{a.trackingSince ? ` (${t.admSince} ${a.trackingSince})` : ''}</p>
      <div className="grid grid-cols-2 sm:grid-cols-5 gap-2">{tiles.map(([l, v]) => <div key={l} className="card p-3 text-center"><div className="text-xl font-bold text-green">{v}</div><div className="text-xs text-muted">{l}</div></div>)}</div>
      <div className="card p-3 space-y-3">
        <Bars values={a.days.map(d => d.dau)} label={t.admDau} />
        <Bars values={a.days.map(d => d.signups)} label={t.admSignups} />
        <Bars values={a.days.map(d => d.messages)} label={t.admMsgsPerDay} />
        <Bars values={a.days.map(d => d.circles)} label={t.admNewCircles} />
      </div>
      <div className="text-sm text-muted">{t.admSealedCounts}: {Object.entries(a.sealed).map(([k, n]) => `${k} ${n}`).join(' · ') || '—'} · {t.admArchived30}: {a.archivedLast30}</div>
    </section>
  );
}

interface Flag { name: string; on: boolean; description: string }
interface SmsOps { provider: string; dailyCap: number; usedToday: number; allowedCodes: string[]; blockedCodes: string[]; countries: Array<{ code: string; sent: number; failed: number; blocked: number; capped: number; verified: number; completion: number | null }> }

function SettingsTab() {
  const { t } = useI18n();
  const fail = useFail();
  const [flags, setFlags] = useState<Flag[]>([]);
  const [sms, setSms] = useState<SmsOps | null>(null);
  const [blocked, setBlocked] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => { api<Flag[]>('/admin/flags').then(setFlags).catch(() => {}); api<SmsOps>('/admin/sms').then(x => { setSms(x); setBlocked(x.blockedCodes.join(', ')); }).catch(() => {}); };
  useEffect(() => { load(); }, []);
  async function flip(f: Flag) { setMsg(''); try { await api(`/admin/flags/${f.name}`, { body: { on: !f.on } }); load(); } catch (e) { setMsg(fail(e)); } }
  async function saveBlocked() { setMsg(''); try { await api('/admin/sms/blocked', { body: { codes: blocked.split(/[ ,]+/).filter(Boolean) } }); setMsg(t.admDone); load(); } catch (e) { setMsg(fail(e)); } }
  return (
    <section className="space-y-4">
      <div className="space-y-2">
        <h3 className="font-bold text-green">{t.admFlags}</h3>
        <ul className="card divide-y divide-line">
          {flags.map(f => (
            <li key={f.name} className="p-3 flex items-start gap-3">
              <span className="flex-1 min-w-0"><b dir="ltr" className="block">{f.name}</b><span className="text-sm text-muted">{f.description}</span></span>
              <button role="switch" aria-checked={f.on} aria-label={f.name} onClick={() => flip(f)} className={`shrink-0 w-12 h-7 rounded-full border ${f.on ? 'bg-brand border-brand' : 'bg-line border-line'} relative`}><span className={`absolute top-0.5 w-6 h-6 rounded-full bg-card transition-all ${f.on ? 'end-0.5' : 'start-0.5'}`} /></button>
            </li>
          ))}
        </ul>
      </div>
      {sms && (
        <div className="space-y-2">
          <h3 className="font-bold text-green">{t.admSms}</h3>
          <p className="text-sm text-muted" dir="ltr">{sms.provider} · {sms.usedToday} / {sms.dailyCap} {t.admToday}{sms.allowedCodes.length ? ` · allowed: ${sms.allowedCodes.join(',')}` : ''}</p>
          {/* Sticky header and zebra rows: this table is read by scanning down a column,
              and with many countries the header scrolls away without it. */}
          {sms.countries.length === 0 ? <p className="text-sm text-muted">{t.admNoSms}</p> : (
            <div className="card overflow-x-auto max-h-96 overflow-y-auto"><table className="w-full text-sm" dir="ltr">
              <thead className="sticky top-0 z-10 bg-card"><tr className="text-muted text-xs"><th className="p-2 text-start">+</th><th className="p-2">sent</th><th className="p-2">verified</th><th className="p-2">%</th><th className="p-2">failed</th><th className="p-2">blocked</th></tr></thead>
              <tbody>{sms.countries.map(c => <tr key={c.code} className="border-t border-line text-center even:bg-paper/60"><td className="p-2 text-start font-bold">{c.code}</td><td>{c.sent}</td><td>{c.verified}</td><td>{c.completion ?? '–'}</td><td>{c.failed}</td><td>{c.blocked}</td></tr>)}</tbody></table></div>
          )}
          <label className="block text-sm font-medium">{t.admBlockCodes}</label>
          <div className="flex gap-2"><input className="field" dir="ltr" placeholder="e.g. 7, 234" value={blocked} onChange={e => setBlocked(e.target.value)} /><button className="btn shrink-0" onClick={saveBlocked}>{t.save}</button></div>
        </div>
      )}
      {msg && <p role="status" className="text-sm text-muted">{msg}</p>}
    </section>
  );
}

interface PlanRow { id: string; quotaBytes: number; priceMonthly: number; priceYearly: number; currency: string }
interface UsageRow { id: number; name: string; plan: string; status: string; bonusBytes: number; usedBytes: number; quotaBytes: number; members: number }
interface StorageReq { id: number; circleId: number; circle: string; requester: string | null; plan: string; note: string | null; createdAt: string }
const GBYTES = 1024 ** 3;
const gb = (n: number) => `${Math.round((n / GBYTES) * 10) / 10} GB`;

interface Capacity { families: number; byPlan: Record<string, number>; paying: number; grace: number; readonly: number; expiring: Array<{ id: number; name: string; plan: string; periodEnd: string; status: string }>; top: Array<{ id: number; name: string; plan: string; usedGB: number; quotaGB: number; percent: number }>; storedGB: number; costPerGB: number; estMonthlyCost: number; estMonthlyRevenue: Record<string, number>; orphans: { count: number; gb: number } }
function CapacityCard({ onFamily }: { onFamily: (id: number) => void }) {
  const { t } = useI18n();
  const fail = useFail();
  const [c, setC] = useState<Capacity | null>(null);
  const [unit, setUnit] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => api<Capacity>('/admin/capacity').then(r => { setC(r); setUnit(String(r.costPerGB)); }).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!c) return null;
  const money = Object.entries(c.estMonthlyRevenue).map(([cur, v]) => `${v} ${cur}`).join(' · ') || '0';
  const stat = (label: string, v: string | number) => <div className="card p-3 text-center"><div className="text-lg font-bold text-green" dir="ltr">{v}</div><div className="text-xs text-muted">{label}</div></div>;
  return (
    <div className="space-y-3">
      <h3 className="font-bold text-green">{t.capTitle}</h3>
      <div className="grid grid-cols-2 sm:grid-cols-3 gap-2">
        {stat(t.capStored, `${c.storedGB} GB`)}{stat(t.capCost, `$${c.estMonthlyCost}`)}{stat(t.capIncome, money)}
        {stat(t.capPaying, c.paying)}{stat(t.capGrace, c.grace)}{stat(t.capReadonly, c.readonly)}
      </div>
      <p className="text-xs text-muted">{t.capFamiliesPlan}: {Object.entries(c.byPlan).map(([k, v]) => `${t.plans[k]} ${v}`).join(' · ')}</p>
      <div className="flex gap-2 items-center"><span className="text-sm flex-1">{t.capCostPer} ($)</span><input className="field !w-24" dir="ltr" inputMode="decimal" value={unit} onChange={e => setUnit(e.target.value.replace(/[^\d.]/g, ''))} /><button className="btn btn-ghost shrink-0" onClick={async () => { setMsg(''); try { await api('/admin/capacity/cost', { body: { perGB: Number(unit) } }); load(); setMsg(t.admDone); } catch (e) { setMsg(fail(e)); } }}>{t.save}</button></div>
      {c.expiring.length > 0 && <div className="space-y-1"><b className="text-sm">{t.capExpiring}</b><div className="flex flex-wrap gap-1.5">{c.expiring.map(e => <button key={e.id} className="btn btn-ghost !py-1 text-xs" onClick={() => onFamily(e.id)}>{e.name} · <bdi dir="ltr">{e.periodEnd}</bdi></button>)}</div></div>}
      {c.top.length > 0 && <div className="space-y-1"><b className="text-sm">{t.capTop}</b><ul className="text-sm space-y-1">{c.top.map(f => <li key={f.id}><button className="w-full flex items-center gap-2 text-start" onClick={() => onFamily(f.id)}><span className="flex-1 truncate">{f.name}</span><span className="text-xs text-muted" dir="ltr">{f.usedGB}/{f.quotaGB} GB · {f.percent}%</span></button></li>)}</ul></div>}
      <p className="text-xs text-muted">{t.capOrphans}: {c.orphans.count} ({c.orphans.gb} GB)</p>
      {msg && <p role="status" className="text-sm text-muted">{msg}</p>}
    </div>
  );
}

interface PayRow { id: number; status: string; cents: number; currency: string; plan: string | null; periodEnd: string | null; createdAt: string; family: string | null; refundable: boolean }
interface PayInfo { mode: 'test' | 'live'; keyConfigured: boolean; webhookConfigured: boolean; paid30: Array<{ currency: string; amount: number; count: number }>; failed7: number; payments: PayRow[] }
function PaymentsCard() {
  const { t } = useI18n();
  const fail = useFail();
  const arm = useArm();
  const [p, setP] = useState<PayInfo | null>(null);
  const [msg, setMsg] = useState('');
  const load = () => api<PayInfo>('/admin/payments').then(setP).catch(() => {});
  useEffect(() => { load(); }, []);
  if (!p) return null;
  const ok = (v: boolean) => <span className={v ? 'text-green' : 'text-danger'}>{v ? t.pmOk : t.pmMissing}</span>;
  return (
    <div className="card p-3 space-y-2">
      <h3 className="font-bold text-green">{t.pmTitle}</h3>
      <p className="text-sm">{t.pmMode}: <b>{p.mode === 'test' ? t.pmTest : t.pmLive}</b> · {t.pmKey}: {ok(p.keyConfigured)} · {t.pmWebhook}: {ok(p.webhookConfigured)}</p>
      <p className="text-sm">{t.pmPaid30}: <b dir="ltr">{p.paid30.length ? p.paid30.map(x => `${x.amount} ${x.currency.toUpperCase()} (${x.count})`).join(' · ') : '0'}</b> · {t.pmFailed7}: <b>{p.failed7}</b></p>
      {p.payments.length === 0 ? <p className="text-sm text-muted">{t.pmNone}</p> : (
        <ul className="space-y-1.5">{p.payments.slice(0, 10).map(r => (
          <li key={r.id} className="text-sm flex items-center gap-2"><span className="flex-1 min-w-0 truncate"><b>{r.family ?? '—'}</b> <span className="text-xs text-muted" dir="ltr">· {(r.cents / 100).toFixed(2)} {r.currency.toUpperCase()} · {t.pmStatus[r.status] ?? r.status} · {r.createdAt.slice(0, 10)}</span></span>
            {r.refundable && <button className="btn btn-ghost !py-0.5 text-xs text-danger" onClick={() => arm.tap(`rf${r.id}`, async () => { setMsg(''); try { await api(`/admin/payments/${r.id}/refund`, { body: {} }); setMsg(t.admDone); load(); } catch (e) { setMsg(fail(e)); } })}>{arm.armed === `rf${r.id}` ? t.ppTapAgain : t.pmRefund}</button>}</li>
        ))}</ul>
      )}
      {msg && <p role="status" className="text-sm text-muted">{msg}</p>}
    </div>
  );
}

function StorageTab({ onFamily }: { onFamily: (id: number) => void }) {
  const { t } = useI18n();
  const fail = useFail();
  const [plans, setPlans] = useState<PlanRow[]>([]);
  const [edit, setEdit] = useState<Record<string, { quotaGB: string; priceMonthly: string; priceYearly: string; currency: string }>>({});
  const [circles, setCircles] = useState<UsageRow[]>([]);
  const [reqs, setReqs] = useState<StorageReq[]>([]);
  const [bonus, setBonus] = useState<Record<number, string>>({});
  const [msg, setMsg] = useState('');
  const load = () => {
    api<{ plans: PlanRow[] }>('/admin/plans').then(r => { setPlans(r.plans); setEdit(Object.fromEntries(r.plans.map(p => [p.id, { quotaGB: String(Math.round((p.quotaBytes / GBYTES) * 100) / 100), priceMonthly: String(p.priceMonthly), priceYearly: String(p.priceYearly), currency: p.currency }]))); }).catch(() => {});
    api<{ circles: UsageRow[]; requests: StorageReq[] }>('/admin/storage').then(r => { setCircles(r.circles); setReqs(r.requests); }).catch(() => {});
  };
  useEffect(() => { load(); }, []);
  const run = async (fn: () => Promise<unknown>) => { setMsg(''); try { await fn(); setMsg(t.admDone); load(); } catch (e) { setMsg(fail(e)); } };
  const input = (id: string, k: 'quotaGB' | 'priceMonthly' | 'priceYearly' | 'currency', label: string) => (
    <label className="text-xs text-muted">{label}<input className="field !py-1 mt-0.5" dir="ltr" inputMode={k === 'currency' ? 'text' : 'decimal'} value={edit[id]?.[k] ?? ''} onChange={e => setEdit(p => ({ ...p, [id]: { ...p[id], [k]: e.target.value } }))} /></label>
  );
  return (
    <section className="space-y-4">
      <PaymentsCard />
      <CapacityCard onFamily={onFamily} />
      <div className="space-y-2">
        <h3 className="font-bold text-green">{t.admPlansHead}</h3>
        <p className="text-xs text-muted">{t.admPlansNote}</p>
        <ul className="space-y-2">
          {plans.map(p => (
            <li key={p.id} className="card p-3 space-y-2">
              <b>{t.plans[p.id]}</b>
              <div className="grid grid-cols-2 sm:grid-cols-4 gap-2">{input(p.id, 'quotaGB', t.admQuotaGb)}{input(p.id, 'priceMonthly', t.admPriceMonth)}{input(p.id, 'priceYearly', t.admPriceYear)}{input(p.id, 'currency', t.admCurrency)}</div>
              <button className="btn btn-ghost" onClick={() => run(() => api(`/admin/plans/${p.id}`, { body: { quotaGB: Number(edit[p.id].quotaGB), priceMonthly: Number(edit[p.id].priceMonthly), priceYearly: Number(edit[p.id].priceYearly), currency: edit[p.id].currency } }))}>{t.save}</button>
            </li>
          ))}
        </ul>
      </div>
      <div className="space-y-2">
        <h3 className="font-bold text-green">{t.admRequestsHead}</h3>
        {reqs.length === 0 ? <p className="text-sm text-muted">{t.admNoRequests}</p> : (
          <ul className="space-y-2">{reqs.map(r => (
            <li key={r.id} className="card p-3 space-y-1">
              <div><b>{r.circle}</b> <span className="text-sm text-muted">· {r.requester ?? '—'} · {t.plans[r.plan]}</span></div>
              {r.note && <p className="text-sm text-muted">{r.note}</p>}
              <div className="text-xs text-muted" dir="ltr">{r.createdAt}</div>
              <div className="flex gap-2"><button className="btn" onClick={() => run(() => api(`/admin/storage-requests/${r.id}/decide`, { body: { grant: true } }))}>{t.admGrant}</button><button className="btn btn-ghost" onClick={() => run(() => api(`/admin/storage-requests/${r.id}/decide`, { body: { grant: false } }))}>{t.admDecline}</button></div>
            </li>
          ))}</ul>
        )}
      </div>
      <div className="space-y-2">
        <h3 className="font-bold text-green">{t.admCirclesUsage}</h3>
        {circles.length === 0 ? <p className="text-sm text-muted">{t.admNoCircles}</p> : (
          <ul className="space-y-2">{circles.map(c => {
            const pct = c.quotaBytes ? Math.min(100, Math.round((c.usedBytes / c.quotaBytes) * 100)) : 0;
            return (
              <li key={c.id} className="card p-3 space-y-1">
                <div className="flex items-center gap-2"><b className="flex-1 truncate">{c.name}</b><span className="text-xs text-muted">{c.members} · {t.plans[c.plan]}</span></div>
                <div className="h-2 rounded-full bg-line overflow-hidden"><div className={`h-full ${pct >= 100 ? 'bg-danger' : pct >= 80 ? 'bg-gold' : 'bg-brand'}`} style={{ width: `${pct}%` }} /></div>
                <div className="text-xs text-muted" dir="ltr">{gb(c.usedBytes)} / {gb(c.quotaBytes)} ({pct}%){c.bonusBytes ? ` · +${gb(c.bonusBytes)}` : ''}</div>
                <div className="flex flex-wrap items-center gap-2">
                  <select className="field !w-auto !py-1" value={c.plan} onChange={e => run(() => api(`/admin/circles/${c.id}/plan`, { body: { plan: e.target.value } }))}>{['free', 'family', 'heritage'].map(p => <option key={p} value={p}>{t.plans[p]}</option>)}</select>
                  <input className="field !w-24 !py-1" dir="ltr" inputMode="decimal" placeholder={t.admBonusGb} value={bonus[c.id] ?? ''} onChange={e => setBonus(p => ({ ...p, [c.id]: e.target.value }))} />
                  <button className="btn btn-ghost !py-1" disabled={bonus[c.id] === undefined || bonus[c.id] === ''} onClick={() => run(() => api(`/admin/circles/${c.id}/plan`, { body: { bonusGB: Number(bonus[c.id]) } }))}>{t.admSet}</button>
                </div>
              </li>
            );
          })}</ul>
        )}
      </div>
      {msg && <p role="status" className="text-sm text-muted">{msg}</p>}
    </section>
  );
}

interface SCase { id: number; subject: string; status: 'open' | 'answered' | 'closed'; person: string; phone: string; updatedAt: string; messages: number }
interface SDetail { id: number; subject: string; status: string; person: string; phone: string; lang: string; messages: Array<{ fromStaff: number; body: string; createdAt: string }> }
function SupportTab() {
  const { t, lang } = useI18n();
  const fail = useFail();
  const [list, setList] = useState<SCase[]>([]);
  const [filter, setFilter] = useState<'open' | 'answered' | 'closed' | ''>('open');
  const [open, setOpen] = useState<SDetail | null>(null);
  const [templates, setTemplates] = useState<Array<{ id: string; ar: string; en: string }>>([]);
  const [text, setText] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => api<SCase[]>(`/admin/support${filter ? `?status=${filter}` : ''}`).then(setList).catch(() => setList([]));
  useEffect(() => { load(); }, [filter]);   // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => { api<typeof templates>('/admin/support/templates').then(setTemplates).catch(() => {}); }, []);
  const show = (id: number) => { setMsg(''); setText(''); api<SDetail>(`/admin/support/${id}`).then(setOpen).catch(e => setMsg(fail(e))); };
  async function send() {
    if (!open || !text.trim()) return;
    try { await api(`/admin/support/${open.id}/reply`, { body: { body: text } }); show(open.id); load(); } catch (e) { setMsg(fail(e)); }
  }
  async function close() { if (!open) return; try { await api(`/admin/support/${open.id}/close`, { body: {} }); setOpen(null); load(); } catch (e) { setMsg(fail(e)); } }
  return (
    <section className="space-y-3">
      <div className="flex gap-2 text-sm">{(['open', 'answered', 'closed', ''] as const).map(k => <button key={k || 'all'} aria-pressed={filter === k} onClick={() => setFilter(k)} className={`px-3 py-1 rounded-full border ${filter === k ? 'border-green text-green font-bold' : 'border-line text-muted'}`}>{k ? t.supportStatus[k] : t.albumAll}</button>)}</div>
      {list.length === 0 ? <p className="text-sm text-muted">{t.admNoSupport}</p> : (
        <ul className="space-y-2">{list.map(k => (
          <li key={k.id}><button className="card p-3 w-full text-start space-y-0.5" onClick={() => show(k.id)}>
            <div className="flex items-center gap-2"><b className="flex-1 truncate">{k.subject}</b><Badge>{t.supportStatus[k.status]}</Badge></div>
            <div className="text-xs text-muted">{k.person} · <span dir="ltr">{k.phone}</span> · {k.messages}</div>
          </button></li>
        ))}</ul>
      )}
      {open && (
        <Dialog onClose={() => setOpen(null)} label={open.subject}>
          <h2 className="text-lg font-bold">{open.subject}</h2>
          <p className="text-xs text-muted">{open.person} · <span dir="ltr">{open.phone}</span> · {open.lang}</p>
          <ul className="mt-2 space-y-1 max-h-60 overflow-y-auto">{open.messages.map((m, i) => <li key={i} className={`text-sm rounded-lg p-2 ${m.fromStaff ? 'bg-green-soft' : 'bg-card border border-line'}`}><span className="text-xs text-muted block">{m.fromStaff ? t.supportTeam : open.person}</span><span className="whitespace-pre-wrap break-words">{m.body}</span></li>)}</ul>
          {open.status !== 'closed' && (
            <div className="mt-3 space-y-2">
              <select className="field" value="" onChange={e => { const tp = templates.find(x => x.id === e.target.value); if (tp) setText(open.lang === 'en' ? tp.en : tp.ar); }}>
                <option value="">{t.admTemplate}</option>{templates.map(x => <option key={x.id} value={x.id}>{(lang !== 'ar' ? x.en : x.ar).slice(0, 60)}…</option>)}
              </select>
              <textarea className="field min-h-24" value={text} onChange={e => setText(e.target.value)} placeholder={t.supportReply} />
              <div className="flex gap-2"><button className="btn flex-1" onClick={send} disabled={!text.trim()}>{t.supportSend}</button><button className="btn btn-ghost" onClick={close}>{t.admClose}</button></div>
            </div>
          )}
          {msg && <p role="alert" className="text-sm text-danger mt-2">{msg}</p>}
          <button className="btn btn-ghost w-full mt-2" onClick={() => setOpen(null)}>{t.cancel}</button>
        </Dialog>
      )}
    </section>
  );
}

interface DigestItem { code: string; sev: 'high' | 'medium' | 'low'; count: number; ar: string; en: string }
interface Proposal { id: number; kind: string; args: Record<string, unknown>; reason: string; source: string; status: string; title: { ar: string; en: string } }
function AgentTab() {
  const { t, lang } = useI18n();
  const fail = useFail();
  const [digest, setDigest] = useState<{ items: DigestItem[]; model: boolean } | null>(null);
  const [q, setQ] = useState('');
  const [busy, setBusy] = useState(false);
  const [out, setOut] = useState<{ answer: string; source: string } | null>(null);
  const [props, setProps] = useState<Proposal[]>([]);
  const [briefs, setBriefs] = useState<Array<{ id: number; at: string; kind: string; items: DigestItem[] }>>([]);
  const [msg, setMsg] = useState('');
  const l = lang !== 'ar' ? 'en' : 'ar';
  const load = () => { api<{ items: DigestItem[]; model: boolean }>('/admin/agent/digest').then(setDigest).catch(e => setMsg(fail(e))); api<Proposal[]>('/admin/agent/proposals?status=pending').then(setProps).catch(() => {}); api<typeof briefs>('/admin/agent/briefs').then(setBriefs).catch(() => {}); };
  useEffect(load, []);
  async function ask(question: string) {
    if (!question.trim() || busy) return;
    setBusy(true); setMsg('');
    try { setOut(await api<{ answer: string; source: string }>('/admin/agent/ask', { body: { question, lang: l } })); setQ(''); load(); } catch (e) { setMsg(fail(e)); } finally { setBusy(false); }
  }
  async function decide(id: number, verb: 'approve' | 'reject') {
    setMsg('');
    try { await api(`/admin/agent/proposals/${id}/${verb}`, { body: {} }); setMsg(t.admDone); } catch (e) { setMsg(fail(e)); }
    load();
  }
  const dot = { high: 'bg-danger', medium: 'bg-gold', low: 'bg-muted' } as const;
  return (
    <section className="space-y-4">
      <p className="text-xs text-muted">{t.agentHint}</p>
      <div className="card p-3 space-y-2">
        <b className="text-sm">{t.agentToday}</b>
        {digest === null ? <TableSkeleton rows={4} cols={2} /> : digest.items.length === 0 ? <p className="text-sm text-muted">{t.agentQuiet}</p> : (
          <ul className="space-y-1.5">{digest.items.map(i => <li key={i.code} className="flex items-start gap-2 text-sm"><span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot[i.sev]}`} /><span>{i[l]}</span></li>)}</ul>
        )}
      </div>
      <form className="flex gap-2" onSubmit={e => { e.preventDefault(); ask(q); }}>
        <input className="field" placeholder={t.agentPlaceholder} value={q} onChange={e => setQ(e.target.value)} maxLength={1000} />
        <button className="btn shrink-0" disabled={busy}>{t.agentSend}</button>
      </form>
      <div className="flex gap-1.5 overflow-x-auto pb-1" aria-label={t.agentCmdsTitle}>
        {t.agentCmds.map(c => <button key={c} type="button" className="btn btn-ghost !py-1 text-xs whitespace-nowrap" onClick={() => ask(c)}>{c}</button>)}
      </div>
      {out && (
        <div className="card p-3 space-y-1">
          <p className="text-sm whitespace-pre-wrap">{out.answer}</p>
          <p className="text-[11px] text-muted">{out.source === 'model' ? t.agentModel : t.agentRules}</p>
        </div>
      )}
      <div className="space-y-2">
        <b className="text-sm">{t.agentProposals}</b>
        {props.length === 0 ? <p className="text-sm text-muted">{t.agentNoProposals}</p> : props.map(p => (
          <div key={p.id} className="card p-3 space-y-2">
            <div className="text-sm"><b>{p.title[l]}</b> <span className="text-muted" dir="ltr">{Object.entries(p.args).map(([k, v]) => `${k}=${String(v)}`).join(' · ')}</span></div>
            {p.source === 'model' && <p className="text-[11px] text-danger">{t.agentFromModel}</p>}
            {p.reason && <p className="text-xs text-muted">{p.reason}</p>}
            <div className="flex gap-2"><button className="btn flex-1" onClick={() => decide(p.id, 'approve')}>{t.agentApprove}</button><button className="btn btn-ghost" onClick={() => decide(p.id, 'reject')}>{t.agentReject}</button></div>
          </div>
        ))}
      </div>
      <div className="space-y-2">
        <div className="flex items-center gap-2"><b className="text-sm flex-1">{t.agentBriefs}</b><button className="btn btn-ghost !py-1 text-xs" onClick={async () => { setMsg(''); try { await api('/admin/agent/brief', { body: {} }); load(); } catch (e) { setMsg(fail(e)); } }}>{t.agentBriefNow}</button></div>
        <p className="text-xs text-muted">{t.agentBriefNote}</p>
        {briefs.slice(0, 4).map(b => (
          <details key={b.id} className="card p-2 text-sm">
            <summary className="cursor-pointer"><b>{t.agentBriefKinds[b.kind] ?? b.kind}</b> <span className="text-xs text-muted" dir="ltr">{b.at.slice(0, 16)} · {b.items.length || t.agentCalm}</span></summary>
            <ul className="mt-1 space-y-1">{b.items.map(i => <li key={i.code} className="flex items-start gap-2"><span className={`mt-1.5 h-2 w-2 shrink-0 rounded-full ${dot[i.sev]}`} /><span>{i[l]}</span></li>)}</ul>
          </details>
        ))}
      </div>
      {msg && <p role="status" className="text-sm text-muted">{msg}</p>}
    </section>
  );
}

interface Aud { lang?: string; country?: string; plan?: string; managersOnly?: boolean }
interface AnnRow { id: number; titleAr: string; titleEn: string; level: string; status: string; endsAt: string; dismissed: number; accepted: number; audience: Aud }
interface BcRow { id: number; bodyAr: string; bodyEn: string; status: string; scheduledAt: string; sent: number; skipped: number; test: number }
interface Maint { on: boolean; from: string | null; until: string | null; messageAr: string; messageEn: string }

function AudiencePicker({ value, onChange }: { value: Aud; onChange: (a: Aud) => void }) {
  const { t } = useI18n();
  const [n, setN] = useState<number | null>(null);
  useEffect(() => {
    const q = new URLSearchParams(); if (value.lang) q.set('lang', value.lang); if (value.country) q.set('country', value.country); if (value.plan) q.set('plan', value.plan); if (value.managersOnly) q.set('managersOnly', '1');
    api<{ count: number }>(`/admin/audience?${q}`).then(r => setN(r.count)).catch(() => setN(null));
  }, [value.lang, value.country, value.plan, value.managersOnly]);
  return (
    <div className="space-y-2">
      <b className="text-sm">{t.anAudience}</b>
      <div className="grid grid-cols-2 gap-2">
        <select className="field !py-1" aria-label={t.anLang} value={value.lang ?? ''} onChange={e => onChange({ ...value, lang: e.target.value || undefined })}><option value="">{t.anLang}: {t.anAny}</option><option value="ar">العربية</option><option value="en">English</option></select>
        <select className="field !py-1" aria-label={t.anPlan} value={value.plan ?? ''} onChange={e => onChange({ ...value, plan: e.target.value || undefined })}><option value="">{t.anPlan}: {t.anAny}</option>{['free', 'family', 'heritage'].map(p => <option key={p} value={p}>{t.plans[p]}</option>)}</select>
        <input className="field !py-1" dir="ltr" inputMode="numeric" placeholder={t.anCountry} value={value.country ?? ''} onChange={e => onChange({ ...value, country: e.target.value.replace(/\D/g, '').slice(0, 4) || undefined })} />
        <label className="flex items-center gap-2 text-sm"><input type="checkbox" checked={!!value.managersOnly} onChange={e => onChange({ ...value, managersOnly: e.target.checked || undefined })} />{t.anManagers}</label>
      </div>
      <p className="text-xs text-muted">{t.anReach}: {n ?? '—'} {t.anPeople}</p>
    </div>
  );
}

function AnnounceTab() {
  const { t } = useI18n();
  const fail = useFail();
  const arm = useArm();
  const [msg, setMsg] = useState('');
  const [maint, setMaint] = useState<Maint | null>(null);
  const [mm, setMm] = useState({ ar: '', en: '', from: '', until: '' });
  const [notice, setNotice] = useState({ titleAr: '', titleEn: '', bodyAr: '', bodyEn: '', level: 'info', days: '7' });
  const [nAud, setNAud] = useState<Aud>({});
  const [bc, setBc] = useState({ ar: '', en: '', at: '' });
  const [bAud, setBAud] = useState<Aud>({});
  const [anns, setAnns] = useState<AnnRow[]>([]);
  const [bcs, setBcs] = useState<BcRow[]>([]);
  const load = () => {
    api<Maint>('/admin/maintenance').then(setMaint).catch(() => {});
    api<AnnRow[]>('/admin/announcements').then(setAnns).catch(() => {});
    api<BcRow[]>('/admin/broadcasts').then(setBcs).catch(() => {});
  };
  useEffect(load, []);
  const run = async (fn: () => Promise<unknown>, ok = t.admDone) => { setMsg(''); try { await fn(); setMsg(ok); load(); } catch (e) { setMsg(fail(e)); } };
  const iso = (v: string) => (v ? new Date(v).toISOString() : undefined);
  return (
    <section className="space-y-5">
      <div className="card p-3 space-y-2">
        <h3 className="font-bold text-green">{t.anMaint}</h3>
        <p className="text-xs text-muted">{t.anMaintNote}</p>
        <p className={`text-sm ${maint?.on ? 'text-danger' : 'text-muted'}`}>{maint?.on ? t.anMaintOn : t.anMaintOff}{maint?.on && maint.from ? ` · ${maint.from}` : ''}{maint?.on && maint.until ? ` → ${maint.until}` : ''}</p>
        <div className="grid grid-cols-2 gap-2"><input className="field !py-1" placeholder={t.anMsgAr} value={mm.ar} onChange={e => setMm({ ...mm, ar: e.target.value })} /><input className="field !py-1" dir="ltr" placeholder={t.anMsgEn} value={mm.en} onChange={e => setMm({ ...mm, en: e.target.value })} />
          <label className="text-xs text-muted">{t.anFrom}<input className="field !py-1" type="datetime-local" dir="ltr" value={mm.from} onChange={e => setMm({ ...mm, from: e.target.value })} /></label><label className="text-xs text-muted">{t.anUntil}<input className="field !py-1" type="datetime-local" dir="ltr" value={mm.until} onChange={e => setMm({ ...mm, until: e.target.value })} /></label></div>
        <div className="flex gap-2">
          <button className="btn flex-1 text-danger" onClick={() => arm.tap('maint', () => run(() => api('/admin/maintenance', { body: { on: true, messageAr: mm.ar, messageEn: mm.en, from: iso(mm.from), until: iso(mm.until) } })))}>{arm.armed === 'maint' ? t.ppTapAgain : t.anMaintSet}</button>
          {maint?.on && <button className="btn btn-ghost" onClick={() => run(() => api('/admin/maintenance', { body: { on: false } }))}>{t.anMaintStop}</button>}
        </div>
      </div>

      <div className="card p-3 space-y-2">
        <h3 className="font-bold text-green">{t.anNewNotice}</h3>
        <div className="grid grid-cols-2 gap-2"><input className="field !py-1" placeholder={t.anTitleAr} value={notice.titleAr} onChange={e => setNotice({ ...notice, titleAr: e.target.value })} /><input className="field !py-1" dir="ltr" placeholder={t.anTitleEn} value={notice.titleEn} onChange={e => setNotice({ ...notice, titleEn: e.target.value })} />
          <textarea className="field !py-1" rows={3} placeholder={t.anBodyAr} value={notice.bodyAr} onChange={e => setNotice({ ...notice, bodyAr: e.target.value })} /><textarea className="field !py-1" dir="ltr" rows={3} placeholder={t.anBodyEn} value={notice.bodyEn} onChange={e => setNotice({ ...notice, bodyEn: e.target.value })} /></div>
        <div className="flex gap-2"><select className="field !py-1" value={notice.level} onChange={e => setNotice({ ...notice, level: e.target.value })}>{Object.entries(t.anLevels).map(([k, v]) => <option key={k} value={k}>{v}</option>)}</select><input className="field !w-24 !py-1" inputMode="numeric" aria-label={t.anDays} placeholder={t.anDays} value={notice.days} onChange={e => setNotice({ ...notice, days: e.target.value.replace(/\D/g, '') })} /></div>
        <AudiencePicker value={nAud} onChange={setNAud} />
        <button className="btn w-full" onClick={() => run(async () => { await api('/admin/announcements', { body: { ...notice, days: Number(notice.days) || 7, audience: nAud } }); setNotice({ titleAr: '', titleEn: '', bodyAr: '', bodyEn: '', level: 'info', days: '7' }); })}>{t.anPublish}</button>
        <ul className="space-y-1.5">{anns.length === 0 ? <li className="text-sm text-muted">{t.anNone}</li> : anns.slice(0, 8).map(a => (
          <li key={a.id} className="text-sm flex items-center gap-2"><span className="flex-1 truncate"><b>{a.titleAr || a.titleEn}</b> <span className="text-xs text-muted">· {t.anLevels[a.level]} · {t.anStatus[a.status]} · {a.dismissed} {t.anDismissed}{a.level === 'consent' ? ` · ${a.accepted} ${t.anAccepted}` : ''}</span></span>
            {a.status === 'active' && <button className="btn btn-ghost !py-0.5 text-xs" onClick={() => run(() => api(`/admin/announcements/${a.id}/cancel`, { body: {} }))}>{t.anCancel}</button>}</li>
        ))}</ul>
      </div>

      <div className="card p-3 space-y-2">
        <h3 className="font-bold text-green">{t.anBroadcast}</h3>
        <p className="text-xs text-muted">{t.anBcNote}</p>
        <div className="grid grid-cols-2 gap-2"><input className="field !py-1" maxLength={180} placeholder={t.anMsgAr} value={bc.ar} onChange={e => setBc({ ...bc, ar: e.target.value })} /><input className="field !py-1" dir="ltr" maxLength={180} placeholder={t.anMsgEn} value={bc.en} onChange={e => setBc({ ...bc, en: e.target.value })} /></div>
        <AudiencePicker value={bAud} onChange={setBAud} />
        <label className="text-xs text-muted block">{t.anAt}<input className="field !py-1" type="datetime-local" dir="ltr" value={bc.at} onChange={e => setBc({ ...bc, at: e.target.value })} /></label>
        <div className="flex gap-2">
          <button className="btn btn-ghost flex-1" onClick={async () => { setMsg(''); try { const r = await api<{ sent: number }>('/admin/broadcasts', { body: { bodyAr: bc.ar, bodyEn: bc.en, test: true } }); setMsg(r.sent ? t.anTestSent : t.anTestNone); load(); } catch (e) { setMsg(fail(e)); } }}>{t.anTest}</button>
          <button className="btn flex-1" onClick={() => arm.tap('bc', () => run(async () => { await api('/admin/broadcasts', { body: { bodyAr: bc.ar, bodyEn: bc.en, audience: bAud, at: iso(bc.at) } }); setBc({ ar: '', en: '', at: '' }); }))}>{arm.armed === 'bc' ? t.ppTapAgain : bc.at ? t.anSchedule : t.anSend}</button>
        </div>
        <ul className="space-y-1.5">{bcs.filter(b => !b.test).slice(0, 8).map(b => (
          <li key={b.id} className="text-sm flex items-center gap-2"><span className="flex-1 truncate">{b.bodyAr} <span className="text-xs text-muted">· {t.anStatus[b.status]}{b.status === 'sent' ? ` · ${b.sent} ${t.anSent} · ${b.skipped} ${t.anSkipped}` : ` · ${b.scheduledAt}`}</span></span>
            {b.status === 'scheduled' && <button className="btn btn-ghost !py-0.5 text-xs" onClick={() => run(() => api(`/admin/broadcasts/${b.id}/cancel`, { body: {} }))}>{t.anCancel}</button>}</li>
        ))}</ul>
      </div>
      {msg && <p role="status" className="text-sm text-muted">{msg}</p>}
    </section>
  );
}

interface OpsInfo {
  jobs: Array<{ name: string; lastOkAt: string | null; lastRunAt: string | null; lastError: string | null; overdue: boolean; failing: boolean }>;
  errors: Array<{ id: number; at: string; kind: string; route: string | null; message: string }>; errors1h: number; errors24h: number;
  providers: { sms: { provider: string; real: boolean; usedToday: number; dailyCap: number }; push: { devices: number }; ai: { configured: boolean }; offsite: { kind: string; ready: boolean; lastSnapshotAt: string | null; lastError: string | null }; payments: { connected: boolean; mode?: 'test' | 'live' | null; webhook?: boolean }; database: { megabytes: number | null } };
  costs: { hostingUSD: number; smsEachUSD: number; budgetUSD: number; smsMonth: number; smsCost: number; storageCost: number; aiCalls: number; aiCost: number; total: number; percentOfBudget: number | null };
  appConfig: { minVersion: string; latestVersion: string; messageAr: string; messageEn: string };
  restore: { pending: { id: string; at: string } | null; last: { at: string | null; id: string | null; error: string | null } };
}
interface BackupRow { id: string; createdAt: string; counts: { users: number; messages: number }; files: number }

function OpsTab() {
  const { t } = useI18n();
  const fail = useFail();
  const [o, setO] = useState<OpsInfo | null>(null);
  const [bk, setBk] = useState<BackupRow[]>([]);
  const [cost, setCost] = useState({ hostingUSD: '0', smsEachUSD: '0.05', budgetUSD: '0' });
  const [app, setApp] = useState({ minVersion: '', latestVersion: '', messageAr: '', messageEn: '' });
  const [word, setWord] = useState('');
  const [pick, setPick] = useState('');
  const [msg, setMsg] = useState('');
  const load = () => {
    api<OpsInfo>('/admin/ops').then(r => { setO(r); setCost({ hostingUSD: String(r.costs.hostingUSD), smsEachUSD: String(r.costs.smsEachUSD), budgetUSD: String(r.costs.budgetUSD) }); setApp(r.appConfig); }).catch(e => setMsg(fail(e)));
    api<BackupRow[]>('/admin/backups').then(setBk).catch(() => {});
  };
  useEffect(load, []);
  const run = async (fn: () => Promise<unknown>, ok = t.admDone) => { setMsg(''); try { await fn(); setMsg(ok); load(); } catch (e) { setMsg(fail(e)); } };
  if (!o) return msg ? <p role="status" className="text-sm text-muted">{msg}</p> : null;
  const dot = (bad: boolean) => <span className={`inline-block h-2 w-2 rounded-full ${bad ? 'bg-danger' : 'bg-green'}`} />;
  const p = o.providers;
  const row = (label: string, ok: boolean, text: string) => <li className="flex items-center gap-2 text-sm">{dot(!ok)}<span className="flex-1">{label}</span><span className="text-xs text-muted">{text}</span></li>;
  const pct = o.costs.percentOfBudget;
  return (
    <section className="space-y-5">
      <div className="card p-3 space-y-2">
        <h3 className="font-bold text-green">{t.opJobs}</h3>
        <ul className="space-y-1.5">{o.jobs.map(j => (
          <li key={j.name} className="text-sm"><div className="flex items-center gap-2">{dot(j.overdue || j.failing)}<b className="flex-1" dir="ltr">{j.name}</b><span className="text-xs text-muted">{j.failing ? t.opJobFail : j.overdue ? t.opJobLate : j.lastOkAt ? `${t.opJobOk}: ${j.lastOkAt.slice(11, 16)}` : t.opJobNever}</span></div>
            {j.lastError && <div className="text-xs text-danger ps-4" dir="ltr">{j.lastError}</div>}</li>
        ))}</ul>
      </div>

      <div className="card p-3 space-y-2">
        <h3 className="font-bold text-green">{t.opErrors}</h3>
        <p className="text-sm">{t.opErr1h}: <b>{o.errors1h}</b> · {t.opErr24h}: <b>{o.errors24h}</b></p>
        {o.errors.length === 0 ? <p className="text-sm text-muted">{t.opNoErrors}</p> : <ul className="space-y-1 text-xs text-muted" dir="ltr">{o.errors.slice(0, 10).map(e => <li key={e.id}>{e.at.slice(5, 16)} · {e.kind}{e.route ? ` · ${e.route}` : ''} · {e.message}</li>)}</ul>}
      </div>

      <div className="card p-3 space-y-2">
        <h3 className="font-bold text-green">{t.opServices}</h3>
        <ul className="space-y-1.5">
          {row(t.opSms, p.sms.real, p.sms.real ? `${p.sms.provider} · ${p.sms.usedToday}/${p.sms.dailyCap}` : t.opSmsFake)}
          {row(t.opPush, true, String(p.push.devices))}
          {row(t.opAi, p.ai.configured, p.ai.configured ? t.opOn : t.opAiOff)}
          {row(t.opOffsite, p.offsite.ready && !p.offsite.lastError, p.offsite.lastError ?? (p.offsite.lastSnapshotAt ? p.offsite.lastSnapshotAt.slice(0, 16) : p.offsite.kind))}
          {row(t.opPayments, p.payments.connected && !!p.payments.webhook, p.payments.connected ? `${p.payments.mode === 'live' ? t.pmLive : t.pmTest}${p.payments.webhook ? '' : ' · ' + t.pmWebhook + ': ' + t.pmMissing}` : t.opPaymentsOff)}
          {row(t.opDb, true, p.database.megabytes === null ? '—' : `${p.database.megabytes} MB`)}
        </ul>
      </div>

      <div className="card p-3 space-y-2">
        <h3 className="font-bold text-green">{t.opCosts}</h3>
        <p className="text-sm">{t.opTotal}: <b dir="ltr">${o.costs.total}</b>{pct !== null ? ` · ${pct}% ${t.opOfBudget}` : ''}</p>
        {pct !== null && <div className="h-2 rounded-full bg-line overflow-hidden"><div className={`h-full ${pct >= 100 ? 'bg-danger' : pct >= 80 ? 'bg-gold' : 'bg-green'}`} style={{ width: `${Math.min(100, pct)}%` }} /></div>}
        <p className="text-xs text-muted" dir="ltr">{t.opSmsCount}: {o.costs.smsMonth} (${o.costs.smsCost}) · {t.opStorageCost}: ${o.costs.storageCost} · {t.opAiCost}: ${o.costs.aiCost} ({o.costs.aiCalls} {t.opAiCalls})</p>
        <div className="grid grid-cols-3 gap-2">
          {([['hostingUSD', t.opHosting], ['smsEachUSD', t.opSmsEach], ['budgetUSD', t.opBudget]] as const).map(([k, label]) => <label key={k} className="text-xs text-muted">{label}<input className="field !py-1 mt-0.5" dir="ltr" inputMode="decimal" value={cost[k]} onChange={e => setCost({ ...cost, [k]: e.target.value.replace(/[^\d.]/g, '') })} /></label>)}
        </div>
        <button className="btn btn-ghost w-full" onClick={() => run(() => api('/admin/ops/costs', { body: { hostingUSD: Number(cost.hostingUSD), smsEachUSD: Number(cost.smsEachUSD), budgetUSD: Number(cost.budgetUSD) } }))}>{t.save}</button>
      </div>

      <div className="card p-3 space-y-2">
        <h3 className="font-bold text-green">{t.opApp}</h3>
        <p className="text-xs text-muted">{t.opAppNote}</p>
        <div className="grid grid-cols-2 gap-2">
          <label className="text-xs text-muted">{t.opMin}<input className="field !py-1 mt-0.5" dir="ltr" placeholder="1.0.0" value={app.minVersion} onChange={e => setApp({ ...app, minVersion: e.target.value })} /></label>
          <label className="text-xs text-muted">{t.opLatest}<input className="field !py-1 mt-0.5" dir="ltr" placeholder="1.2.0" value={app.latestVersion} onChange={e => setApp({ ...app, latestVersion: e.target.value })} /></label>
          <input className="field !py-1" placeholder={t.opAppMsgAr} value={app.messageAr} onChange={e => setApp({ ...app, messageAr: e.target.value })} />
          <input className="field !py-1" dir="ltr" placeholder={t.opAppMsgEn} value={app.messageEn} onChange={e => setApp({ ...app, messageEn: e.target.value })} />
        </div>
        <button className="btn btn-ghost w-full" onClick={() => run(() => api('/admin/ops/app-config', { body: app }))}>{t.save}</button>
      </div>

      <div className="card p-3 space-y-2">
        <h3 className="font-bold text-green">{t.opBackups}</h3>
        <p className="text-xs text-muted">{t.opRestoreNote}</p>
        {o.restore.pending && (
          <div className="rounded-xl border border-gold bg-gold/10 p-2 space-y-1.5"><p className="text-sm">{t.opRestorePending}: <b dir="ltr">{o.restore.pending.id}</b></p>
            <button className="btn btn-ghost w-full" onClick={() => run(() => api('/admin/restore/cancel', { body: {} }))}>{t.opRestoreCancel}</button></div>
        )}
        {o.restore.last.at && <p className="text-xs text-muted">{t.opLastRestore}: <span dir="ltr">{o.restore.last.id} · {o.restore.last.at.slice(0, 16)}</span>{o.restore.last.error ? ` · ${o.restore.last.error}` : ''}</p>}
        {bk.length === 0 ? <p className="text-sm text-muted">{t.opNoBackups}</p> : (
          <ul className="space-y-1">{bk.map(b => (
            <li key={b.id}><label className="flex items-center gap-2 text-sm"><input type="radio" name="restore" checked={pick === b.id} onChange={() => setPick(b.id)} /><span className="flex-1" dir="ltr">{b.createdAt.slice(0, 16).replace('T', ' ')}</span><span className="text-xs text-muted">{b.counts.users} · {b.counts.messages} · {b.files}</span></label></li>
          ))}</ul>
        )}
        <div className="flex gap-2"><input className="field !py-1" dir="ltr" placeholder={t.opRestoreType} value={word} onChange={e => setWord(e.target.value)} /><button className="btn shrink-0 text-danger" disabled={!pick || word !== 'RESTORE'} onClick={() => run(async () => { await api(`/admin/backups/${pick}/restore`, { body: { confirm: word } }); setWord(''); }, t.opRestoreStaged)}>{t.opRestoreStage}</button></div>
      </div>
      {msg && <p role="status" className="text-sm text-muted">{msg}</p>}
    </section>
  );
}

interface SecStatus { totp: boolean; pending: boolean; verified: boolean; verifiedUntil: number | null; pin: boolean }
interface StaffSession { id: string; name: string; role: string; createdAt: string | null; agent: string | null; verified: boolean; current: boolean }
interface DataRequestRow { id: number; kind: string; status: string; dueAt: string; name: string; note: string | null; overdue: boolean }

function SecurityTab({ role, onUnlocked }: { role: Role; onUnlocked?: () => void }) {
  const { t } = useI18n();
  const fail = useFail();
  const [st, setSt] = useState<SecStatus | null>(null);
  const [setup, setSetup] = useState<{ secret: string; uri: string } | null>(null);
  const [code, setCode] = useState('');
  const [pin, setPin] = useState('');
  const [sessions, setSessions] = useState<StaffSession[]>([]);
  const [reqs, setReqs] = useState<DataRequestRow[]>([]);
  const [msg, setMsg] = useState('');
  const load = () => {
    api<SecStatus>('/admin/security/status').then(setSt).catch(e => setMsg(fail(e)));
    if (role === 'owner') api<StaffSession[]>('/admin/security/sessions').then(setSessions).catch(() => {});
    if (role !== 'support') api<DataRequestRow[]>('/admin/data-requests').then(setReqs).catch(() => {});
  };
  useEffect(load, []);
  const run = async (fn: () => Promise<unknown>, ok = t.admDone) => { setMsg(''); try { await fn(); setMsg(ok); setCode(''); load(); } catch (e) { setMsg(fail(e)); } };
  const digits = (v: string) => v.replace(/\D/g, '').slice(0, 6);
  return (
    <section className="space-y-5">
      <div className="card p-3 space-y-2">
        <h3 className="font-bold text-green">{t.secTotp}</h3>
        <p className="text-xs text-muted">{t.secTotpNote}</p>
        <p className={`text-sm ${st?.totp ? 'text-green' : 'text-muted'}`}>{st?.totp ? t.secOn : t.secOff}{st?.totp && st.verified ? ` · ${t.secVerified}` : ''}</p>
        {!st?.totp && st?.pin && <input className="field text-center tracking-[0.4em]" dir="ltr" type="password" inputMode="numeric" placeholder={t.secPinAsk} value={pin} onChange={e => setPin(digits(e.target.value))} />}
        {!st?.totp && !setup && <button className="btn w-full" onClick={() => run(async () => setSetup(await api<{ secret: string; uri: string }>('/admin/security/totp/start', { body: { pin } })), '')}>{t.secStart}</button>}
        {!st?.totp && setup && (
          <div className="space-y-2">
            <p className="text-xs text-muted">{t.secKey}</p>
            <p className="font-mono text-sm break-all select-all card p-2" dir="ltr">{setup.secret}</p>
            <a className="text-xs text-green underline" href={setup.uri}>{t.secOpen}</a>
            <div className="flex gap-2"><input className="field text-center tracking-[0.4em]" dir="ltr" inputMode="numeric" placeholder={t.secCode} value={code} onChange={e => setCode(digits(e.target.value))} /><button className="btn shrink-0" onClick={() => run(async () => { await api('/admin/security/totp/enable', { body: { code, pin } }); setSetup(null); onUnlocked?.(); })}>{t.secEnable}</button></div>
          </div>
        )}
        {st?.totp && (
          <div className="flex gap-2"><input className="field text-center tracking-[0.4em]" dir="ltr" inputMode="numeric" placeholder={t.secCode} value={code} onChange={e => setCode(digits(e.target.value))} />
            <button className="btn btn-ghost shrink-0" onClick={() => run(async () => { await api('/admin/security/verify', { body: { code } }); onUnlocked?.(); })}>{t.secVerify}</button>
            <button className="btn btn-ghost shrink-0 text-danger" onClick={() => run(() => api('/admin/security/totp/disable', { body: { code } }))}>{t.secDisable}</button></div>
        )}
      </div>

      {role === 'owner' && (
        <div className="card p-3 space-y-2">
          <h3 className="font-bold text-green">{t.secSessions}</h3>
          <ul className="space-y-1.5">{sessions.map(s => (
            <li key={s.id} className="text-sm flex items-center gap-2"><span className="flex-1 min-w-0"><b>{s.name}</b> <span className="text-xs text-muted">· {t.admRoles[s.role as Role] ?? s.role}{s.verified && <Icon name="check" className="w-3.5 h-3.5 inline text-green ms-1" />}{s.current ? ` · ${t.secCurrent}` : ''}</span><span className="block text-xs text-muted truncate" dir="ltr">{s.createdAt ?? '—'} · {s.agent ?? '—'}</span></span>
              {!s.current && <button className="btn btn-ghost !py-0.5 text-xs text-danger" onClick={() => run(() => api(`/admin/security/sessions/${s.id}/revoke`, { body: {} }))}>{t.secRevoke}</button>}</li>
          ))}</ul>
        </div>
      )}

      {role !== 'support' && (
        <div className="card p-3 space-y-2">
          <h3 className="font-bold text-green">{t.secRequests}</h3>
          {reqs.length === 0 ? <p className="text-sm text-muted">{t.secNoRequests}</p> : <ul className="space-y-1.5">{reqs.slice(0, 10).map(r => (
            <li key={r.id} className="text-sm flex items-center gap-2"><span className="flex-1 min-w-0"><b>{r.name}</b> · {t.rightsKind[r.kind]} <span className="text-xs text-muted">· {t.rightsStatus[r.status]} · <bdi dir="ltr">{r.dueAt.slice(0, 10)}</bdi></span>{r.overdue && <span className="text-xs text-danger"> · {t.secOverdue}</span>}{r.note && <span className="block text-xs text-muted truncate">{r.note}</span>}</span>
              {r.status === 'open' && <><button className="btn !py-0.5 text-xs" onClick={() => run(() => api(`/admin/data-requests/${r.id}/resolve`, { body: { status: 'done' } }))}>{t.secDone}</button><button className="btn btn-ghost !py-0.5 text-xs" onClick={() => run(() => api(`/admin/data-requests/${r.id}/resolve`, { body: { status: 'rejected' } }))}>{t.secReject}</button></>}</li>
          ))}</ul>}
        </div>
      )}

      {role !== 'support' && (
        <div className="card p-3 space-y-2"><h3 className="font-bold text-green">{t.secAudit}</h3><a className="btn btn-ghost block text-center" href="/api/admin/audit/export" download>{t.secAuditGet}</a></div>
      )}
      {msg && <p role="status" className="text-sm text-muted">{msg}</p>}
    </section>
  );
}

/** Arabic | English, always in reach on the admin screen (staff work on a desktop and switch as they need). */
function LangSwitch() {
  const { lang, setLang } = useI18n();
  return (
    <div role="group" aria-label="Language" className="inline-flex rounded-full border border-line p-0.5 text-xs shrink-0">
      {([['ar', 'العربية'], ['en', 'English']] as const).map(([k, label]) => (
        <button key={k} aria-pressed={lang === k} onClick={() => setLang(k)} className={`px-3 py-1 rounded-full ${lang === k ? 'bg-green text-white font-bold' : 'text-muted'}`}>{label}</button>
      ))}
    </div>
  );
}

export function Admin() {
  const { t } = useI18n();
  const [role, setRole] = useState<Role | null | undefined>(undefined);
  const [tab, setTab] = useState<Tab>('overview');
  const [openCases, setOpenCases] = useState(0);
  const [needPin, setNeedPin] = useState(false);
  const [gate, setGate] = useState<'' | 'totp' | 'setup'>('');
  const [gateCode, setGateCode] = useState('');
  const [gateMsg, setGateMsg] = useState('');
  const probe = () => api('/admin/stats').then(() => setGate('')).catch(e => { if (e instanceof ApiError && e.code === 'admin_requires_pin') setNeedPin(true); else if (e instanceof ApiError && e.code === 'admin_totp_required') setGate('totp'); else if (e instanceof ApiError && e.code === 'admin_requires_totp') setGate('setup'); });
  const [focusFamily, setFocusFamily] = useState<number | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  useEffect(() => { probe(); }, []);
  useEffect(() => { api<unknown[]>('/admin/support?status=open').then(l => setOpenCases(l.length)).catch(() => {}); }, [tab]);
  useEffect(() => { api<Me>('/me').then(m => { const r = ((m as Me & { admin_role?: Role | null }).admin_role as Role) ?? (m.is_admin ? 'owner' : null); setRole(r); if (r && r !== 'support') setTab('agent'); }).catch(() => setRole(null)); }, []);
  if (!role) return null;
  if (gate === 'totp') return (
    <div className="space-y-3">
      <div className="flex items-center gap-3"><h2 className="flex-1 text-lg font-bold text-green">{t.secGateTitle}</h2><LangSwitch /></div>
      <form className="card p-4 space-y-3" onSubmit={async e => { e.preventDefault(); setGateMsg(''); try { await api('/admin/security/verify', { body: { code: gateCode } }); setGateCode(''); window.location.reload(); } catch (err) { setGateMsg(t.errors[err instanceof ApiError ? err.code : 'generic'] ?? t.errors.generic); } }}>
        <p className="text-sm">{t.secGateNote}</p>
        <input className="field text-center tracking-[0.4em]" dir="ltr" inputMode="numeric" autoFocus placeholder={t.secCode} value={gateCode} onChange={e => setGateCode(e.target.value.replace(/\D/g, '').slice(0, 6))} />
        <button className="btn w-full" disabled={gateCode.length !== 6}>{t.secVerify}</button>
        {gateMsg && <p role="alert" className="text-sm text-danger">{gateMsg}</p>}
      </form>
    </div>
  );
  if (gate === 'setup') return <div className="space-y-3"><div className="flex items-center gap-3"><h2 className="flex-1 text-lg font-bold text-green">{t.secTitle}</h2><LangSwitch /></div><SecurityTab role={role} onUnlocked={() => window.location.reload()} /></div>;
  if (needPin) return (
    <div className="space-y-3">
      <div className="flex items-center gap-3"><h2 className="flex-1 text-lg font-bold text-green">{t.adminTitle} · {t.admRoles[role]}</h2><LangSwitch /></div>
      <div className="card p-4 space-y-3"><p className="text-sm">{t.admNeedPin}</p><button className="btn w-full" onClick={() => { location.hash = '#/you'; }}>{t.admNeedPinGo}</button></div>
    </div>
  );
  const tabs = TABS[role];
  return (
    <div className="space-y-3">
      <div className="flex items-center gap-3"><h2 className="flex-1 text-lg font-bold text-green">{t.adminTitle} · {t.admRoles[role]}</h2><LangSwitch /></div>
      {/* The menu is a vertical list at the side (the start side: right in Arabic, left in English). On a phone it folds into one button above the page. */}
      <div className="md:flex md:items-start md:gap-6">
        <button className="md:hidden w-full flex items-center justify-between card px-4 py-2.5 text-sm font-bold" aria-expanded={menuOpen} onClick={() => setMenuOpen(o => !o)}>
          <span>{t.admTabs[tab]}</span><span aria-hidden>{menuOpen ? '▴' : '▾'}</span>
        </button>
        <nav role="tablist" aria-orientation="vertical" className={`${menuOpen ? 'flex' : 'hidden'} md:flex flex-col gap-0.5 mt-2 md:mt-0 md:w-52 md:shrink-0 md:sticky md:top-3 card p-1.5`}>
          {tabs.map(k => <button key={k} role="tab" aria-selected={tab === k} onClick={() => { setTab(k); setMenuOpen(false); }} className={`text-start px-3 py-2 rounded-xl text-sm flex items-center gap-2 ${tab === k ? 'bg-green-soft text-green font-bold' : 'text-muted hover:bg-green-soft/50'}`}><span className="flex-1">{t.admTabs[k]}</span>{k === 'support' && openCases > 0 && <span className="text-[11px] min-w-5 text-center rounded-full bg-gold/25 text-gold-dark px-1.5">{openCases}</span>}</button>)}
        </nav>
        <div className="flex-1 min-w-0 mt-3 md:mt-0 space-y-4">
      {tab === 'agent' && <AgentTab />}
      {tab === 'overview' && <Overview role={role} />}
      {tab === 'storage' && <StorageTab onFamily={id => { setFocusFamily(id); setTab('families'); }} />}
      {tab === 'support' && <SupportTab />}
      {tab === 'analytics' && <AnalyticsTab />}
      {tab === 'settings' && <SettingsTab />}
      {tab === 'reports' && <ReportsTab />}
      {tab === 'users' && <UsersTab role={role} onFamily={id => { setFocusFamily(id); setTab('families'); }} />}
      {tab === 'families' && <FamiliesTab role={role} focus={focusFamily} />}
      {tab === 'announce' && <AnnounceTab />}
      {tab === 'ops' && <OpsTab />}
      {tab === 'security' && <SecurityTab role={role} />}
      {tab === 'audit' && <AuditTab />}
      {tab === 'staff' && <StaffTab />}
        </div>
      </div>
    </div>
  );
}
