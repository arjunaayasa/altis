import type { DbHandle } from '@altis/db';
import type { AuditAction, Permission } from '@altis/shared';
import type { Hono } from 'hono';
import type { AppEnv } from '../../src/app.js';
import type { Config } from '../../src/config.js';
import type { JobRuntime } from '../../src/jobs/runtime.js';
import type { AgentReply } from '../agent.js';
import { AUDIT as ATTACHMENTS } from './catalog-attachments.js';
import { AUDIT as AUTHORITIES } from './catalog-authorities.js';
import { AUDIT as EXCHANGE } from './catalog-exchange.js';
import { AUDIT as ITEMS } from './catalog-items.js';
import { AUDIT as MASTERS } from './catalog-masters.js';
import { AUDIT as MIGRATION } from './catalog-migration.js';
import { AUDIT as PAGES } from './catalog-pages.js';
import { AUDIT as RECORDS } from './catalog-records.js';
import { AUDIT as RUNS } from './catalog-runs.js';
import { AUDIT as SEARCH } from './catalog-search.js';

// A10 for Phase 2 (its spec §12.4: "Setiap aksi wajib tercakup tes A10"; plan Task 2, decision P2-02): one audit
// script per area, each in a file of its own that only its owning task fills, so no later task edits a shared file.
// db/audit-coverage.test.ts runs every script whose `run` is set, on one installation and in this order, and checks
// that each appended at least one entry of each action it owns and that the chain still verifies. A script left `null`
// lists its actions as pending (`it.todo`) while PHASE2_PENDING_ALLOWED; Task 39 sets it to false, and every action must
// then be covered.
//
// Owners: records 16, attachments 18, items 17, authorities 13, masters 12 (locations, 14, write `catalog.master.*`
// too), search 15, runs 19, exchange 31, migration 23, pages 20.

/** The methods of {@link AuditBrowser.send}. */
export type AuditMethod = 'get' | 'post' | 'put' | 'patch' | 'delete';

/**
 * A browser signed in as one staff user, the way the admin SPA drives the API: its session cookie, the session's CSRF
 * token and the baseUrl's Origin on every request. The session was re-authenticated when it was made (at
 * `clock.now`); a script that moves the clock on more than 5 minutes before a `reauth` route calls `auth/reauth` with
 * `password` first.
 */
export interface AuditBrowser {
  readonly userId: string;
  readonly password: string;
  /** A JSON request (`body` as JSON; extra `headers`, e.g. `Idempotency-Key`). */
  send(method: AuditMethod, url: string, body?: unknown, headers?: Record<string, string>): Promise<AgentReply>;
  /** `POST url` with `form` as multipart/form-data. */
  multipart(url: string, form: FormData): Promise<AgentReply>;
  /**
   * Uploads `data` into the upload context `context` through the API (declare, every chunk, complete) and answers what
   * `complete` answered: `{uploadId, …}` for a staged context, `{fileId}` for a file context. Fails the test on an
   * unexpected status.
   */
  upload(context: string, data: Uint8Array, originalName?: string): Promise<{ uploadId: string } | { fileId: string }>;
}

/** What audit-coverage.test.ts hands each script: one installation, shared by every script in order. */
export interface AuditScriptContext {
  /** A super admin's browser (the actor of every entry the script expects). */
  admin: AuditBrowser;
  /** A new browser of a staff user holding `permissions` through a custom role assigned globally. */
  signIn(permissions: readonly Permission[]): Promise<AuditBrowser>;
  /** The installation's database (seeding fixtures, reading what a route wrote). */
  db: DbHandle;
  /**
   * The app's clock, which a script may move on (`clock.now += ms`). It starts six hours behind the real clock: an audit
   * entry may never be dated ahead of the real one.
   */
  clock: { now: number };
  /** The app under test (for a request the browsers cannot make). */
  app: Hono<AppEnv>;
  config: Config;
  dataDir: string;
  /** The job runtime of the installation (external mode): `jobs.drive(id, {budgetMs})` runs a slice of a job. */
  jobs: JobRuntime;
}

/** The audit script of one area: the actions it owns, and the run that appends them (null: not written yet). */
export interface AreaAuditScript {
  actions: readonly AuditAction[];
  run: ((s: AuditScriptContext) => Promise<void>) | null;
}

/** Every area's script, in the order audit-coverage.test.ts runs them. */
export const PHASE2_AUDIT_SCRIPTS: Readonly<Record<string, AreaAuditScript>> = Object.freeze({
  masters: MASTERS,
  authorities: AUTHORITIES,
  records: RECORDS,
  attachments: ATTACHMENTS,
  items: ITEMS,
  search: SEARCH,
  runs: RUNS,
  exchange: EXCHANGE,
  migration: MIGRATION,
  pages: PAGES,
});

/** While true, a script that is still null lists its actions as pending; Task 39 set it to false: every action is covered. */
export const PHASE2_PENDING_ALLOWED: boolean = false;
