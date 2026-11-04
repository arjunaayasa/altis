import { newId, systemRolePermissions, type Permission } from '@altis/shared';
import { describe, expect, it, vi } from 'vitest';
import { authorizeChannels } from '../src/authz/channels.js';
import type { ActorAuthz } from '../src/authz/escalation.js';
import type { Grants } from '../src/authz/grants.js';

// Channel authorization (spec §10.7): every channel of a request must be known and allowed, else the whole request
// is refused with 403 AUTHZ_DENIED. The HTTP endpoint arrives in 1c (M19); this is the function it will call.

function grants(global: readonly Permission[], superAdmin = false): Grants {
  return { global: new Set(global), branches: new Map(), superAdmin, roleMfaRequired: false };
}

const staff = (g: Grants = grants([])): ActorAuthz => ({ id: newId(), grants: g });

const noJobs = { jobCreator: () => Promise.resolve(null) };

const DENIED = { code: 'AUTHZ_DENIED', status: 403 };

describe('authorizeChannels', () => {
  it('a staff user without system.update.read is denied system.update with 403; with it, allowed', async () => {
    const plain = staff(grants(['system.users.read']));
    await expect(authorizeChannels(plain, ['system.update'], noJobs)).rejects.toMatchObject(DENIED);
    await expect(authorizeChannels(staff(grants(['system.update.read'])), ['system.update'], noJobs)).resolves.toBeUndefined();
  });

  it('system.backup needs system.backup.read', async () => {
    await expect(authorizeChannels(staff(), ['system.backup'], noJobs)).rejects.toMatchObject(DENIED);
    await expect(authorizeChannels(staff(grants(['system.backup.read'])), ['system.backup'], noJobs)).resolves.toBeUndefined();
  });

  it('Phase 2: catalog needs catalog.records.read, held globally; a super admin holds it', async () => {
    await expect(authorizeChannels(staff(grants(['system.users.read'])), ['catalog'], noJobs)).rejects.toMatchObject(DENIED);
    await expect(authorizeChannels(staff(grants(['catalog.records.manage'])), ['catalog'], noJobs)).rejects.toMatchObject(DENIED);
    await expect(authorizeChannels(staff(grants(['catalog.records.read'])), ['catalog', 'system.status'], noJobs)).resolves.toBeUndefined();
    await expect(authorizeChannels(staff(grants(systemRolePermissions('super_admin'), true)), ['catalog'], noJobs)).resolves.toBeUndefined();
  });

  it('user.<id>: only that user', async () => {
    const me = staff(grants(systemRolePermissions('super_admin'), true));
    await expect(authorizeChannels(me, [`user.${me.id}`], noJobs)).resolves.toBeUndefined();
    await expect(authorizeChannels(me, [`user.${newId()}`], noJobs)).rejects.toMatchObject(DENIED);
  });

  it('system.status: any staff, without any permission', async () => {
    await expect(authorizeChannels(staff(), ['system.status'], noJobs)).resolves.toBeUndefined();
  });

  it('jobs.<id>: its creator, or a holder of system.jobs.read; anyone else is denied', async () => {
    const creator = staff();
    const jobId = newId();
    const jobCreator = vi.fn((id: string) => Promise.resolve(id === jobId ? creator.id : null));
    await expect(authorizeChannels(creator, [`jobs.${jobId}`], { jobCreator })).resolves.toBeUndefined();
    expect(jobCreator).toHaveBeenCalledWith(jobId);
    await expect(authorizeChannels(staff(), [`jobs.${jobId}`], { jobCreator })).rejects.toMatchObject(DENIED);
    await expect(authorizeChannels(staff(grants(['system.jobs.read'])), [`jobs.${jobId}`], { jobCreator })).resolves.toBeUndefined();
    // An unknown job has no creator: only system.jobs.read reaches it.
    await expect(authorizeChannels(creator, [`jobs.${newId()}`], { jobCreator })).rejects.toMatchObject(DENIED);
  });

  it('an unknown channel is denied: bogus, wrong case, padding, a non-ULID id, a Phase 6 chat channel', async () => {
    const me = staff(grants(systemRolePermissions('super_admin'), true));
    for (const name of ['bogus', 'SYSTEM.STATUS', ' system.status', 'system.status.x', `user.${me.id.toLowerCase()}`, 'jobs.1', `chat.${newId()}`, '']) {
      await expect(authorizeChannels(me, [name], noJobs), name).rejects.toMatchObject(DENIED);
    }
  });

  it('one unknown or forbidden channel denies the whole request, before any job is looked up', async () => {
    const jobCreator = vi.fn(() => Promise.resolve(null));
    const me = staff(grants(['system.update.read']));
    await expect(authorizeChannels(me, ['system.status', 'system.update', 'bogus'], { jobCreator })).rejects.toMatchObject(DENIED);
    await expect(authorizeChannels(me, [`jobs.${newId()}`, 'bogus'], { jobCreator })).rejects.toMatchObject(DENIED);
    expect(jobCreator).not.toHaveBeenCalled();
    await expect(authorizeChannels(me, ['system.status', 'system.backup'], { jobCreator })).rejects.toMatchObject(DENIED);
  });

  it('several allowed channels together pass', async () => {
    const me = staff(grants(['system.update.read', 'system.backup.read']));
    await expect(
      authorizeChannels(me, ['system.status', 'system.update', 'system.backup', `user.${me.id}`, 'system.status'], noJobs),
    ).resolves.toBeUndefined();
  });

  it('a permission held only at a branch does not open a channel', async () => {
    const me: ActorAuthz = {
      id: newId(),
      grants: { global: new Set(), branches: new Map([[newId(), new Set<Permission>(['system.update.read'])]]), superAdmin: false, roleMfaRequired: false },
    };
    await expect(authorizeChannels(me, ['system.update'], noJobs)).rejects.toMatchObject(DENIED);
  });
});
