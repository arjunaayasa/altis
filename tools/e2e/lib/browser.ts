import fs from 'node:fs';
import path from 'node:path';

// Which Chromium the E2E suite drives (playwright.config.ts):
//
// - by default Playwright's own build of its pinned version (CI: `pnpm --filter @altis/e2e exec playwright install
//   --with-deps chromium` in the nightly `e2e` job);
// - ALTIS_E2E_EXECUTABLE=<absolute path>: a Chromium-based browser already on the machine (a Chrome for Testing or
//   headless shell left by another Playwright version, Chromium, Brave, ...), for a developer who cannot or should not
//   download Playwright's build;
// - ALTIS_E2E_CHANNEL=<channel>: an installed Google Chrome or Microsoft Edge, by Playwright's channel name.
//
// Only Chromium-based browsers: the specs assert Chromium's CSP console wording (lib/csp.ts).

/** Playwright's Chromium channels. */
export const BROWSER_CHANNELS = Object.freeze([
  'chromium',
  'chrome',
  'chrome-beta',
  'chrome-dev',
  'chrome-canary',
  'msedge',
  'msedge-beta',
  'msedge-dev',
  'msedge-canary',
] as const);

export type BrowserChannel = (typeof BROWSER_CHANNELS)[number];

/** The part of Playwright's `use` that picks the browser (and the switches it is launched with). */
export interface BrowserUse {
  channel?: BrowserChannel;
  launchOptions?: { executablePath?: string; args?: string[] };
}

/**
 * The names the specs give an app whose baseUrl must be a DNS name, not an IP address (uninstalled-setup.ts
 * `createOwnApp({host})`): `<label>.altis-e2e.test`. `.test` is reserved (RFC 2606), so such a
 * name never reaches a real host.
 */
export const E2E_HOST_SUFFIX = 'altis-e2e.test';

/** Chromium's switch that resolves every name under `suffix` to 127.0.0.1 (no hosts file, no DNS server). */
export function hostResolverArg(suffix: string = E2E_HOST_SUFFIX): string {
  return `--host-resolver-rules=MAP *.${suffix} 127.0.0.1`;
}

/** `use` with Chromium launched with {@link hostResolverArg} beside whatever picked the browser. */
export function withHostResolver(use: BrowserUse): BrowserUse {
  return { ...use, launchOptions: { ...use.launchOptions, args: [...(use.launchOptions?.args ?? []), hostResolverArg()] } };
}

const isChannel = (value: string): value is BrowserChannel => (BROWSER_CHANNELS as readonly string[]).includes(value);

/**
 * The browser of `env` (see the top of this file). A blank variable counts as unset.
 *
 * @throws Error for both variables at once, a relative or missing executable, or an unknown channel
 */
export function browserUse(env: NodeJS.ProcessEnv = process.env, exists: (file: string) => boolean = fs.existsSync): BrowserUse {
  const executable = env['ALTIS_E2E_EXECUTABLE']?.trim() ?? '';
  const channel = env['ALTIS_E2E_CHANNEL']?.trim() ?? '';
  if (executable !== '' && channel !== '') {
    throw new Error('ALTIS_E2E_EXECUTABLE and ALTIS_E2E_CHANNEL each pick the browser: set one of them, not both');
  }
  if (executable !== '') {
    if (!path.isAbsolute(executable)) throw new Error(`ALTIS_E2E_EXECUTABLE must be an absolute path, got ${JSON.stringify(executable)}`);
    if (!exists(executable)) throw new Error(`ALTIS_E2E_EXECUTABLE: no such file: ${executable}`);
    return { launchOptions: { executablePath: executable } };
  }
  if (channel !== '') {
    if (!isChannel(channel)) throw new Error(`ALTIS_E2E_CHANNEL must be one of ${BROWSER_CHANNELS.join(', ')}, got ${JSON.stringify(channel)}`);
    return { channel };
  }
  return {};
}
