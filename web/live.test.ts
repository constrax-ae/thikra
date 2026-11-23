// The live socket must ask to hear chats created after the page loaded (the server only joins the chats known at connect time).
import { test } from 'node:test';
import assert from 'node:assert/strict';

class FakeSocket {
  static last: FakeSocket;
  sent: Array<{ t: string; circle: number }> = [];
  onopen: any; onmessage: any; onclose: any; onerror: any;
  constructor() { FakeSocket.last = this; }
  send(s: string) { this.sent.push(JSON.parse(s)); }
  close() { this.onclose?.(); }
}
(globalThis as any).WebSocket = FakeSocket;
(globalThis as any).location = { protocol: 'http:', host: 'x' };

test('live.join asks the server for new chats once per socket, and again after a reconnect', async () => {
  const { live } = await import('./src/live.ts');
  const off = live.on(() => {});
  const sock: FakeSocket = FakeSocket.last;
  live.join([5]);                                   // not open yet: nothing is sent
  assert.equal(sock.sent.length, 0);
  sock.onopen();
  live.join([5, 6]); live.join([5, 6, 7]);
  assert.deepEqual(sock.sent.filter(f => f.t === 'join').map(f => f.circle), [5, 6, 7]);   // each chat once
  sock.onclose();                                   // connection lost: a new socket is made, so the memory is reset
  await new Promise(r => setTimeout(r, 1500));
  const again: FakeSocket = FakeSocket.last;
  assert.notEqual(again, sock);
  again.onopen();
  live.join([5]);
  assert.deepEqual(again.sent.filter(f => f.t === 'join').map(f => f.circle), [5]);
  off();
});
