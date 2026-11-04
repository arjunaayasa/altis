import { isUlid } from './ids.js';
import type { Permission } from './permissions.js';

/**
 * Who may read a real-time channel (spec §10.7), as data. The check itself (the subject, the job's creator, the
 * permissions) lives in `packages/core`; this only recognizes the channel names.
 */
export type ChannelRule =
  | { kind: 'user'; userId: string }
  | { kind: 'job'; jobId: string }
  | { kind: 'permission'; permission: Permission }
  | { kind: 'staff' };

/**
 * The rule of a channel name, or null for an unknown name (the whole request then answers 403):
 * - `user.<ulid>`: that user only;
 * - `jobs.<ulid>`: the job's creator, or `system.jobs.read`;
 * - `system.update`: `system.update.read`; `system.backup`: `system.backup.read`;
 * - `system.status`: every staff member;
 * - `catalog` (Phase 2 spec §12.6): `catalog.records.read`; its events carry ids only.
 *
 * Names are matched exactly (case, padding and extra segments all fail); an id must be a canonical ULID.
 */
export function parseChannel(name: string): ChannelRule | null {
  switch (name) {
    case 'system.update':
      return { kind: 'permission', permission: 'system.update.read' };
    case 'system.backup':
      return { kind: 'permission', permission: 'system.backup.read' };
    case 'system.status':
      return { kind: 'staff' };
    // ---- Phase 2 (catalog): Task 2 ----
    case 'catalog':
      return { kind: 'permission', permission: 'catalog.records.read' };
  }
  const dot = name.indexOf('.');
  if (dot < 0) return null;
  const prefix = name.slice(0, dot);
  const id = name.slice(dot + 1);
  if (!isUlid(id)) return null;
  if (prefix === 'user') return { kind: 'user', userId: id };
  if (prefix === 'jobs') return { kind: 'job', jobId: id };
  return null;
}
