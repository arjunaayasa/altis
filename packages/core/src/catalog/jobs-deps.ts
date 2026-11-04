import type { CoreLogger } from '../context.js';
import type { KeyringEntry } from '../crypto/secret-box.js';
import type { StorageDriver } from '../files/serve.js';

/**
 * What every catalog job handler is built with (Phase 2 Task 3): the process's facts, which core does not hold (M22).
 * The server binds them per job runtime (apps/server/src/jobs/catalog.ts, `needsRuntime`); handlers take them as
 * `deps: () => CatalogJobDeps` and read them per slice, so a config change (the keyring, the base URL) is seen by the
 * next slice. An unbound handler (a registry that only enqueues) throws TypeError when it reads them.
 */
export interface CatalogJobDeps {
  /** DATA_DIR: run work files (`tmp/<runId>/`), export files (`exports/`), uploads. */
  dataDir: string;
  /** config.json's `baseUrl` (P13): the absolute URLs of exports and reports, never a Host header. */
  baseUrl: string;
  /** The keyring of the moment: enqueueing a job, sealing a secret parameter. */
  keyring: readonly KeyringEntry[];
  /** Where stored files (covers, attachments, reports) live (§13.8; the local driver in Phase 2). */
  storage: StorageDriver;
  log: CoreLogger;
}
