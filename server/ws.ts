// The live gateway: one WebSocket per device, authenticated by the same session cookie as the HTTP API.
// JSON frames for now; PROTOCOL.md specifies Protobuf, which replaces only the encoding, not this flow.
//
//   client → server   {t:'send', circle, client_msg_id, body}      server → client  {t:'ack', client_msg_id, id, seq, duplicate}
//                     {t:'sync', circle, after_seq}                                  {t:'sync', circle, messages:[…]}
//                     {t:'ping'}                                                     {t:'pong'}
//   (server push)                                                                    {t:'msg', circle, m}  {t:'changed', circle}
//
// Delivery guarantee does not depend on this socket: anything missed is fetched by `sync` (or GET /messages) by seq.

import type { Server } from 'node:http';
import { createHash } from 'node:crypto';
import { WebSocketServer, type WebSocket } from 'ws';
import { one, all, type Row } from './db.ts';
import { join, publish, setVisible } from './live.ts';
import { suspension } from './lib/admin.ts';
import { trackSocket } from './lib/sockets.ts';
import { count } from './metrics.ts';

export interface GatewayDeps {
  sendText(circleId: number, userId: number, body: string, clientMsgId: string | null, replyTo?: number | null): { id: number; seq: number; duplicate: boolean };
  membership(circleId: number, userId: number): Row | undefined;
  limited(key: string, max: number, windowMs: number): Promise<boolean>;
  /** Has this exact send already been stored? (a retry after a lost ack) */
  known(circleId: number, userId: number, clientMsgId: string): boolean;
  messagesSince(circleId: number, userId: number, afterSeq: number): Row[];
  messagesChanged(circleId: number, userId: number, afterRev: number): Row[];
  syncPage: number;
  markRead(circleId: number, userId: number, seq: number): void;
}

const sha = (s: string) => createHash('sha256').update(s).digest('hex');
const HEARTBEAT_MS = 25_000;

function cookieValue(header: string | undefined, name: string) {
  for (const part of (header ?? '').split(';')) {
    const [k, ...v] = part.trim().split('=');
    if (k === name) return decodeURIComponent(v.join('='));
  }
}

export function attachGateway(server: Server, deps: GatewayDeps) {
  const wss = new WebSocketServer({ noServer: true, maxPayload: 64 * 1024 });

  server.on('upgrade', (req, socket, head) => {
    if (new URL(req.url ?? '/', 'http://x').pathname !== '/ws') return; // not ours
    const token = cookieValue(req.headers.cookie, 'thikra_session');
    const s = token && one('SELECT user_id FROM sessions WHERE token = ? AND expires_at > ?', sha(token), Date.now());
    if (!s) { socket.write('HTTP/1.1 401 Unauthorized\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }
    if (suspension(s.user_id)) { socket.write('HTTP/1.1 403 Forbidden\r\nConnection: close\r\n\r\n'); socket.destroy(); return; }   // suspended people get no live connection
    wss.handleUpgrade(req, socket, head, ws => connection(ws, s.user_id));
  });

  function connection(ws: WebSocket, userId: number) {
    const leave = new Map<number, () => void>();
    const send = (o: unknown) => { if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(o)); };
    const subscribe = (circleId: number) => {
      if (leave.has(circleId) || !deps.membership(circleId, userId)) return;
      leave.set(circleId, join(circleId, send, userId));
    };
    count('ws_open');
    const untrack = trackSocket(userId, () => ws.close(4001, 'signed_out'));   // suspend, ban and "sign out everywhere" end live connections too
    ws.once('close', untrack);
    for (const r of all('SELECT circle_id FROM circle_members WHERE user_id = ?', userId)) subscribe(r.circle_id);

    let isVisibleNow = false;
    let alive = true;
    ws.on('pong', () => { alive = true; });
    const beat = setInterval(() => {
      if (!alive) return ws.terminate();
      alive = false; ws.ping();
    }, HEARTBEAT_MS);

    // Frames from one connection are handled strictly one after another: a send that waits on the rate limiter must not be overtaken
    // by the next one (that would swap the order of a person's messages).
    let queue: Promise<unknown> = Promise.resolve();
    ws.on('message', raw => { queue = queue.then(() => onFrame(raw)).catch(() => { /* one bad frame never stops the connection */ }); });
    const onFrame = async (raw: unknown) => {
      let f: any;
      try { f = JSON.parse(String(raw)); } catch { return send({ t: 'err', error: 'bad_frame' }); }
      const circle = Number(f?.circle);
      switch (f?.t) {
        case 'ping': return send({ t: 'pong' });
        case 'visible': { const now = f.on === true; setVisible(userId, isVisibleNow, now); isVisibleNow = now; return; }
        case 'join': return subscribe(circle);
        case 'send': {
          const cmid = typeof f.client_msg_id === 'string' && f.client_msg_id.length <= 64 ? f.client_msg_id : null;
          const fail = (error: string) => send({ t: 'err', client_msg_id: cmid, error });
          if (!deps.membership(circle, userId)) return fail('not_found');
          const body = String(f.body ?? '').trim().slice(0, 4000);
          if (!body) return fail('empty');
          // A retry of a message the server already holds costs nothing and must never be refused: after a
          // dropped connection the client resends everything unacknowledged, and refusing that would lose messages.
          const retry = cmid !== null && deps.known(circle, userId, cmid);
          if (!retry && await deps.limited(`ws-send:${userId}`, 120, 60_000)) { count('ws_rate_limited'); return fail('rate_limited'); }
          subscribe(circle);
          try {
            const r = deps.sendText(circle, userId, body, cmid, Number.isInteger(f.reply_to) ? f.reply_to : null);
            return send({ t: 'ack', client_msg_id: cmid, id: r.id, seq: r.seq, duplicate: r.duplicate });
          } catch (e: any) {
            if (e?.code === 'blocked' || e?.code === 'maintenance' || e?.code === 'circle_frozen') return fail(e.code);
            console.error('[ws send]', e); return fail('server');
          }
        }
        case 'read': {
          if (!deps.membership(circle, userId)) return send({ t: 'err', error: 'not_found' });
          return deps.markRead(circle, userId, Number(f.seq));
        }
        case 'typing': {
          // Not stored anywhere: relayed to the others in the circle, at most twice a second per person.
          if (!deps.membership(circle, userId) || await deps.limited(`typing:${userId}`, 2, 1000)) return;
          return void publish(circle, { t: 'typing', circle, user: userId, on: f.on !== false }, undefined, userId);
        }
        case 'sync': {
          if (!deps.membership(circle, userId)) return send({ t: 'err', error: 'not_found' });
          subscribe(circle);
          const byRev = f.after_rev !== undefined;
          const messages = byRev ? deps.messagesChanged(circle, userId, Number(f.after_rev) || 0) : deps.messagesSince(circle, userId, Number(f.after_seq) || 0);
          // `more`: the page was full, so the client should ask again from its new contiguous prefix.
          return send({ t: 'sync', circle, messages, more: messages.length >= deps.syncPage });
        }
        default: return send({ t: 'err', error: 'unknown_frame' });
      }
    };

    ws.on('close', () => { setVisible(userId, isVisibleNow, false); count('ws_close'); clearInterval(beat); for (const off of leave.values()) off(); leave.clear(); });
    ws.on('error', () => ws.terminate());
    send({ t: 'hello', circles: [...leave.keys()] });
  }

  return wss;
}

