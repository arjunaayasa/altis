import { describe, expect, it } from 'vitest';
import { RESCUE_REASONS, rescueHtml, rescueSteps } from '../src/rescue.js';

// The rescue texts are frozen in app.js for every one-click install from the first public release on: where they send
// an operator who has no backup, or whose release keeps failing, must be the public issue tracker.

const ISSUES = 'github.com/arjunaayasa/altis/issues';

describe('rescue texts of the community edition', () => {
  it.each(['STATE_CORRUPT', 'CONFIG_CORRUPT', 'START_FAILED'] as const)('%s points to the public issue tracker in both languages', (reason) => {
    const steps = rescueSteps(reason);
    expect(steps).toContain('laporkan di ' + ISSUES + '.');
    expect(steps).toContain('report it at ' + ISSUES + '.');
    expect(rescueHtml(reason)).toContain(ISSUES);
  });

  it.each(RESCUE_REASONS)('%s names no vendor support channel', (reason) => {
    const text = rescueHtml(reason) + rescueSteps(reason);
    expect(text).not.toMatch(/dukungan|support|Arsya/i);
  });
});
