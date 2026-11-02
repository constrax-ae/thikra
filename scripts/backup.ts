// pnpm backup | pnpm backup:verify [id] | pnpm backup:restore <id> <target-data-dir>
// (Run these with the app stopped when using the WebAssembly SQLite backend: it locks the database file. With node:sqlite it is safe while the app runs.)
import { createBackup, listBackups, pruneBackups, restoreBackup, verifyBackup } from '../server/backup.ts';

const [cmd, a, b] = process.argv.slice(2);
try {
  if (cmd === 'create') {
    const m = await createBackup();
    console.log(`backup ${m.id}: ${m.counts.users} users, ${m.counts.circles} circles, ${m.counts.messages} messages, ${m.blobs.length} files, database ${m.dbBytes} bytes`);
    const rep = await verifyBackup(m.id);
    console.log(rep.ok ? 'verified: OK' : `VERIFICATION FAILED:\n- ${rep.problems.join('\n- ')}`);
    const pruned = await pruneBackups(7);
    if (pruned) console.log(`removed ${pruned} older snapshot(s), kept 7`);
    process.exit(rep.ok ? 0 : 1);
  } else if (cmd === 'verify') {
    const rep = await verifyBackup(a);
    console.log(rep.ok ? `backup ${rep.id}: OK (${rep.counts?.messages} messages, ${rep.blobs} files)` : `backup ${rep.id}: FAILED\n- ${rep.problems.join('\n- ')}`);
    process.exit(rep.ok ? 0 : 1);
  } else if (cmd === 'list') {
    for (const m of await listBackups()) console.log(`${m.id}  ${m.counts.messages} messages  ${m.blobs.length} files  ${m.dbBytes} bytes`);
    process.exit(0);
  } else if (cmd === 'restore' && a && b) {
    await restoreBackup(a, b);
    console.log(`restored ${a} into ${b}. Start the app with THIKRA_DB=${b}/thikra.db THIKRA_BLOBS=${b}/blobs`);
    process.exit(0);
  } else {
    console.log('usage: backup create | verify [id] | list | restore <id> <target-data-dir>');
    process.exit(2);
  }
} catch (e) { console.error(e instanceof Error ? e.message : e); process.exit(1); }
