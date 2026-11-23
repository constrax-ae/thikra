// The encryption core (feature 26). These tests use the real MLS library: nothing is mocked.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  addDevices, createGroup, decrypt, decryptText, describeKeyPackage, encryptText, epochOf, fromB64, identityOf, join, loadGroup, members, newKeyPackages,
  newDeviceIdentity, endorseDevice, verifyEndorsement, parseIdentity, processCommit, removeDevices, rotateKeys, safetyNumber, saveGroup, toB64, type Group, type StoredKeyPackage,
} from './e2ee.ts';

/** A device with a stock of key packages, as the web app will hold it. */
async function device(userId: number, deviceId: number) {
  const identity = await newDeviceIdentity();
  const kps = await newKeyPackages(userId, deviceId, 3, identity);
  return { userId, deviceId, kps, identity, take: (): StoredKeyPackage => kps.shift()! };
}
type Dev = Awaited<ReturnType<typeof device>>;
/** alice makes a chat and adds `others`; each other joins by its welcome. Returns everyone's group, all in the same epoch. */
async function chatOf(creator: Dev, others: Dev[]) {
  const own = creator.take();
  let g = await createGroup('chat-1', own);
  const taken = others.map(o => o.take());
  const h = await addDevices(g, taken.map(k => k.publicBytes));
  g = h.group;
  const groups = new Map<Dev, Group>([[creator, g]]);
  for (let i = 0; i < others.length; i++) groups.set(others[i], await join(h.welcome!, taken[i]));
  return groups;
}

test('two people: a message goes one way, a reply the other, and the ciphertext holds no plaintext', async () => {
  const [a, b] = [await device(1, 1), await device(2, 1)];
  const gs = await chatOf(a, [b]);
  const sent = await encryptText(gs.get(a)!, 'مرحبا يا بوب secret-word-42');
  assert.ok(!Buffer.from(sent.ciphertext).toString('latin1').includes('secret-word-42'));
  const got = await decryptText(gs.get(b)!, sent.ciphertext);
  assert.equal(got.text, 'مرحبا يا بوب secret-word-42');
  const back = await encryptText(got.group, 'وعليكم السلام');
  assert.equal((await decryptText(sent.group, back.ciphertext)).text, 'وعليكم السلام');
});

test('the same words encrypted twice give different bytes, and a flipped byte is refused', async () => {
  const [a, b] = [await device(1, 1), await device(2, 1)];
  const gs = await chatOf(a, [b]);
  const one = await encryptText(gs.get(a)!, 'same'), two = await encryptText(one.group, 'same');
  assert.notDeepEqual(one.ciphertext, two.ciphertext);
  const bad = Uint8Array.from(one.ciphertext); bad[bad.length - 3] ^= 1;
  await assert.rejects(() => decrypt(gs.get(b)!, bad));
});

test('a saved group comes back and still decrypts (the device stores it after every step)', async () => {
  const [a, b] = [await device(1, 1), await device(2, 1)];
  const gs = await chatOf(a, [b]);
  const m1 = await encryptText(gs.get(a)!, 'one');
  const stored = saveGroup(gs.get(b)!);
  const back = loadGroup(stored);
  assert.equal(epochOf(back), epochOf(gs.get(b)!));
  assert.equal((await decryptText(back, m1.ciphertext)).text, 'one');
});

test('a person removed from a group cannot read the next epoch; the others can; the epoch moves on', async () => {
  const [a, b, c] = [await device(1, 1), await device(2, 1), await device(3, 1)];
  const gs = await chatOf(a, [b, c]);
  assert.equal(epochOf(gs.get(a)!), 1);
  const h = await removeDevices(gs.get(a)!, { userId: 3 });
  assert.equal(epochOf(h.group), 2);
  const bGroup = await processCommit(gs.get(b)!, h.commit);
  assert.equal(epochOf(bGroup), 2);
  assert.deepEqual(members(bGroup).map(m => m.identity).sort(), [identityOf(1, 1), identityOf(2, 1)]);
  // carol cannot even apply the commit that removed her, and cannot read what comes after
  const after = await encryptText(h.group, 'after carol left');
  assert.equal((await decryptText(bGroup, after.ciphertext)).text, 'after carol left');
  await assert.rejects(() => decryptText(gs.get(c)!, after.ciphertext));
});

test('a person who joins later cannot read what was said before', async () => {
  const [a, b, d] = [await device(1, 1), await device(2, 1), await device(4, 1)];
  const gs = await chatOf(a, [b]);
  const before = await encryptText(gs.get(a)!, 'before dave');
  const dKp = d.take();
  const h = await addDevices(before.group, [dKp.publicBytes]);
  const dGroup = await join(h.welcome!, dKp);
  const bGroup = await processCommit(gs.get(b)!, h.commit);
  await assert.rejects(() => decryptText(dGroup, before.ciphertext), 'dave has no keys for the earlier epoch');
  const after = await encryptText(h.group, 'with dave');
  assert.equal((await decryptText(dGroup, after.ciphertext)).text, 'with dave');
  assert.equal((await decryptText(bGroup, after.ciphertext)).text, 'with dave');
});

test('a second device of the same person, added by the first, reads new messages', async () => {
  const [a, b, b2] = [await device(1, 1), await device(2, 1), await device(2, 2)];
  const gs = await chatOf(a, [b]);
  const k = b2.take();
  const h = await addDevices(gs.get(b)!, [k.publicBytes]);   // bob's phone adds bob's laptop
  const b2Group = await join(h.welcome!, k);
  const aGroup = await processCommit(gs.get(a)!, h.commit);
  const m = await encryptText(aGroup, 'to both of bob\'s devices');
  assert.equal((await decryptText(b2Group, m.ciphertext)).text, 'to both of bob\'s devices');
  assert.equal((await decryptText(h.group, m.ciphertext)).text, 'to both of bob\'s devices');
  assert.equal(members(aGroup).filter(x => parseIdentity(x.identity)?.userId === 2).length, 2);
});

test('rotating the keys moves the epoch without changing who is in the group', async () => {
  const [a, b] = [await device(1, 1), await device(2, 1)];
  const gs = await chatOf(a, [b]);
  const h = await rotateKeys(gs.get(a)!);
  assert.equal(epochOf(h.group), epochOf(gs.get(a)!) + 1);
  assert.equal(members(h.group).length, 2);
  const bGroup = await processCommit(gs.get(b)!, h.commit);
  assert.equal(epochOf(bGroup), epochOf(h.group));
});

test('a commit replayed, or applied out of order, is refused', async () => {
  const [a, b] = [await device(1, 1), await device(2, 1)];
  const gs = await chatOf(a, [b]);
  const h1 = await rotateKeys(gs.get(a)!), h2 = await rotateKeys(h1.group);
  await assert.rejects(() => processCommit(gs.get(b)!, h2.commit), 'the second commit before the first');
  const bAfter = await processCommit(await processCommit(gs.get(b)!, h1.commit), h2.commit);
  await assert.rejects(() => processCommit(bAfter, h1.commit), 'the first again');
});

test('only well-formed Tamtim device names are accepted, and the app can refuse any key it does not know', async () => {
  assert.deepEqual(parseIdentity('u12.d3'), { userId: 12, deviceId: 3 });
  for (const bad of ['', 'alice', 'u1', 'u1.d', 'u1.d2 ', '../u1.d2', 'u1.d2;x']) assert.equal(parseIdentity(bad), null, bad);
  const [a, mallory] = [await device(1, 1), await device(9, 1)];
  const own = a.take();
  const knownKeys = new Set([toB64(describeKeyPackage(own.publicBytes).signaturePublicKey)]);   // the directory knows only alice
  const trusted = (_id: string, key: Uint8Array) => knownKeys.has(toB64(key));
  const g = await createGroup('chat-2', own, trusted);
  await assert.rejects(() => addDevices(g, [mallory.take().publicBytes]), 'a key the directory does not know cannot be added');
});

test('a key package says who it belongs to', async () => {
  const d = await device(7, 3);
  assert.equal(describeKeyPackage(d.kps[0].publicBytes).identity, 'u7.d3');
  assert.equal(describeKeyPackage(d.kps[0].publicBytes).signaturePublicKey.length, 32);
  assert.notEqual(d.kps[0].ref, d.kps[1].ref);
  assert.deepEqual(describeKeyPackage(d.kps[1].publicBytes).signaturePublicKey, d.identity.publicKey, 'every package of a device carries the same identity key');
});

test('the safety number is the same for both people, 60 digits, and changes when a key changes', async () => {
  const k1 = new Uint8Array(32).fill(1), k2 = new Uint8Array(32).fill(2), k3 = new Uint8Array(32).fill(3);
  const ab = await safetyNumber({ userId: 1, keys: [k1] }, { userId: 2, keys: [k2] });
  const ba = await safetyNumber({ userId: 2, keys: [k2] }, { userId: 1, keys: [k1] });
  assert.equal(ab, ba);
  assert.match(ab, /^(\d{5} ){11}\d{5}$/);
  assert.notEqual(ab, await safetyNumber({ userId: 1, keys: [k1] }, { userId: 2, keys: [k3] }));
  assert.equal(await safetyNumber({ userId: 1, keys: [k1, k3] }, { userId: 2, keys: [k2] }), await safetyNumber({ userId: 1, keys: [k3, k1] }, { userId: 2, keys: [k2] }), 'the order of a person\'s devices does not matter');
});

test('base64 round trip for large and empty buffers', () => {
  for (const n of [0, 1, 5, 40000]) { const b = crypto.getRandomValues(new Uint8Array(Math.min(n, 65536))); assert.deepEqual(fromB64(toB64(b)), b); }
});

test('sha-256 known answer (the hash the safety number is built on): "abc"', async () => {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode('abc')));
  assert.equal(Buffer.from(d).toString('hex'), 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad');
});

test('an endorsement: a device vouches for another device of the same person; it fits only that user, device and key, and only the signer', async () => {
  const [b1, b2, other] = [await newDeviceIdentity(), await newDeviceIdentity(), await newDeviceIdentity()];
  const sig = await endorseDevice(b1.signKey, 7, 22, b2.publicKey);
  assert.equal(await verifyEndorsement(b1.publicKey, 7, 22, b2.publicKey, sig), true);
  assert.equal(await verifyEndorsement(b1.publicKey, 8, 22, b2.publicKey, sig), false, 'another user');
  assert.equal(await verifyEndorsement(b1.publicKey, 7, 23, b2.publicKey, sig), false, 'another device number');
  assert.equal(await verifyEndorsement(b1.publicKey, 7, 22, other.publicKey, sig), false, 'another key');
  assert.equal(await verifyEndorsement(other.publicKey, 7, 22, b2.publicKey, sig), false, 'another signer');
  assert.equal(await verifyEndorsement(b1.publicKey, 7, 22, b2.publicKey, sig.slice(0, 10)), false, 'garbage');
});
