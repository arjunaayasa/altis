import type { BranchView } from '@altis/shared/api/branches';
import type { LoanListItem } from '@altis/shared/api/circulation';
import type { NoticeListItem, NoticeStatusResponse } from '@altis/shared/api/notices';
import type { EmailSettings } from '@altis/shared/api/settings';
import { fireEvent, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { adminMe, startApp } from '../fake-api';

// Pengingat E-mail: the status of sending, the log with its states and reasons, the preview and the test send; and the
// reminder buttons of Terlambat & Jatuh Tempo, which queue an overdue reminder at the loan's branch.

beforeAll(async () => {
  await import('@/screens/circulation/notices');
  await import('@/screens/circulation/overdue');
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

const BRANCH = '01JZ0000000000000000000B01';
const MEMBER = '01JZ0000000000000000000A01';

const STATUS: NoticeStatusResponse = {
  smtpConfigured: false,
  lastWeek: { queued: 0, sending: 0, sent: 3, failed: 1, skipped: 2 },
  lastBuildAt: Date.UTC(2026, 10, 15, 0, 0),
  lastSendAt: null,
  waiting: 4,
};

const NOTICE: NoticeListItem = {
  id: '01JZ0000000000000000000N01',
  kind: 'overdue',
  status: 'skipped',
  reason: 'no_email',
  manual: true,
  attempts: 0,
  createdAt: Date.UTC(2026, 10, 15, 0, 0),
  sentAt: null,
  member: { id: MEMBER, memberNo: 'A001', name: 'Siti Rahma' },
  loanCount: 2,
  holdId: null,
};

const NO_TEMPLATE = { id: { subject: null, body: null }, en: { subject: null, body: null } };
const EMAIL: EmailSettings = {
  senderName: null,
  templates: { passwordReset: NO_TEMPLATE, circulationDueSoon: NO_TEMPLATE, circulationOverdue: NO_TEMPLATE, circulationHoldReady: NO_TEMPLATE },
};

const BRANCH_VIEW: BranchView = {
  id: BRANCH,
  code: 'PUSAT',
  name: 'Perpustakaan Pusat',
  address: null,
  timezone: 'Asia/Jakarta',
  isDefault: true,
  archivedAt: null,
  version: 1,
  active: true,
};

const LOAN: LoanListItem = {
  id: '01JZ0000000000000000000L01',
  version: 1,
  state: 'open',
  overdue: true,
  daysLate: 3,
  branchId: BRANCH,
  loanedOn: '2026-10-01',
  dueOn: '2026-10-08',
  returnedOn: null,
  outcome: null,
  renewals: 0,
  renewLimit: 1,
  item: { id: '01JZ0000000000000000000I01', barcode: 'B0001', callNumber: null },
  record: { id: '01JZ0000000000000000000R01', title: 'Judul 1' },
  member: { id: MEMBER, memberNo: 'A001', name: 'Siti Rahma', className: null, typeId: '01JZ0000000000000000000T01' },
  finePreview: null,
};

describe('Pengingat E-mail', () => {
  it('shows that SMTP is missing, the log with its reason, previews a mail and sends a test', async () => {
    const app = startApp({
      me: adminMe(),
      path: '/admin/layanan/pengingat',
      routes: {
        'GET circulation/notices/status': () => STATUS,
        'GET circulation/notices': () => ({ items: [NOTICE], nextCursor: null }),
        'GET settings/email': () => EMAIL,
        'POST circulation/notices/preview': () => ({ subject: 'Pinjaman Anda sudah lewat jatuh tempo', text: 'Halo Siti Rahma,\n- Laskar Pelangi' }),
        'POST circulation/notices/test': () => ({ sent: true }),
      },
    });
    expect(await screen.findByText(/SMTP\) belum diatur/)).toBeTruthy();
    expect(await screen.findByText('Siti Rahma')).toBeTruthy();
    expect(screen.getByText('Anggota tidak punya alamat e-mail')).toBeTruthy();
    expect(screen.getByText('2 pinjaman · dikirim petugas')).toBeTruthy();

    fireEvent.click(screen.getByRole('button', { name: 'Pratinjau' }));
    expect(await screen.findByText('Pinjaman Anda sudah lewat jatuh tempo')).toBeTruthy();
    fireEvent.change(screen.getByLabelText('Kirim ke alamat'), { target: { value: 'saya@example.test' } });
    fireEvent.click(screen.getByRole('button', { name: 'Kirim uji' }));
    expect(await screen.findByText('Surat uji terkirim ke saya@example.test.')).toBeTruthy();
    const test = app.requests.find((r) => r.method === 'POST' && r.path === 'circulation/notices/test');
    expect(test?.body).toEqual({ kind: 'overdue', locale: 'id', to: 'saya@example.test' });
    // The templates of the three mails are on the same page.
    expect(await screen.findByText('Templat pengingat ke anggota')).toBeTruthy();
  });
});

describe('Terlambat & Jatuh Tempo: reminders', () => {
  it('a row’s button queues an overdue reminder for its member at the loan’s branch and says what was queued', async () => {
    const app = startApp({
      me: adminMe(),
      path: '/admin/layanan/terlambat',
      routes: {
        'GET branches': () => ({ items: [BRANCH_VIEW] }),
        'GET members/types': () => ({ items: [] }),
        'POST circulation/loans/search': () => ({ items: [LOAN], nextCursor: null }),
        'POST branches/:branchId/circulation/notices': () => ({ kind: 'overdue', queued: 1, existing: 0, nothing: 0, refused: [] }),
      },
    });
    const button = await screen.findByRole('button', { name: 'Kirim pengingat' });
    fireEvent.click(button);
    expect(await screen.findByText('Pengingat masuk antrean: 1. Sudah dikirim hari ini: 0. Tidak ada yang perlu diingatkan: 0.')).toBeTruthy();
    // The list itself is a POST read (the search body); the reminder is the only write.
    await waitFor(() => expect(app.writes().filter((w) => w !== 'POST circulation/loans/search')).toEqual([`POST branches/${BRANCH}/circulation/notices`]));
    expect(app.requests.find((r) => r.method === 'POST' && r.path.endsWith('/notices'))?.body).toEqual({ memberIds: [MEMBER], kind: 'overdue' });
    expect(screen.getByRole('button', { name: 'Kirim pengingat ke semua yang tampil' })).toBeTruthy();
  });
});
