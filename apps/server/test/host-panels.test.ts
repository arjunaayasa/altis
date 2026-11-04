import fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { PANEL_MARKERS, detectPanelMarkers } from '../src/cli/host-panels.js';

// The hosting-panel markers install looks for when the shell's runtime detection found nothing (ruling R66).

describe('detectPanelMarkers', () => {
  it('knows cPanel, LiteSpeed, aaPanel and Plesk, with the runtime each one runs ALTIS under', () => {
    expect(PANEL_MARKERS.map((m) => [m.path, m.panel, m.runtime])).toEqual([
      ['/usr/local/cpanel', 'cPanel', 'passenger'],
      ['/usr/local/lsws', 'LiteSpeed', 'litespeed'],
      ['/www/server/panel', 'aaPanel', 'pm2'],
      ['/usr/local/psa', 'Plesk', 'passenger'],
    ]);
  });

  it('reports exactly the marker folders that exist on this machine', () => {
    expect(detectPanelMarkers()).toEqual(PANEL_MARKERS.map((m) => m.path).filter((p) => fs.existsSync(p)));
  });
});
