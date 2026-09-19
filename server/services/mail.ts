import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import type { DB } from '../db/index.js';

export interface Mail {
  recipient: string;
  subject: string;
  body: string;
}
export type MailSender = (mail: Mail, id: string) => Promise<void>;
export function mailSettings(env = process.env) {
  const key = env.RESEND_API_KEY || '';
  const from = env.MAIL_FROM || '';
  const alertTo = env.BACKUP_ALERT_EMAIL || '';
  if (!key && !from && !alertTo) return undefined;
  if (!key || /\s/.test(key) || !z.string().email().safeParse(from).success)
    throw new Error('Set RESEND_API_KEY and a verified MAIL_FROM email together');
  if (alertTo && !z.string().email().safeParse(alertTo).success)
    throw new Error('Set BACKUP_ALERT_EMAIL to one operator email');
  return { key, from, alertTo };
}
export function resendSender(
  settings: NonNullable<ReturnType<typeof mailSettings>>,
  request: typeof fetch = fetch,
): MailSender {
  return async (mail, id) => {
    // Never log provider bodies, recipient addresses or password-reset links.
    const response = await request('https://api.resend.com/emails', {
      method: 'POST',
      redirect: 'error',
      signal: AbortSignal.timeout(10000),
      headers: {
        authorization: `Bearer ${settings.key}`,
        'content-type': 'application/json',
        'idempotency-key': id,
      },
      body: JSON.stringify({
        from: settings.from,
        to: [mail.recipient],
        subject: mail.subject,
        text: mail.body,
      }),
    });
    if (!response.ok) {
      await response.body?.cancel();
      throw new Error(`Mail delivery rejected (${response.status})`);
    }
    const receipt = z.object({ id: z.string().uuid() }).safeParse(await response.json());
    if (!receipt.success) throw new Error('Mail delivery receipt is invalid');
  };
}
export function enqueueMail(db: DB, mail: Mail, expiresAt: number, now = Date.now()) {
  const id = randomUUID();
  db.prepare(
    'INSERT INTO mail_outbox(id,recipient,subject,body,expires_at,next_attempt_at) VALUES (?,?,?,?,?,?)',
  ).run(id, mail.recipient, mail.subject, mail.body, expiresAt, now);
  return id;
}
export class MailDelivery {
  private timer?: ReturnType<typeof setInterval>;
  private pending?: Promise<void>;
  private stopped = false;
  constructor(
    private db: DB,
    private send: MailSender,
    private now = Date.now,
  ) {}
  start() {
    if (this.timer) return;
    this.stopped = false;
    this.tick();
    this.timer = setInterval(() => this.tick(), 5000);
    this.timer.unref();
  }
  private tick() {
    if (this.pending || this.stopped) return;
    this.pending = this.drainOne()
      .catch(() => console.error(JSON.stringify({ event: 'mail_queue_failed' })))
      .finally(() => {
        this.pending = undefined;
      });
  }
  async drainOne() {
    const now = this.now();
    const row = this.db.transaction(() => {
      const expired = this.db.prepare('DELETE FROM mail_outbox WHERE expires_at <= ?').run(now);
      if (expired.changes)
        console.error(JSON.stringify({ event: 'mail_expired', count: expired.changes }));
      return this.db
        .prepare(
          `UPDATE mail_outbox SET lease_until = ?, attempts = attempts + 1
        WHERE id = (SELECT id FROM mail_outbox WHERE next_attempt_at <= ? AND lease_until <= ?
          ORDER BY next_attempt_at, id LIMIT 1)
        RETURNING id,recipient,subject,body,attempts,lease_until`,
        )
        .get(now + 30000, now, now) as
        (Mail & { id: string; attempts: number; lease_until: number }) | undefined;
    })();
    if (!row) return;
    try {
      await this.send(row, row.id);
      this.db
        .prepare('DELETE FROM mail_outbox WHERE id=? AND lease_until=?')
        .run(row.id, row.lease_until);
      console.log(JSON.stringify({ event: 'mail_delivered' }));
    } catch {
      this.db
        .prepare(
          'UPDATE mail_outbox SET next_attempt_at=?, lease_until=0 WHERE id=? AND lease_until=?',
        )
        .run(
          this.now() + Math.min(300000, 10000 * 2 ** Math.min(row.attempts - 1, 5)),
          row.id,
          row.lease_until,
        );
      console.error(JSON.stringify({ event: 'mail_delivery_failed', attempt: row.attempts }));
    }
  }
  async stop() {
    this.stopped = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = undefined;
    await this.pending;
  }
}
