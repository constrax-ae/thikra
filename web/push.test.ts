// Notifications on the web: what the service worker does with a push and a tap, and how a tapped route becomes a screen.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import vm from 'node:vm';
import { hashFromPath } from './src/push.ts';

function loadWorker() {
  const handlers: Record<string, (e: any) => void> = {};
  const shown: Array<{ title: string; opts: any }> = [];
  const opened: string[] = [];
  const messages: any[] = [];
  const focused: number[] = [];
  let windows: any[] = [];
  const self: any = {
    addEventListener: (t: string, f: any) => { handlers[t] = f; },
    skipWaiting() {}, registration: { showNotification: async (title: string, opts: any) => { shown.push({ title, opts }); } },
    clients: { claim() {}, matchAll: async () => windows, openWindow: async (u: string) => { opened.push(u); } },
  };
  vm.runInNewContext(readFileSync(new URL('./public/sw.js', import.meta.url), 'utf8'), { self, JSON, Number, String });
  const run = async (name: string, e: any) => { let p: Promise<unknown> = Promise.resolve(); handlers[name]({ ...e, waitUntil: (x: Promise<unknown>) => { p = x; } }); await p; };
  return { run, shown, opened, messages, focused, setWindows: (n: number) => { windows = Array.from({ length: n }, (_, i) => ({ focus: async () => { focused.push(i); }, postMessage: (m: any) => messages.push(m) })); } };
}
const tap = (data: any) => ({ notification: { close() {}, data } });

test('a push shows its title and text, one notification per chat, and carries where to go', async () => {
  const w = loadWorker();
  await w.run('push', { data: { json: () => ({ title: 'العائلة', body: 'سارة: مرحبا', circle: 7, tag: 'circle-7' }) } });
  assert.equal(w.shown[0].title, 'العائلة');
  assert.equal(w.shown[0].opts.body, 'سارة: مرحبا');
  assert.equal(w.shown[0].opts.tag, 'circle-7');
  assert.deepEqual({ ...w.shown[0].opts.data }, { circle: 7, url: undefined });
});

test('a push that is not readable still shows something, and never throws', async () => {
  const w = loadWorker();
  await w.run('push', { data: { json: () => { throw new Error('not json'); } } });
  await w.run('push', {});
  assert.equal(w.shown.length, 2);
  assert.equal(w.shown[0].title, 'Tamtim');
  assert.equal(w.shown[1].opts.body, '');
});

test('tapping opens the chat in an open tab, or opens a window when there is none', async () => {
  const w = loadWorker();
  w.setWindows(1);
  await w.run('notificationclick', tap({ circle: 7 }));
  assert.equal(JSON.stringify(w.messages), JSON.stringify([{ t: 'open', path: '/#/circle/7' }]));
  assert.deepEqual(w.focused, [0]);
  assert.deepEqual(w.opened, []);
  w.setWindows(0);
  await w.run('notificationclick', tap({ circle: 9 }));
  assert.deepEqual(w.opened, ['/#/circle/9']);
});

test('a notification with its own address (support, quota, admin alert) opens that address, not the chat list', async () => {
  const w = loadWorker();
  w.setWindows(0);
  await w.run('notificationclick', tap({ circle: 0, url: '/#/you' }));
  await w.run('notificationclick', tap({ circle: 0 }));
  assert.deepEqual(w.opened, ['/#/you', '/']);
});

test('a tap never opens an address outside the app', async () => {
  const w = loadWorker();
  w.setWindows(0);
  for (const url of ['https://evil.test/x', '//evil.test/x', '/\\evil.test/x', 'javascript:alert(1)']) await w.run('notificationclick', tap({ url }));
  await w.run('notificationclick', tap({ circle: '7; drop' }));
  assert.deepEqual(w.opened, ['/', '/', '/', '/', '/']);
});

test('the route a notification asks for becomes the screen the router reads', () => {
  assert.equal(hashFromPath('/#/circle/7'), '/circle/7');
  assert.equal(hashFromPath('/#/you'), '/you');
  assert.equal(hashFromPath('/'), '/');
  assert.equal(hashFromPath('/#'), '/');
  assert.equal(hashFromPath('//evil.test'), null);
  assert.equal(hashFromPath('/\\evil.test'), null);
  assert.equal(hashFromPath('https://evil.test'), null);
  assert.equal(hashFromPath(undefined), null);
});
