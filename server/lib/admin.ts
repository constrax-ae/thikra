import { type Context } from 'hono';
import { type Env, PROD, sha } from '../app.ts';
import { all, one, run, type Row } from '../db.ts';
import { callerIp } from './auth.ts';
import { getCookie } from 'hono/cookie';
import { closeUserSockets } from './sockets.ts';

// ---- platform admin -----------------------------------------------------------

export type Role = 'owner' | 'moderator' | 'support';
export type Perm = 'stats' | 'metrics' | 'backups' | 'circles' | 'reports' | 'reports.act' | 'users.read' | 'users.reveal' | 'users.act' | 'roles' | 'audit' | 'analytics' | 'sms' | 'flags' | 'plans' | 'support' | 'agent' | 'agent.act' | 'circles.act' | 'users.delete' | 'notes' | 'announce';

/** What each role may do. Owner: everything. Moderator: the safety work (reports, suspending and banning people, reading the audit log). Support: look people up (numbers masked), nothing that changes anything. */
export const ROLE_PERMS: Record<Role, readonly Perm[]> = {
  owner: ['stats', 'metrics', 'backups', 'circles', 'reports', 'reports.act', 'users.read', 'users.reveal', 'users.act', 'roles', 'audit', 'analytics', 'sms', 'flags', 'plans', 'support', 'agent', 'agent.act', 'circles.act', 'users.delete', 'notes', 'announce'],
  moderator: ['stats', 'circles', 'reports', 'reports.act', 'users.read', 'users.reveal', 'users.act', 'audit', 'analytics', 'support', 'agent', 'agent.act', 'circles.act', 'notes'],
  support: ['stats', 'users.read', 'support', 'notes'],
};
export const ROLES = Object.keys(ROLE_PERMS) as Role[];
export const roleOf = (u: Row): Role | null => (ROLES.includes(u.admin_role) ? u.admin_role : u.is_admin ? 'owner' : null);
export const can = (u: Row, perm: Perm) => { const r = roleOf(u); return !!r && ROLE_PERMS[r].includes(perm); };

/** Optional extra locks for staff: a list of allowed addresses (THIKRA_ADMIN_IPS) and, in production, the two-step PIN (THIKRA_ADMIN_REQUIRE_PIN=0 turns the PIN rule off). Read at request time. */
const adminIps = () => (process.env.THIKRA_ADMIN_IPS ?? '').split(',').map(x => x.trim()).filter(Boolean);
const adminNeedsPin = () => process.env.THIKRA_ADMIN_REQUIRE_PIN === '1' || (PROD && process.env.THIKRA_ADMIN_REQUIRE_PIN !== '0');

/** `requireAdmin('reports.act')`: the signed-in person must be staff whose role includes the permission. */
export const requireAdmin = (perm: Perm, opts: { stepUp?: boolean } = {}) => async (c: Context<Env>, next: () => Promise<void>) => {
  const u = c.get('user');
  if (!can(u, perm)) return c.json({ error: 'forbidden' }, 403);
  const ips = adminIps();
  if (ips.length) {
    const ip = callerIp(c);
    if (!ip || !ips.includes(ip)) return c.json({ error: 'forbidden' }, 403);
  }
  if (adminNeedsPin() && !u.has_pin) return c.json({ error: 'admin_requires_pin' }, 403);
  // An authenticator code (TOTP): once a staff member switched it on, admin actions need a code verified in the last 30 minutes on THIS session.
  // The security routes themselves (to verify, to switch it on) are exempt, otherwise nobody could ever get in.
  if (opts.stepUp !== false) {
    const t = one('SELECT enabled FROM admin_totp WHERE user_id = ?', u.id);
    if (!t?.enabled && process.env.THIKRA_ADMIN_REQUIRE_TOTP === '1') return c.json({ error: 'admin_requires_totp' }, 403);
    if (t?.enabled) {
      const token = getCookie(c, 'thikra_session');
      const s = token ? one('SELECT admin_ok_until FROM sessions WHERE token = ?', sha(token)) : undefined;
      if (!s || !(Number(s.admin_ok_until) > Date.now())) return c.json({ error: 'admin_totp_required' }, 403);
    }
  }
  return next();
};

/** Every staff action is written here, append-only (the table refuses updates and deletes). `detail` never holds message text or a full phone number. */
export function audit(c: Context<Env>, action: string, target?: { type: string; id: string | number }, detail?: Record<string, unknown>) {
  const u = c.get('user');
  run('INSERT INTO admin_audit (actor_id, actor_role, action, target_type, target_id, detail) VALUES (?, ?, ?, ?, ?, ?)',
    u.id, roleOf(u), action, target?.type ?? null, target ? String(target.id) : null, detail ? JSON.stringify(detail) : null);
}

export const maskPhone = (p: string) => (p.length > 4 ? '•'.repeat(Math.max(3, p.length - 4)) + p.slice(-4) : p);
export const phoneHash = (p: string) => sha(`ban:${p}`);
export const isBanned = (phone: string) => !!one('SELECT 1 FROM banned_phones WHERE phone_hash = ?', phoneHash(phone));

/** Is this person suspended right now? A suspension with an end date lifts itself. */
export function suspension(userId: number): { reason: string | null; until: string | null } | null {
  const u = one('SELECT suspended_at, suspended_until, suspended_reason FROM users WHERE id = ?', userId);
  if (!u?.suspended_at) return null;
  if (u.suspended_until && Date.parse(u.suspended_until.replace(' ', 'T') + 'Z') <= Date.now()) {
    run('UPDATE users SET suspended_at = NULL, suspended_until = NULL, suspended_reason = NULL WHERE id = ?', userId);
    return null;
  }
  return { reason: u.suspended_reason ?? null, until: u.suspended_until ?? null };
}

export const endSessions = (userId: number) => { run('DELETE FROM sessions WHERE user_id = ?', userId); closeUserSockets(userId); };
export const staff = () => all("SELECT id, name, admin_role AS role FROM users WHERE admin_role IS NOT NULL ORDER BY id");

/** Private staff notes on a person or a family (never shown to them), newest first. */
export const notesOf = (type: 'user' | 'circle', id: number) =>
  all('SELECT n.id, n.body, n.created_at AS createdAt, u.name AS author FROM admin_notes n LEFT JOIN users u ON u.id = n.author_id WHERE n.target_type = ? AND n.target_id = ? ORDER BY n.id DESC LIMIT 20', type, id);
