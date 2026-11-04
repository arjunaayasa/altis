import type { CurrentState } from '@altis/platform';
import { describe, expect, it } from 'vitest';
import { classifyBundled } from '../src/bundled.js';

// The bundled release against `pending ?? active` (spec §9.8, decision D1d-24): app.js only classifies; what the
// server does with an `offer` (row 1) or a `schemaHold` boot (row 3) is Task 27's.

function state(active: string, o: { pending?: string; pinned?: string } = {}): CurrentState {
  return {
    schema: 1,
    active: { version: active, source: 'data' },
    previous: null,
    pending: o.pending === undefined ? null : { version: o.pending, source: 'data' },
    pendingSince: o.pending === undefined ? null : 1,
    pinned: o.pinned ?? null,
  };
}

describe('classifyBundled (§9.8)', () => {
  it('newer than active, the active folder present: offer (row 1)', () => {
    expect(classifyBundled(state('0.1.0-test'), '0.2.0-test', true)).toEqual({ relation: 'newer', action: 'offer' });
  });

  it('newer than active, the active folder missing (never adopted, image mode): schema_hold (row 3)', () => {
    expect(classifyBundled(state('0.1.0-test'), '0.2.0-test', false)).toEqual({ relation: 'newer', action: 'schema_hold' });
  });

  it('equal to active: same, none; older: older, none (row 4), whether or not the active folder is there', () => {
    for (const present of [true, false]) {
      expect(classifyBundled(state('0.2.0-test'), '0.2.0-test', present)).toEqual({ relation: 'same', action: 'none' });
      expect(classifyBundled(state('0.3.0-test'), '0.2.0-test', present)).toEqual({ relation: 'older', action: 'none' });
    }
    expect(classifyBundled(state('1.0.0'), '0.9.9', true)).toEqual({ relation: 'older', action: 'none' });
    expect(classifyBundled(state('1.0.0-rc.1'), '1.0.0', true)).toEqual({ relation: 'newer', action: 'offer' });
  });

  it('D1d-24: the pinned version is never begun again, whatever the folder', () => {
    expect(classifyBundled(state('0.1.0-test', { pinned: '0.2.0-test' }), '0.2.0-test', true)).toEqual({ relation: 'newer', action: 'none' });
    expect(classifyBundled(state('0.1.0-test', { pinned: '0.2.0-test' }), '0.2.0-test', false)).toEqual({ relation: 'newer', action: 'none' });
    // A pin of another version blocks only that version.
    expect(classifyBundled(state('0.1.0-test', { pinned: '0.3.0-test' }), '0.2.0-test', true)).toEqual({ relation: 'newer', action: 'offer' });
  });

  it('compares with pending ?? active', () => {
    expect(classifyBundled(state('0.1.0-test', { pending: '0.3.0-test' }), '0.2.0-test', true)).toEqual({ relation: 'older', action: 'none' });
    expect(classifyBundled(state('0.1.0-test', { pending: '0.2.0-test' }), '0.2.0-test', true)).toEqual({ relation: 'same', action: 'none' });
  });

  it('no bundled release (none beside app.js): no relation, nothing to do', () => {
    expect(classifyBundled(state('0.1.0-test'), null, false)).toEqual({ relation: null, action: 'none' });
  });
});
