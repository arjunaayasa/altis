import type { DB } from '@altis/db';
import { DomainError, newId } from '@altis/shared';
import type { FieldWarning } from '@altis/shared/api/catalog/common';
import {
  ACTIVATION_CODE_ALPHABET,
  ACTIVATION_CODE_LENGTH,
  ACTIVATION_CODE_TTL_MS,
  normalizeActivationCode,
  type StationCodeResponse,
  type StationCreateBody,
  type StationListQuery,
  type StationListResponse,
  type StationView,
} from '@altis/shared/api/visits';
import { randomBytes } from 'node:crypto';
import type { Selectable } from 'kysely';
import type { TxCtx } from '../context.js';
import { randomToken, sha256hex } from '../crypto/tokens.js';
import { memberValidationFailed, type Db } from '../members/common.js';

// Guestbook stations: a device of a branch (and optionally a room) that records visits on its own page.
//
// - Staff create a station and get an activation code: 8 characters of base32, valid 10 minutes, one use. Only its
//   SHA-256 is stored (`activation_hash`, with `activation_expires_at`); the code is in the answer that made it and
//   nowhere else. A new code clears the station's device token, so the device it was paired with stops working.
// - On the device, the code is typed on the activation page: when it matches a pending code (not expired, station not
//   revoked), the station gets a new 256-bit device token, stored as its SHA-256 (`token_hash`), the code is used up,
//   and the device keeps the token in a cookie. The match is by the code's hash, so a wrong code finds nothing; the
//   activation page's own rate limit (per client IP) bounds guessing.
// - Revoking sets `revoked_at` and clears both hashes: the device's next request finds no station.
// - A station of another branch than the route's is 404, as a station that does not exist.

type StationRow = Selectable<DB['visit_stations']>;

/** A station is gone for the route (none, or another branch's). */
export function stationNotFound(): DomainError {
  return new DomainError('NOT_FOUND', { detail: 'Perangkat buku tamu tidak ditemukan / Guestbook station not found' });
}

/** A fresh activation code: 8 characters of {@link ACTIVATION_CODE_ALPHABET}, uniformly drawn. */
export function newActivationCode(): string {
  let out = '';
  for (const byte of randomBytes(ACTIVATION_CODE_LENGTH)) out += ACTIVATION_CODE_ALPHABET[byte & 31];
  return out;
}

/** A field error unless `locationId` is a live location of `branchId`. */
async function locationError(db: Db, branchId: string, locationId: string): Promise<FieldWarning | null> {
  const row = await db.selectFrom('locations').select(['branch_id', 'archived_at']).where('id', '=', locationId).executeTakeFirst();
  return row === undefined || row.archived_at !== null || row.branch_id !== branchId ? { path: 'locationId', code: 'not_found' } : null;
}

/** The station `id` of `branchId`, locked by a write that changes nothing (the first statement of its writes). */
async function lockStation(tx: TxCtx, branchId: string, id: string): Promise<StationRow> {
  const locked = await tx.trx
    .updateTable('visit_stations')
    .set((eb) => ({ version: eb.ref('version') }))
    .where('id', '=', id)
    .where('branch_id', '=', branchId)
    .executeTakeFirst();
  if (Number(locked.numUpdatedRows) !== 1) throw stationNotFound();
  return tx.trx.selectFrom('visit_stations').selectAll().where('id', '=', id).executeTakeFirstOrThrow();
}

/**
 * Creates a station of `branchId` and answers its first activation code. Audit `visits.station.create`.
 *
 * @throws DomainError VALIDATION_FAILED `{path: 'locationId', code: 'not_found'}`
 */
export async function createStation(tx: TxCtx, branchId: string, body: StationCreateBody): Promise<StationCodeResponse> {
  const { trx } = tx;
  if (body.locationId !== undefined && body.locationId !== null) {
    const e = await locationError(trx, branchId, body.locationId);
    if (e !== null) throw memberValidationFailed([e]);
  }
  const id = newId(tx.now);
  const code = newActivationCode();
  const expiresAt = tx.now + ACTIVATION_CODE_TTL_MS;
  await trx
    .insertInto('visit_stations')
    .values({
      id,
      branch_id: branchId,
      location_id: body.locationId ?? null,
      name: body.name,
      token_hash: null,
      activation_hash: sha256hex(code),
      activation_expires_at: expiresAt,
      activated_at: null,
      last_seen_at: null,
      revoked_at: null,
      version: 0,
      created_at: tx.now,
      created_by: tx.actor.id,
      updated_at: tx.now,
      updated_by: tx.actor.id,
    })
    .execute();
  await tx.audit({ action: 'visits.station.create', entity: 'visit_stations', entityId: id, branchId, meta: {} });
  return { id, code, expiresAt };
}

/**
 * A new activation code for the station `id` of `branchId`; its device token is cleared and a revocation undone (the
 * station is paired again with the code). Audit `visits.station.activation_code`.
 *
 * @throws DomainError NOT_FOUND
 */
export async function newStationCode(tx: TxCtx, branchId: string, id: string): Promise<StationCodeResponse> {
  await lockStation(tx, branchId, id);
  const code = newActivationCode();
  const expiresAt = tx.now + ACTIVATION_CODE_TTL_MS;
  await tx.trx
    .updateTable('visit_stations')
    .set((eb) => ({
      token_hash: null,
      activation_hash: sha256hex(code),
      activation_expires_at: expiresAt,
      revoked_at: null,
      updated_at: tx.now,
      updated_by: tx.actor.id,
      version: eb('version', '+', 1),
    }))
    .where('id', '=', id)
    .execute();
  await tx.audit({ action: 'visits.station.activation_code', entity: 'visit_stations', entityId: id, branchId, meta: {} });
  return { id, code, expiresAt };
}

/**
 * Revokes the station `id` of `branchId`: its device token and any pending code are cleared. Revoking a revoked
 * station changes nothing more. Audit `visits.station.revoke`.
 *
 * @throws DomainError NOT_FOUND
 */
export async function revokeStation(tx: TxCtx, branchId: string, id: string): Promise<void> {
  const row = await lockStation(tx, branchId, id);
  await tx.trx
    .updateTable('visit_stations')
    .set((eb) => ({
      token_hash: null,
      activation_hash: null,
      activation_expires_at: null,
      revoked_at: row.revoked_at ?? tx.now,
      updated_at: tx.now,
      updated_by: tx.actor.id,
      version: eb('version', '+', 1),
    }))
    .where('id', '=', id)
    .execute();
  await tx.audit({ action: 'visits.station.revoke', entity: 'visit_stations', entityId: id, branchId, meta: {} });
}

/**
 * Pairs the device that typed `rawCode`: the station whose pending code it is gets a new device token (answered once,
 * for the cookie). The caller audits `visits.station.activated` with the station as the actor, once it is known.
 *
 * @throws DomainError VISIT_ACTIVATION_INVALID (no such pending code, expired, or the station revoked)
 */
export async function activateStation(tx: TxCtx, rawCode: string): Promise<{ stationId: string; branchId: string; token: string }> {
  const code = normalizeActivationCode(rawCode);
  const invalid = new DomainError('VISIT_ACTIVATION_INVALID', { detail: 'Kode aktivasi tidak berlaku / The activation code is not valid' });
  if (code.length !== ACTIVATION_CODE_LENGTH || [...code].some((c) => !ACTIVATION_CODE_ALPHABET.includes(c))) throw invalid;
  const hash = sha256hex(code);
  const token = randomToken(32);
  // The conditional write is the first statement: two devices typing the same code at once cannot both pair.
  const claimed = await tx.trx
    .updateTable('visit_stations')
    .set((eb) => ({
      token_hash: sha256hex(token),
      activation_hash: null,
      activation_expires_at: null,
      activated_at: tx.now,
      last_seen_at: tx.now,
      updated_at: tx.now,
      version: eb('version', '+', 1),
    }))
    .where('activation_hash', '=', hash)
    .where('activation_expires_at', '>=', tx.now)
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  if (Number(claimed.numUpdatedRows) !== 1) throw invalid;
  const row = await tx.trx.selectFrom('visit_stations').select(['id', 'branch_id']).where('token_hash', '=', sha256hex(token)).executeTakeFirstOrThrow();
  return { stationId: row.id, branchId: row.branch_id, token };
}

/** The live (paired, not revoked) station of the device token `token`, or null. */
export async function stationByToken(db: Db, token: string): Promise<{ id: string; branchId: string; locationId: string | null; name: string } | null> {
  if (!/^[A-Za-z0-9_-]{43}$/.test(token)) return null;
  const row = await db
    .selectFrom('visit_stations')
    .select(['id', 'branch_id', 'location_id', 'name'])
    .where('token_hash', '=', sha256hex(token))
    .where('revoked_at', 'is', null)
    .executeTakeFirst();
  return row === undefined ? null : { id: row.id, branchId: row.branch_id, locationId: row.location_id, name: row.name };
}

function stationView(r: StationRow, now: number): StationView {
  const codeExpiresAt = r.activation_hash !== null && r.activation_expires_at !== null && Number(r.activation_expires_at) >= now ? Number(r.activation_expires_at) : null;
  return {
    id: r.id,
    branchId: r.branch_id,
    locationId: r.location_id,
    name: r.name,
    paired: r.token_hash !== null && r.revoked_at === null,
    codeExpiresAt,
    activatedAt: r.activated_at === null ? null : Number(r.activated_at),
    lastSeenAt: r.last_seen_at === null ? null : Number(r.last_seen_at),
    revokedAt: r.revoked_at === null ? null : Number(r.revoked_at),
    createdAt: Number(r.created_at),
  };
}

/** The stations, newest first (at most a few hundred). */
export async function listStations(db: Db, q: StationListQuery, now: number): Promise<StationListResponse> {
  let query = db.selectFrom('visit_stations').selectAll();
  if (q.branchId !== undefined) query = query.where('branch_id', '=', q.branchId);
  if (q.includeRevoked !== true) query = query.where('revoked_at', 'is', null);
  const rows = await query.orderBy('created_at', 'desc').orderBy('id', 'desc').limit(1000).execute();
  return { items: rows.map((r) => stationView(r, now)) };
}
