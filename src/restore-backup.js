import { existsSync, readFileSync, writeFileSync, renameSync, rmSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { decrypt, fetchCopy, checkDatabase } from './services/offsite.js';

// Restore an off-site backup into a plain database file, checked before it's written.
//   node src/restore-backup.js diamond-20260927-030000.db restored.db    (fetch from storage)
//   node src/restore-backup.js ~/Downloads/diamond-...db.enc restored.db (a copy you downloaded)
// Needs BACKUP_PASSPHRASE; fetching also needs the BACKUP_S3_* settings. See DEPLOY.md.
export async function restore([src, out]) {
  if (!src || !out) throw new Error('Usage: node src/restore-backup.js <backup name or .enc file> <output .db>');
  if (existsSync(out)) throw new Error(`${out} already exists; pick a new file name.`);
  const pass = process.env.BACKUP_PASSPHRASE;
  if (!pass) throw new Error('Set BACKUP_PASSPHRASE first.');
  const plain = existsSync(src) ? decrypt(readFileSync(src), pass) : await fetchCopy(src);
  const tmp = `${out}.partial`;
  writeFileSync(tmp, plain, { mode: 0o600 });
  try { checkDatabase(tmp); } catch (e) { rmSync(tmp, { force: true }); throw e; }
  renameSync(tmp, out);
  return { file: out, bytes: plain.length };
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  restore(process.argv.slice(2))
    .then((r) => console.log(`Restored and checked: ${r.file} (${Math.round(r.bytes / 1024)} KB)`))
    .catch((e) => { console.error(`Restore failed: ${e.message}`); process.exit(1); });
}
