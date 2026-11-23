import { app } from '../app.ts';
import { all, one, run } from '../db.ts';
import { checkKeyPackage, describeKeyPackage, fromB64, verifyEndorsement } from '../../core/e2ee.ts';
import { e2eeEnabled, identityName, purgeStaleTransfers, requireRekey, readBody } from '../lib/e2ee.ts';
import { limited, tx } from '../lib/helpers.ts';

// ---- the key directory (feature 26, part A) ----------------------------------------------------------------------------------------------
// Each device of a person registers once, then publishes key packages (its public one-time keys, all signed by its one identity key).
// A person who starts or extends an encrypted chat claims ONE package per device of each other person. The server stores and hands out bytes; it never
// has a secret key. What the server could do wrong is hand out a key that is not the device's (a man in the middle): that is what the safety number is for.

const now = () => Math.floor(Date.now() / 1000);
const MAX_DEVICES = 10;            // active devices per person
const MAX_STOCK = 100;             // unused one-time packages per device
const MAX_BATCH = 50;
const MAX_PACKAGE = 8 * 1024;
const B64 = /^[A-Za-z0-9+/]+={0,2}$/;
const b64 = (v: unknown, max: number): Uint8Array | null => {
  if (typeof v !== 'string' || !v || v.length > Math.ceil(max / 3) * 4 + 4 || !B64.test(v) || v.length % 4 !== 0) return null;
  const out = fromB64(v);
  return out.length > 0 && out.length <= max ? out : null;
};
export const toBase64 = (b: Uint8Array | Buffer) => Buffer.from(b).toString('base64');
const activeDevice = (id: number, userId: number) => one('SELECT * FROM e2ee_devices WHERE id = ? AND user_id = ? AND revoked_at IS NULL', id, userId);
/** You may look up a person's devices only if you already share a chat with them (or it is you): the directory is not a phone book. */
const sharesChat = (me: number, other: number) => me === other || !!one(
  `SELECT 1 FROM circle_members a JOIN circle_members b ON b.circle_id = a.circle_id AND b.user_id = ? JOIN circles c ON c.id = a.circle_id AND c.deleted_at IS NULL WHERE a.user_id = ? LIMIT 1`, other, me);
const stockOf = (deviceId: number) => one('SELECT COUNT(*) AS n FROM e2ee_key_packages WHERE device_id = ? AND last_resort = 0', deviceId)!.n as number;

app.get('/api/keys/status', c => c.json({ enabled: e2eeEnabled() }));

// A new device. Its id becomes part of its name inside the protocol, so it comes BEFORE its key packages.
app.post('/api/keys/devices', async c => {
  if (!e2eeEnabled()) return c.json({ error: 'e2ee_unavailable' }, 409);
  const u = c.get('user');
  if (await limited(`e2ee-device:${u.id}`, 20, 3600_000)) return c.json({ error: 'too_many_requests' }, 429);
  const b = await readBody(c);
  if (one('SELECT COUNT(*) AS n FROM e2ee_devices WHERE user_id = ? AND revoked_at IS NULL', u.id)!.n as number >= MAX_DEVICES) return c.json({ error: 'too_many_devices' }, 409);
  const label = typeof b.label === 'string' ? b.label.trim().slice(0, 40) || null : null;
  const id = Number(run('INSERT INTO e2ee_devices (user_id, label) VALUES (?, ?)', u.id, label).lastInsertRowid);
  return c.json({ deviceId: id, identity: identityName(u.id, id) }, 201);
});
// My devices, with how many unused packages each has left (the device tops up when it runs low).
app.get('/api/keys/devices', c => c.json(all(
  `SELECT d.id, d.label, d.created_at AS createdAt, d.revoked_at AS revokedAt, d.identity_key AS identityKey, d.link_proof AS linkProof, d.link_pub AS linkPub, d.link_expires_at AS linkExpiresAt, d.link_used_at AS linkUsedAt, d.endorsement, d.endorsed_by AS endorsedBy,
          (SELECT COUNT(*) FROM e2ee_key_packages k WHERE k.device_id = d.id AND k.last_resort = 0) AS stock
     FROM e2ee_devices d WHERE d.user_id = ? ORDER BY d.id`, c.get('user').id).map(d => {
    // An expired or used pairing is not offered: nobody can find the device with an old code or picture any more.
    const live = !!d.linkProof && !d.linkUsedAt && Number(d.linkExpiresAt) > now();
    return { ...d, identityKey: d.identityKey ? toBase64(d.identityKey) : null, linkProof: live ? d.linkProof : null, linkPub: live ? d.linkPub : null, linkExpiresAt: live ? d.linkExpiresAt : null };
  })));

// Publish key packages. Each must be a valid MLS key package that NAMES this device (u<me>.d<device>) and is signed by the device's one identity key: the first
// package fixes that key, every later one must carry the same.
app.post('/api/keys/devices/:did/packages', async c => {
  const u = c.get('user');
  const dev = activeDevice(Number(c.req.param('did')), u.id);
  if (!dev) return c.json({ error: 'not_found' }, 404);
  const b = await readBody(c);
  const rawList = Array.isArray(b.packages) ? b.packages : [];
  if (rawList.length > MAX_BATCH) return c.json({ error: 'too_many_packages' }, 400);
  const list: Uint8Array[] = [];
  for (const x of rawList) { const p = b64(x, MAX_PACKAGE); if (!p) return c.json({ error: 'invalid_package' }, 400); list.push(p); }
  const last = b.lastResort === undefined || b.lastResort === null ? null : b64(b.lastResort, MAX_PACKAGE);
  if (b.lastResort !== undefined && b.lastResort !== null && !last) return c.json({ error: 'invalid_package' }, 400);
  if (stockOf(dev.id) + list.length > MAX_STOCK) return c.json({ error: 'too_many_packages' }, 400);
  let key: Uint8Array | null = dev.identity_key ? new Uint8Array(dev.identity_key) : null;
  for (const p of [...list, ...(last ? [last] : [])]) {
    let d: ReturnType<typeof describeKeyPackage>;
    try { d = describeKeyPackage(p); } catch { return c.json({ error: 'invalid_package' }, 400); }
    if (d.identity !== identityName(u.id, dev.id) || d.signaturePublicKey.length !== 32) return c.json({ error: 'invalid_package' }, 400);
    if (!await checkKeyPackage(p)) return c.json({ error: 'invalid_package' }, 400);   // signatures, ciphersuite, expiry
    if (key && Buffer.compare(Buffer.from(key), Buffer.from(d.signaturePublicKey)) !== 0) return c.json({ error: 'invalid_package' }, 400);   // one device, one identity key
    key = d.signaturePublicKey;
  }
  const clash = tx(() => {
    // Checked again inside the transaction: the signature checks above wait, and a second upload may have pinned a key or filled the stock meanwhile.
    const now = one('SELECT identity_key FROM e2ee_devices WHERE id = ? AND revoked_at IS NULL', dev.id);
    if (!now) return 'not_found';
    if (now.identity_key && key && Buffer.compare(Buffer.from(now.identity_key as Uint8Array), Buffer.from(key)) !== 0) return 'invalid_package';
    if (stockOf(dev.id) + list.length > MAX_STOCK) return 'too_many_packages';
    if (!now.identity_key && key) run('UPDATE e2ee_devices SET identity_key = ? WHERE id = ?', Buffer.from(key), dev.id);
    for (const p of list) run('INSERT INTO e2ee_key_packages (device_id, data) VALUES (?, ?)', dev.id, Buffer.from(p));
    if (last) { run('DELETE FROM e2ee_key_packages WHERE device_id = ? AND last_resort = 1', dev.id); run('INSERT INTO e2ee_key_packages (device_id, data, last_resort) VALUES (?, ?, 1)', dev.id, Buffer.from(last)); }
    return null;
  });
  if (clash) return c.json({ error: clash }, clash === 'not_found' ? 404 : 400);
  return c.json({ stock: stockOf(dev.id) });
});

// A device is lost or retired: it is no longer offered, its unused packages go, and every encrypted chat of this person is told to change keys
// (a commit that removes the device), so the lost device cannot read what is sent next.
app.delete('/api/keys/devices/:did', c => {
  const u = c.get('user');
  const dev = activeDevice(Number(c.req.param('did')), u.id);
  if (!dev) return c.json({ error: 'not_found' }, 404);
  run("UPDATE e2ee_devices SET revoked_at = datetime('now') WHERE id = ?", dev.id);
  run('DELETE FROM e2ee_key_packages WHERE device_id = ?', dev.id);
  run('DELETE FROM e2ee_welcomes WHERE to_device_id = ?', dev.id);
  run('DELETE FROM e2ee_transfers WHERE device_id = ?', dev.id);
  for (const r of all('SELECT c.id FROM circles c JOIN circle_members m ON m.circle_id = c.id AND m.user_id = ? WHERE c.encrypted = 1 AND c.deleted_at IS NULL', u.id)) requireRekey(r.id as number, 'device_revoked', u.id);
  return c.json({ ok: true });
});

// A person's active devices and their identity keys (what the safety number is made from).
app.get('/api/keys/users/:uid', c => {
  const uid = Number(c.req.param('uid'));
  if (!Number.isInteger(uid) || !sharesChat(c.get('user').id, uid)) return c.json({ error: 'not_found' }, 404);
  const devices = all('SELECT id, identity_key AS identityKey, (SELECT COUNT(*) FROM e2ee_key_packages k WHERE k.device_id = e2ee_devices.id) AS stock FROM e2ee_devices WHERE user_id = ? AND revoked_at IS NULL AND identity_key IS NOT NULL ORDER BY id', uid);
  return c.json({ userId: uid, devices: devices.map(d => ({ id: d.id, identityKey: toBase64(d.identityKey), stock: d.stock })) });
});
// Take one package per device of this person, to start or extend a chat. A one-time package is used once; when a device has none left its last-resort package is
// handed out again (it is never used up, so a chat can still start, with a little less protection against replay, until the device tops up).
app.post('/api/keys/users/:uid/claim', async c => {
  const me = c.get('user').id;
  const uid = Number(c.req.param('uid'));
  if (!Number.isInteger(uid) || !sharesChat(me, uid)) return c.json({ error: 'not_found' }, 404);
  if (await limited(`e2ee-claim:${me}`, 120, 10 * 60_000)) return c.json({ error: 'too_many_requests' }, 429);
  // A few per hour per person is plenty to start or extend chats; more would only drain their stock (leaving the reusable last-resort package).
  if (await limited(`e2ee-claim:${me}:${uid}`, 8, 3600_000)) return c.json({ error: 'too_many_requests' }, 429);
  const packages = tx(() => {
    const out: Array<{ deviceId: number; package: string; lastResort: boolean }> = [];
    for (const d of all('SELECT id FROM e2ee_devices WHERE user_id = ? AND revoked_at IS NULL AND identity_key IS NOT NULL ORDER BY id', uid)) {
      const one1 = one('SELECT id, data FROM e2ee_key_packages WHERE device_id = ? AND last_resort = 0 ORDER BY id LIMIT 1', d.id);
      if (one1) { run('DELETE FROM e2ee_key_packages WHERE id = ?', one1.id); out.push({ deviceId: d.id, package: toBase64(one1.data), lastResort: false }); continue; }
      const lr = one('SELECT data FROM e2ee_key_packages WHERE device_id = ? AND last_resort = 1', d.id);
      if (lr) out.push({ deviceId: d.id, package: toBase64(lr.data), lastResort: true });
    }
    return out;
  });
  return c.json({ packages });
});

// The recovery backup: one opaque blob per person, made and encrypted on their device with a key from their recovery code. The server cannot read it. It is replaced
// by each new backup and removed on request; it is also removed with the account (ON DELETE CASCADE).
const MAX_BACKUP = 4 * 1024 * 1024;
app.get('/api/keys/backup', c => {
  const r = one('SELECT data, version, updated_at AS updatedAt FROM e2ee_backups WHERE user_id = ?', c.get('user').id);
  return r ? c.json({ data: toBase64(r.data), version: r.version, updatedAt: r.updatedAt }) : c.json({ error: 'not_found' }, 404);
});
app.put('/api/keys/backup', async c => {
  const u = c.get('user');
  if (!e2eeEnabled()) return c.json({ error: 'e2ee_unavailable' }, 409);
  if (await limited(`e2ee-backup:${u.id}`, 30, 3600_000)) return c.json({ error: 'too_many_requests' }, 429);
  const b = await readBody(c);
  if (typeof b.data === 'string' && b.data.length > Math.ceil(MAX_BACKUP / 3) * 4 + 4) return c.json({ error: 'too_large', max: MAX_BACKUP }, 413);
  const data = b64(b.data, MAX_BACKUP);
  if (!data) return c.json({ error: 'invalid_value' }, 400);
  const version = Number.isInteger(b.version) && b.version > 0 && b.version < 1000 ? b.version : 1;
  run("INSERT INTO e2ee_backups (user_id, data, version, updated_at) VALUES (?, ?, ?, datetime('now')) ON CONFLICT(user_id) DO UPDATE SET data = excluded.data, version = excluded.version, updated_at = excluded.updated_at", u.id, Buffer.from(data), version);
  return c.json({ ok: true });
});
app.delete('/api/keys/backup', c => { run('DELETE FROM e2ee_backups WHERE user_id = ?', c.get('user').id); return c.json({ ok: true }); });


// ---- linking a second device ---------------------------------------------------------------------------------------------------------------
// A PAIRING: the NEW device makes a one-time key pair and shows its public key in a QR code (and a short typed code as a fallback). It publishes the public key and a proof
// of the typed code. The person scans or types on an OLDER device, which finds the device, asks the person to CONFIRM, adds it to every encrypted chat and hands its history
// over, sealed with a key that only the two devices can make (a key agreement between the new device's one-time key and the older device's). A pairing lives LINK_TTL
// seconds and works ONCE. The server stores public keys, a proof and bytes; it never has a key that opens the hand-over.
const PROOF = /^[0-9a-f]{64}$/;
const LINK_TTL = 180;              // seconds a pairing may be started
const LINK_FINISH = 600;           // seconds after it was started that the remaining parts of the hand-over are still accepted
const pubKey = (v: unknown) => { const k = b64(v, 32); return k && k.length === 32 ? (v as string) : null; };
/** The pairing may still be started: published, not expired, not used. */
const pairingActive = (d: any) => !!d.link_proof && !d.link_used_at && Number(d.link_expires_at) > now();
app.put('/api/keys/devices/:did/link', async c => {
  const u = c.get('user');
  if (!e2eeEnabled()) return c.json({ error: 'e2ee_unavailable' }, 409);
  const dev = activeDevice(Number(c.req.param('did')), u.id);
  if (!dev) return c.json({ error: 'not_found' }, 404);
  const b = await readBody(c);
  const pub = pubKey(b.pub);
  if (typeof b.proof !== 'string' || !PROOF.test(b.proof) || !pub) return c.json({ error: 'invalid_value' }, 400);
  if (pairingActive(dev)) return c.json({ error: 'already_linked' }, 409);
  run('DELETE FROM e2ee_transfers WHERE device_id = ?', dev.id);
  run('UPDATE e2ee_devices SET link_proof = ?, link_pub = ?, link_expires_at = ?, link_used_at = NULL, link_peer = NULL WHERE id = ?', b.proof, pub, now() + LINK_TTL, dev.id);
  return c.json({ ok: true, expiresAt: now() + LINK_TTL });
});

const MAX_PART = 3 * 1024 * 1024;   // bytes per part
const MAX_PARTS = 40;
app.put('/api/keys/devices/:did/transfer', async c => {
  const u = c.get('user');
  if (!e2eeEnabled()) return c.json({ error: 'e2ee_unavailable' }, 409);
  const dev = activeDevice(Number(c.req.param('did')), u.id);
  if (!dev) return c.json({ error: 'not_found' }, 404);
  if (await limited(`e2ee-transfer:${u.id}`, 400, 3600_000)) return c.json({ error: 'too_many_requests' }, 429);
  purgeStaleTransfers();
  const b = await readBody(c);
  if (!Number.isInteger(b.part) || b.part < 0 || b.part >= MAX_PARTS) return c.json({ error: 'invalid_value' }, 400);
  if (typeof b.data === 'string' && b.data.length > Math.ceil(MAX_PART / 3) * 4 + 4) return c.json({ error: 'too_large', max: MAX_PART }, 413);
  const data = b64(b.data, MAX_PART);
  if (!data) return c.json({ error: 'invalid_value' }, 400);
  if (!dev.link_proof) return c.json({ error: 'not_linking' }, 409);
  if (b.part === 0) {
    // The start of a hand-over: the pairing must be alive and unused, and it is used up right now (one use). The older device's one-time public key comes with part 0.
    const peer = pubKey(b.peer);
    if (!peer) return c.json({ error: 'invalid_value' }, 400);
    if (!pairingActive(dev)) return c.json({ error: 'link_expired' }, 410);
    run('DELETE FROM e2ee_transfers WHERE device_id = ?', dev.id);   // parts of an earlier, unfinished hand-over never mix into this one
    run('UPDATE e2ee_devices SET link_used_at = ?, link_peer = ? WHERE id = ?', now(), peer, dev.id);
  } else if (!dev.link_used_at) return c.json({ error: 'not_linking' }, 409);
  else if (now() - Number(dev.link_used_at) > LINK_FINISH) return c.json({ error: 'link_expired' }, 410);
  run("INSERT INTO e2ee_transfers (device_id, part, last, data, created_at) VALUES (?, ?, ?, ?, datetime('now')) ON CONFLICT(device_id, part) DO UPDATE SET last = excluded.last, data = excluded.data, created_at = excluded.created_at", dev.id, b.part, b.last ? 1 : 0, Buffer.from(data));
  return c.json({ ok: true });
});
app.get('/api/keys/devices/:did/transfer', c => {
  const dev = activeDevice(Number(c.req.param('did')), c.get('user').id);
  if (!dev) return c.json({ error: 'not_found' }, 404);
  const rows = all('SELECT part, last FROM e2ee_transfers WHERE device_id = ? ORDER BY part', dev.id);
  const parts = rows.map(r => r.part as number);
  const lastPart = rows.find(r => r.last)?.part as number | undefined;
  return c.json({ parts, complete: lastPart !== undefined && parts.length === lastPart + 1 && parts.every((p, i) => p === i), peer: (dev.link_peer as string | null) ?? null });
});
app.get('/api/keys/devices/:did/transfer/:part', c => {
  const dev = activeDevice(Number(c.req.param('did')), c.get('user').id);
  const r = dev && one('SELECT data FROM e2ee_transfers WHERE device_id = ? AND part = ?', dev.id, Number(c.req.param('part')));
  return r ? c.json({ data: toBase64(r.data) }) : c.json({ error: 'not_found' }, 404);
});
app.delete('/api/keys/devices/:did/transfer', c => {
  const dev = activeDevice(Number(c.req.param('did')), c.get('user').id);
  if (!dev) return c.json({ error: 'not_found' }, 404);
  run('DELETE FROM e2ee_transfers WHERE device_id = ?', dev.id);
  run('UPDATE e2ee_devices SET link_proof = NULL, link_pub = NULL, link_expires_at = NULL, link_peer = NULL WHERE id = ?', dev.id);   // the pairing is over
  return c.json({ ok: true });
});

// A person's older device vouches for another device of theirs: the signature (made with the older device's identity key over the new device's name and key) is kept so that
// everyone who trusts the older device can check it. The server verifies it too, so junk is not stored; it cannot make one.
app.put('/api/keys/devices/:did/endorsement', async c => {
  const u = c.get('user');
  if (!e2eeEnabled()) return c.json({ error: 'e2ee_unavailable' }, 409);
  const dev = activeDevice(Number(c.req.param('did')), u.id);
  const b = await readBody(c);
  const by = Number.isInteger(b.by) ? activeDevice(b.by, u.id) : null;
  if (!dev || !by) return c.json({ error: 'not_found' }, 404);
  const sig = b64(b.sig, 64);
  if (dev.id === by.id || !sig || sig.length !== 64 || !dev.identity_key || !by.identity_key) return c.json({ error: 'invalid_value' }, 400);
  if (!await verifyEndorsement(new Uint8Array(by.identity_key), u.id, dev.id, new Uint8Array(dev.identity_key), sig)) return c.json({ error: 'invalid_value' }, 400);
  run('UPDATE e2ee_devices SET endorsement = ?, endorsed_by = ? WHERE id = ?', b.sig, by.id, dev.id);
  return c.json({ ok: true });
});
