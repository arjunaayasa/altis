import { createHash } from 'node:crypto';
import { upsert, type DB } from '@altis/db';
import { DomainError, normalizeKey } from '@altis/shared';
import { opacHomeFilePaths, type OpacHomeContent, type OpacHomePutBody } from '@altis/shared/api/opac-home';
import type { Kysely, Transaction } from 'kysely';
import type { TxCtx } from '../context.js';
import type { KeyringEntry } from '../crypto/secret-box.js';
import { SETTINGS, type SettingKey } from '../settings/registry.js';
import { readSettings, writeSettings } from '../settings/service.js';

// The content of the OPAC home page (the setting `opac.home`) and the welcome text of each language (the subtitle of a
// hero slide without one of its own), read and saved as one thing by the admin screen OPAC › Halaman awal.
//
// - A revision (the first 16 hex digits of the SHA-256 of the three values as JSON) names what the screen loaded; a
//   save that names another revision is refused with CONFLICT_STALE, so a second admin never overwrites the first
//   one's save unseen. The save locks the `opac.home` row first (inserting it as its default when absent, which two
//   first saves meet on), then reads, so the comparison sees the latest committed content.
// - The photos (every slide's, the logo, the "about" photo, the facility and the gallery photos) are uploads of
//   `opac.home_photo`. Saving claims the ones the content names as public files of the
//   setting (`owner_type 'settings'`, `owner_id 'opac.home'`, served by `/files/<id>` like a cover) and releases the
//   ones it no longer names: they lose their owner and turn `staff`, so the reports housekeeping removes them a day
//   later as orphan uploads, and nobody fetches them meanwhile. A file id that is not such an upload (or is held by
//   something else) is a VALIDATION_FAILED at its place in the body.
// - One audit entry `opac.home.update` with the settings that changed (names only).
// - The contact e-mail is published on every page, so it must be the library's own: an address a staff user or a member
//   has (compared as their keys are, case and width folded) is a VALIDATION_FAILED `personal_email` at its place.

/** The setting that holds the page's content, and the owner id of its photos. */
export const OPAC_HOME_KEY = 'opac.home';
/** The upload context of the page's photos. */
export const OPAC_HOME_PHOTO_CONTEXT = 'opac.home_photo';

/** The settings the screen reads and saves together, in the order the revision hashes them. */
const KEYS = ['opac.home', 'opac.welcome.id', 'opac.welcome.en'] as const satisfies readonly SettingKey[];

type Db = Kysely<DB> | Transaction<DB>;

/** What the screen edits: the content, both welcome texts and their revision. */
export interface OpacHomeState {
  home: OpacHomeContent;
  welcome: { id: string | null; en: string | null };
  revision: string;
}

function revisionOf(values: Record<(typeof KEYS)[number], unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify(KEYS.map((key) => values[key])))
    .digest('hex')
    .slice(0, 16);
}

/** The home page's content, the welcome texts and their revision, as stored now (defaults for absent rows). */
export async function readOpacHome(db: Db): Promise<OpacHomeState> {
  const values = await readSettings(db, KEYS, []);
  return {
    home: values['opac.home'] as OpacHomeContent,
    welcome: { id: values['opac.welcome.id'] as string | null, en: values['opac.welcome.en'] as string | null },
    revision: revisionOf(values),
  };
}

/** A blank welcome text is none. */
const welcomeValue = (text: string | null): string | null => (text === null || text.trim() === '' ? null : text);

/** The place of each photo of `home` in a PUT body, by file id. */
function photoPaths(home: OpacHomeContent): Map<string, string> {
  return new Map(opacHomeFilePaths(home).map(({ fileId, path }) => [fileId, ['home', ...path].join('.')]));
}

/**
 * Claims the photos `home` names as public files of the setting and releases the setting's other files.
 *
 * @throws DomainError VALIDATION_FAILED (`not_found`, or `invalid` for a file of another context, not stored, or owned
 *   by something else) at the photo's place in the body
 */
async function claimPhotos(trx: Transaction<DB>, home: OpacHomeContent): Promise<void> {
  const paths = photoPaths(home);
  const wanted = [...paths.keys()];
  if (wanted.length > 0) {
    const rows = await trx.selectFrom('files').select(['id', 'context', 'status', 'owner_type', 'owner_id']).where('id', 'in', wanted).execute();
    const byId = new Map(rows.map((r) => [r.id, r]));
    const errors: { path: string; code: string }[] = [];
    for (const [id, path] of paths) {
      const f = byId.get(id);
      if (f === undefined) {
        errors.push({ path, code: 'not_found' });
        continue;
      }
      const unowned = f.owner_type === null && f.owner_id === null;
      const ours = f.owner_type === 'settings' && f.owner_id === OPAC_HOME_KEY;
      if (f.context !== OPAC_HOME_PHOTO_CONTEXT || f.status !== 'ok' || !(unowned || ours)) errors.push({ path, code: 'invalid' });
    }
    if (errors.length > 0) {
      throw new DomainError('VALIDATION_FAILED', { detail: 'Foto halaman awal tidak valid / A home page photo is not valid', meta: { errors } });
    }
    await trx
      .updateTable('files')
      .set({ owner_type: 'settings', owner_id: OPAC_HOME_KEY, access: 'public' })
      .where('id', 'in', wanted)
      .where('context', '=', OPAC_HOME_PHOTO_CONTEXT)
      .where((eb) => eb.or([eb.and([eb('owner_type', 'is', null), eb('owner_id', 'is', null)]), eb.and([eb('owner_type', '=', 'settings'), eb('owner_id', '=', OPAC_HOME_KEY)])]))
      .execute();
  }
  let release = trx.updateTable('files').set({ owner_type: null, owner_id: null, access: 'staff' }).where('owner_type', '=', 'settings').where('owner_id', '=', OPAC_HOME_KEY);
  if (wanted.length > 0) release = release.where('id', 'not in', wanted);
  await release.execute();
}

// ---- Komunitas (OPAC look) ----
/**
 * Refuses a contact e-mail that is a person's: the address of a staff user (their `email_key`) or of a member (any
 * case).
 *
 * @throws DomainError VALIDATION_FAILED `personal_email` at `home.contact.email`
 */
async function checkContactEmail(trx: Transaction<DB>, home: OpacHomeContent): Promise<void> {
  const email = home.contact.email;
  if (email === null) return;
  const key = normalizeKey(email);
  const [staff, member] = await Promise.all([
    trx.selectFrom('staff_users').select('id').where('email_key', '=', key).limit(1).executeTakeFirst(),
    trx
      .selectFrom('members')
      .select('id')
      .where((eb) => eb(eb.fn<string>('upper', [eb.ref('email')]), '=', key))
      .limit(1)
      .executeTakeFirst(),
  ]);
  if (staff !== undefined || member !== undefined) {
    throw new DomainError('VALIDATION_FAILED', {
      detail: 'E-mail kontak tidak boleh alamat pengguna atau anggota / The contact e-mail may not be a user\'s or a member\'s address',
      meta: { errors: [{ path: 'home.contact.email', code: 'personal_email' }] },
    });
  }
}

/**
 * Saves the home page (see the top of this file) in `tx`: the content and both welcome texts of `body`, if `body.revision`
 * is the stored one. Answers the new revision and the settings that changed (in registry order).
 *
 * @throws DomainError CONFLICT_STALE when the stored content is not the revision the body names; VALIDATION_FAILED for
 *   a photo that cannot be claimed (or a value the registry refuses)
 */
export async function saveOpacHome(
  tx: TxCtx,
  body: OpacHomePutBody,
  o: { keyring: readonly KeyringEntry[] },
): Promise<{ revision: string; changed: SettingKey[] }> {
  const { trx } = tx;
  // Lock first: the content's row, inserted as the default when absent (its scope is the one writeSettings writes).
  const seed = {
    value: JSON.stringify(SETTINGS[OPAC_HOME_KEY].default),
    is_secret: 0,
    scope: SETTINGS[OPAC_HOME_KEY].scope,
    updated_at: tx.now,
    updated_by: tx.actor.id,
  };
  await upsert(trx, 'settings', { key: OPAC_HOME_KEY }, seed, { scope: SETTINGS[OPAC_HOME_KEY].scope });
  const current = await readOpacHome(trx);
  if (current.revision !== body.revision) {
    throw new DomainError('CONFLICT_STALE', {
      detail: 'Halaman awal sudah diubah orang lain; muat ulang lalu ulangi perubahan Anda / The home page was changed by someone else; reload it and make your changes again',
    });
  }
  await checkContactEmail(trx, body.home);
  await claimPhotos(trx, body.home);
  const changed = await writeSettings(
    trx,
    { 'opac.home': body.home, 'opac.welcome.id': welcomeValue(body.welcome.id), 'opac.welcome.en': welcomeValue(body.welcome.en) },
    { keyring: o.keyring, now: tx.now, actorId: tx.actor.id },
  );
  await tx.audit({ action: 'opac.home.update', entity: 'settings', entityId: null, meta: { keys: changed } });
  return { revision: (await readOpacHome(trx)).revision, changed };
}
