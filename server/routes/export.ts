import { EXPORT_MAX_BYTES, safeName } from '../lib/export.ts';
import { textLang } from '../lib/lang.ts';
import { all } from '../db.ts';
import { app } from '../app.ts';
import { archiveFor } from '../lib/archive.ts';
import { blobs } from '../storage.ts';
import { limited } from '../lib/helpers.ts';
import { strToU8, zipSync } from 'fflate';
import { readStory } from '../lib/story.ts';

// A zip of everything you can see, as plain JSON plus the original files: no lock-in, readable without Thekra (README.txt inside).
// It contains only what you could read in the app: messages you deleted for yourself, and ones deleted for everyone, are not in it.
app.get('/api/me/export', async c => {
  const u = c.get('user');
  if (await limited(`export:${u.id}`, 3, 3600_000)) return c.json({ error: 'too_many_requests' }, 429);
  const files: Record<string, Uint8Array> = {};
  const json = (path: string, v: unknown) => { files[path] = strToU8(JSON.stringify(v, null, 2)); };
  const circles = all(
    `SELECT c.id, c.name, c.kind, cm.role FROM circles c JOIN circle_members cm ON cm.circle_id = c.id AND cm.user_id = ? WHERE c.deleted_at IS NULL ORDER BY c.id`, u.id);
  json('profile.json', { exportedAt: new Date().toISOString(), name: u.name, phone: u.phone, language: u.lang, circles: circles.map(x => ({ id: x.id, name: x.name, kind: x.kind, role: x.role })) });
  let bytes = 0; const omitted: string[] = [];
  for (const ci of circles) {
    const dir = `circles/${ci.id}-${safeName(ci.kind === 'direct' ? `chat-${ci.id}` : ci.name)}`;
    const msgs = all(
      `SELECT m.id, m.seq, m.created_at AS time, u.name AS author, m.kind, m.body, m.transcript, m.edited_at AS editedAt, m.sealed_on AS sealedOn, m.forward_count AS forwarded
         FROM messages m LEFT JOIN users u ON u.id = m.user_id
        WHERE m.circle_id = ? AND m.kind != 'system' AND m.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = ?) ORDER BY m.seq`, ci.id, u.id);
    const media = all(
      `SELECT md.id, md.message_id AS messageId, md.kind, md.mime, md.name, md.size, md.blob_hash FROM media md JOIN messages m ON m.id = md.message_id
        WHERE md.circle_id = ? AND md.kind IN ('image','video','file','audio') AND m.deleted_at IS NULL
          AND NOT EXISTS (SELECT 1 FROM message_hidden h WHERE h.message_id = m.id AND h.user_id = ?) ORDER BY md.id`, ci.id, u.id);
    const reactions = all(`SELECT r.message_id AS messageId, u.name, r.emoji FROM reactions r JOIN users u ON u.id = r.user_id JOIN messages m ON m.id = r.message_id WHERE m.circle_id = ?`, ci.id);
    const fileOf = new Map<number, string>();
    for (const md of media) {
      const path = `${dir}/files/${md.id}-${safeName(md.name ?? `${md.kind}`)}${md.kind === 'audio' ? '.audio' : ''}`;
      if (bytes + md.size > EXPORT_MAX_BYTES) { omitted.push(path); continue; }
      const data = await blobs.get(md.blob_hash);
      if (!data) { omitted.push(path); continue; }
      files[path] = new Uint8Array(data); bytes += data.length; fileOf.set(md.id, path);
    }
    json(`${dir}/messages.json`, msgs.map(m => ({
      ...m, reactions: reactions.filter(r => r.messageId === m.id).map(r => `${r.name}: ${r.emoji}`),
      files: media.filter(md => md.messageId === m.id && fileOf.has(md.id)).map(md => ({ name: md.name, type: md.mime, path: fileOf.get(md.id) })),
    })));
    if (ci.kind === 'circle') {
      json(`${dir}/archive.json`, archiveFor(ci.id, ci.role, u.id).map(e => ({ date: e.eventDate, title: e.title, summary: e.summary, category: e.category, kind: e.kind })));
      json(`${dir}/people.json`, all('SELECT name, relation, birth_date AS birthDate, death_date AS deathDate FROM persons WHERE circle_id = ? ORDER BY id', ci.id));
      // the family's albums (pictures and voices kept from an old chat), with the files
      for (const al of all('SELECT id, title, range_from AS rangeFrom, range_to AS rangeTo FROM albums WHERE circle_id = ? ORDER BY id', ci.id)) {
        const items = all(
          `SELECT i.id, i.kind, i.taken_at AS takenAt, i.sender, i.blob_hash, md.name, md.mime, md.size FROM album_items i LEFT JOIN media md ON md.id = i.media_id
            WHERE i.album_id = ? ORDER BY i.taken_at`, al.id);
        const adir = `${dir}/albums/${al.id}-${safeName(al.title)}`;
        const listed: Array<Record<string, unknown>> = [];
        for (const it of items) {
          const path = `${adir}/${String(it.takenAt).slice(0, 4)}/${it.id}-${safeName(it.name ?? it.kind)}`;
          const size = Number(it.size ?? 0);
          if (bytes + size > EXPORT_MAX_BYTES) { omitted.push(path); continue; }
          const data = await blobs.get(it.blob_hash);
          if (!data) { omitted.push(path); continue; }
          files[path] = new Uint8Array(data); bytes += data.length;
          listed.push({ kind: it.kind, takenAt: it.takenAt, sender: it.sender, type: it.mime, path });
        }
        json(`${adir}/album.json`, { title: al.title, from: al.rangeFrom, to: al.rangeTo, items: listed });
      }
      // the family story, year by year, as the book shows it
      const years = [...new Set(archiveFor(ci.id, ci.role, u.id).filter(e => e.kind !== 'conflict').map(e => String(e.eventDate).slice(0, 4)))];
      for (const y of years) {
        const chapters = readStory(ci.id, Number(y), textLang(u.lang));
        if (chapters.length) json(`${dir}/story-${y}.json`, chapters.map(ch => ({ title: ch.title, text: ch.paragraphs.join('\n\n'), writtenBy: ch.source })));
      }
    }
  }
  const sealed = all("SELECT s.body, s.unlock_at AS opensAt, s.yearly, c2.name AS circle FROM sealed_messages s JOIN circles c2 ON c2.id = s.circle_id WHERE s.author_id = ? AND s.status = 'sealed'", u.id);
  if (sealed.length) json('sealed-messages-i-wrote.json', sealed);
  const cases = all('SELECT id, subject, status, created_at AS createdAt FROM support_cases WHERE user_id = ? ORDER BY id', u.id).map(k => ({ ...k, messages: all('SELECT from_staff AS fromStaff, body, created_at AS createdAt FROM support_messages WHERE case_id = ? ORDER BY id', k.id) }));
  if (cases.length) json('support-messages-i-wrote.json', cases);
  if (omitted.length) json('omitted-files.json', { reason: `the export is limited to ${EXPORT_MAX_BYTES / 1048576} MB of files`, files: omitted });
  files['README.txt'] = strToU8(`Thekra data export\n\nEverything you could see in the app, as plain files:\n- profile.json: your details and your circles\n- circles/<id>-<name>/messages.json: the messages (JSON), with the files they carry under files/\n- archive.json / people.json: what the agent documented and the family record (family circles)\n- albums/: the family's albums (pictures and voices), with album.json for each\n- story-<year>.json: the family story, chapter by chapter\n- sealed-messages-i-wrote.json: letters you sealed that have not opened yet\n- support-messages-i-wrote.json: what you wrote to the Thekra team, and its answers\n\nMessages you deleted for yourself, and messages deleted for everyone, are not included.\nYou do not need Thekra to read any of this: every file is JSON or the original photo/video/document.\n`);
  const zip = zipSync(files, { level: 0 }); // level 0: media is already compressed, and it keeps the request fast
  return new Response(zip, { headers: { 'content-type': 'application/zip', 'content-disposition': `attachment; filename="thikra-export-${new Date().toISOString().slice(0, 10)}.zip"`, 'cache-control': 'no-store', 'x-content-type-options': 'nosniff' } });
});
