import { describe, expect, it } from 'vitest';
import { FIXED_CHANNEL_NAMES, ID_CHANNEL_PREFIXES, parseChannel } from '../src/channels.js';
import { newId } from '../src/ids.js';

// Spec §10.7: the channel registry.
describe('parseChannel', () => {
  const id = newId();

  it('user.<ulid> is the subject own channel', () => {
    expect(parseChannel(`user.${id}`)).toEqual({ kind: 'user', userId: id });
  });

  it('jobs.<ulid> belongs to the creator, or to system.jobs.read', () => {
    expect(parseChannel(`jobs.${id}`)).toEqual({ kind: 'job', jobId: id });
  });

  it('system.update needs system.update.read', () => {
    expect(parseChannel('system.update')).toEqual({ kind: 'permission', permission: 'system.update.read' });
  });

  it('system.backup needs system.backup.read', () => {
    expect(parseChannel('system.backup')).toEqual({ kind: 'permission', permission: 'system.backup.read' });
  });

  it('system.status is open to all staff', () => {
    expect(parseChannel('system.status')).toEqual({ kind: 'staff' });
  });

  it('Phase 2: catalog needs catalog.records.read (its spec §12.6: the payloads carry ids only)', () => {
    expect(parseChannel('catalog')).toEqual({ kind: 'permission', permission: 'catalog.records.read' });
    for (const name of ['Catalog', 'CATALOG', ' catalog', 'catalog ', 'catalog.', `catalog.${id}`, 'catalog.records', 'catalogs']) {
      expect(parseChannel(name), JSON.stringify(name)).toBeNull();
    }
  });

  it('accreditation needs accreditation.workspace.read (the results hints carry a period id only)', () => {
    expect(parseChannel('accreditation')).toEqual({ kind: 'permission', permission: 'accreditation.workspace.read' });
    for (const name of ['Accreditation', 'accreditation.', `accreditation.${id}`, 'accreditation.results', ' accreditation']) {
      expect(parseChannel(name), JSON.stringify(name)).toBeNull();
    }
  });

  it('FIXED_CHANNEL_NAMES lists every channel without an id, each of which parses; user and jobs take an id', () => {
    expect([...FIXED_CHANNEL_NAMES]).toEqual(['system.update', 'system.backup', 'system.status', 'catalog', 'accreditation']);
    for (const name of FIXED_CHANNEL_NAMES) expect(parseChannel(name), name).not.toBeNull();
    expect([...ID_CHANNEL_PREFIXES]).toEqual(['user', 'jobs']);
    for (const prefix of ID_CHANNEL_PREFIXES) expect(parseChannel(`${prefix}.${id}`), prefix).not.toBeNull();
    expect(parseChannel('constructor')).toBeNull();
    expect(parseChannel('__proto__')).toBeNull();
  });

  it('refuses unknown channels (the whole request then answers 403)', () => {
    for (const name of ['user.x', 'chat.1', 'system.other', '', 'user', 'user.', 'jobs.', 'system', 'system.']) {
      expect(parseChannel(name), JSON.stringify(name)).toBeNull();
    }
  });

  it('refuses near misses: case, padding, extra segments, ids that are not canonical ULIDs', () => {
    expect(parseChannel(`USER.${id}`)).toBeNull();
    expect(parseChannel(`user.${id.toLowerCase()}`)).toBeNull();
    expect(parseChannel(` user.${id}`)).toBeNull();
    expect(parseChannel(`user.${id} `)).toBeNull();
    expect(parseChannel(`user.${id}\n`)).toBeNull();
    expect(parseChannel(`user.${id}.x`)).toBeNull();
    expect(parseChannel(`user.${id.slice(1)}`)).toBeNull();
    expect(parseChannel(`jobs.${id}0`)).toBeNull();
    expect(parseChannel('System.Update')).toBeNull();
    expect(parseChannel('system.update.')).toBeNull();
    expect(parseChannel('system.status ')).toBeNull();
    expect(parseChannel('system.update.read')).toBeNull();
  });

  it('chat.<id> is not a Phase 1 channel (Phase 6)', () => {
    expect(parseChannel(`chat.${id}`)).toBeNull();
  });

  it('never matches an inherited property name', () => {
    expect(parseChannel('constructor')).toBeNull();
    expect(parseChannel('__proto__')).toBeNull();
    expect(parseChannel('toString')).toBeNull();
  });
});
