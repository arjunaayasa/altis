#!/usr/bin/env tsx
import { spawn } from 'node:child_process';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { parseArgs } from 'node:util';

// The Docker image check (spec §9.11 "CI memastikan image tidak memuat `.env`, `.git`, maupun *source map*"; 1d Task
// 32, L58/L59), run nightly against the image built from the release zip:
//
//   pnpm exec tsx tools/release/smoke/docker-image-check.ts --image <tag>
//
// 1. Forbidden files. Every regular file of the image's own file system is listed with
//      docker run --rm --network none --user 0 --entrypoint sh <tag> -c 'find / -xdev -type f'
//    (as root, so that no folder is skipped for want of permission; -xdev keeps to the image's layers: no /proc, /sys
//    or volume) and any forbidden path fails the check (forbiddenImagePaths: a `.env` or `.env.<name>` file, anything
//    in or named `.git`, a `*.map` source map). The listing must show /app/app.js, else it did not list this image.
// 2. Non-root. The image's USER (`docker image inspect`) must not be root (empty, `root` or uid 0).
// 3. Nothing written in appRoot. As the image's user: no file or folder under /app that this user could change, i.e.
//    every one owned by root:root and not world-writable (APP_ROOT_CHECK lists the others; symbolic links are skipped,
//    their own mode means nothing).
//
// The read-only root file system and the /data and /tmp exceptions are compose.yml's (`read_only: true`, the tmpfs,
// the volume), checked by the Docker smoke run, not by the image.
//
// Exit 0 when every check passes, 1 when one fails (each failure on stderr), 2 for a usage error. Nothing else is
// printed but a one-line summary on stdout.

/** The listing command of check 1, run by `sh -c` in the image. */
export const LIST_FILES = 'find / -xdev -type f';

/** Check 3: what under /app the image's user is not kept from changing (not root:root, or world-writable). */
export const APP_ROOT_CHECK = 'find /app ! -type l \\( ! -user 0 -o ! -group 0 -o -perm -0002 \\) -print';

/** The file the listing must show: the image holds the release zip at /app (docker/Dockerfile). */
export const APP_ENTRY = '/app/app.js';

const COMMAND_TIMEOUT_MS = 180_000;
const SHOWN_MAX = 50;

/** The last segment of an image path. */
function baseName(p: string): string {
  const at = p.lastIndexOf('/');
  return at === -1 ? p : p.slice(at + 1);
}

/** A `.env` file or one of its variants (`.env.production`, `.env.local`, …): secrets by convention. */
function isEnvFile(name: string): boolean {
  return name === '.env' || name.startsWith('.env.');
}

/** A git repository, a file inside one, or a `.git` file (the link of a worktree or a submodule). */
function isGitPath(p: string): boolean {
  return p.split('/').includes('.git');
}

/** A source map: `<something>.map`. */
function isSourceMap(name: string): boolean {
  return name.length > '.map'.length && name.endsWith('.map');
}

/**
 * The paths of `paths` (absolute image paths, one per entry; blank entries ignored) the image must not hold, in their
 * order: `.env` (and `.env.<name>`), anything in or named `.git`, and `*.map`.
 */
export function forbiddenImagePaths(paths: readonly string[]): string[] {
  return paths.filter((p) => {
    if (p.trim() === '') return false;
    const name = baseName(p);
    return isEnvFile(name) || isGitPath(p) || isSourceMap(name);
  });
}

/** Whether a Dockerfile USER (as `docker image inspect` gives `.Config.User`) means root: empty, `root` or uid 0. */
export function isRootUser(user: string): boolean {
  const name = user.trim().split(':')[0] ?? '';
  return name === '' || name === 'root' || name === '0';
}

export interface ImageCheckOptions {
  image: string;
}

/** A tag, digest or image id; never something `docker` would read as an option. */
const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._/:@-]{0,254}$/;

/** @throws Error `USAGE: …` */
export function parseImageCheckArgs(argv: string[]): ImageCheckOptions {
  let values: { image?: string | undefined };
  try {
    ({ values } = parseArgs({ args: argv, options: { image: { type: 'string' } }, strict: true, allowPositionals: false }));
  } catch (error) {
    throw new Error(`USAGE: ${error instanceof Error ? error.message : String(error)}`, { cause: error });
  }
  const image = values.image;
  if (image === undefined || !IMAGE_REF.test(image)) throw new Error('USAGE: --image <tag> is required (a tag, digest or image id)');
  return { image };
}

export interface DockerResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

/** Runs `docker <args>` to the end (no shell). */
export type DockerExec = (args: readonly string[]) => Promise<DockerResult>;

export interface ImageCheckResult {
  ok: boolean;
  /** The image's USER, as inspected ('' when it could not be read). */
  user: string;
  /** How many files the listing showed. */
  files: number;
  forbidden: string[];
  /** One line per failed check. */
  failures: string[];
}

function lines(text: string): string[] {
  return text.split('\n').filter((line) => line.trim() !== '');
}

function dockerFailure(what: string, result: DockerResult): string {
  const why = result.stderr.trim().split('\n').slice(-3).join(' / ') || `exit ${String(result.code)}`;
  return `${what}: docker failed: ${why}`;
}

function shown(paths: readonly string[]): string {
  return paths.slice(0, SHOWN_MAX).join(', ') + (paths.length > SHOWN_MAX ? `, … (${paths.length} in all)` : '');
}

/** The three checks of `image` through `docker`. Never throws for a failed check: that is in the result. */
export async function checkImage(image: string, docker: DockerExec): Promise<ImageCheckResult> {
  const failures: string[] = [];

  let user = '';
  const inspected = await docker(['image', 'inspect', '--format', '{{.Config.User}}', image]);
  if (inspected.code !== 0) failures.push(dockerFailure('user', inspected));
  else {
    user = inspected.stdout.trim();
    if (isRootUser(user)) failures.push(`user: the image runs as root (USER ${JSON.stringify(user)}); it must run as a non-root user (spec §9.11)`);
  }

  let files: string[] = [];
  let forbidden: string[] = [];
  const listed = await docker(['run', '--rm', '--network', 'none', '--user', '0', '--entrypoint', 'sh', image, '-c', LIST_FILES]);
  if (listed.code !== 0) failures.push(dockerFailure('files', listed));
  else {
    files = lines(listed.stdout);
    forbidden = forbiddenImagePaths(files);
    if (!files.includes(APP_ENTRY)) failures.push(`files: the listing does not show ${APP_ENTRY}; it is not the ALTIS image, or find did not run`);
    if (forbidden.length > 0) failures.push(`files: forbidden in the image (.env, .git, source maps; spec §9.11): ${shown(forbidden)}`);
  }

  const writable = await docker(['run', '--rm', '--network', 'none', '--entrypoint', 'sh', image, '-c', APP_ROOT_CHECK]);
  if (writable.code !== 0) failures.push(dockerFailure('appRoot', writable));
  else {
    const found = lines(writable.stdout);
    if (found.length > 0) failures.push(`appRoot: not root:root, or world-writable, under /app (nothing may be written there; spec §9.11): ${shown(found)}`);
  }

  return { ok: failures.length === 0, user, files: files.length, forbidden, failures };
}

/** `docker` on this machine, with a time limit; output kept in memory (a file listing is a few MB at most). */
export const runDocker: DockerExec = (args) =>
  new Promise((resolve, reject) => {
    const child = spawn('docker', [...args], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding('utf8').on('data', (chunk: string) => (stderr += chunk));
    const timer = setTimeout(() => {
      child.kill('SIGKILL');
      reject(new Error(`docker ${args.slice(0, 2).join(' ')}: no result after ${COMMAND_TIMEOUT_MS} ms`));
    }, COMMAND_TIMEOUT_MS);
    child.once('error', (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
  });

async function main(argv: string[]): Promise<number> {
  let options: ImageCheckOptions;
  try {
    options = parseImageCheckArgs(argv);
  } catch (error) {
    process.stderr.write(`docker-image-check: ${error instanceof Error ? error.message : String(error)}\n`);
    process.stderr.write('usage: tsx tools/release/smoke/docker-image-check.ts --image <tag>\n');
    return 2;
  }
  const result = await checkImage(options.image, runDocker);
  for (const failure of result.failures) process.stderr.write(`docker-image-check: FAILED: ${failure}\n`);
  process.stdout.write(
    `docker-image-check: ${options.image}: ${result.ok ? 'ok' : 'FAILED'} (user ${JSON.stringify(result.user)}, ${result.files} files, ` +
      `${result.forbidden.length} forbidden)\n`,
  );
  return result.ok ? 0 : 1;
}

if (process.argv[1] !== undefined && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main(process.argv.slice(2)).then(
    (code) => process.stderr.write('', () => process.exit(code)),
    (error: unknown) => {
      process.stderr.write(`docker-image-check: ${error instanceof Error ? (error.stack ?? error.message) : String(error)}\n`);
      process.stderr.write('', () => process.exit(1));
    },
  );
}
