// A demo family for showing Thekra: invented people, messages, documented events, an album with pictures and a voice note, a sealed letter.
// It talks to a RUNNING server over HTTP exactly like the app does, so nothing is faked and it cannot touch other circles.
// Needs the server to show sign-in codes (the default console SMS provider, not production).
//   pnpm demo [http://localhost:8787]
// Run it once per database: it refuses to create a second «عائلة الديمو». The demo phone numbers are fake (+9665000000xx).
import { deflateSync } from 'node:zlib';

const base = (process.argv[2] ?? 'http://localhost:8787').replace(/\/$/, '');
// The demo numbers look like real mobile numbers, and signing in asks the server to SMS a code to each. On a server with a real SMS provider that would text
// strangers. So this only runs against this computer (localhost, or inside the demo project's own shell) unless you say you are sure.
const host = new URL(base).hostname;
if (!['localhost', '127.0.0.1', '[::1]', '::1'].includes(host) && process.env.THIKRA_DEMO_ALLOW_REMOTE !== '1') {
  console.error(`Refusing to seed ${host}: it is not this computer. Run the script on the server's own machine (http://localhost:PORT), or set THIKRA_DEMO_ALLOW_REMOTE=1 if that server only prints codes (the console SMS provider).`);
  process.exit(2);
}
const PEOPLE = [
  { phone: '+966500000001', name: 'أبو خالد' },
  { phone: '+966500000002', name: 'أم خالد' },
  { phone: '+966500000003', name: 'خالد' },
  { phone: '+966500000004', name: 'سارة' },
  { phone: '+966500000005', name: 'جدّتي نوره' },
];

async function http(cookie: string | undefined, path: string, body?: unknown, form?: FormData, method?: string) {
  const res = await fetch(base + path, { method: method ?? (body || form ? 'POST' : 'GET'), headers: { ...(cookie ? { cookie } : {}), ...(form ? {} : { 'content-type': 'application/json' }) }, body: form ?? (body ? JSON.stringify(body) : undefined) });
  const text = await res.text();
  let json: any = {}; try { json = JSON.parse(text); } catch { /* not json */ }
  return { status: res.status, json, cookie: res.headers.get('set-cookie')?.split(';')[0] };
}
async function signIn(p: { phone: string; name: string }) {
  const r = await http(undefined, '/api/auth/request', { phone: p.phone });
  if (!r.json.devCode) throw new Error(`no devCode for ${p.phone} (${r.status} ${JSON.stringify(r.json)}): the server must be in development mode`);
  const v = await http(undefined, '/api/auth/verify', { phone: p.phone, code: r.json.devCode, name: p.name });
  if (!v.cookie) throw new Error(`sign-in failed for ${p.phone}: ${JSON.stringify(v.json)}`);
  return v.cookie;
}

// ---- generated media: a valid PNG (a soft gradient) and a valid WAV (a gentle tone), so everything opens and plays ----
const crcTable = Array.from({ length: 256 }, (_, n) => { let c = n; for (let k = 0; k < 8; k++) c = c & 1 ? 0xedb88320 ^ (c >>> 1) : c >>> 1; return c >>> 0; });
const crc = (b: Buffer) => { let c = 0xffffffff; for (const x of b) c = crcTable[(c ^ x) & 255] ^ (c >>> 8); return (c ^ 0xffffffff) >>> 0; };
const chunk = (type: string, data: Buffer) => { const t = Buffer.from(type), len = Buffer.alloc(4), sum = Buffer.alloc(4); len.writeUInt32BE(data.length); sum.writeUInt32BE(crc(Buffer.concat([t, data]))); return Buffer.concat([len, t, data, sum]); };
function png(w: number, h: number, a: [number, number, number], b: [number, number, number]) {
  const rows: Buffer[] = [];
  for (let y = 0; y < h; y++) {
    const row = Buffer.alloc(1 + w * 3);
    for (let x = 0; x < w; x++) { const t = (x / w + y / h) / 2; for (let i = 0; i < 3; i++) row[1 + x * 3 + i] = Math.round(a[i] + (b[i] - a[i]) * t); }
    rows.push(row);
  }
  const head = Buffer.alloc(13); head.writeUInt32BE(w, 0); head.writeUInt32BE(h, 4); head[8] = 8; head[9] = 2;
  return Buffer.concat([Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]), chunk('IHDR', head), chunk('IDAT', deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
}
function wav(seconds: number, hz: number) {
  const rate = 8000, n = rate * seconds, data = Buffer.alloc(n * 2);
  for (let i = 0; i < n; i++) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hz * i) / rate) * 2500 * Math.min(1, (n - i) / rate)), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + data.length, 4); h.write('WAVEfmt ', 8); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34); h.write('data', 36); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

const [owner] = PEOPLE;
const cookies: string[] = [];
for (const p of PEOPLE) cookies.push(await signIn(p));
const ownerCookie = cookies[0];
const existing = (await http(ownerCookie, '/api/circles')).json as Array<{ id: number; name: string }>;
const has = (name: string) => Array.isArray(existing) && existing.some(c => c.name === name);
let circleId = existing?.find?.(c => c.name === 'عائلة الديمو')?.id as number | undefined;
if (!circleId) {
circleId = (await http(ownerCookie, '/api/circles', { name: 'عائلة الديمو' })).json.id as number;
const invite = (await http(ownerCookie, `/api/circles/${circleId}`)).json.inviteCode as string;
for (const ck of cookies.slice(1)) await http(ck, '/api/circles/join', { code: invite });

const talk: Array<[number, string]> = [
  [0, 'صباح الخير يا أحبّة 🌿 تذكّروا أن عيد ميلاد جدّتي يوم الجمعة'],
  [4, 'الله يحفظكم. أنا مشتاقة لكم كثيراً'],
  [1, 'سنجتمع كلنا عندك يا جدّتي إن شاء الله، وسأعدّ الكبسة'],
  [2, 'أخبار سارة: تخرّجتُ اليوم من الجامعة! الحمد لله 🎓'],
  [3, 'مبروك يا خالد! فخورة بك كثيراً'],
  [0, 'مبارك يا بطل. بارك الله فيك، فرحتنا كبيرة'],
  [4, 'ما شاء الله، ربّي يوفقك يا حبيبي'],
  [1, 'سنقيم حفلاً صغيراً يوم السبت، الجميع مدعوّ'],
  [3, 'أنا سأحضر الحلوى 🍰'],
];
for (const [who, body] of talk) await http(cookies[who], `/api/circles/${circleId}/messages`, { body });

await http(ownerCookie, `/api/circles/${circleId}/import`, {
  entries: [
    { date: '2021-08-14', title: 'زواج العم أحمد', summary: 'اجتمعت العائلة في حفل زواج العم أحمد، وكان أجمل يوم صيف.', category: 'marriage' },
    { date: '2022-03-02', title: 'ولادة ليان', summary: 'وُلدت ليان ابنة سارة، وأتت الجدّة من بعيد لتراها.', category: 'birth' },
    { date: '2023-06-20', title: 'رحلة العائلة إلى أبها', summary: 'أسبوع في الجبال مع الضباب والشاي والذكريات.', category: 'travel' },
    { date: '2024-07-05', title: 'تخرّج خالد', summary: 'تخرّج خالد من الجامعة وحضر الجميع الحفل.', category: 'graduation' },
  ],
});

const album = (await http(ownerCookie, `/api/circles/${circleId}/albums`, { title: 'ألبوم واتساب 2021–2024', source: 'whatsapp', from: '2021-01-01', to: '2024-12-31' })).json.id as number;
const photos: Array<[string, string, [number, number, number], [number, number, number]]> = [
  ['2021-08-14 20:10', 'عرس-1.png', [240, 214, 170], [200, 120, 90]], ['2021-08-14 21:30', 'عرس-2.png', [190, 210, 190], [90, 140, 110]],
  ['2022-03-02 11:05', 'ليان.png', [250, 225, 225], [210, 150, 170]], ['2023-06-20 17:45', 'أبها-1.png', [170, 200, 225], [70, 110, 150]],
  ['2023-06-21 09:12', 'أبها-2.png', [215, 225, 200], [110, 150, 100]], ['2024-07-05 19:00', 'تخرج.png', [235, 225, 190], [60, 90, 70]],
];
const upload = async (kind: 'image' | 'voice', takenAt: string, name: string, data: Buffer, sender: string, thumb?: Buffer) => {
  const fd = new FormData();
  fd.append('file', new File([new Uint8Array(data)], name)); if (thumb) fd.append('thumb', new File([new Uint8Array(thumb)], 'thumb.png'));
  fd.append('takenAt', takenAt); fd.append('sender', sender);
  const r = await http(ownerCookie, `/api/albums/${album}/items`, undefined, fd);
  if (r.status >= 300) throw new Error(`album upload ${name}: ${r.status} ${JSON.stringify(r.json)}`);
};
for (const [t, name, a, b] of photos) await upload('image', t, name, png(640, 480, a, b), 'أم خالد', png(160, 120, a, b));
await upload('voice', '2022-03-02 11:20', 'voice-1.wav', wav(3, 440), 'جدّتي نوره');
await upload('voice', '2024-07-05 19:30', 'voice-2.wav', wav(3, 523), 'أبو خالد');

const when = new Date(Date.now() + 40 * 86400_000).toISOString();
await http(ownerCookie, `/api/circles/${circleId}/sealed`, { body: 'إلى أبنائي: كونوا لبعضكم سنداً، وتذكّروا أن الفرح أجمل حين نتشاركه.', trigger: 'date', unlockAt: when });

}

// ---- a busy chat list, like a real phone: a second family circle, a plain group, one-to-one chats, unread counts, a muted group ----
async function make(who: number, body: { name: string; kind?: string }, members: number[]) {
  const id = (await http(cookies[who], '/api/circles', body)).json.id as number;
  const code = (await http(cookies[who], `/api/circles/${id}`)).json.inviteCode as string;
  for (const m of members) await http(cookies[m], '/api/circles/join', { code });
  return id;
}
const say = async (circle: number, lines: Array<[number, string]>) => { for (const [who, body] of lines) await http(cookies[who], `/api/circles/${circle}/messages`, { body }); };
async function direct(a: number, b: number) {
  const uid = (await http(cookies[a], '/api/me')).json.id as number;
  const id = (await http(cookies[b], '/api/direct', { userId: uid })).json;   // b opens the chat with a (they share the demo circle)
  return id.id as number;
}
if (!has('عائلة جدّتي نوره')) {
  const fam2 = await make(4, { name: 'عائلة جدّتي نوره' }, [0, 1, 2, 3]);
  await say(fam2, [[4, 'الله يرضى عليكم يا أحبّة، الجمعة عندي الغداء'], [1, 'أبشري يا جدّتي، نحن قادمون'], [3, 'سأحضر الحلوى 🍰'], [2, 'ونسيتم أنا؟ سأجلب الفاكهة']]);
}
if (!has('رحلة الصيف')) {
  const trip = await make(2, { name: 'رحلة الصيف', kind: 'group' }, [0, 3]);
  await say(trip, [[2, 'متى نحجز الفندق؟'], [3, 'الأفضل هذا الأسبوع قبل ارتفاع الأسعار'], [0, 'أنا موافق، أرسلوا لي التواريخ'], [2, 'ممتاز، 15 يوليو'], [3, '🌴🌴']]);
  await http(cookies[0], `/api/circles/${trip}/prefs`, { muted: true }, undefined, 'PATCH');
}
if (!has('سارة') && !has('خالد')) {
  const chats: Array<[number, number, Array<[number, string]>]> = [
    [0, 3, [[3, 'بابا، هل وصلت؟'], [0, 'وصلت يا حبيبتي، الحمد لله'], [3, 'الله يسلمك 🌿']]],
    [0, 2, [[2, 'أبي، هل أجدّد الإقامة هذا الأسبوع؟'], [0, 'نعم، أرسل لي الأوراق'], [2, 'تمام، سأرسلها الآن']]],
    [0, 1, [[1, 'لا تنسَ الدواء'], [0, 'أخذته الصباح']]],
    [0, 4, [[4, 'الله يحفظك يا ابني'], [4, 'متى تزورنا؟']]],
  ];
  for (const [a, b, lines] of chats) { const id = await direct(a, b); await say(id, lines); }
}
console.log(`Demo family ready (circle ${circleId}). Sign in with any of these phones; the code appears on the sign-in screen:`);
for (const p of PEOPLE) console.log(`  ${p.phone}  ${p.name}`);
