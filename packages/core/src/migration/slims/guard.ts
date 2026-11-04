import type { DB } from '@altis/db';
import { DomainError } from '@altis/shared';
import type { Kysely, Transaction } from 'kysely';

// The target guard of a SLiMS migration (Phase 2 spec §11.2, decision D2-25): a real run writes into an empty catalogue
// (no record that is not archived), or into one that has records only with the explicit confirmation, `allowNonEmpty`
// plus the library's name typed out. A dry run writes nothing into the catalogue and is never refused here.

type Db = Kysely<DB> | Transaction<DB>;

/** NFKC, then trimmed: how a typed library name is compared (as for a restore of another installation's backup). */
export function comparableLibraryName(name: string): string {
  return name.normalize('NFKC').trim();
}

/**
 * Refuses a migration into a catalogue that has live records (`records.archived_at IS NULL`), unless `o.allowNonEmpty`
 * and `o.confirmLibraryName` equal to `o.libraryName` (after NFKC and trimming, never blank) both say so.
 *
 * @throws DomainError `MIGRATION_TARGET_NOT_EMPTY` (409) otherwise
 */
export async function assertTargetEmpty(
  db: Db,
  o: { allowNonEmpty: boolean; confirmLibraryName?: string | null; libraryName: string },
): Promise<void> {
  const live = await db.selectFrom('records').select('id').where('archived_at', 'is', null).limit(1).executeTakeFirst();
  if (live === undefined) return;
  const typed = o.confirmLibraryName === undefined || o.confirmLibraryName === null ? '' : comparableLibraryName(o.confirmLibraryName);
  if (o.allowNonEmpty && typed !== '' && typed === comparableLibraryName(o.libraryName)) return;
  throw new DomainError('MIGRATION_TARGET_NOT_EMPTY', {
    detail:
      'Katalog tujuan sudah berisi cantuman; izinkan target tidak kosong dan ketik nama perpustakaan ini untuk melanjutkan / ' +
      "The target catalogue already holds records; allow a non-empty target and type this library's name to go on",
  });
}
