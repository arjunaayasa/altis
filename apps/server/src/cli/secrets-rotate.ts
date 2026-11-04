import { rotateSecrets } from '@altis/core';
import { connect } from '@altis/db';
import type { Env } from '@altis/platform';
import { loadConfig, updateConfig } from '../config.js';
import type { BootContext } from '../index.js';
import { createLogger } from '../logger.js';
import { notInstalled } from './migrate.js';

// `node app.js secrets:rotate [--json]` (spec §7.6, §13.6; decision C32; 1c Task 24): a new active key in config.json's
// keyring (the old kids stay), a 5 s wait for every process's config fence, every registered secret column re-sealed
// under the new kid, `system.secrets_rotate {kid, rows}` audited (actor `cli`). The work is core's rotateSecrets; the
// keyring changes through updateConfig (ruling R58: under config.lock, the file as written, never the environment's
// overrides). Running it again is safe. Values that do not open (another installation's) are logged in
// DATA_DIR/logs/altis.log and left as they are.

/** What a rotation did. */
export interface SecretsRotateResult {
  kid: string;
  rows: number;
}

/**
 * Rotates the secrets key of the installed DATA_DIR.
 *
 * @throws DomainError `NOT_INSTALLED`, `OPS_IN_PROGRESS` (a rotation runs elsewhere), or what loadConfig, connect,
 *   updateConfig and the database throw
 */
export async function secretsRotate(ctx: BootContext, env: Env): Promise<SecretsRotateResult> {
  const config = await loadConfig(ctx.dataDir, env);
  if (config === null || config.installState !== 'complete') throw notInstalled();
  const log = createLogger({ dataDir: ctx.dataDir, level: config.log.level }).child({ command: 'secrets:rotate' });
  const h = await connect(config.db, { runtime: ctx.runtime, purpose: 'cli', dataDir: ctx.dataDir });
  try {
    return await rotateSecrets(h, {
      dataDir: ctx.dataDir,
      now: () => Date.now(),
      log,
      updateKeyring: async (mutate) =>
        (
          await updateConfig(ctx.dataDir, (cfg) => {
            cfg.keyring = mutate(cfg.keyring);
          })
        ).keyring,
    });
  } finally {
    await h.close();
  }
}

/** The human line of a rotation (the command and the new kid first, so scripts can match them). */
export function describeRotate(result: SecretsRotateResult): string {
  return (
    `secrets:rotate: ${result.kid} kunci aktif baru; ${result.rows} nilai rahasia dienkripsi ulang / ` +
    `${result.kid} is the new active key; ${result.rows} secret value(s) re-encrypted`
  );
}
