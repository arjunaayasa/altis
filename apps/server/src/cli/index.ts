import readline from 'node:readline/promises';
import { Writable } from 'node:stream';
import { JOBS_RUN_DEFAULT_S } from '@altis/core';
import type { TrustedKey } from '@altis/crypto';
import { RUNTIMES, type Env, type Runtime } from '@altis/platform';
import { isUlid } from '@altis/shared';
import { notWellFormed } from '../http/validate.js';
import type { BootContext } from '../index.js';
import { backupCreate, backupRestore, describeBackupCreate, describeBackupRestore, describeRestoreStatus } from './backup.js';
import { catalogReindex, describeCatalogReindex } from './catalog-reindex.js';
import { CliError, EXIT, describeFailure, type Failure } from './common.js';
import { CONFIG_SET_KEYS, configSet, shadowNote } from './config-set.js';
import { DOCTOR_CHECKS, doctor, type Check, type DoctorReport } from './doctor.js';
import { install } from './install.js';
import { describeReset, installReset } from './install-reset.js';
import { describeJobsRun, jobsRun } from './jobs-run.js';
import { describeOff, describeOn, maintenanceOff, maintenanceOn } from './maintenance.js';
import { describeOutcome, migrate } from './migrate.js';
import { describeCancel, describeResume, opsCancel, opsResume } from './ops.js';
import { describeReleaseList, describeReleaseRollback, describeReleaseUnpin, releaseList, releaseRollback, releaseUnpin } from './release.js';
import { describeRotate, secretsRotate } from './secrets-rotate.js';
import { describeSlimsImport, slimsImport, type SlimsImportOptions } from './slims-import.js';
import { disableUserTotp, resetUserPassword } from './user.js';

// runCli(argv, ctx) of the bootloader contract v1 (spec §9.2, §13.6): `node app.js <command> ...` arrives here with
// argv = the words after `app.js`. Phase 1a has `install --config <file> [--runtime <runtime>]`, `migrate` and
// `doctor [--smoke]`; 1b adds `user:reset-password <username>`, `user:disable-2fa <username>` and
// `config:set <key> <value>` (Task 24); 1c adds `jobs:run [--budget <seconds>]` (Task 13), `maintenance:on [--reason
// <text>]`, `maintenance:off [--force]`, `install:reset [--wipe-db] [--confirm-db <name>]` and `secrets:rotate`, and runs
// `migrate` under the ops lock (Task 24), `backup:create [--files]` (Task 20) and `backup:restore <file|backupId>
// [--without-files] [--yes-external <library name>]` (Task 29); the final review adds `ops:resume` and `ops:cancel`
// (cli/ops.ts, OPS-ATTN-EXIT); 1d adds `release:list`, `release:rollback [--force]` and `release:unpin` (Task 26,
// cli/release.ts); Phase 2 (Task 3) adds
// `catalog:reindex` (Task 15) and `slims:import` with the flags of spec §12.6 (Task 23); each takes `--json`.
// Exit codes: 0 ok, 1 failure, 2 already installed, 3 schema too new (needs a newer release).
//
// Output: short bilingual lines for humans (results on stdout, a failure on stderr), or with --json exactly one JSON
// line on stdout, failures included: {"ok":false,"command","code","detail"}. When app.js fails before runCli runs (Node
// too old, DATA_DIR, docroot, release state or verification), app.js prints that line itself, with `reason` (its rescue
// reason, equal to `code`) added (packages/bootloader rescue.ts printJsonFailure), and exits 1. An invalid port does not
// stop a command (L52: a command has no server; ctx.port is then 0), so doctor, migrate and the user:* commands still
// run; config:set does not repair it (updateConfig parses the whole config.json first): a port in config.json that is
// not a port is fixed by editing the file, and a bad ALTIS_PORT or PORT by changing the environment.
// Nothing printed ever holds a secret, a password or the content of config.json or of the input file (see common.ts
// describeFailure), with one exception: the temporary password `user:reset-password` made, shown once.

export interface CliIo {
  /** The environment the commands read: the ALTIS_* overrides, HOME, test hooks. Default `process.env`. */
  env: Env;
  stdout(text: string): void;
  stderr(text: string): void;
  /** The Node.js version to check. Default `process.versions.node`. */
  nodeVersion?: string;
  /**
   * Root keys for doctor's full release check, in place of the ones embedded at build time (rulings R62, R65).
   * BootContext v1 carries none. Tests pass the dev root.
   */
  rootKeys?: readonly TrustedKey[];
  /** For doctor: refuse keyset documents that add a `dev-` key (default: a production build does, R65b). Tests set it. */
  refuseDevKids?: boolean;
  /**
   * The hosting-panel marker folders on this host, for install's runtime guard (ruling R66). Default: the folders of
   * cli/host-panels.ts that exist. Tests pass their own.
   */
  hostPanels?: () => readonly string[];
  /**
   * Asks the operator a question at the terminal and returns the line typed, or null when there is no TTY
   * (`install:reset --wipe-db` asks for the database's name; 1c Task 24). Default: a prompt on stderr reading stdin
   * when both are a TTY.
   */
  prompt?: (question: string) => Promise<string | null>;
  /**
   * Asks the operator for a secret at the terminal without echoing it, and returns the line typed, or null when there
   * is no TTY (`backup:restore` asks for an archive's passphrase unless ALTIS_BACKUP_PASSPHRASE is set; 1c Task 29).
   * Default: a prompt on stderr reading stdin when both are a TTY, the typed characters not shown.
   */
  promptSecret?: (question: string) => Promise<string | null>;
}

const COMMANDS = [
  'help',
  'install',
  'migrate',
  'doctor',
  'user:reset-password',
  'user:disable-2fa',
  'config:set',
  'jobs:run',
  'maintenance:on',
  'maintenance:off',
  'install:reset',
  'secrets:rotate',
  'backup:create',
  'backup:restore',
  'ops:resume',
  'ops:cancel',
  'release:list',
  'release:rollback',
  'release:unpin',
  // ---- Phase 2 (catalog): Task 3 ----
  'catalog:reindex',
  'slims:import',
] as const;

type Command = (typeof COMMANDS)[number];

/** A parsed command line. */
export interface Args {
  command: Command;
  json: boolean;
  smoke: boolean;
  config?: string;
  runtime?: Runtime;
  /** `jobs:run --budget <seconds>` (1c Task 13). */
  budget?: number;
  /** `maintenance:on --reason <text>` (1c Task 24). */
  reason?: string;
  /** `maintenance:off --force` (1c Task 24); `release:rollback --force` (1d Task 26). */
  force: boolean;
  /** `install:reset --wipe-db` and `--confirm-db <name>` (1c Task 24). */
  wipeDb: boolean;
  confirmDb?: string;
  /** `backup:create --files` (1c Task 20). */
  files: boolean;
  /** `backup:restore --without-files` and `--yes-external <library name>` (1c Task 29). */
  withoutFiles: boolean;
  yesExternal?: string;
  /** Phase 2 Task 3: the flags of `slims:import` (spec §12.6) that take a value. */
  slims: Pick<SlimsImportOptions, 'db' | 'user' | 'dump' | 'filesZip' | 'filesDir' | 'branch' | 'priceMode' | 'catalogMode' | 'skipCatalog' | 'fromRunId'>;
  /** `slims:import --dry-run` and `--allow-non-empty`. */
  dryRun: boolean;
  allowNonEmpty: boolean;
  /** The words after the command that are not options (`<username>`, `<key> <value>`). */
  operands: string[];
}

/** The longest `maintenance:on --reason`, in characters (code points). */
const REASON_MAX = 100;
/** The longest `install:reset --confirm-db` (a database name is at most 64 characters on every dialect). */
const CONFIRM_MAX = 255;
/** The longest `backup:restore --yes-external`, in characters (code points): `library.name` holds at most 191. */
const LIBRARY_NAME_MAX = 191;
/** Phase 2 Task 3: the longest value of a `slims:import` flag (a host:port/database, a user, a path, a branch code). */
const SLIMS_VALUE_MAX = 1024;
/** `slims:import --price-mode` (§11.4). */
const PRICE_MODES = ['major', 'minor', 'skip'] as const;
// ---- Komunitas K1 (catalogue re-sync) ----
/** `slims:import --catalog-mode`: new rows only, or also rewrite the mapped rows no one edited in ALTIS. */
const CATALOG_MODES = ['append', 'sync'] as const;
/** The `slims:import` flags that take a value, and the field each fills. */
const SLIMS_VALUE_FLAGS: Readonly<Record<string, 'db' | 'user' | 'dump' | 'filesZip' | 'filesDir' | 'branch'>> = {
  '--db': 'db',
  '--user': 'user',
  '--dump': 'dump',
  '--files-zip': 'filesZip',
  '--files-dir': 'filesDir',
  '--branch': 'branch',
};

export const USAGE = [
  'Pemakaian / Usage: node app.js <perintah / command> [--json]',
  '  install --config <file> [--runtime <runtime>]',
  '                            pasang tanpa antarmuka / headless install; runtime: ' + RUNTIMES.join(', '),
  '  migrate                   jalankan migrasi database / run the database migrations',
  '  doctor [--smoke]          diagnostik (dan uji jalan) / diagnostics (and a smoke test)',
  '  user:reset-password <username>',
  '                            kata sandi sementara baru / a new temporary password',
  '  user:disable-2fa <username>',
  '                            matikan 2FA pengguna / turn off a user\'s 2FA',
  '  config:set <key> <value>  ubah config.json / change config.json; key: ' + CONFIG_SET_KEYS.join(', '),
  '                            (nilai kosong menghapus port, update.feedUrl / an empty value removes port, update.feedUrl)',
  `  jobs:run [--budget <detik / seconds>]`,
  `                            jalankan antrean tugas / run the job queue (default ${JOBS_RUN_DEFAULT_S} s; untuk cron / for cron)`,
  `  maintenance:on [--reason <teks / text, ≤ ${REASON_MAX}>]`,
  '                            nyalakan mode pemeliharaan / turn maintenance mode on',
  '  maintenance:off [--force] matikan mode pemeliharaan (--force: juga saat operasi macet) / turn it off (--force:',
  '                            also while an operation is stuck)',
  '  install:reset [--wipe-db] [--confirm-db <nama database / database name>]',
  '                            reset instalasi (--wipe-db: hapus tabel ALTIS) / reset the installation (--wipe-db:',
  '                            drop the ALTIS tables)',
  '  secrets:rotate            kunci baru untuk rahasia tersimpan / a new key for the stored secrets',
  '  backup:create [--files]   buat cadangan sekarang (--files: beserta berkas unggahan) / make a backup now (--files:',
  '                            with the uploaded files)',
  '  backup:restore <berkas / file | backupId> [--without-files] [--yes-external <nama perpustakaan / library name>]',
  '                            pulihkan backup atau arsip .altisbak (frasa sandi: ALTIS_BACKUP_PASSPHRASE atau prompt;',
  '                            --yes-external: konfirmasi arsip instalasi lain) / restore a backup or an .altisbak archive',
  '                            (passphrase: ALTIS_BACKUP_PASSPHRASE or a prompt; --yes-external: confirms another',
  "                            installation's archive)",
  '  ops:resume                lanjutkan operasi yang macet (needs_attention) sampai selesai / resume a stuck operation',
  '                            (needs_attention) and run it to its end',
  '  ops:cancel                batalkan operasi (ditolak setelah titik tanpa kembali; op.json rusak disisihkan) / cancel',
  '                            the operation (refused past its point of no return; an unreadable op.json is set aside)',
  '  release:list              rilis aktif, sebelumnya, tertunda, terpasang, dan riwayatnya / the active, previous,',
  '                            pending and installed releases, and their history',
  '  release:rollback [--force]',
  '                            batalkan rilis tertunda, atau kembali ke versi sebelumnya (--force: tunggu proses yang',
  '                            sedang mem-boot rilis tertunda) / revert the pending release, or go back to the previous',
  '                            version (--force: wait for the process booting the pending release)',
  '  release:unpin             lepas sematan versi setelah rollback / remove the version pin a rollback set',
  '  catalog:reindex           bangun ulang indeks pencarian katalog / rebuild the catalogue search index',
  '  slims:import (--db <host:port/db> --user <pengguna / user> | --dump <berkas / file>)',
  '               [--files-zip <zip> | --files-dir <folder>] [--branch <kode / code>] [--price-mode major|minor|skip]',
  '               [--dry-run] [--allow-non-empty] [--catalog-mode append|sync] [--skip-catalog --from-run <id>]',
  '                            migrasi katalog SLiMS (sandi database: ALTIS_SLIMS_DB_PASSWORD atau prompt) / migrate a',
  '                            SLiMS catalogue (database password: ALTIS_SLIMS_DB_PASSWORD or a prompt)',
  '                            --catalog-mode sync: selaraskan juga katalog yang belum disunting di ALTIS / also',
  '                            re-sync the catalogue rows not edited in ALTIS; --skip-catalog --from-run <id>: lewati',
  '                            tahap katalog setelah uji coba sinkron tanpa perubahan / skip the catalogue stages after',
  '                            a sync dry run that found no change',
].join('\n');

/** Options each command accepts (besides --json). */
const OPTIONS: Readonly<Record<Command, readonly string[]>> = {
  help: [],
  install: ['--config', '--runtime'],
  migrate: [],
  doctor: ['--smoke'],
  'user:reset-password': [],
  'user:disable-2fa': [],
  'config:set': [],
  'jobs:run': ['--budget'],
  'maintenance:on': ['--reason'],
  'maintenance:off': ['--force'],
  'install:reset': ['--wipe-db', '--confirm-db'],
  'secrets:rotate': [],
  'backup:create': ['--files'],
  'backup:restore': ['--without-files', '--yes-external'],
  'ops:resume': [],
  'ops:cancel': [],
  'release:list': [],
  'release:rollback': ['--force'],
  'release:unpin': [],
  'catalog:reindex': [],
  'slims:import': [
    '--db',
    '--user',
    '--dump',
    '--files-zip',
    '--files-dir',
    '--branch',
    '--price-mode',
    '--dry-run',
    '--allow-non-empty',
    // ---- Komunitas K1 (catalogue re-sync) ----
    '--catalog-mode',
    '--skip-catalog',
    '--from-run',
  ],
};

/** The operands each command takes, by name (exactly these, in this order). */
const OPERANDS: Readonly<Record<Command, readonly string[]>> = {
  help: [],
  install: [],
  migrate: [],
  doctor: [],
  'user:reset-password': ['<username>'],
  'user:disable-2fa': ['<username>'],
  'config:set': ['<key>', '<value>'],
  'jobs:run': [],
  'maintenance:on': [],
  'maintenance:off': [],
  'install:reset': [],
  'secrets:rotate': [],
  'backup:create': [],
  'backup:restore': ['<file|backupId>'],
  'ops:resume': [],
  'ops:cancel': [],
  'release:list': [],
  'release:rollback': [],
  'release:unpin': [],
  'catalog:reindex': [],
  'slims:import': [],
};

function usage(why: string): CliError {
  return new CliError('USAGE', why);
}

function isCommand(word: string): word is Command {
  return (COMMANDS as readonly string[]).includes(word);
}

/** The parsed command line `argv` (exported for the tests of its flags). @throws CliError `USAGE` */
export function parseArgs(argv: readonly string[]): Args {
  const [first, ...rest] = argv;
  if (first === undefined) throw usage('perintah tidak ada / no command given');
  const command: Command | undefined = first === '--help' || first === '-h' ? 'help' : isCommand(first) ? first : undefined;
  if (command === undefined) throw usage('perintah tidak dikenal / unknown command');

  const args: Args = {
    command,
    json: false,
    smoke: false,
    force: false,
    wipeDb: false,
    files: false,
    withoutFiles: false,
    slims: {},
    dryRun: false,
    allowNonEmpty: false,
    operands: [],
  };
  const expected = OPERANDS[command];
  let optionsEnded = false;
  for (let i = 0; i < rest.length; i += 1) {
    const token = rest[i]!;
    if (optionsEnded || !token.startsWith('--')) {
      // An operand (a username, a key, a value, possibly empty); after `--` even one that starts with `--`.
      if (args.operands.length >= expected.length) throw usage('argumen tidak dikenal / unexpected argument');
      args.operands.push(token);
      continue;
    }
    if (token === '--' && expected.length > 0) {
      optionsEnded = true;
      continue;
    }
    const [name, inline] = token.includes('=') ? [token.slice(0, token.indexOf('=')), token.slice(token.indexOf('=') + 1)] : [token, undefined];
    if (name === '--json' && inline === undefined) {
      args.json = true;
    } else if (!OPTIONS[command].includes(name)) {
      // An option name is shown (it is what the operator typed as one); any other word is not (it could be a value).
      throw usage(
        name.startsWith('--') && name.length <= 40 && /^--[a-z-]+$/.test(name)
          ? `opsi tidak dikenal / unknown option ${name}`
          : 'argumen tidak dikenal / unexpected argument',
      );
    } else if (name === '--smoke' && inline === undefined) {
      args.smoke = true;
    } else if (name === '--config') {
      const value = inline ?? rest[(i += 1)];
      if (value === undefined || value === '') throw usage('--config memerlukan path berkas / --config needs a file path');
      args.config = value;
    } else if (name === '--runtime') {
      const value = inline ?? rest[(i += 1)];
      const runtime = RUNTIMES.find((candidate) => candidate === value);
      if (runtime === undefined) {
        throw usage(`--runtime harus salah satu dari / --runtime must be one of ${RUNTIMES.join(', ')}`);
      }
      args.runtime = runtime;
    } else if (name === '--budget') {
      const value = inline ?? rest[(i += 1)];
      // Whole seconds, at most a day: a cron line runs it again anyway.
      if (value === undefined || !/^[1-9]\d{0,4}$/.test(value) || Number(value) > MAX_BUDGET_S) {
        throw usage(`--budget memerlukan detik bulat 1-${MAX_BUDGET_S} / --budget needs whole seconds 1-${MAX_BUDGET_S}`);
      }
      args.budget = Number(value);
    } else if (name === '--reason') {
      const value = inline ?? rest[(i += 1)];
      if (value === undefined || !reasonValid(value)) {
        throw usage(
          `--reason memerlukan teks 1-${REASON_MAX} karakter tanpa karakter kontrol / ` +
            `--reason needs a text of 1-${REASON_MAX} characters without control characters`,
        );
      }
      args.reason = value;
    } else if (name === '--force' && inline === undefined) {
      args.force = true;
    } else if (name === '--wipe-db' && inline === undefined) {
      args.wipeDb = true;
    } else if (name === '--files' && inline === undefined) {
      args.files = true;
    } else if (name === '--without-files' && inline === undefined) {
      args.withoutFiles = true;
    } else if (name === '--yes-external') {
      const value = inline ?? rest[(i += 1)];
      if (value === undefined || !libraryNameValid(value)) {
        throw usage(
          `--yes-external memerlukan nama perpustakaan ini (1-${LIBRARY_NAME_MAX} karakter) / ` +
            `--yes-external needs this library's name (1-${LIBRARY_NAME_MAX} characters)`,
        );
      }
      args.yesExternal = value;
    } else if (Object.hasOwn(SLIMS_VALUE_FLAGS, name)) {
      const value = inline ?? rest[(i += 1)];
      if (value === undefined || !slimsValueValid(value)) {
        throw usage(`${name} memerlukan nilai (1-${SLIMS_VALUE_MAX} karakter) / ${name} needs a value (1-${SLIMS_VALUE_MAX} characters)`);
      }
      args.slims[SLIMS_VALUE_FLAGS[name]!] = value;
    } else if (name === '--price-mode') {
      const value = inline ?? rest[(i += 1)];
      const mode = PRICE_MODES.find((candidate) => candidate === value);
      if (mode === undefined) throw usage(`--price-mode harus salah satu dari / --price-mode must be one of ${PRICE_MODES.join(', ')}`);
      args.slims.priceMode = mode;
    } else if (name === '--catalog-mode') {
      // ---- Komunitas K1 (catalogue re-sync) ----
      const value = inline ?? rest[(i += 1)];
      const mode = CATALOG_MODES.find((candidate) => candidate === value);
      if (mode === undefined) throw usage(`Nilai --catalog-mode tidak dikenal / Unknown --catalog-mode value (${CATALOG_MODES.join(', ')})`);
      args.slims.catalogMode = mode;
    } else if (name === '--skip-catalog' && inline === undefined) {
      args.slims.skipCatalog = true;
    } else if (name === '--from-run') {
      const value = inline ?? rest[(i += 1)];
      if (value === undefined || !isUlid(value)) throw usage('--from-run memerlukan id run (ULID) / --from-run needs a run id (ULID)');
      args.slims.fromRunId = value;
    } else if (name === '--dry-run' && inline === undefined) {
      args.dryRun = true;
    } else if (name === '--allow-non-empty' && inline === undefined) {
      args.allowNonEmpty = true;
    } else if (name === '--confirm-db') {
      const value = inline ?? rest[(i += 1)];
      if (value === undefined || value === '' || value.length > CONFIRM_MAX) {
        throw usage('--confirm-db memerlukan nama database / --confirm-db needs the database name');
      }
      args.confirmDb = value;
    } else {
      throw usage('argumen tidak dikenal / unexpected argument');
    }
  }
  if (args.confirmDb !== undefined && !args.wipeDb) {
    throw usage('--confirm-db hanya bersama --wipe-db / --confirm-db goes with --wipe-db only');
  }
  if (command === 'slims:import') checkSlimsSources(args.slims);
  if (command === 'install' && args.config === undefined) {
    throw usage('install memerlukan --config <file> / install needs --config <file>');
  }
  if (args.operands.length < expected.length) {
    throw usage(`${command} memerlukan / needs ${expected.join(' ')}`);
  }
  return args;
}

/** The longest `jobs:run --budget`: a day. */
const MAX_BUDGET_S = 86_400;

/** A `slims:import` value: 1 to 1024 characters, not blank, well formed, no control characters. */
function slimsValueValid(value: string): boolean {
  return value.trim() !== '' && Array.from(value).length <= SLIMS_VALUE_MAX && notWellFormed(value).length === 0 && !/\p{Cc}/u.test(value);
}

/** `slims:import` (§12.6): `--db` with `--user`, or `--dump`, never both; at most one of `--files-zip` and `--files-dir`. */
function checkSlimsSources(s: Args['slims']): void {
  const db = s.db !== undefined || s.user !== undefined;
  if (db && s.dump !== undefined) throw usage('pilih --db atau --dump, tidak keduanya / choose --db or --dump, not both');
  if (!db && s.dump === undefined) throw usage('slims:import memerlukan --db dan --user, atau --dump / slims:import needs --db and --user, or --dump');
  if (db && (s.db === undefined || s.user === undefined)) throw usage('--db dan --user dipakai bersama / --db and --user go together');
  if (s.filesZip !== undefined && s.filesDir !== undefined) {
    throw usage('pilih --files-zip atau --files-dir, tidak keduanya / choose --files-zip or --files-dir, not both');
  }
  // ---- Komunitas K1 (catalogue re-sync) ----
  // Skipping the catalogue stages is accepted only after a sync dry run that found nothing to change: the run names it.
  if (s.skipCatalog === true && s.fromRunId === undefined) {
    throw usage('--skip-catalog butuh --from-run <id uji coba sinkron> / --skip-catalog needs --from-run <sync dry run id>');
  }
}

/** A `--yes-external`: 1 to 191 characters (not blank), well formed, no control characters. */
function libraryNameValid(value: string): boolean {
  const length = Array.from(value).length;
  return length >= 1 && length <= LIBRARY_NAME_MAX && value.trim() !== '' && notWellFormed(value).length === 0 && !/\p{Cc}/u.test(value);
}

/** A `--reason`: 1 to 100 characters, well formed, no control characters (it ends up in the audit log). */
function reasonValid(value: string): boolean {
  const length = Array.from(value).length;
  return length >= 1 && length <= REASON_MAX && notWellFormed(value).length === 0 && !/\p{Cc}/u.test(value);
}

let guarded = false;

/** A closed stdout/stderr (`node app.js doctor | head -1`) emits 'error'; unhandled that would crash the process. */
function guardStreams(): void {
  if (guarded) return;
  guarded = true;
  process.stdout.on('error', () => {});
  process.stderr.on('error', () => {});
}

function processIo(
  io: Partial<CliIo>,
): CliIo & { nodeVersion: string; prompt: (question: string) => Promise<string | null>; promptSecret: (question: string) => Promise<string | null> } {
  if (io.stdout === undefined || io.stderr === undefined) guardStreams();
  return {
    env: io.env ?? process.env,
    stdout: io.stdout ?? ((text) => void process.stdout.write(text)),
    stderr: io.stderr ?? ((text) => void process.stderr.write(text)),
    nodeVersion: io.nodeVersion ?? process.versions.node,
    ...(io.rootKeys === undefined ? {} : { rootKeys: io.rootKeys }),
    ...(io.refuseDevKids === undefined ? {} : { refuseDevKids: io.refuseDevKids }),
    ...(io.hostPanels === undefined ? {} : { hostPanels: io.hostPanels }),
    prompt: io.prompt ?? ttyPrompt,
    promptSecret: io.promptSecret ?? ttySecretPrompt,
  };
}

/** The default {@link CliIo.prompt}: one line read from stdin, asked on stderr, when both are a terminal. */
async function ttyPrompt(question: string): Promise<string | null> {
  if (process.stdin.isTTY !== true || process.stderr.isTTY !== true) return null;
  const rl = readline.createInterface({ input: process.stdin, output: process.stderr });
  try {
    return await rl.question(question);
  } finally {
    rl.close();
  }
}

/**
 * The default {@link CliIo.promptSecret}: one line read from stdin, asked on stderr, when both are a terminal; what is
 * typed is not echoed (the question is written, then the output is muted until Enter).
 */
async function ttySecretPrompt(question: string): Promise<string | null> {
  if (process.stdin.isTTY !== true || process.stderr.isTTY !== true) return null;
  let muted = false;
  const output = new Writable({
    write(chunk: Buffer | string, _encoding, done) {
      if (!muted) process.stderr.write(chunk);
      done();
    },
  });
  const rl = readline.createInterface({ input: process.stdin, output, terminal: true });
  try {
    const answer = rl.question(question);
    muted = true;
    return await answer;
  } finally {
    rl.close();
    process.stderr.write('\n');
  }
}

function line(check: Check, name: string): string {
  return `  ${check.ok ? 'OK   ' : 'GAGAL'}  ${name.padEnd(11)} ${check.detail}`;
}

function printDoctor(report: DoctorReport, ctx: BootContext, io: CliIo): void {
  const lines = [`ALTIS doctor: ${ctx.release.version} (${ctx.runtime})`];
  for (const name of DOCTOR_CHECKS) lines.push(line(report.checks[name], name));
  if (report.smoke !== undefined) lines.push(line(report.smoke, 'smoke'));
  lines.push(report.ok ? 'Hasil / Result: semua baik / all good' : 'Hasil / Result: ada masalah (GAGAL) / problems found (GAGAL = failed)');
  io.stdout(`${lines.join('\n')}\n`);
}

function printFailure(command: string, failure: Failure, json: boolean, io: CliIo): void {
  if (json) {
    io.stdout(`${JSON.stringify({ ok: false, command, code: failure.code, detail: failure.detail })}\n`);
    return;
  }
  io.stderr(`GAGAL / FAILED [${failure.code}]${failure.detail === '' ? '' : `: ${failure.detail}`}\n`);
  if (failure.code === 'USAGE') io.stderr(`${USAGE}\n`);
}

/**
 * Runs one CLI command (bootloader contract v1). Never throws and never calls `process.exit`: every failure is
 * printed and turned into the exit code, and everything opened (database, server, locks) is closed before it returns.
 *
 * @param argv the words after `app.js`, e.g. `['install', '--config', 'input.json']`
 * @param io where output goes and what the commands read (tests pass their own); defaults to the process's
 * @returns the exit code: 0 ok, 1 failure, 2 already installed, 3 schema too new
 */
export async function runCli(argv: string[], ctx: BootContext, io: Partial<CliIo> = {}): Promise<number> {
  const cli = processIo(io);
  const json = argv.includes('--json');
  let args: Args;
  try {
    args = parseArgs(argv);
  } catch (error) {
    const failure = describeFailure(error);
    printFailure(argv[0] ?? '', failure, json, cli);
    return failure.exitCode;
  }

  try {
    switch (args.command) {
      case 'help':
        cli.stdout(`${USAGE}\n`);
        return EXIT.ok;
      case 'install': {
        const result = await install(args.config!, ctx, cli.env, cli.nodeVersion, { runtime: args.runtime, hostPanels: cli.hostPanels });
        // The input holds the first super admin's password in plain text, and nothing else removes it.
        if (args.json) {
          // 1c Task 27 (L51): `warnings` only when a check warned.
          const warned = result.warnings.length === 0 ? {} : { warnings: result.warnings };
          cli.stdout(`${JSON.stringify({ ok: true, command: 'install', resumed: result.resumed, deleteInput: args.config!, ...warned })}\n`);
        } else {
          // 1c Task 27 (L51): the wizard's warnings (WASM, RAM), as the web wizard shows them.
          for (const warning of result.warnings) cli.stderr(`PERINGATAN / WARNING: ${warning}\n`);
          cli.stdout(
            `Instalasi selesai / Install complete${result.resumed ? ' (dilanjutkan / resumed)' : ''}.\n` +
              `Hapus berkas ${args.config!} sekarang: isinya memuat sandi super admin pertama.\n` +
              `Delete ${args.config!} now: it holds the first super admin's password.\n` +
              'Mulai ulang aplikasi, lalu periksa / Restart the app, then check: node app.js doctor --smoke\n',
          );
        }
        return EXIT.ok;
      }
      case 'migrate': {
        const outcome = await migrate(ctx, cli.env);
        cli.stdout(args.json ? `${JSON.stringify({ ok: true, command: 'migrate', ...outcome })}\n` : `${describeOutcome(outcome)}\n`);
        return EXIT.ok;
      }
      case 'doctor': {
        const report = await doctor(ctx, cli.env, {
          nodeVersion: cli.nodeVersion,
          smoke: args.smoke,
          ...(cli.rootKeys === undefined ? {} : { rootKeys: cli.rootKeys }),
          ...(cli.refuseDevKids === undefined ? {} : { refuseDevKids: cli.refuseDevKids }),
        });
        if (args.json) cli.stdout(`${JSON.stringify({ ok: report.ok, command: 'doctor', checks: report.checks, smoke: report.smoke })}\n`);
        else printDoctor(report, ctx, cli);
        return report.ok ? EXIT.ok : EXIT.failure;
      }
      case 'user:reset-password': {
        // The one secret the CLI prints, once (spec §7.1 emergency recovery; D23).
        const { temporaryPassword } = await resetUserPassword(ctx, cli.env, args.operands[0]!);
        if (args.json) {
          cli.stdout(`${JSON.stringify({ ok: true, command: 'user:reset-password', temporaryPassword })}\n`);
        } else {
          cli.stdout(
            `Kata sandi sementara / Temporary password: ${temporaryPassword}\n` +
              'Berikan kepada pengguna; wajib diganti saat login berikutnya. Semua sesinya telah diakhiri. / ' +
              'Hand it to the user; it must be changed at the next sign-in. All of their sessions were ended.\n',
          );
        }
        return EXIT.ok;
      }
      case 'user:disable-2fa': {
        await disableUserTotp(ctx, cli.env, args.operands[0]!);
        cli.stdout(
          args.json
            ? `${JSON.stringify({ ok: true, command: 'user:disable-2fa' })}\n`
            : '2FA pengguna dinonaktifkan dan semua sesinya diakhiri; bila 2FA diwajibkan, pengguna mendaftar ulang saat login ' +
                'berikutnya. / The user\'s 2FA was turned off and all of their sessions were ended; if 2FA is required, the ' +
                'user enrols again at the next sign-in.\n',
        );
        return EXIT.ok;
      }
      case 'jobs:run': {
        const result = await jobsRun(ctx, cli.env, { budgetS: args.budget ?? JOBS_RUN_DEFAULT_S });
        if (args.json) {
          const fields = result.installed ? { passes: result.passes, slices: result.slices } : { installed: false };
          cli.stdout(`${JSON.stringify({ ok: true, command: 'jobs:run', ...fields })}\n`);
        } else {
          cli.stdout(`${describeJobsRun(result)}\n`);
        }
        return EXIT.ok;
      }
      case 'maintenance:on': {
        const result = await maintenanceOn(ctx, cli.env, args.reason ?? null);
        cli.stdout(args.json ? `${JSON.stringify({ ok: true, command: 'maintenance:on', ...result })}\n` : `${describeOn(result)}\n`);
        return EXIT.ok;
      }
      case 'maintenance:off': {
        const result = await maintenanceOff(ctx, cli.env, args.force);
        cli.stdout(args.json ? `${JSON.stringify({ ok: true, command: 'maintenance:off', ...result })}\n` : `${describeOff(result)}\n`);
        return EXIT.ok;
      }
      case 'install:reset': {
        const result = await installReset(ctx, cli.env, { wipeDb: args.wipeDb, confirmDb: args.confirmDb, prompt: cli.prompt });
        cli.stdout(args.json ? `${JSON.stringify({ ok: true, command: 'install:reset', ...result })}\n` : `${describeReset(result)}\n`);
        return EXIT.ok;
      }
      case 'secrets:rotate': {
        const result = await secretsRotate(ctx, cli.env);
        cli.stdout(args.json ? `${JSON.stringify({ ok: true, command: 'secrets:rotate', ...result })}\n` : `${describeRotate(result)}\n`);
        return EXIT.ok;
      }
      case 'backup:create': {
        const result = await backupCreate(ctx, cli.env, { files: args.files });
        cli.stdout(
          args.json
            ? `${JSON.stringify({ ok: true, command: 'backup:create', backupId: result.backupId })}\n`
            : `${describeBackupCreate(result)}\n`,
        );
        return EXIT.ok;
      }
      case 'backup:restore': {
        const result = await backupRestore(ctx, cli.env, {
          target: args.operands[0]!,
          withoutFiles: args.withoutFiles,
          ...(args.yesExternal === undefined ? {} : { yesExternal: args.yesExternal }),
          promptSecret: cli.promptSecret,
          ...(args.json ? {} : { onStatus: (status) => cli.stdout(`${describeRestoreStatus(status)}\n`) }),
        });
        cli.stdout(
          args.json
            ? `${JSON.stringify({ ok: true, command: 'backup:restore', backupId: result.backupId, opId: result.opId, state: result.state })}\n`
            : `${describeBackupRestore(result)}\n`,
        );
        return EXIT.ok;
      }
      case 'ops:resume': {
        // Final review (OPS-ATTN-EXIT): the CLI way out of an op that needs attention.
        const result = await opsResume(ctx, cli.env);
        cli.stdout(args.json ? `${JSON.stringify({ ok: true, command: 'ops:resume', ...result })}\n` : `${describeResume(result)}\n`);
        return EXIT.ok;
      }
      case 'ops:cancel': {
        const result = await opsCancel(ctx, cli.env);
        cli.stdout(args.json ? `${JSON.stringify({ ok: true, command: 'ops:cancel', ...result })}\n` : `${describeCancel(result)}\n`);
        return EXIT.ok;
      }
      // 1d Task 26: the releases (spec §9.7, §13.6; D1d-33).
      case 'release:list': {
        const result = await releaseList(ctx, cli.env);
        cli.stdout(args.json ? `${JSON.stringify({ ok: true, command: 'release:list', ...result })}\n` : `${describeReleaseList(result)}\n`);
        return EXIT.ok;
      }
      case 'release:rollback': {
        let told = false;
        const onWait = (): void => {
          if (told || args.json) return;
          told = true;
          cli.stderr(
            'Menunggu proses yang sedang mem-boot rilis tertunda (paling lama 15 menit) / ' +
              'Waiting for the process booting the pending release (at most 15 minutes)\n',
          );
        };
        const result = await releaseRollback(ctx, cli.env, { force: args.force, onWait });
        cli.stdout(args.json ? `${JSON.stringify({ ok: true, command: 'release:rollback', ...result })}\n` : `${describeReleaseRollback(result)}\n`);
        return EXIT.ok;
      }
      case 'release:unpin': {
        const result = await releaseUnpin(ctx, cli.env);
        cli.stdout(args.json ? `${JSON.stringify({ ok: true, command: 'release:unpin', ...result })}\n` : `${describeReleaseUnpin(result)}\n`);
        return EXIT.ok;
      }
      // ---- Phase 2 (catalog): Task 3 ----
      case 'catalog:reindex': {
        const result = await catalogReindex(ctx, cli.env, args.json ? {} : { onProgress: (text) => cli.stdout(`${text}\n`) });
        cli.stdout(args.json ? `${JSON.stringify({ ok: true, command: 'catalog:reindex', ...result })}\n` : `${describeCatalogReindex(result)}\n`);
        return EXIT.ok;
      }
      case 'slims:import': {
        const result = await slimsImport(ctx, cli.env, {
          ...args.slims,
          dryRun: args.dryRun,
          allowNonEmpty: args.allowNonEmpty,
          promptSecret: cli.promptSecret,
          prompt: cli.prompt,
          ...(args.json ? {} : { onProgress: (text: string) => cli.stdout(`${text}\n`) }),
        });
        cli.stdout(args.json ? `${JSON.stringify({ ok: true, command: 'slims:import', ...result })}\n` : `${describeSlimsImport(result)}\n`);
        return EXIT.ok;
      }
      case 'config:set': {
        const result = await configSet(ctx, cli.env, args.operands[0]!, args.operands[1]!);
        if (args.json) {
          cli.stdout(`${JSON.stringify({ ok: true, command: 'config:set', ...result })}\n`);
        } else {
          cli.stdout(
            `config.json diperbarui: ${result.key}; server yang berjalan memakainya dalam beberapa detik. / ` +
              `config.json updated: ${result.key}; a running server picks it up within seconds.\n`,
          );
          if (result.shadowedBy !== undefined) cli.stderr(`${shadowNote(result.key, result.shadowedBy)}\n`);
          if (result.warning !== undefined) cli.stderr(`${result.warning}\n`);
        }
        return EXIT.ok;
      }
    }
  } catch (error) {
    const failure = describeFailure(error);
    printFailure(args.command, failure, args.json, cli);
    return failure.exitCode;
  }
}
