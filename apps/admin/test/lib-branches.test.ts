import type { BranchView } from '@altis/shared/api/branches';
import { describe, expect, it } from 'vitest';
import { isWritableBranch } from '@/lib/branches';

// The neutral "inactive branch is read-only" gate (ruling R5): a live branch is writable unless the server marks it
// `active: false`; the community server sends `active = archivedAt === null`.

const branch = (o: Partial<BranchView> = {}): BranchView => ({
  id: '01JZ0000000000000000000BR1',
  code: 'PUSAT',
  name: 'Perpustakaan Pusat',
  address: null,
  timezone: 'Asia/Jakarta',
  isDefault: true,
  archivedAt: null,
  version: 1,
  active: true,
  ...o,
});

describe('isWritableBranch', () => {
  it('live and active → writable; marked inactive, or archived → not', () => {
    expect([branch(), branch({ active: false }), branch({ archivedAt: 1_700_000_000_000, active: false })].map(isWritableBranch)).toEqual([true, false, false]);
  });
});
