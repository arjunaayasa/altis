/** Where the process is hosted. Decides restart strategy (P14), database pool size (P17) and SQLite eligibility. */
export const RUNTIMES = ['passenger', 'litespeed', 'pm2', 'docker', 'service', 'standalone'] as const;

export type Runtime = (typeof RUNTIMES)[number];

/** `process.env`, or a stand-in for it. */
export type Env = Readonly<Record<string, string | undefined>>;

/**
 * An environment variable counts as set when it is defined and not empty or whitespace-only
 * (`FOO= cmd` and a blank line in a `.env` file both clear a variable). Used for the presence markers
 * of {@link detectRuntime} (`PASSENGER_APP_ENV`, `LSNODE_*`, `pm_id`) and for the settings read from
 * the environment by resolvePort (`ALTIS_PORT`, `PORT`), resolveDataDir (`ALTIS_DATA_DIR`) and the
 * server's config and CLI. Not for every marker: `IN_PASSENGER` must equal `'1'`, and `ALTIS_RUNTIME`
 * is read as it is (a value that names no runtime is ignored).
 */
export function isEnvSet(env: Env, name: string): boolean {
  const value = env[name];
  return typeof value === 'string' && value.trim() !== '';
}

function isRuntime(value: string | undefined): value is Runtime {
  return value !== undefined && (RUNTIMES as readonly string[]).includes(value);
}

/**
 * Detects the hosting runtime. The first matching rule wins:
 *
 * 1. `ALTIS_RUNTIME` naming one of the six runtimes (any other value is ignored);
 * 2. Phusion Passenger: the `PhusionPassenger` global, `IN_PASSENGER=1`, or `PASSENGER_APP_ENV` set;
 * 3. LiteSpeed: any environment variable whose name starts with `LSNODE_` and that is set
 *    (marker still to be confirmed in the §12.8 field test);
 * 4. PM2: `pm_id` set;
 * 5. `standalone`.
 *
 * `docker` and `service` cannot be detected: they are reachable only through `ALTIS_RUNTIME`.
 *
 * @param env the process environment
 * @param g   the global object (`globalThis`); the Passenger shim defines `PhusionPassenger` on it
 */
export function detectRuntime(env: Env, g: { PhusionPassenger?: unknown }): Runtime {
  const forced = env['ALTIS_RUNTIME'];
  if (isRuntime(forced)) return forced;

  if (
    (g.PhusionPassenger !== undefined && g.PhusionPassenger !== null) ||
    env['IN_PASSENGER'] === '1' ||
    isEnvSet(env, 'PASSENGER_APP_ENV')
  ) {
    return 'passenger';
  }

  for (const name of Object.keys(env)) {
    if (name.startsWith('LSNODE_') && isEnvSet(env, name)) return 'litespeed';
  }

  if (isEnvSet(env, 'pm_id')) return 'pm2';

  return 'standalone';
}

/**
 * Whether the runtime itself permits SQLite (P20): false for `passenger` and `litespeed`, which may run
 * several worker processes against one database file.
 *
 * This checks the runtime only. P20 also requires `pm2` to run a single instance, a deployment property PM2
 * tells each process through its environment: see {@link pm2ClusterSignals} (1d Task 32, L8), which the
 * server's boot and doctor consult for SQLite under runtime `pm2`.
 */
export function sqliteAllowed(runtime: Runtime): boolean {
  return runtime !== 'passenger' && runtime !== 'litespeed';
}

// 1d Task 32 (L8, decision D1d-36) -----------------------------------------------------------------------------

/** A count PM2 writes is a plain decimal number; a longer one is named without its value. */
const SHOWN_NUMBER = /^[0-9]{1,9}$/;

/**
 * The signs, in the environment PM2 gives the process it runs, that this process is one of several on the same
 * DATA_DIR (P20: SQLite needs one process per database file). PM2 copies the app's settings into the environment
 * of every process it starts: `exec_mode` (`fork_mode` or `cluster_mode`), `instances` (already resolved to a
 * number), and `NODE_APP_INSTANCE` (this process's index, `0` for the first). The signals, in this order:
 *
 * - `exec_mode=cluster_mode` (or `exec_mode=cluster`): Node's cluster module, even with one instance;
 * - `instances=<n>` for an `instances` above 1 (or `max`), in fork mode too, where every process sees it;
 * - `NODE_APP_INSTANCE=<i>` for an index other than unset, empty or `0`: a second process exists.
 *
 * Values are trimmed. A value that is not what PM2 writes is named as `?` (the signals reach logs and doctor
 * output, never an arbitrary environment value). The caller decides whether the runtime is PM2: the variables
 * mean nothing elsewhere (`NODE_APP_INSTANCE` is also read by other tools).
 */
export function pm2ClusterSignals(env: Env): string[] {
  const signals: string[] = [];
  const mode = env['exec_mode']?.trim();
  if (mode === 'cluster_mode' || mode === 'cluster') signals.push(`exec_mode=${mode}`);

  const instances = env['instances']?.trim().toLowerCase();
  if (instances === 'max') signals.push('instances=max');
  else if (instances !== undefined && /^[0-9]+$/.test(instances) && Number(instances) > 1) {
    signals.push(`instances=${SHOWN_NUMBER.test(instances) ? instances : '?'}`);
  }

  const index = env['NODE_APP_INSTANCE']?.trim();
  if (index !== undefined && index !== '' && index !== '0') {
    signals.push(`NODE_APP_INSTANCE=${SHOWN_NUMBER.test(index) ? index : '?'}`);
  }
  return signals;
}
