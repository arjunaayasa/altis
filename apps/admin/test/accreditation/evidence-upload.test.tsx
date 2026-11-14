import { fireEvent, screen, waitFor, within } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { EvidenceUpload } from '@/components/accreditation/evidence-upload';
import { resizeImage } from '@/lib/image-resize';
import { uploadFile } from '@/lib/upload';
import { json, problem } from '../fake-api';
import { instrumentsAnswer, readerMe, renderWithServer } from './register-harness';

// The evidence upload of the accreditation workspace: one file (a PDF as it is, an image converted to JPEG in the
// browser first) goes up in the `accreditation.evidence` upload context, checked against the workspace's
// `evidenceMaxMb` before anything is sent, and `POST accreditation/evidence` records it once the upload is complete,
// linked to a period's indicator and evidence item or to a register row.

vi.mock('@/lib/image-resize', async (importOriginal) => {
  const real = await importOriginal<typeof import('@/lib/image-resize')>();
  return { ...real, resizeImage: vi.fn() };
});
vi.mock('@/lib/upload', () => ({ uploadFile: vi.fn() }));

const PERIOD = '01JZ0000000000000000000P01';
const UPLOAD = '01JZ0000000000000000000F01';
const ROW = '01JZ0000000000000000000D01';
const EVIDENCE = '01JZ0000000000000000000E01';
const MIB = 1024 * 1024;

beforeEach(() => {
  vi.mocked(resizeImage).mockReset();
  vi.mocked(uploadFile).mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
});

function start(o: { maxMb?: number; post?: () => unknown; reader?: boolean; props?: Partial<Parameters<typeof EvidenceUpload>[0]> } = {}) {
  const onDone = vi.fn();
  const harness = renderWithServer(
    <EvidenceUpload
      periodId={PERIOD}
      indicatorCode="SCH-K1"
      evidenceCode="catalogue_screenshot"
      label="Unggah tangkapan layar"
      onDone={onDone}
      {...o.props}
    />,
    {
      ...(o.reader === true ? { me: readerMe() } : {}),
      routes: {
        'GET accreditation/instruments': () => instrumentsAnswer(o.maxMb ?? 2),
        'POST accreditation/evidence': () => o.post?.() ?? json({ id: EVIDENCE, version: 1 }, 201),
      },
    },
  );
  return { ...harness, onDone };
}

/** Opens the dialog, chooses `file`, types `caption` and presses Unggah. */
async function upload(file: File, caption?: string): Promise<HTMLElement> {
  fireEvent.click(await screen.findByRole('button', { name: 'Unggah tangkapan layar' }));
  const dialog = await screen.findByRole('dialog', { name: 'Unggah tangkapan layar' });
  // The limit comes from the workspace configuration: wait until the dialog says it.
  await within(dialog).findByText(/paling besar \d+ MB/);
  fireEvent.change(within(dialog).getByLabelText('Berkas'), { target: { files: [file] } });
  if (caption !== undefined) fireEvent.change(within(dialog).getByLabelText('Keterangan'), { target: { value: caption } });
  fireEvent.click(within(dialog).getByRole('button', { name: 'Unggah' }));
  return dialog;
}

describe('the evidence upload', () => {
  it('converts an image to JPEG before the upload, then records the evidence once the upload is complete', async () => {
    const jpeg = new Blob([new Uint8Array(2048)], { type: 'image/jpeg' });
    vi.mocked(resizeImage).mockResolvedValue(jpeg);
    vi.mocked(uploadFile).mockResolvedValue({ uploadId: UPLOAD });
    const { sent, onDone } = start();
    const png = new File([new Uint8Array(4096)], 'layar-opac.png', { type: 'image/png' });
    await upload(png, '  Tampilan OPAC  ');

    await waitFor(() => expect(sent('POST', 'accreditation/evidence')).toHaveLength(1));
    expect(resizeImage).toHaveBeenCalledWith(png, { maxSide: 2000, type: 'image/jpeg' });
    const [uploaded, options] = vi.mocked(uploadFile).mock.calls[0]!;
    expect(uploaded).toBeInstanceOf(File);
    expect((uploaded as File).type).toBe('image/jpeg');
    expect((uploaded as File).name).toBe('layar-opac.jpg');
    expect((uploaded as File).size).toBe(2048);
    expect(options).toEqual(expect.objectContaining({ context: 'accreditation.evidence' }));
    expect(vi.mocked(resizeImage).mock.invocationCallOrder[0]).toBeLessThan(vi.mocked(uploadFile).mock.invocationCallOrder[0]!);
    const post = sent('POST', 'accreditation/evidence')[0]!;
    expect(vi.mocked(uploadFile).mock.invocationCallOrder[0]).toBeLessThan(post.order);
    expect(post.body).toEqual({ uploadId: UPLOAD, periodId: PERIOD, indicatorCode: 'SCH-K1', evidenceCode: 'catalogue_screenshot', caption: 'Tampilan OPAC' });
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
  });

  it('a PDF goes up as it is, with an empty caption when none is typed', async () => {
    vi.mocked(uploadFile).mockResolvedValue({ uploadId: UPLOAD });
    const { sent, onDone } = start();
    const pdf = new File([new Uint8Array(MIB)], 'kebijakan.pdf', { type: 'application/pdf' });
    await upload(pdf);
    await waitFor(() => expect(sent('POST', 'accreditation/evidence')).toHaveLength(1));
    expect(resizeImage).not.toHaveBeenCalled();
    expect(vi.mocked(uploadFile).mock.calls[0]![0]).toBe(pdf);
    expect(sent('POST', 'accreditation/evidence')[0]!.body).toEqual({
      uploadId: UPLOAD,
      periodId: PERIOD,
      indicatorCode: 'SCH-K1',
      evidenceCode: 'catalogue_screenshot',
      caption: '',
    });
    await waitFor(() => expect(onDone).toHaveBeenCalledTimes(1));
  });

  it('a file over the workspace limit is refused before anything is sent', async () => {
    const { requests, onDone } = start({ maxMb: 2 });
    const pdf = new File([new Uint8Array(2 * MIB + 1)], 'besar.pdf', { type: 'application/pdf' });
    const dialog = await upload(pdf);
    expect(await within(dialog).findByText('Berkas ini lebih besar dari batas 2 MB. Perkecil atau pisahkan berkasnya.')).toBeTruthy();
    expect(uploadFile).not.toHaveBeenCalled();
    expect(requests.filter((r) => r.method !== 'GET')).toEqual([]);
    expect(onDone).not.toHaveBeenCalled();
  });

  it('an image still over the limit after the JPEG conversion is refused before the upload', async () => {
    vi.mocked(resizeImage).mockResolvedValue(new Blob([new Uint8Array(MIB + 1)], { type: 'image/jpeg' }));
    const { requests } = start({ maxMb: 1 });
    const dialog = await upload(new File([new Uint8Array(10)], 'foto.webp', { type: 'image/webp' }));
    expect(await within(dialog).findByText('Berkas ini lebih besar dari batas 1 MB. Perkecil atau pisahkan berkasnya.')).toBeTruthy();
    expect(resizeImage).toHaveBeenCalledTimes(1);
    expect(uploadFile).not.toHaveBeenCalled();
    expect(requests.filter((r) => r.method !== 'GET')).toEqual([]);
  });

  it('a file that is neither a PDF nor an image, or an image the browser cannot read, is refused', async () => {
    vi.mocked(resizeImage).mockRejectedValue(new TypeError('decode'));
    start();
    const dialog = await upload(new File(['a,b'], 'data.csv', { type: 'text/csv' }));
    expect(await within(dialog).findByText('Pilih berkas PDF atau gambar (JPG, PNG, WebP).')).toBeTruthy();
    expect(resizeImage).not.toHaveBeenCalled();

    fireEvent.change(within(dialog).getByLabelText('Berkas'), { target: { files: [new File(['x'], 'rusak.jpg', { type: 'image/jpeg' })] } });
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unggah' }));
    expect(await within(dialog).findByText('Gambar ini tidak dapat dibaca. Coba berkas lain.')).toBeTruthy();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('asks for a file before it uploads anything', async () => {
    start();
    fireEvent.click(await screen.findByRole('button', { name: 'Unggah tangkapan layar' }));
    const dialog = await screen.findByRole('dialog', { name: 'Unggah tangkapan layar' });
    await within(dialog).findByText(/paling besar 2 MB/);
    fireEvent.click(within(dialog).getByRole('button', { name: 'Unggah' }));
    expect(await within(dialog).findByText('Pilih berkas dulu.')).toBeTruthy();
    expect(uploadFile).not.toHaveBeenCalled();
  });

  it('links a register row without a period', async () => {
    vi.mocked(uploadFile).mockResolvedValue({ uploadId: UPLOAD });
    const { sent } = start({ props: { periodId: undefined, indicatorCode: undefined, evidenceCode: undefined, entity: 'library_documents', entityId: ROW } });
    await upload(new File([new Uint8Array(10)], 'sk.pdf', { type: 'application/pdf' }), 'SK kepala sekolah');
    await waitFor(() => expect(sent('POST', 'accreditation/evidence')).toHaveLength(1));
    expect(sent('POST', 'accreditation/evidence')[0]!.body).toEqual({ uploadId: UPLOAD, entity: 'library_documents', entityId: ROW, caption: 'SK kepala sekolah' });
  });

  it('a refused record shows the reason and keeps the dialog open', async () => {
    vi.mocked(uploadFile).mockResolvedValue({ uploadId: UPLOAD });
    const { onDone } = start({ post: () => problem(409, 'ACCRED_PERIOD_FROZEN') });
    const dialog = await upload(new File([new Uint8Array(10)], 'a.pdf', { type: 'application/pdf' }));
    await waitFor(() => expect(within(dialog).getByRole('alert')).toBeTruthy());
    expect(screen.getByRole('dialog', { name: 'Unggah tangkapan layar' })).toBeTruthy();
    expect(onDone).not.toHaveBeenCalled();
  });

  it('is not offered to a user who may only read the workspace', async () => {
    start({ reader: true });
    await waitFor(() => expect(screen.queryByText('Unggah tangkapan layar')).toBeNull());
    expect(screen.queryByRole('button')).toBeNull();
  });
});
