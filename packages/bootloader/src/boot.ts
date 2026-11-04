import fsp from 'node:fs/promises';
import os from 'node:os';
import type { KeysetSource } from '@altis/crypto';
import { checkDocroot, dataPath, detectRuntime, ensureDir, readJsonWithBak, resolveDataDir, resolvePort } from '@altis/platform';
import { isDomainError, newId } from '@altis/shared';
import {
  BootFailure,
  bundledPlan,
  bundledVersion,
  context,
  embeddedRoots,
  load,
  rescueOnFront,
  serveActive,
  stateFailure,
  withFallback,
  type BootOptions,
  type Setup,
} from './boot-core.js';
import { readCurrentState, releaseDir, type CurrentState, type ReleaseRef } from './current.js';
import { openFront, type Front } from './front.js';
import type { BootLog } from './log.js';
import { bootPending } from './pending.js';
import { installedKeysets, verify } from './release.js';
import { exitWith, listenErrorMessage, printJsonFailure, rescueDetail, rescueSteps, rescueSummary, serveRescue, wantsJson } from './rescue.js';
import { exitWithSupervisor, runSupervisor } from './supervisor.js';

// BootContext, the contract v1 context (spec §9.2), lives in boot-core.ts with the internals that pending.ts shares
// (preflight M9); it is exported from here, where apps/server's mirror is compared with it (test/contract.types.ts).
export type { BootContext, BootOptions } from './boot-core.js';

// Everything app.js does once the Node check has passed (spec §9.2 for 1a). main.ts loads this module lazily
// (ruling R56), so nothing here, nor @altis/platform, @altis/crypto or @altis/shared, is evaluated on an old Node.
//
// Order:
//   2. DATA_DIR: resolveDataDir → checkDocroot (P16; before anything is created, so nothing lands in a document
//      root) → mkdir → writability probe;
//   3. detectRuntime + resolvePort (ALTIS_PORT → PORT → config.json port → 3000; a command, which has no server,
//      runs with port 0 when that setting is not a port, L52, so doctor, migrate and user:* still run; config:set
//      cannot repair it, as it parses the whole config.json first: the file is edited by hand); a process that will serve
//      (not a command, not the standalone supervisor) now creates its one http.Server and listens, once (P2, ruling
//      R64; under Passenger the loader's listen()), answering 503 "starting" until a release serves; it then refuses
//      a config.json that is corrupt along with its .bak (CONFIG_CORRUPT: no release is tried, none is at fault);
//   4. current.json, read or initialised under current.lock;
//   5. every root-signed keyset document of the installation (ruling R65a): DATA_DIR/releases/keyset.json and its
//      .bak, the keyset.json of every bundled release and of every release current.json names;
//   6. verifyRelease(check:'executed') of the release to run, with the keys app.js trusts for it: the embedded root
//      keys + the keys that root-signed documents add (those of step 5 and the release's own keyset.json) − revoked;
//   7. a command (argv): import server.mjs → runCli(argv, ctx) → exit with its code. While current.json names a
//      `pending` release (1d, spec §9.2 step 4), only CLI_WHILE_PENDING runs, and it runs `active` (with the fallback
//      to `previous`), never `pending`, touching no boot marker; any other command is refused (RELEASE_PENDING, exit
//      1) right after step 4, except `jobs:run`, which prints one line and exits 0 with nothing run;
//   8. otherwise, standalone and not yet supervised: become the supervisor (fork app.js with ALTIS_SUPERVISED=1);
//      otherwise import server.mjs → start(ctx), which installs its request listener with ctx.serve(handler):
//      - a `pending` release (1d, spec §9.3) is booted only by the holder of releases/boot.lock, with boot markers and
//        revert counting; a pending release that fails is reverted (op.json first) and `active` boots in this process;
//        a process that does not get the lock waits, serving the minimal pages of §9.2 step 6 (pending.ts, waiting.ts);
//      - otherwise the bundled release is classified against `active` (§9.8, bundled.ts): a newer one with no `active`
//        folder boots in `schemaHold`; else `active` boots with `ctx.bundledRelease`. An `active` release that fails
//        (verification, import or start) falls back to the bundled copy of the same version when its DATA_DIR folder
//        fails verification (S14), then to `previous` in this process when schema-meta.json allows it (§9.7): the
//        failed release's handler is retired and the next one serves on the same server (boot-core.ts);
//   9. any failure: the rescue page with the reason code, on the same server (or, on the command line, the message
//      and exit 1, plus runCli's one JSON line on stdout when the command has --json); except a port that cannot be
//      listened on: the bilingual message and exit 1 (P2).

/** app.js could not listen (the port is taken, or not allowed): message and exit 1, never a rescue page. */
class ListenFailed extends Error {
  constructor(cause: unknown) {
    super('listen failed', { cause });
    this.name = 'ListenFailed';
  }
}

/** A port setting that is not a port: there is no port to serve a rescue page on. */
class PortInvalid extends Error {
  readonly detail: string;

  constructor(detail: string, cause: unknown) {
    super('INVALID_CONFIG: port', { cause });
    this.name = 'PortInvalid';
    this.detail = detail;
  }
}

/**
 * The commands that still run while current.json names a `pending` release (spec §9.2 step 4: "menolak berjalan saat
 * `pending` terisi (kecuali `release:rollback`, `doctor`, `maintenance:*`)"), as the refusal names them. They run the
 * `active` release. An entry ending in `:*` stands for every command of that family (`maintenance:on`,
 * `maintenance:off`, and any a later release adds: app.js is frozen with contract v1).
 */
export const CLI_WHILE_PENDING: readonly string[] = ['release:rollback', 'doctor', 'maintenance:*'];

/** The scheduler's command (cPanel's cron line, every 5 min): while `pending` is set it runs nothing and exits 0. */
const JOBS_RUN = 'jobs:run';

/**
 * Whether the command of `argv` may run while `pending` is set: its first word (the command, as runCli parses it) is
 * one of {@link CLI_WHILE_PENDING}, or of a `<family>:*` entry's family (`<family>:` and at least one character more).
 */
export function cliAllowedWhilePending(argv: readonly string[]): boolean {
  if (argv.length === 0) return false;
  const command = argv[0] as string;
  for (const entry of CLI_WHILE_PENDING) {
    if (entry.slice(-2) === ':*') {
      const family = entry.slice(0, -1);
      if (command.length > family.length && command.indexOf(family) === 0 && command !== entry) return true;
    } else if (command === entry) {
      return true;
    }
  }
  return false;
}

function homeDir(): string {
  try {
    return os.homedir();
  } catch {
    return '';
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Step 2a: where DATA_DIR is, refused when it or the app folder lies in a document root (P16). */
function locateDataDir(o: BootOptions, env: NodeJS.ProcessEnv): string {
  const home = homeDir();
  let dir: string;
  try {
    dir = resolveDataDir({ env, appRoot: o.appRoot, home }).dir;
  } catch (error) {
    throw new BootFailure('DATA_DIR_UNWRITABLE', 'DATA_DIR cannot be resolved', error);
  }
  const check = checkDocroot({ dataDir: dir, appRoot: o.appRoot, home });
  if (!check.ok) {
    throw new BootFailure('DOCROOT_EXPOSED', check.reason + ' (DATA_DIR ' + dir + ', app ' + o.appRoot + ', matched ' + check.matched + ')');
  }
  return dir;
}

/** Step 2b: DATA_DIR exists and a file can be created, written, synced and removed in it. */
async function prepareDataDir(dataDir: string): Promise<void> {
  try {
    await ensureDir(dataDir);
    await ensureDir(dataPath(dataDir, 'tmp'));
    const probe = dataPath(dataDir, 'tmp', newId());
    try {
      const handle = await fsp.open(probe, 'wx', 0o600);
      try {
        await handle.writeFile('altis');
        await handle.sync();
      } finally {
        await handle.close();
      }
    } finally {
      await fsp.rm(probe, { force: true }).catch(() => undefined);
    }
  } catch (error) {
    throw new BootFailure('DATA_DIR_UNWRITABLE', 'DATA_DIR ' + dataDir + ' cannot be created or written', error);
  }
}

/**
 * DATA_DIR/config.json as app.js sees it: read leniently (the server validates the whole file), for its `port` and to
 * tell whether it is corrupt. `config`: the object (from the `.bak` when the main file is torn), or null when there is
 * none or it cannot be read; `corrupt`: config.json and its `.bak` are both unusable (not JSON, or not an object),
 * which the server could only report as a failed start.
 */
interface ConfigFile {
  config: Record<string, unknown> | null;
  corrupt: boolean;
}

function configObject(raw: unknown): Record<string, unknown> {
  if (!isRecord(raw)) throw new TypeError('config.json is not an object');
  return raw;
}

async function readConfigFile(dataDir: string | null): Promise<ConfigFile> {
  if (dataDir === null) return { config: null, corrupt: false };
  try {
    return { config: await readJsonWithBak(dataPath(dataDir, 'root', 'config.json'), configObject), corrupt: false };
  } catch (error) {
    // STATE_CORRUPT: both unusable. Any other error (EACCES, say) is the server's to report.
    return { config: null, corrupt: isDomainError(error) && error.code === 'STATE_CORRUPT' };
  }
}

/** config.json's `port`: undefined when absent; NaN when it is not a number (resolvePort refuses it). */
function configPort(file: ConfigFile): number | undefined {
  if (file.config === null || file.config['port'] === undefined) return undefined;
  return typeof file.config['port'] === 'number' ? file.config['port'] : Number.NaN;
}

/** Step 3: the port (P2). @throws PortInvalid */
async function portFor(env: NodeJS.ProcessEnv, dataDir: string | null, file?: ConfigFile): Promise<number> {
  try {
    return resolvePort(env, configPort(file === undefined ? await readConfigFile(dataDir) : file)).port;
  } catch (error) {
    const detail = isDomainError(error) && error.detail !== undefined ? error.detail : 'invalid port';
    throw new PortInvalid(detail, error);
  }
}

/**
 * Step 3 for this process (L52): a process that serves needs a valid port (PortInvalid otherwise); a command has no
 * server, so an invalid port does not stop it: it runs with ctx.port 0, so doctor (which reports the setting itself),
 * migrate and the user:* commands still run. `config:set` does not repair it (updateConfig parses the whole
 * config.json first and refuses a schema-invalid port): a bad config.json port is fixed by editing the file, a bad
 * ALTIS_PORT or PORT by changing the environment.
 * @throws PortInvalid (not a command)
 */
async function commandTolerantPort(o: BootOptions, env: NodeJS.ProcessEnv, dataDir: string, file: ConfigFile): Promise<number> {
  try {
    return await portFor(env, dataDir, file);
  } catch (error) {
    if (o.cli && error instanceof PortInvalid) return 0;
    throw error;
  }
}

/**
 * Step 3, a process that serves: its one http.Server, listening on `port` before any release is imported.
 * @throws ListenFailed
 */
async function listen(port: number, log: BootLog): Promise<Front> {
  const front = openFront(port, log);
  try {
    await front.listening;
  } catch (error) {
    throw new ListenFailed(error);
  }
  log.info('listening', { port });
  return front;
}

function refuseServe(): Promise<void> {
  throw new Error('ctx.serve() is not available to a command (CLI): it has no server');
}

/**
 * Step 8, the server: the pending boot protocol when current.json names a `pending` release (pending.ts), otherwise
 * `active` with the §9.8 classification and the fallbacks (boot-core.ts serveActive). The release serves on `front`
 * through ctx.serve.
 */
async function serve(s: Setup, front: Front): Promise<void> {
  if (s.state.pending !== null) {
    await bootPending(s, front);
    return;
  }
  await serveActive(s, front);
}

/**
 * Step 7, a command: runCli(argv, ctx), then exit with its code. A failing command is not a release failure. It runs
 * `active` (with the fallback to `previous`), never `pending`, even when a pending release is set (only the
 * CLI_WHILE_PENDING commands get here then), and its ctx.bootMarker writes nothing (spec §9.2 step 4).
 */
async function command(s: Setup): Promise<void> {
  const loaded = await withFallback(s, (ref) => load(s, ref));
  let code: number;
  try {
    const result = await loaded.server.runCli(s.argv, context(s, loaded, 'cli', refuseServe));
    code = typeof result === 'number' && Number.isInteger(result) && result >= 0 && result <= 255 ? result : 1;
  } catch (error) {
    s.log.error('command failed', { argv: s.argv, err: error });
    code = 1;
  }
  exitWith(code, '');
}

/**
 * Step 8, standalone: check that a release the child will boot can be verified, then supervise children that run it.
 * The child boots `pending` when one is set (and reverts to `active` when it fails), the bundled release in
 * `schemaHold` (§9.8 row 3), or else `active` with its fallbacks; the check follows the same order, so that the
 * supervisor never shows a rescue page for an installation its child would boot.
 */
async function supervise(s: Setup): Promise<void> {
  const check = async (ref: ReleaseRef): Promise<void> => {
    try {
      await verify(releaseDir(s.appRoot, s.dataDir, ref), ref, s.roots, s.keysets, s.log);
    } catch (error) {
      throw new BootFailure('RELEASE_INVALID', 'release ' + ref.version + ' (' + ref.source + ') failed verification', error, 'verify');
    }
  };
  let verified = false;
  if (s.state.pending !== null) {
    try {
      await check(s.state.pending);
      verified = true;
    } catch (error) {
      if (!(error instanceof BootFailure)) throw error;
      s.log.warn('the pending release fails verification; its child will revert it', { release: s.state.pending.version, err: error });
    }
  } else {
    const hold = (await bundledPlan(s)).schemaHold;
    if (hold !== null) {
      await check(hold);
      verified = true;
    }
  }
  if (!verified) await withFallback(s, check);
  runSupervisor({ script: s.script, args: s.argv, env: s.env, log: s.log });
}

/** One line on stdout (a closed stdout is ignored: the exit code remains). */
function printLine(line: string): void {
  try {
    process.stdout.write(line + '\n');
  } catch {
    // stdout closed
  }
}

/** The one-line bilingual reason a command is refused while `version` is pending (no path, host or value). */
function pendingDetail(version: string): string {
  return (
    'Versi baru ALTIS ' +
    version +
    ' sedang dipasang; perintah ini tidak dijalankan. Tunggu sampai selesai, atau batalkan dengan node app.js release:rollback / ' +
    'A new ALTIS version ' +
    version +
    ' is being installed; this command was not run. Wait until it has finished, or cancel it with node app.js release:rollback'
  );
}

/** The bilingual message on stderr for a command refused while `version` is pending: Indonesian, then English. */
function pendingMessage(version: string): string {
  const allowed = CLI_WHILE_PENDING.join(', ');
  return (
    'ALTIS (RELEASE_PENDING): Versi baru ALTIS ' +
    version +
    ' sedang dipasang dan belum selesai dijalankan, jadi perintah ini tidak dijalankan.\n' +
    'ALTIS (RELEASE_PENDING): A new ALTIS version ' +
    version +
    ' is being installed and has not finished starting, so this command was not run.\n' +
    '  - Tunggu sampai pembaruan selesai (membuka halaman ALTIS di peramban menjalankan versi baru itu), lalu jalankan perintah ini lagi.\n' +
    '  - Untuk membatalkan pembaruan dan kembali ke versi yang berjalan sebelumnya: node app.js release:rollback\n' +
    '  - Selama pembaruan, hanya perintah berikut yang dapat dijalankan: ' +
    allowed +
    '.\n' +
    '  - Wait until the update has finished (opening an ALTIS page in a browser starts the new version), then run this command again.\n' +
    '  - To cancel the update and go back to the version that ran before: node app.js release:rollback\n' +
    '  - During an update, only these commands run: ' +
    allowed +
    '.\n'
  );
}

/**
 * Step 7 while current.json names `pending` and the command is not one of {@link CLI_WHILE_PENDING} (spec §9.2 step 4):
 * nothing is verified, imported or run, and no boot marker is touched.
 * - `jobs:run` (cPanel's cron line, every 5 min): one line on stdout (`pending <v>: nothing run`, or with --json
 *   runCli's success line with nothing run) and exit 0, so cron mails no error while an update waits for its boot
 *   (preflight 1D-27);
 * - any other command: the bilingual message naming `release:rollback` on stderr and exit 1; with --json also runCli's
 *   failure line `{ok: false, command, code: 'RELEASE_PENDING', detail}` on stdout.
 */
function refuseWhilePending(argv: readonly string[], version: string): void {
  const json = wantsJson(argv);
  if (argv[0] === JOBS_RUN) {
    printLine(json ? JSON.stringify({ ok: true, command: JOBS_RUN, pending: version, passes: 0, slices: 0 }) : 'pending ' + version + ': nothing run');
    exitWith(0, '');
    return;
  }
  if (json) {
    const command = argv.length > 0 && argv[0] !== '--json' ? argv[0] : '';
    printLine(JSON.stringify({ ok: false, command: command, code: 'RELEASE_PENDING', detail: pendingDetail(version) }));
  }
  exitWith(1, pendingMessage(version));
}

/** Step 9: rescue page (server; on `front` when app.js already listens) or message and exit 1 (command line). */
async function fail(o: BootOptions, error: unknown, dataDir: string | null, knownPort: number | null, front: Front | null): Promise<void> {
  const json = o.cli && wantsJson(o.argv);
  if (error instanceof PortInvalid) {
    // Only a process that serves gets here (a command runs with port 0, L52).
    exitWith(1, 'ALTIS: ' + error.detail + '\n', true);
    return;
  }
  if (front !== null) {
    rescueOnFront(o.log, front, error);
    return;
  }
  const failure = error instanceof BootFailure ? error : new BootFailure('START_FAILED', 'unexpected bootloader error', error);
  o.log.error('boot failed', { reason: failure.reason, err: failure });
  const message = rescueSummary(failure.reason) + rescueSteps(failure.reason);
  if (o.cli) {
    // runCli never ran: its `--json` contract (one JSON line on stdout) is kept here; never a rescue server.
    if (json) printJsonFailure(o.argv, failure.reason, rescueDetail(failure.reason));
    exitWith(1, message);
    return;
  }
  let port = knownPort;
  if (port === null) {
    try {
      port = await portFor(process.env, dataDir);
    } catch (portError) {
      exitWith(1, message + 'ALTIS: ' + (portError instanceof PortInvalid ? portError.detail : 'invalid port') + '\n', true);
      return;
    }
  }
  process.stderr.write(message);
  o.log.info('serving the rescue page', { reason: failure.reason, port });
  serveRescue(failure.reason, port, o.log);
}

/** Steps 2 to 9 (see the top of this file). Never rejects. */
export async function boot(o: BootOptions): Promise<void> {
  const env = process.env;
  const supervised = env['ALTIS_SUPERVISED'] === '1';
  if (supervised) exitWithSupervisor(o.log);
  let dataDir: string | null = null;
  let port: number | null = null;
  let front: Front | null = null;
  try {
    dataDir = locateDataDir(o, env);
    await prepareDataDir(dataDir);

    const runtime = detectRuntime(env, globalThis as { PhusionPassenger?: unknown });
    const configFile = await readConfigFile(dataDir);
    port = await commandTolerantPort(o, env, dataDir, configFile);
    const supervisor = runtime === 'standalone' && !supervised;
    if (!o.cli && !supervisor) front = await listen(port, o.log);
    // A process that serves (the supervisor's child does it in its place) never starts a release on a config.json
    // that is gone for good: no release is at fault, and none could start. A command still runs (doctor reports it).
    if (front !== null && configFile.corrupt) {
      throw new BootFailure('CONFIG_CORRUPT', 'config.json and config.json.bak in DATA_DIR are both unusable');
    }

    let state: CurrentState;
    try {
      state = await readCurrentState(dataDir, bundledVersion());
    } catch (error) {
      throw stateFailure('releases/current.json', error);
    }
    if (o.cli && state.pending !== null && !cliAllowedWhilePending(o.argv)) {
      refuseWhilePending(o.argv, state.pending.version);
      return;
    }
    let keysets: KeysetSource[];
    try {
      keysets = await installedKeysets(o.appRoot, dataDir, state, o.log);
    } catch (error) {
      throw stateFailure('releases/keyset.json', error);
    }

    const s: Setup = { ...o, env, dataDir, runtime, port, state, roots: embeddedRoots(), keysets };
    if (o.cli) await command(s);
    else if (front === null) await supervise(s);
    else await serve(s, front);
  } catch (error) {
    if (error instanceof ListenFailed) {
      o.log.error('listen failed', { port, err: error });
      exitWith(1, listenErrorMessage(port === null ? 0 : port, error.cause), true);
      return;
    }
    try {
      await fail(o, error, dataDir, port, front);
    } catch (failError) {
      exitWith(1, 'ALTIS: ' + String(failError) + '\n', true);
    }
  }
}
