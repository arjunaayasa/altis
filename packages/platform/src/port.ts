import { DomainError } from '@altis/shared';
import { isEnvSet, type Env } from './runtime.js';

export type PortSource = 'ALTIS_PORT' | 'PORT' | 'config' | 'default';

export const DEFAULT_PORT = 3000;

/** `value` is the offending input exactly as received; `meta.value` carries it unquoted. */
function invalid(variable: string, value: string): DomainError {
  const shown = JSON.stringify(value.slice(0, 64)); // quoted and cut short for the message only
  return new DomainError('INVALID_CONFIG', {
    detail:
      `${variable} harus berupa bilangan bulat 1-65535 (nilai: ${shown}) / ` +
      `${variable} must be an integer from 1 to 65535 (got: ${shown})`,
    meta: { variable, value },
  });
}

function parseEnvPort(variable: string, raw: string): number {
  const text = raw.trim();
  const port = /^\d{1,5}$/.test(text) ? Number(text) : Number.NaN;
  if (!(port >= 1 && port <= 65535)) throw invalid(variable, raw);
  return port;
}

/**
 * Chooses the TCP port (P2). Order: `ALTIS_PORT`, then `PORT`, then `config.json`'s `port`, then 3000.
 *
 * A source that is set but not a valid port (an integer from 1 to 65535) is an error, not a reason to
 * try the next source: silently listening somewhere else would hide a misconfiguration.
 * An empty or whitespace-only environment variable counts as not set (see `isEnvSet`).
 *
 * @throws DomainError `INVALID_CONFIG`
 */
export function resolvePort(env: Env, configPort?: number): { port: number; source: PortSource } {
  for (const source of ['ALTIS_PORT', 'PORT'] as const) {
    if (isEnvSet(env, source)) return { port: parseEnvPort(source, env[source]!), source };
  }
  if (configPort !== undefined) {
    if (!Number.isInteger(configPort) || configPort < 1 || configPort > 65535) {
      throw invalid('config.port', String(configPort));
    }
    return { port: configPort, source: 'config' };
  }
  return { port: DEFAULT_PORT, source: 'default' };
}
