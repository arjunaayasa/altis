import { DomainError, parseChannel, type ChannelRule } from '@altis/shared';
import type { ActorAuthz } from './escalation.js';
import { can } from './grants.js';

// Who may read a real-time channel (spec §10.7). The names are recognized by parseChannel (@altis/shared); this
// checks them against a staff actor. 1c's events endpoint calls it on every poll and heartbeat (§10.7: authorization
// is checked again each time).

function denied(index: number, reason: 'unknown' | 'forbidden'): DomainError {
  // The channel name is not echoed (it is client input); its position is enough for the logs.
  return new DomainError('AUTHZ_DENIED', {
    detail: 'Anda tidak berhak membaca salah satu kanal yang diminta / You may not read one of the requested channels',
    meta: { channelIndex: index, reason },
  });
}

/**
 * Resolves when `actor` may read every channel of `channels`; otherwise rejects with DomainError `AUTHZ_DENIED` (403)
 * for the whole request (§10.7: an unknown or forbidden channel → 403 for the entire request):
 *
 * - `user.<id>`: that user only;
 * - `jobs.<id>`: the job's creator (`o.jobCreator(id)`, null for an unknown job), or a holder of `system.jobs.read`;
 * - `system.update` / `system.backup`: `system.update.read` / `system.backup.read`, held globally;
 * - `system.status`: any staff;
 * - `catalog` (Phase 2 spec §12.6; Task 2): `catalog.records.read`, held globally (a global permission is never held
 *   per branch), through the same `permission` rule of parseChannel.
 *
 * Every name is recognized first, so an unknown one is refused before any job is looked up.
 */
export async function authorizeChannels(
  actor: ActorAuthz,
  channels: readonly string[],
  o: { jobCreator(jobId: string): Promise<string | null> },
): Promise<void> {
  const rules: ChannelRule[] = [];
  for (const [i, name] of channels.entries()) {
    const rule = typeof name === 'string' ? parseChannel(name) : null;
    if (rule === null) throw denied(i, 'unknown');
    rules.push(rule);
  }
  for (const [i, rule] of rules.entries()) {
    switch (rule.kind) {
      case 'staff':
        break;
      case 'user':
        if (rule.userId !== actor.id) throw denied(i, 'forbidden');
        break;
      case 'permission':
        if (!can(actor.grants, rule.permission)) throw denied(i, 'forbidden');
        break;
      case 'job':
        if (can(actor.grants, 'system.jobs.read')) break;
        if ((await o.jobCreator(rule.jobId)) !== actor.id) throw denied(i, 'forbidden');
        break;
    }
  }
}
