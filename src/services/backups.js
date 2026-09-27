import { mkdirSync, readdirSync, statSync, unlinkSync, createReadStream, existsSync } from 'node:fs';
import { join, dirname, basename } from 'node:path';
import { notFound, badRequest } from '../util.js';

// Nightly snapshots of the whole database. VACUUM INTO writes a consistent copy while the app keeps running.
export const backupDir = (ctx) => ctx.backupDir ?? process.env.BACKUP_DIR ?? join(dirname(ctx.dbFile && ctx.dbFile !== ':memory:' ? ctx.dbFile : 'data/diamond.db'), 'backups');
const KEEP = Number(process.env.BACKUP_KEEP ?? 30);

export function createBackup(ctx) {
  const dir = backupDir(ctx);
  mkdirSync(dir, { recursive: true });
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..*/, '').replace('T', '-');
  const file = join(dir, `diamond-${stamp}.db`);
  if (existsSync(file)) return listBackups(ctx).find((b) => b.name === basename(file));
  ctx.db.run(`VACUUM INTO '${file.replace(/'/g, "''")}'`);
  prune(ctx);
  return listBackups(ctx).find((b) => b.name === basename(file));
}
export function listBackups(ctx) {
  const dir = backupDir(ctx);
  if (!existsSync(dir)) return [];
  return readdirSync(dir).filter((f) => /^diamond-\d{8}-\d{6}\.db$/.test(f))
    .map((f) => { const st = statSync(join(dir, f)); return { name: f, bytes: st.size, created_at: st.mtime.toISOString() }; })
    .sort((a, b) => b.name.localeCompare(a.name));
}
function prune(ctx) { for (const b of listBackups(ctx).slice(KEEP)) unlinkSync(join(backupDir(ctx), b.name)); }
export function backupFile(ctx, name) {
  if (!/^diamond-\d{8}-\d{6}\.db$/.test(name)) throw badRequest('Not a backup name.');
  const path = join(backupDir(ctx), name);
  if (!existsSync(path)) throw notFound('Backup');
  return { filename: name, type: 'application/vnd.sqlite3', stream: createReadStream(path) };
}
// Runs once a day; skips if today's backup already exists.
export function dailyBackup(ctx) {
  const today = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  if (listBackups(ctx).some((b) => b.name.startsWith(`diamond-${today}`))) return null;
  return createBackup(ctx);
}
