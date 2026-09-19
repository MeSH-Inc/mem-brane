import type { DB } from '../db/index.js';
import { enqueueMail } from './mail.js';

const day = 86400000;
export function recordBackupResult(db: DB, recipient: string, ok: boolean, now = Date.now()) {
  db.transaction(() => {
    const state = db
      .prepare('SELECT failed_since,last_alert_at FROM backup_alert_state WHERE singleton=1')
      .get() as { failed_since: number | null; last_alert_at: number | null };
    if (ok) {
      if (state.failed_since !== null && state.last_alert_at !== null)
        enqueueMail(
          db,
          {
            recipient,
            subject: 'mem-brane backup recovered',
            body: 'The backup job is healthy again and reports a verified daily archive. Review the retained backup evidence and perform a restore rehearsal if needed.',
          },
          now + day,
          now,
        );
      db.prepare(
        'UPDATE backup_alert_state SET failed_since=NULL,last_alert_at=NULL WHERE singleton=1',
      ).run();
      return;
    }
    if (state.last_alert_at === null || now - state.last_alert_at >= day) {
      enqueueMail(
        db,
        {
          recipient,
          subject: 'mem-brane backup needs attention',
          body: 'The production backup job failed. Inspect Railway backup logs, bucket access, free space and the newest verified archive. The job retries hourly; do not delete prior backups. A recovery notification follows a successful job.',
        },
        now + day,
        now,
      );
      db.prepare('UPDATE backup_alert_state SET last_alert_at=? WHERE singleton=1').run(now);
    }
    db.prepare(
      'UPDATE backup_alert_state SET failed_since=COALESCE(failed_since,?) WHERE singleton=1',
    ).run(now);
  })();
}
