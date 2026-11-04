import { auditAppend, withTx, type DB, type DbHandle } from '@altis/db';
import { isAuditAction, isDomainError, type AuditAction } from '@altis/shared';
import type { Transaction } from 'kysely';

// What core services run with (spec §7.8): who acts (Actor), the transaction of the action with the clock reading it
// runs under (TxCtx), and the audit entry it writes in that same transaction. A security event without a successful
// action (a failed login or 2FA, the first authz.denied of a minute) is written by securityAudit in a transaction of
// its own, so that it stays when the action's transaction rolls back.
//
// Services that open several short transactions (a rate-limit hit committed before the check that may fail, then a
// security audit after the failure) take a TxRunner rather than a DbHandle, so that the HTTP layer can hand them its
// own `rc.withTx` and count their audits (M38); runnerFor builds one over withTx for the CLI and the tests.

/** Who performs an action. `id` is the staff user's ULID (null for system, CLI and anonymous actors). */
export interface Actor {
  type: 'staff' | 'system' | 'cli' | 'anonymous';
  id: string | null;
  /** The client IP (P15), or null when there is no request. */
  ip: string | null;
}

/** One audit entry as a service states it; the actor, the time and the transaction come from its {@link TxCtx}. */
export interface AuditInput {
  action: AuditAction;
  /** The kind of entity acted on (`staff_users`, `roles`, ...), or null. */
  entity: string | null;
  entityId: string | null;
  branchId?: string | null;
  /** JSON data, never a secret or a password (default `{}`). */
  meta?: Record<string, unknown>;
}

/** A transaction of an action, the time it happens at, and who performs it. */
export interface TxCtx {
  trx: Transaction<DB>;
  /** Epoch ms of the action (one reading of the clock for the whole action). */
  now: number;
  actor: Actor;
  /** Appends an entry to the audit log in `trx` (auditAppend). Await it before the next statement on `trx`. */
  audit(e: AuditInput): Promise<void>;
}

/** Runs `fn` in a transaction of its own, with the runner's actor unless `o.actor` replaces it. */
export type TxRunner = <T>(fn: (tx: TxCtx) => Promise<T>, o?: { actor?: Actor }) => Promise<T>;

/** The minimal logger core code takes; the server's `Logger` satisfies it (M25). */
export interface CoreLogger {
  info(msg: string, fields?: Record<string, unknown>): void;
  warn(msg: string, fields?: Record<string, unknown>): void;
  error(msg: string, fields?: Record<string, unknown>): void;
}

/** What core logs a failure with: codes and names only, never a message (it could quote SQL or values). */
export function errorFields(error: unknown): Record<string, unknown> {
  if (isDomainError(error)) return { code: error.code };
  if (error instanceof Error) {
    const code = (error as { code?: unknown }).code;
    return { name: error.name, code: typeof code === 'string' ? code : undefined };
  }
  return { name: typeof error };
}

/**
 * The context of an action running in `trx`. Its `audit` writes `{at: now, actorType: actor.type, actorId: actor.id,
 * ip: actor.ip, branchId: e.branchId ?? null, meta: e.meta ?? {}, ...}` with auditAppend.
 *
 * @throws TypeError from `audit`, before anything is written, for an action outside AUDIT_ACTIONS (and whatever
 *   auditAppend refuses: an actor id that is not a ULID, an over-long entity id, ...)
 */
export function txCtx(trx: Transaction<DB>, now: number, actor: Actor): TxCtx {
  return {
    trx,
    now,
    actor,
    audit: async (e) => {
      if (typeof e.action !== 'string' || !isAuditAction(e.action)) {
        throw new TypeError(`audit action ${JSON.stringify(e.action)} is not in AUDIT_ACTIONS (@altis/shared)`);
      }
      await auditAppend(trx, {
        at: now,
        actorType: actor.type,
        actorId: actor.id,
        action: e.action,
        entity: e.entity,
        entityId: e.entityId,
        branchId: e.branchId ?? null,
        ip: actor.ip,
        meta: e.meta ?? {},
      });
    },
  };
}

/**
 * Writes a security event (a failed login, a denial, a remember-me token reuse) in a transaction of its own, so
 * that it is kept whatever happens to the action's transaction. Call it outside any withTx callback (R49: inside one
 * withTx refuses it with a TypeError).
 */
export async function securityAudit(h: DbHandle, now: number, actor: Actor, e: AuditInput): Promise<void> {
  await withTx(h, (trx) => txCtx(trx, now, actor).audit(e));
}

/**
 * A {@link TxRunner} over withTx on `h`, for the CLI and the tests: every call is one transaction (re-run as a whole
 * on a conflict, R37, so `fn` must be re-runnable), at `now`, by `actor` unless the call names another.
 */
export function runnerFor(h: DbHandle, now: number, actor: Actor): TxRunner {
  return (fn, o) => withTx(h, (trx) => fn(txCtx(trx, now, o?.actor ?? actor)));
}
