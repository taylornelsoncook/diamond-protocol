import { newId } from '../util.js';

// Every email is recorded in the outbox. With RESEND_API_KEY set, it's also sent through Resend.
// Without it (local and test mode), coaches can read messages under API & integrations → Outbox.
export async function sendEmail(ctx, { to, subject, text }) {
  const id = newId('msg');
  let status = 'logged', error = null;
  if (ctx.mail?.resendKey) {
    try {
      const res = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { authorization: `Bearer ${ctx.mail.resendKey}`, 'content-type': 'application/json' },
        body: JSON.stringify({ from: ctx.mail.from, to: [to], subject, text }),
        signal: AbortSignal.timeout(10000)
      });
      status = res.ok ? 'sent' : 'failed';
      if (!res.ok) error = `Email service responded ${res.status}`;
    } catch (e) { status = 'failed'; error = e.message; }
  }
  ctx.db.run('INSERT INTO outbox (id, to_email, subject, body, status, error, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)', id, to, subject, text, status, error, ctx.now());
  return { id, status };
}
export const listOutbox = (ctx, limit = 50) => ctx.db.all('SELECT * FROM outbox ORDER BY created_at DESC, rowid DESC LIMIT ?', limit);

// Fire-and-forget notification to every guardian in a family.
export function notifyFamily(ctx, familyId, subject, text) {
  if (!familyId) return;
  for (const g of ctx.db.all('SELECT email FROM guardians WHERE family_id = ?', familyId)) sendEmail(ctx, { to: g.email, subject, text }).catch(() => {});
}
