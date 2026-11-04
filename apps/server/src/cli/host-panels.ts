import { existsSync } from 'node:fs';
import type { Runtime } from '@altis/platform';

// Hosting panels on this host (ruling R66). A headless install runs from a shell (SSH, the panel's terminal), where
// detectRuntime sees none of the markers that Passenger, lsnode or PM2 set only in the processes they start, and so
// says 'standalone'. On a host that runs a hosting panel that is almost never the runtime the server will have; install
// then refuses to guess and asks for --runtime. These folders exist only where the panel is installed.

export interface PanelMarker {
  /** A folder that only this panel creates. */
  path: string;
  panel: string;
  /** The runtime the panel runs ALTIS under (what --runtime should say there). */
  runtime: Runtime;
}

export const PANEL_MARKERS: readonly PanelMarker[] = [
  { path: '/usr/local/cpanel', panel: 'cPanel', runtime: 'passenger' },
  { path: '/usr/local/lsws', panel: 'LiteSpeed', runtime: 'litespeed' },
  { path: '/www/server/panel', panel: 'aaPanel', runtime: 'pm2' },
  { path: '/usr/local/psa', panel: 'Plesk', runtime: 'passenger' },
];

function exists(probe: () => boolean): boolean {
  try {
    return probe();
  } catch {
    return false;
  }
}

/**
 * The marker folders of {@link PANEL_MARKERS} that exist on this host, in that order. Each path is written out as a
 * literal (spec §7.5: no fs call with a computed path outside the platform helpers). Tests hand runCli their own list
 * instead (CliIo.hostPanels).
 */
export function detectPanelMarkers(): string[] {
  const found: string[] = [];
  if (exists(() => existsSync('/usr/local/cpanel'))) found.push('/usr/local/cpanel');
  if (exists(() => existsSync('/usr/local/lsws'))) found.push('/usr/local/lsws');
  if (exists(() => existsSync('/www/server/panel'))) found.push('/www/server/panel');
  if (exists(() => existsSync('/usr/local/psa'))) found.push('/usr/local/psa');
  return found;
}
