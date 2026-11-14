import { systemRolePermissions, type Permission } from '@altis/shared';
import type { AttachmentView } from '@altis/shared/api/catalog/attachments';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { AttachmentsPanel } from '@/components/catalog/attachments-panel';
import { ME_KEY } from '@/lib/me';
import { uploadFile } from '@/lib/upload';
import { json, problem, signedIn } from '../fake-api';

// The attachments panel of the record editor (Phase 2 Task 18; spec §8, §13): it lists a record's attachments
// (`GET catalog/records/:id/attachments`), uploads a file (`uploadFile`, context `catalog.attachment`) or adds a link,
// edits the title, description and access of one, and archives one. The write routes answer `{id, version}` only
// (S15), so after each write the panel reads the list again.

vi.mock('@/lib/upload', () => ({ uploadFile: vi.fn() }));

const RECORD = '01JZRECORD0000000000000001';

function attachment(o: Partial<AttachmentView>): AttachmentView {
  return {
    id: 'A1',
    recordId: RECORD,
    kind: 'file',
    fileId: '01JZFILE000000000000000001',
    url: null,
    title: 'Bab 1',
    description: null,
    access: 'public',
    mime: 'application/pdf',
    size: 2_621_440,
    readCount: 12,
    sortOrder: 0,
    version: 3,
    memberTypeIds: [],
    ...o,
  };
}

const TWO: AttachmentView[] = [
  attachment({}),
  attachment({ id: 'A2', kind: 'url', fileId: null, url: 'https://repositori.example/bab-2', title: 'Bab 2 daring', access: 'staff', mime: null, size: null, readCount: 0, sortOrder: 1, version: 0 }),
];

interface Call {
  method: string;
  path: string;
  body: unknown;
}

/** A fake `/api/v1`: `routes['METHOD path']` answers (a Response, or a body as 200 JSON); anything else is a 404 problem. */
function stubApi(routes: Record<string, (body: unknown) => unknown>) {
  const calls: Call[] = [];
  vi.stubGlobal(
    'fetch',
    vi.fn<typeof fetch>(async (input, init) => {
      const url = new URL(String(input), 'https://altis.test');
      const method = init?.method ?? 'GET';
      const path = url.pathname.replace(/^\/api\/v1\//, '');
      const body = typeof init?.body === 'string' ? (JSON.parse(init.body) as unknown) : undefined;
      calls.push({ method, path, body });
      const handler = routes[`${method} ${path}`];
      if (handler === undefined) return problem(404, 'NOT_FOUND');
      const answer = handler(body);
      return answer instanceof Response ? answer : json(answer);
    }),
  );
  const lists = (): number => calls.filter((c) => c.method === 'GET' && c.path === `catalog/records/${RECORD}/attachments`).length;
  const writes = (): Call[] => calls.filter((c) => c.method !== 'GET');
  return { calls, lists, writes };
}

function renderPanel(permissions: readonly Permission[] = systemRolePermissions('admin')) {
  const queryClient = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } });
  // Signed in already: the panel's reads wait for auth/me (useApiQuery), which the cache answers.
  queryClient.setQueryData(ME_KEY, signedIn({ id: 'U1', permissions }));
  return render(
    <QueryClientProvider client={queryClient}>
      <AttachmentsPanel recordId={RECORD} />
    </QueryClientProvider>,
  );
}

const LIST = `GET catalog/records/${RECORD}/attachments`;
const CREATE = `POST catalog/records/${RECORD}/attachments`;

/** The list item of the attachment titled `title`. */
const row = (title: string): HTMLElement => screen.getByText(title).closest('li')!;

beforeEach(() => {
  vi.mocked(uploadFile).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

describe('AttachmentsPanel', () => {
  it('shows the record’s attachments: title, access, the file’s type and size, the read count, and a checked link', async () => {
    stubApi({ [LIST]: () => ({ items: TWO }) });
    renderPanel();
    expect(await screen.findByText('Bab 1')).toBeTruthy();
    const file = row('Bab 1');
    expect(within(file).getByText('Publik')).toBeTruthy();
    expect(within(file).getByText(/application\/pdf · 2,5 MiB/)).toBeTruthy();
    expect(within(file).getByText('Dibuka 12 kali')).toBeTruthy();
    expect(within(file).getByRole('link', { name: 'Buka lampiran Bab 1' }).getAttribute('href')).toBe('/files/01JZFILE000000000000000001');
    const link = row('Bab 2 daring');
    expect(within(link).getByText('Hanya staf')).toBeTruthy();
    const open = within(link).getByRole('link', { name: 'Buka lampiran Bab 2 daring' });
    expect([open.getAttribute('href'), open.getAttribute('rel')]).toEqual(['https://repositori.example/bab-2', 'noopener noreferrer']);
  });

  it('a link that is not http(s) is shown as text, never as an href (S4)', async () => {
    stubApi({ [LIST]: () => ({ items: [attachment({ id: 'A3', kind: 'url', fileId: null, url: 'javascript:alert(1)', title: 'Tautan lama', mime: null, size: null })] }) });
    renderPanel();
    await screen.findByText('Tautan lama');
    const item = row('Tautan lama');
    expect(within(item).queryByRole('link')).toBeNull();
    expect(within(item).getByText('javascript:alert(1)')).toBeTruthy();
  });

  it('edits the access: PATCH {version, access} only, then reads the list again', async () => {
    const api = stubApi({ [LIST]: () => ({ items: TWO }), 'PATCH catalog/attachments/A1': () => ({ id: 'A1', version: 4 }) });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Ubah lampiran Bab 1' }));
    const form = screen.getByRole('form', { name: 'Ubah lampiran Bab 1' });
    fireEvent.change(within(form).getByLabelText('Akses'), { target: { value: 'staff' } });
    const before = api.lists();
    fireEvent.click(within(form).getByRole('button', { name: 'Simpan' }));
    await waitFor(() => expect(api.writes()).toEqual([{ method: 'PATCH', path: 'catalog/attachments/A1', body: { version: 3, access: 'staff' } }]));
    await waitFor(() => expect(api.lists()).toBeGreaterThan(before));
    expect(await screen.findByText('Perubahan lampiran disimpan.')).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Ubah lampiran Bab 1' })).toBeNull();
  });

  it('adds a link: POST {kind: url, url, title, access}; a non-http(s) address is refused before anything is sent', async () => {
    const api = stubApi({ [LIST]: () => ({ items: TWO }), [CREATE]: () => json({ id: 'A9', version: 0 }, 201) });
    renderPanel();
    const form = await screen.findByRole('form', { name: 'Tambah lampiran' });
    fireEvent.click(within(form).getByLabelText('Tautan'));
    fireEvent.change(within(form).getByLabelText('Alamat tautan'), { target: { value: 'ftp://arsip.example/x' } });
    fireEvent.change(within(form).getByLabelText('Judul'), { target: { value: 'Versi daring' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Tambahkan' }));
    expect(await within(form).findByText('Gunakan alamat yang diawali http:// atau https://.')).toBeTruthy();
    expect(api.writes()).toEqual([]);

    fireEvent.change(within(form).getByLabelText('Alamat tautan'), { target: { value: 'https://arsip.example/x' } });
    const before = api.lists();
    fireEvent.click(within(form).getByRole('button', { name: 'Tambahkan' }));
    await waitFor(() =>
      expect(api.writes()).toEqual([
        { method: 'POST', path: `catalog/records/${RECORD}/attachments`, body: { kind: 'url', url: 'https://arsip.example/x', title: 'Versi daring', access: 'public' } },
      ]),
    );
    await waitFor(() => expect(api.lists()).toBeGreaterThan(before));
    expect(await screen.findByText('Lampiran ditambahkan.')).toBeTruthy();
  });

  it('uploads a file as catalog.attachment and posts its id; the title defaults to the file name', async () => {
    vi.mocked(uploadFile).mockResolvedValue({ uploadId: '01JZFILE000000000000000009' });
    const api = stubApi({ [LIST]: () => ({ items: TWO }), [CREATE]: () => json({ id: 'A9', version: 0 }, 201) });
    renderPanel();
    const form = await screen.findByRole('form', { name: 'Tambah lampiran' });
    const file = new File(['%PDF-1.4'], 'bab-3.pdf', { type: 'application/pdf' });
    fireEvent.change(within(form).getByLabelText('Berkas yang diunggah'), { target: { files: [file] } });
    expect((within(form).getByLabelText('Judul') as HTMLInputElement).value).toBe('bab-3.pdf');
    fireEvent.change(within(form).getByLabelText('Akses'), { target: { value: 'staff' } });
    fireEvent.change(within(form).getByLabelText('Keterangan'), { target: { value: 'Untuk staf saja' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Tambahkan' }));
    await waitFor(() => expect(api.writes()).toHaveLength(1));
    expect(vi.mocked(uploadFile)).toHaveBeenCalledWith(file, expect.objectContaining({ context: 'catalog.attachment' }));
    expect(api.writes()[0]).toEqual({
      method: 'POST',
      path: `catalog/records/${RECORD}/attachments`,
      body: { kind: 'file', fileId: '01JZFILE000000000000000009', title: 'bab-3.pdf', description: 'Untuk staf saja', access: 'staff' },
    });
  });

  it('shows a field error the server names (VALIDATION_FAILED) and a problem it cannot place', async () => {
    let answer: Response = problem(422, 'VALIDATION_FAILED', { errors: [{ path: 'title', code: 'too_big' }] });
    stubApi({ [LIST]: () => ({ items: [] }), [CREATE]: () => answer });
    renderPanel();
    expect(await screen.findByText('Belum ada lampiran.')).toBeTruthy();
    const form = screen.getByRole('form', { name: 'Tambah lampiran' });
    fireEvent.click(within(form).getByLabelText('Tautan'));
    fireEvent.change(within(form).getByLabelText('Alamat tautan'), { target: { value: 'https://arsip.example/x' } });
    fireEvent.change(within(form).getByLabelText('Judul'), { target: { value: 'Judul' } });
    fireEvent.click(within(form).getByRole('button', { name: 'Tambahkan' }));
    expect(await within(form).findByText('Terlalu panjang.')).toBeTruthy();
    answer = problem(404, 'NOT_FOUND');
    fireEvent.click(within(form).getByRole('button', { name: 'Tambahkan' }));
    expect(await within(form).findByRole('alert')).toBeTruthy();
  });

  it('archives after a confirmation: DELETE {version}, then reads the list again', async () => {
    const api = stubApi({ [LIST]: () => ({ items: TWO }), 'DELETE catalog/attachments/A2': () => ({ id: 'A2', version: 1 }) });
    renderPanel();
    fireEvent.click(await screen.findByRole('button', { name: 'Arsipkan lampiran Bab 2 daring' }));
    const dialog = await screen.findByRole('alertdialog');
    expect(within(dialog).getByText(/“Bab 2 daring” tidak lagi tampil di OPAC/)).toBeTruthy();
    const before = api.lists();
    fireEvent.click(within(dialog).getByRole('button', { name: 'Arsipkan' }));
    await waitFor(() => expect(api.writes()).toEqual([{ method: 'DELETE', path: 'catalog/attachments/A2', body: { version: 0 } }]));
    await waitFor(() => expect(api.lists()).toBeGreaterThan(before));
  });

  it('without catalog.records.manage it only lists: no form, no edit or archive buttons', async () => {
    stubApi({ [LIST]: () => ({ items: TWO }) });
    renderPanel(['catalog.records.read']);
    expect(await screen.findByText('Bab 1')).toBeTruthy();
    expect(screen.queryByRole('form', { name: 'Tambah lampiran' })).toBeNull();
    expect(screen.queryByRole('button', { name: /Ubah lampiran|Arsipkan lampiran/ })).toBeNull();
  });
});
