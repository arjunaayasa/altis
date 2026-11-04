import os from 'node:os';
import { checkDocroot, ensureHeadroom, isEnvSet, type Env, type Runtime } from '@altis/platform';
import { compareSemver, isDomainError, isSemver } from '@altis/shared';
import type { PreflightCheck, PreflightCheckName, PreflightReport } from '@altis/shared/api/install';
import { WASM_HINT, wasmProbe } from '../diagnostics/wasm.js';

// The install's mandatory checks (spec §9.5 step 1: "Node, DATA_DIR bisa ditulis, P16, WASM (P19), zona waktu, RAM";
// plan Task 27, L51). The web wizard shows them in `GET checks` and refuses `POST config` while one of level `error`
// fails; the headless `install` runs the same checks and prints the warnings.
//
//   node      error  Node ≥ 22.16
//   dataDir   error  DATA_DIR exists and takes a small write (ensureHeadroom, 4 MiB: answered from its 10-minute cache
//                    on a repeat, so a reload of the wizard writes nothing; L51/C23 keep the probe small on LVE hosts)
//   docroot   error  P16: neither DATA_DIR nor the app folder lies in a document root, DATA_DIR not inside the app
//   wasm      warn   P19: one page of WebAssembly memory can be reserved; else the NODE_OPTIONS hint
//   timezone  error  Intl knows Asia/Jakarta (the default library time zone) and the host's own zone
//   ram       warn   the host has at least 512 MiB of memory

/** The oldest Node.js ALTIS runs on (global constraints). */
export const MIN_NODE_VERSION = '22.16.0';
/** Below this much memory the host is warned about (spec §9.5 step 1 "RAM"). */
export const PREFLIGHT_MIN_RAM_BYTES = 512 * 1024 * 1024;
/** What the dataDir check writes (L51, decision C23: small, as doctor's). */
export const PREFLIGHT_HEADROOM_BYTES = 4 * 1024 * 1024;
/** The library time zone every install starts with. */
const DEFAULT_TIMEZONE = 'Asia/Jakarta';

export interface PreflightOptions {
  /** `process.versions.node` form. */
  nodeVersion: string;
  dataDir: string;
  /** The folder of app.js. */
  appRoot: string;
  /** The user's home folder (document-root rules relative to it); '' disables them. */
  home: string;
  /** The runtime the server runs under (named in the RAM detail of a shared host). */
  runtime: Runtime;
  /** The environment: `NODE_OPTIONS` (whether the WASM hint is already applied). */
  env: Env;
  /**
   * Prepended to `/var/www` and `/www` by the document-root check (checkDocroot's `rootPrefix`).
   *
   * @internal Tests only; never wired from the environment or a file.
   */
  rootPrefix?: string;
}

/** True when `version` (`process.versions.node` form) is at least {@link MIN_NODE_VERSION}. */
export function nodeVersionSupported(version: string): boolean {
  return isSemver(version) && compareSemver(version, MIN_NODE_VERSION) >= 0;
}

const pass = (level: PreflightCheck['level'], detail: string): PreflightCheck => ({ ok: true, level, detail });
const fail = (level: PreflightCheck['level'], detail: string): PreflightCheck => ({ ok: false, level, detail });

function nodeCheck(version: string): PreflightCheck {
  return nodeVersionSupported(version)
    ? pass('error', `Node ${version}`)
    : fail(
        'error',
        `Node ${version} terlalu lama; ALTIS memerlukan Node 22.16 atau lebih baru (pilih di panel hosting) / ` +
          `Node ${version} is too old; ALTIS needs Node 22.16 or newer (choose it in the hosting panel)`,
      );
}

function errorCode(error: unknown): string | undefined {
  const code = (error as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}

async function dataDirCheck(dataDir: string): Promise<PreflightCheck> {
  try {
    await ensureHeadroom(dataDir, PREFLIGHT_HEADROOM_BYTES);
    return pass('error', 'DATA_DIR dapat ditulis / DATA_DIR is writable');
  } catch (error) {
    if (isDomainError(error) && error.code === 'DISK_QUOTA') {
      return fail('error', 'Ruang disk atau kuota DATA_DIR habis / The disk or quota of DATA_DIR is full');
    }
    const code = errorCode(error);
    const why = code === 'ENOENT' ? 'tidak ada / does not exist' : `tidak dapat ditulis / is not writable${code === undefined ? '' : ` (${code})`}`;
    return fail('error', `DATA_DIR ${why}`);
  }
}

function docrootCheck(o: PreflightOptions): PreflightCheck {
  let result: ReturnType<typeof checkDocroot>;
  try {
    result = checkDocroot({ dataDir: o.dataDir, appRoot: o.appRoot, home: o.home, ...(o.rootPrefix === undefined ? {} : { rootPrefix: o.rootPrefix }) });
  } catch (error) {
    const code = errorCode(error);
    return fail('error', `Lokasi folder tidak dapat diperiksa / The folders cannot be checked${code === undefined ? '' : ` (${code})`}`);
  }
  if (result.ok) return pass('error', 'Di luar document root / Outside any document root');
  const what =
    result.reason === 'DATA_IN_APPROOT'
      ? 'DATA_DIR ada di dalam folder aplikasi / DATA_DIR lies inside the app folder'
      : 'DATA_DIR atau folder aplikasi ada di dalam document root / DATA_DIR or the app folder lies inside a document root';
  return fail(
    'error',
    `${what}: ${result.matched}; pindahkan ke luar (cPanel: ~/altis/app; aaPanel: /www/altis/<nama>/app) / ` +
      `move it outside (cPanel: ~/altis/app; aaPanel: /www/altis/<name>/app)`,
  );
}

function wasmCheck(env: Env): PreflightCheck {
  const probe = wasmProbe();
  if (probe.ok) return pass('warn', 'WebAssembly tersedia / WebAssembly is available');
  const applied = isEnvSet(env, 'NODE_OPTIONS') && env['NODE_OPTIONS']!.includes('--disable-wasm-trap-handler');
  return fail(
    'warn',
    applied
      ? 'Memori WebAssembly tidak dapat dipesan walau NODE_OPTIONS sudah diatur; minta batas memori virtual dinaikkan / ' +
          'WebAssembly memory cannot be reserved although NODE_OPTIONS is set; ask for a higher virtual memory limit'
      : `Memori WebAssembly tidak dapat dipesan; atur ${probe.hint ?? WASM_HINT} di panel hosting / ` +
          `WebAssembly memory cannot be reserved; set ${probe.hint ?? WASM_HINT} in the hosting panel`,
  );
}

/** Whether `Intl` knows `zone` as a time zone. */
function knowsZone(zone: string): boolean {
  try {
    new Intl.DateTimeFormat('en-US', { timeZone: zone });
    return true;
  } catch {
    return false;
  }
}

function timezoneCheck(): PreflightCheck {
  let host: string | undefined;
  try {
    host = new Intl.DateTimeFormat().resolvedOptions().timeZone;
  } catch {
    host = undefined;
  }
  const hostOk = typeof host === 'string' && host !== '' && knowsZone(host);
  if (knowsZone(DEFAULT_TIMEZONE) && hostOk) return pass('error', `${DEFAULT_TIMEZONE}; host ${host}`);
  return fail(
    'error',
    'Data zona waktu Node tidak lengkap (Asia/Jakarta atau zona host tidak dikenal); pakai Node dengan ICU penuh / ' +
      'Node lacks time zone data (Asia/Jakarta or the host zone is unknown); use a Node built with full ICU',
  );
}

function ramCheck(runtime: Runtime): PreflightCheck {
  let total: number;
  try {
    total = os.totalmem();
  } catch {
    total = 0;
  }
  const mib = Math.floor(total / (1024 * 1024));
  if (total >= PREFLIGHT_MIN_RAM_BYTES) return pass('warn', `${mib} MiB`);
  const shared = runtime === 'passenger' || runtime === 'litespeed' ? ' (batas LVE / the LVE limit)' : '';
  return fail(
    'warn',
    `Memori ${mib} MiB${shared}; ALTIS disarankan minimal 512 MiB / ` + `${mib} MiB of memory${shared}; ALTIS should have at least 512 MiB`,
  );
}

/**
 * The install's checks (see the top of this file), in {@link PREFLIGHT_CHECKS} order. Never throws: a check that
 * cannot run fails with its reason.
 */
export async function preflightChecks(o: PreflightOptions): Promise<PreflightReport> {
  const checks: Record<PreflightCheckName, PreflightCheck> = {
    node: nodeCheck(o.nodeVersion),
    dataDir: await dataDirCheck(o.dataDir),
    docroot: docrootCheck(o),
    wasm: wasmCheck(o.env),
    timezone: timezoneCheck(),
    ram: ramCheck(o.runtime),
  };
  const ok = Object.values(checks).every((c) => c.ok || c.level !== 'error');
  return { ok, checks };
}

/** The checks of `report` that failed at `level`, in order. */
export function failedChecks(report: PreflightReport, level: PreflightCheck['level']): PreflightCheckName[] {
  return (Object.keys(report.checks) as PreflightCheckName[]).filter((name) => !report.checks[name].ok && report.checks[name].level === level);
}
