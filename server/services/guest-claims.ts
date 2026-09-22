import { createHash, randomBytes } from 'node:crypto';
import type { DB } from '../db/index.js';
import { DomainError } from '../domain/access.js';

const digest = (token: string) => createHash('sha256').update(token).digest('hex');
export const claimLifetime = 30 * 60 * 1000;
export const guestRecoveryGrace = 7 * 86400000;
export const guestStarterTitle = 'Your first brane';

// An untouched guest library holds only its starter brane. Claiming it would give
// the account an empty extra library, so sign-in leaves it to expire instead.
export function guestHasWork(db: DB, libraryId: string) {
  const branes = db.prepare('SELECT title FROM branes WHERE owner_id=?').all(libraryId) as {
    title: string;
  }[];
  return (
    branes.length > 1 ||
    branes.some((b) => b.title !== guestStarterTitle) ||
    Boolean(db.prepare('SELECT 1 FROM blocks WHERE owner_id=? LIMIT 1').get(libraryId))
  );
}

// The proof is delivered only in an HttpOnly, same-site cookie, never a library ID
// or a browser-provided principal. It remains usable after the login cookie changes.
export function prepareGuestClaim(
  db: DB,
  principalId: string,
  libraryId: string,
  previous?: string,
) {
  if (
    !db.prepare('SELECT 1 FROM libraries WHERE id=? AND principal_id=?').get(libraryId, principalId)
  )
    throw new DomainError(403, 'This guest session cannot claim that workspace.');
  const guest = db
    .prepare(
      'SELECT * FROM guest_libraries WHERE library_id=? AND claimed_by IS NULL AND purged_at IS NULL',
    )
    .get(libraryId) as { expires_at: number } | undefined;
  if (!guest || guest.expires_at + guestRecoveryGrace <= Date.now())
    throw new DomainError(409, 'This workspace is no longer available to claim.');
  if (
    previous &&
    db
      .prepare(
        'SELECT 1 FROM guest_claim_intents WHERE token_hash=? AND guest_principal_id=? AND library_id=? AND expires_at>?',
      )
      .get(digest(previous), principalId, libraryId, Date.now())
  )
    return previous;
  const token = randomBytes(32).toString('base64url');
  db.prepare(
    'INSERT INTO guest_claim_intents VALUES (?,?,?,?) ON CONFLICT(library_id) DO UPDATE SET token_hash=excluded.token_hash,guest_principal_id=excluded.guest_principal_id,expires_at=excluded.expires_at',
  ).run(digest(token), libraryId, principalId, Date.now() + claimLifetime);
  return token;
}

export function claimGuestLibrary(
  db: DB,
  guestPrincipal: string,
  principalId: string,
  libraryId: string,
) {
  return db
    .transaction(() => {
      const target = db.prepare('SELECT isAnonymous FROM user WHERE id=?').get(principalId) as
        { isAnonymous: number } | undefined;
      if (!target || target.isAnonymous)
        throw new DomainError(401, 'Sign in to keep this workspace.');
      const receipt = db
        .prepare('SELECT * FROM library_claims WHERE library_id=?')
        .get(libraryId) as { principal_id: string; guest_principal_id: string } | undefined;
      if (receipt) {
        if (receipt.principal_id !== principalId || receipt.guest_principal_id !== guestPrincipal)
          throw new DomainError(409, 'This workspace was already claimed by another account.');
        return libraryId;
      }
      const guest = db
        .prepare(
          'SELECT * FROM guest_libraries WHERE library_id=? AND claimed_by IS NULL AND purged_at IS NULL',
        )
        .get(libraryId) as { expires_at: number } | undefined;
      if (!guest || guest.expires_at + guestRecoveryGrace <= Date.now())
        throw new DomainError(
          409,
          'This guest workspace has expired. Local recovery remains on this device.',
        );
      // Expired guests may still claim during the recovery grace period.
      const owned = db
        .prepare('SELECT 1 FROM libraries WHERE id=? AND principal_id=?')
        .get(libraryId, guestPrincipal);
      if (!owned) throw new DomainError(403, 'Guest proof does not own this workspace.');
      db.prepare('INSERT INTO library_claims VALUES (?,?,?,?)').run(
        libraryId,
        guestPrincipal,
        principalId,
        Date.now(),
      );
      db.prepare('UPDATE libraries SET principal_id=? WHERE id=?').run(principalId, libraryId);
      db.prepare('UPDATE guest_libraries SET claimed_by=? WHERE library_id=?').run(
        principalId,
        libraryId,
      );
      db.prepare('DELETE FROM session WHERE userId=?').run(guestPrincipal);
      return libraryId;
    })
    .immediate();
}

export function completeGuestClaim(db: DB, principalId: string, token: string) {
  const intent = db
    .prepare('SELECT * FROM guest_claim_intents WHERE token_hash=? AND expires_at>?')
    .get(digest(token), Date.now()) as
    { library_id: string; guest_principal_id: string } | undefined;
  if (!intent)
    throw new DomainError(
      409,
      'The workspace claim expired. Return to the guest workspace to try again.',
    );
  return claimGuestLibrary(db, intent.guest_principal_id, principalId, intent.library_id);
}
