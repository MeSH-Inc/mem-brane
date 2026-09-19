import { expect, it, vi } from 'vitest';
import { openDatabase } from '../server/db';
import { MailDelivery, enqueueMail, mailSettings, resendSender } from '../server/services/mail';
import { recordBackupResult } from '../server/services/backup-alerts';

it('retries with the same delivery id after failure and persists claims between workers', async () => {
  const db = openDatabase(':memory:');
  let now = 1000;
  const ids: string[] = [];
  const send = vi.fn(async (_mail, id: string) => {
    ids.push(id);
    if (ids.length === 1) throw new Error('private detail');
  });
  try {
    enqueueMail(
      db,
      { recipient: 'operator@example.com', subject: 'Backup', body: 'Failed' },
      100000,
      now,
    );
    const worker = new MailDelivery(db, send, () => now);
    await worker.drainOne();
    await new MailDelivery(db, send, () => now).drainOne();
    expect(send).toHaveBeenCalledTimes(1);
    now += 10000;
    await new MailDelivery(db, send, () => now).drainOne();
    expect(ids[1]).toBe(ids[0]);
    expect(db.prepare('SELECT count(*) n FROM mail_outbox').get()).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});
it('leases prevent duplicate concurrent sends and expired credentials are never sent', async () => {
  const db = openDatabase(':memory:');
  let finish!: () => void;
  const send = vi.fn(
    () =>
      new Promise<void>((resolve) => {
        finish = resolve;
      }),
  );
  try {
    enqueueMail(
      db,
      { recipient: 'a@example.com', subject: 'Reset', body: 'expired token' },
      999,
      1,
    );
    enqueueMail(
      db,
      { recipient: 'a@example.com', subject: 'Reset', body: 'valid token' },
      99999,
      1,
    );
    const first = new MailDelivery(db, send, () => 1000).drainOne();
    await new MailDelivery(db, send, () => 1000).drainOne();
    expect(send).toHaveBeenCalledTimes(1);
    expect(send.mock.calls[0]).toBeDefined();
    finish();
    await first;
    expect(db.prepare('SELECT count(*) n FROM mail_outbox').get()).toEqual({ n: 0 });
  } finally {
    db.close();
  }
});
it('deduplicates persistent backup incidents and emits one recovery', () => {
  const db = openDatabase(':memory:');
  try {
    recordBackupResult(db, 'operator@example.com', false, 1000);
    recordBackupResult(db, 'operator@example.com', false, 2000);
    expect(db.prepare('SELECT count(*) n FROM mail_outbox').get()).toEqual({ n: 1 });
    recordBackupResult(db, 'operator@example.com', false, 86402000);
    recordBackupResult(db, 'operator@example.com', true, 86403000);
    recordBackupResult(db, 'operator@example.com', true, 86404000);
    expect(db.prepare('SELECT subject FROM mail_outbox').all()).toEqual([
      { subject: 'mem-brane backup needs attention' },
      { subject: 'mem-brane backup needs attention' },
      { subject: 'mem-brane backup recovered' },
    ]);
    expect(db.prepare('SELECT failed_since,last_alert_at FROM backup_alert_state').get()).toEqual({
      failed_since: null,
      last_alert_at: null,
    });
  } finally {
    db.close();
  }
});
it('requires complete mail settings and redacts failed provider responses', async () => {
  expect(mailSettings({})).toBeUndefined();
  expect(() => mailSettings({ MAIL_FROM: 'a@example.com' })).toThrow();
  const settings = mailSettings({ MAIL_FROM: 'a@example.com', RESEND_API_KEY: 'test-key' })!;
  const request = vi
    .fn<typeof fetch>()
    .mockResolvedValue(new Response('secret reset link', { status: 429 }));
  await expect(
    resendSender(settings, request)(
      { recipient: 'b@example.com', subject: 's', body: 'b' },
      'stable-id',
    ),
  ).rejects.toThrow('Mail delivery rejected (429)');
  expect(request.mock.calls[0][0]).toBe('https://api.resend.com/emails');
  expect(request.mock.calls[0][1]).toMatchObject({
    redirect: 'error',
    headers: { 'idempotency-key': 'stable-id' },
  });
});
