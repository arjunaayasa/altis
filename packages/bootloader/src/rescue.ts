import { HEALTH_PATH, PAGE_STYLE, openFront, pathOf, sendPage, type Front, type RequestHandler } from './front.js';
import type { BootLog } from './log.js';
import { MIN_NODE_TEXT } from './node-version.js';

// The rescue page (spec §9.2 step 1): when app.js cannot start a release, it still answers HTTP, so the operator
// sees what is wrong instead of a hosting error page. It is a handler of the process's one http.Server (front.ts,
// P2, ruling R64): put in place of whatever served before, or on a server opened for it when the failure came before
// app.js listened. Every path answers 503 with `Retry-After: 30` and a bilingual page (Indonesian first);
// `/_health` answers 503 JSON `{status:'rescue', reason}`.
//
// The pages name the reason code and the fix, never a stack trace, path, host name or configuration value: they are
// public. The details go to the log on stderr.
//
// Loaded before the Node check (ruling R56): it must run on Node 10, and uses no API newer than that.

export type RescueReason =
  | 'NODE_TOO_OLD'
  | 'DATA_DIR_UNWRITABLE'
  | 'DOCROOT_EXPOSED'
  | 'STATE_CORRUPT'
  | 'CONFIG_CORRUPT'
  | 'RELEASE_INVALID'
  | 'START_FAILED';

export const RESCUE_REASONS: readonly RescueReason[] = [
  'NODE_TOO_OLD',
  'DATA_DIR_UNWRITABLE',
  'DOCROOT_EXPOSED',
  'STATE_CORRUPT',
  'CONFIG_CORRUPT',
  'RELEASE_INVALID',
  'START_FAILED',
];

export const RETRY_AFTER_SECONDS = 30;
export const DEFAULT_PORT = 3000;

interface Text {
  /** One sentence: what is wrong. */
  problem: string;
  /** What to do, in order. */
  steps: string[];
}

interface Explanation {
  id: Text;
  en: Text;
}

const LOG_STEP_ID = 'Rinciannya tercatat di log aplikasi (stderr; di cPanel: log aplikasi Node.js).';
const LOG_STEP_EN = 'The details are in the application log (stderr; in cPanel: the Node.js application log).';

const EXPLANATIONS: Record<RescueReason, Explanation> = {
  NODE_TOO_OLD: {
    id: {
      problem: 'Versi Node.js yang dipilih terlalu lama. ALTIS memerlukan Node ' + MIN_NODE_TEXT + ' atau yang lebih baru.',
      steps: [
        'Di cPanel: buka menu Setup Node.js App, pilih aplikasi ALTIS, ganti Node.js version ke ' +
          MIN_NODE_TEXT +
          ' atau yang lebih baru (misalnya 22 atau 24), simpan, lalu klik Restart.',
        'Di aaPanel: buka Website, lalu Node Project, ganti versi Node ke ' + MIN_NODE_TEXT + ' atau yang lebih baru, lalu mulai ulang proyek.',
        'Di server sendiri: pasang Node.js ' + MIN_NODE_TEXT + ' atau yang lebih baru (LTS 22 atau 24).',
      ],
    },
    en: {
      problem: 'The selected Node.js version is too old. ALTIS needs Node ' + MIN_NODE_TEXT + ' or newer.',
      steps: [
        'In cPanel: open Setup Node.js App, select the ALTIS application, change the Node.js version to ' +
          MIN_NODE_TEXT +
          ' or newer (for example 22 or 24), save, then click Restart.',
        'In aaPanel: open Website, then Node Project, change the Node version to ' + MIN_NODE_TEXT + ' or newer, then restart the project.',
        'On your own server: install Node.js ' + MIN_NODE_TEXT + ' or newer (LTS 22 or 24).',
      ],
    },
  },
  DATA_DIR_UNWRITABLE: {
    id: {
      problem: 'Folder data ALTIS (DATA_DIR) tidak dapat dibuat atau ditulis oleh aplikasi.',
      steps: [
        'Pastikan folder data dimiliki akun yang menjalankan ALTIS dan boleh ditulis olehnya.',
        'Untuk memakai folder lain, setel variabel lingkungan ALTIS_DATA_DIR, atau tulis path folder itu di berkas altis-data-dir.txt di samping app.js. Folder data harus berada di luar public_html.',
        LOG_STEP_ID,
      ],
    },
    en: {
      problem: 'The ALTIS data folder (DATA_DIR) cannot be created or written by the application.',
      steps: [
        'Make sure the data folder belongs to the account that runs ALTIS and that this account may write to it.',
        'To use another folder, set the ALTIS_DATA_DIR environment variable, or write its path into altis-data-dir.txt next to app.js. The data folder must be outside public_html.',
        LOG_STEP_EN,
      ],
    },
  },
  DOCROOT_EXPOSED: {
    id: {
      problem:
        'Folder aplikasi atau folder data ALTIS berada di dalam folder yang disajikan web server (document root, misalnya public_html), atau folder data berada di dalam folder aplikasi. Siapa saja bisa mengunduh berkas rahasianya, jadi ALTIS menolak berjalan.',
      steps: [
        'Pindahkan folder aplikasi ke luar public_html, misalnya ke ~/altis/app.',
        'Pindahkan folder data ke luar public_html dan ke luar folder aplikasi, misalnya ke ~/altis-data, lalu tunjuk lewat ALTIS_DATA_DIR atau altis-data-dir.txt.',
        'Pemeriksaan ini tidak dapat dilewati.',
      ],
    },
    en: {
      problem:
        'The ALTIS application folder or data folder is inside a folder that the web server publishes (the document root, such as public_html), or the data folder is inside the application folder. Anybody could download its secret files, so ALTIS refuses to run.',
      steps: [
        'Move the application folder out of public_html, for example to ~/altis/app.',
        'Move the data folder out of public_html and out of the application folder, for example to ~/altis-data, and point to it with ALTIS_DATA_DIR or altis-data-dir.txt.',
        'This check cannot be skipped.',
      ],
    },
  },
  STATE_CORRUPT: {
    id: {
      problem:
        'Berkas status rilis ALTIS di folder data (folder releases) rusak, dan salinan cadangannya (.bak) juga tidak dapat dipakai. ALTIS tidak akan menebak rilis mana yang harus dijalankan.',
      steps: ['Pulihkan folder releases di folder data dari cadangan.', 'Bila tidak ada cadangan, laporkan di github.com/arjunaayasa/altis/issues.', LOG_STEP_ID],
    },
    en: {
      problem:
        'An ALTIS release state file in the data folder (the releases folder) is corrupt, and its backup copy (.bak) cannot be used either. ALTIS will not guess which release to run.',
      steps: ['Restore the releases folder in the data folder from a backup.', 'If there is no backup, report it at github.com/arjunaayasa/altis/issues.', LOG_STEP_EN],
    },
  },
  CONFIG_CORRUPT: {
    id: {
      problem:
        'Berkas konfigurasi ALTIS (config.json di folder data) rusak, dan salinan cadangannya (config.json.bak) juga tidak dapat dipakai. Tanpa berkas ini ALTIS tidak tahu database dan kunci rahasia instalasinya.',
      steps: [
        'Pulihkan config.json di folder data dari cadangan. Berkas ini memuat kunci rahasia instalasi, jadi gunakan cadangan dari instalasi yang sama.',
        'Jalankan node app.js doctor di terminal untuk memeriksa konfigurasi.',
        'Bila tidak ada cadangan, laporkan di github.com/arjunaayasa/altis/issues.',
        LOG_STEP_ID,
      ],
    },
    en: {
      problem:
        'The ALTIS configuration file (config.json in the data folder) is corrupt, and its backup copy (config.json.bak) cannot be used either. Without it ALTIS does not know its database or the secret keys of this installation.',
      steps: [
        'Restore config.json in the data folder from a backup. It holds the secret keys of the installation, so use a backup of this same installation.',
        'Run node app.js doctor in a terminal to check the configuration.',
        'If there is no backup, report it at github.com/arjunaayasa/altis/issues.',
        LOG_STEP_EN,
      ],
    },
  },
  RELEASE_INVALID: {
    id: {
      problem:
        'Berkas rilis ALTIS tidak lolos pemeriksaan tanda tangan atau keutuhan, jadi tidak dijalankan. Berkas mungkin rusak saat diunggah atau telah diubah.',
      steps: [
        'Unggah ulang paket zip ALTIS yang asli, lalu ekstrak seluruh isinya lagi.',
        'Jangan mengubah berkas di dalam folder bundled-release atau releases.',
        LOG_STEP_ID,
      ],
    },
    en: {
      problem:
        'The ALTIS release files failed the signature or integrity check, so they were not run. They may have been damaged during upload or changed.',
      steps: [
        'Upload the original ALTIS zip package again and extract all of it again.',
        'Do not change the files in the bundled-release or releases folders.',
        LOG_STEP_EN,
      ],
    },
  },
  START_FAILED: {
    id: {
      problem: 'Rilis ALTIS gagal dijalankan, dan tidak ada rilis sebelumnya yang aman untuk dipakai.',
      steps: [
        'Periksa log aplikasi (stderr, dan logs/altis.log di folder data).',
        'Jalankan node app.js doctor di terminal untuk memeriksa konfigurasi.',
        'Bila masalah berlanjut, laporkan di github.com/arjunaayasa/altis/issues.',
      ],
    },
    en: {
      problem: 'The ALTIS release failed to start, and there is no earlier release that is safe to use.',
      steps: [
        'Check the application log (stderr, and logs/altis.log in the data folder).',
        'Run node app.js doctor in a terminal to check the configuration.',
        'If the problem persists, report it at github.com/arjunaayasa/altis/issues.',
      ],
    },
  },
};

function section(lang: 'id' | 'en', text: Text): string {
  const heading = lang === 'id' ? 'ALTIS belum dapat berjalan' : 'ALTIS cannot run yet';
  const fix = lang === 'id' ? 'Cara memperbaiki' : 'How to fix it';
  const after = lang === 'id' ? 'Setelah diperbaiki, mulai ulang aplikasi.' : 'Once fixed, restart the application.';
  let items = '';
  for (let i = 0; i < text.steps.length; i += 1) items += '<li>' + text.steps[i] + '</li>';
  return (
    '<section lang="' + lang + '"><h1>' + heading + '</h1><p>' + text.problem + '</p><h2>' + fix + '</h2><ol>' + items + '</ol><p>' + after + '</p></section>'
  );
}

/** The bilingual rescue page for `reason` (static text; nothing about this installation). */
export function rescueHtml(reason: RescueReason): string {
  const text = EXPLANATIONS[reason];
  return (
    '<!doctype html><html lang="id"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">' +
    '<meta name="robots" content="noindex"><title>ALTIS: mode penyelamatan / rescue mode</title><style>' +
    PAGE_STYLE +
    '</style></head><body>' +
    section('id', text.id) +
    '<hr>' +
    section('en', text.en) +
    '<p class="code">Kode / Code: ' +
    reason +
    '</p></body></html>'
  );
}

/** Two lines for stderr: the problem in Indonesian and in English, with the reason code. */
export function rescueSummary(reason: RescueReason): string {
  const text = EXPLANATIONS[reason];
  return 'ALTIS (' + reason + '): ' + text.id.problem + '\nALTIS (' + reason + '): ' + text.en.problem + '\n';
}

/** One line: the problem in Indonesian / in English (no path, host or value: the same text as the page). */
export function rescueDetail(reason: RescueReason): string {
  const text = EXPLANATIONS[reason];
  return text.id.problem + ' / ' + text.en.problem;
}

/** A command asked for JSON output (`--json` among its arguments). */
export function wantsJson(argv: readonly string[] | null): boolean {
  return argv !== null && argv.indexOf('--json') !== -1;
}

/**
 * runCli's contract for `--json` (apps/server cli/index.ts) is exactly one JSON line on stdout, failures included.
 * When app.js itself fails before runCli runs (Node too old, DATA_DIR, docroot, release state or verification; never
 * an invalid port, which does not stop a command, L52), this prints that line: `{ok: false, command, code, reason,
 * detail}`, with `code` and `reason` both the failure's code (the rescue reason, as `/_health` names it) and `detail`
 * the bilingual one-line text. The caller still exits with code 1, after the bilingual message on stderr.
 */
export function printJsonFailure(argv: readonly string[], code: string, detail: string): void {
  const command = argv.length > 0 && argv[0] !== '--json' ? argv[0] : '';
  try {
    process.stdout.write(JSON.stringify({ ok: false, command: command, code: code, reason: code, detail: detail }) + '\n');
  } catch {
    // stdout closed: the message on stderr and the exit code remain
  }
}

/** Steps for stderr, both languages. */
export function rescueSteps(reason: RescueReason): string {
  const text = EXPLANATIONS[reason];
  let out = '';
  for (let i = 0; i < text.id.steps.length; i += 1) out += '  - ' + text.id.steps[i] + '\n';
  for (let i = 0; i < text.en.steps.length; i += 1) out += '  - ' + text.en.steps[i] + '\n';
  return out;
}

/** The bilingual message for a port that another program holds (P2). */
export function portInUseMessage(port: number): string {
  return (
    'ALTIS: port ' +
    port +
    ' sedang dipakai oleh program lain. Hentikan program itu, atau pilih port lain lewat variabel lingkungan ALTIS_PORT atau perintah `node app.js config:set port <nomor>`.\n' +
    'ALTIS: port ' +
    port +
    ' is in use by another program. Stop that program, or choose another port with the ALTIS_PORT environment variable or `node app.js config:set port <number>`.\n'
  );
}

/** The bilingual message for any other error of `listen()` (a privileged port, say). */
export function listenFailedMessage(port: number, code: string): string {
  return (
    'ALTIS: tidak dapat mendengarkan di port ' +
    port +
    ' (' +
    code +
    '). Pilih port lain lewat variabel lingkungan ALTIS_PORT.\n' +
    'ALTIS: cannot listen on port ' +
    port +
    ' (' +
    code +
    '). Choose another port with the ALTIS_PORT environment variable.\n'
  );
}

/** The `code` of an error or of any error in its cause chain, or ''. */
export function errorCode(error: unknown): string {
  let current = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string') return code;
    current = (current as { cause?: unknown }).cause;
  }
  return '';
}

/**
 * The exit code of a supervised child (runtime `standalone`) that a restart cannot help: its port is in use or
 * cannot be used (EX_CONFIG of sysexits.h). The supervisor sees it in the child's exit code, with no message to
 * race against the exit, and stops with exit code 1 instead of restarting.
 */
export const FATAL_EXIT_CODE = 78;

/** This process is the child of app.js's standalone supervisor (forked with ALTIS_SUPERVISED=1 and an IPC channel). */
function isSupervisedChild(): boolean {
  return process.env['ALTIS_SUPERVISED'] === '1' && typeof process.send === 'function';
}

/**
 * Writes `message` to stderr and exits with `code` once stdout and stderr have been flushed (a pipe may be
 * asynchronous). `fatal`: a restart would fail the same way; a supervised child then exits with FATAL_EXIT_CODE.
 */
export function exitWith(code: number, message: string, fatal?: boolean): void {
  const exitCode = fatal === true && isSupervisedChild() ? FATAL_EXIT_CODE : code;
  if (message !== '') process.stderr.write(message);
  process.stdout.write('', () => {
    process.stderr.write('', () => process.exit(exitCode));
  });
}

/**
 * The port for a rescue page shown before anything else could be loaded (Node too old): `ALTIS_PORT`, then
 * `PORT`, then 3000. config.json is not read here (it needs code that is loaded after the check). A value that
 * is set but not a port gives null.
 */
export function earlyPort(env: Readonly<Record<string, string | undefined>>): number | null {
  const names = ['ALTIS_PORT', 'PORT'];
  for (let i = 0; i < names.length; i += 1) {
    const raw = env[names[i] as string];
    if (typeof raw !== 'string' || raw.trim() === '') continue;
    const text = raw.trim();
    const port = /^\d{1,5}$/.test(text) ? parseInt(text, 10) : -1;
    return port >= 1 && port <= 65535 ? port : null;
  }
  return DEFAULT_PORT;
}

/** The rescue page for `reason` as a request handler: 503 and `Retry-After: 30` on every path. */
export function rescueHandler(reason: RescueReason): RequestHandler {
  const html = rescueHtml(reason);
  const health = JSON.stringify({ status: 'rescue', reason: reason });
  const retryAfter = { 'Retry-After': String(RETRY_AFTER_SECONDS) };
  return function (req, res) {
    req.resume();
    if (pathOf(req) === HEALTH_PATH) sendPage(res, req.method, 503, 'application/json; charset=utf-8', health, retryAfter);
    else sendPage(res, req.method, 503, 'text/html; charset=utf-8', html, retryAfter);
  };
}

/** The bilingual message for a listen() that failed with `error`: the port is in use, or cannot be used. */
export function listenErrorMessage(port: number, error: unknown): string {
  const code = errorCode(error);
  return code === 'EADDRINUSE' ? portInUseMessage(port) : listenFailedMessage(port, code === '' ? 'error' : code);
}

/**
 * Opens the process's one http.Server on `port` for a failure that came before app.js listened, and serves the
 * rescue page for `reason` on it until the process is stopped. When the port cannot be bound, the bilingual message
 * goes to stderr and the process exits with 1 (P2): there is nowhere else to show it.
 */
export function serveRescue(reason: RescueReason, port: number, log?: BootLog): Front {
  const front = openFront(port, log);
  void front.use(rescueHandler(reason));
  front.listening.then(undefined, function (error: unknown) {
    exitWith(1, listenErrorMessage(port, error), true);
  });
  return front;
}
