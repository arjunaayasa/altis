import type { DB, DbHandle } from '@altis/db';
import { EVENT_TYPES } from '@altis/shared/api/events';
import type { Transaction } from 'kysely';
import { describe, expect, it } from 'vitest';
import { RESERVED_EVENT_TYPES, createRealtimeTransport, isEventType, publish } from '../src/events/publish.js';

// The event type registry (R1c-8): every type the plan names, and publish() refuses any other, before it touches the
// transaction (so no database is needed here: the DB project covers the writes, packages/core/test/db/events.test.ts).

/** A transaction or handle that fails the test if it is used at all. */
const untouchable = new Proxy(
  {},
  {
    get(_target, prop) {
      throw new Error(`the database was used (${String(prop)})`);
    },
  },
);
const trx = untouchable as Transaction<DB>;
const handle = untouchable as DbHandle;

describe('EVENT_TYPES (R1c-8)', () => {
  it('lists every type the code publishes and the plan names', () => {
    for (const type of [
      'notification',
      'job.progress',
      'job.finished',
      'op.progress',
      'clock.anomaly',
      'backup.progress',
      'backup.done',
      // 1d (Task 1): an update check finished (system.update)
      'update.checked',
    ]) {
      expect(EVENT_TYPES).toContain(type);
    }
    // Phase 2 (its spec §12.6), appended after 1c's, in this order: the `catalog` channel's hints.
    expect(EVENT_TYPES.slice(-3)).toEqual(['catalog.record.changed', 'catalog.item.changed', 'catalog.bulk.changed']);
    expect(new Set(EVENT_TYPES).size).toBe(EVENT_TYPES.length);
    expect(Object.isFrozen(EVENT_TYPES)).toBe(true);
  });

  it('1d: update.checked is an event type publish() accepts; the community edition has no license.changed', () => {
    expect(isEventType('update.checked')).toBe(true);
    expect(isEventType('license.changed')).toBe(false);
    expect(EVENT_TYPES).not.toContain('license.changed');
  });

  it('holds well-formed types only: never a control name of the event stream', () => {
    for (const type of EVENT_TYPES) {
      expect(type).toMatch(/^[a-z][a-z0-9_.]{0,63}$/);
      expect(RESERVED_EVENT_TYPES).not.toContain(type);
      expect(isEventType(type)).toBe(true);
    }
  });

  it('publish refuses a well-formed type outside the registry with a TypeError, before using the transaction', async () => {
    for (const type of ['status.changed', 'backup.progress_2', 'job', 'jobs.progress', 'error.mail']) {
      expect(isEventType(type)).toBe(false);
      await expect(publish(trx, { channel: 'system.status', type })).rejects.toThrow(TypeError);
      await expect(publish(trx, { channel: 'system.status', type })).rejects.toThrow(/EVENT_TYPES/);
    }
  });

  it('the realtime transport refuses it too, before opening a transaction', async () => {
    const transport = createRealtimeTransport(handle, () => 'polling');
    await expect(transport.publish('system.backup', 'backup.finished', {})).rejects.toThrow(TypeError);
    await expect(transport.publish('system.status', 'status.changed', {})).rejects.toThrow(/EVENT_TYPES/);
  });
});
