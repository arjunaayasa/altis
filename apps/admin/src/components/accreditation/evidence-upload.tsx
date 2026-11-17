import type { EvidenceEntity } from '@altis/shared';
import type { InstrumentsResponse } from '@altis/shared/api/accreditation';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import { useQueryClient } from '@tanstack/react-query';
import { useId, useState, type FormEvent, type JSX } from 'react';
import { Field } from '@/components/form-field';
import { InlinePanel } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { FileInput } from '@/components/file-input';
import { useT, type Translate } from '@/i18n';
import { holds } from '@/lib/access';
import { api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { resizeImage } from '@/lib/image-resize';
import { useApiQuery, useMe } from '@/lib/me';
import { uploadFile } from '@/lib/upload';

/**
 * The evidence files of the accreditation workspace (spec §10.6, §5.6): a PDF, or an image the browser converts to
 * JPEG first (the upload context `accreditation.evidence` takes PDF and JPEG only), at most
 * `accreditation.evidence.maxMb` (the workspace configuration of `GET accreditation/instruments`). The size is checked
 * before anything is sent, on the bytes that would go up (an image after its conversion), so a refused file costs no
 * upload. The server checks the type by its magic bytes and the size again.
 *
 * - {@link EvidenceUpload}: a button that opens a small inline panel under it (file, caption); "Unggah" prepares the file, uploads it
 *   (lib/upload.ts) and, once the upload is complete, records it with `POST accreditation/evidence`, linked to a
 *   period's indicator and evidence item or to a register row. Only a holder of `accreditation.workspace.manage` sees
 *   it.
 * - {@link uploadEvidenceFile}: the same preparation and upload for a file that a register row claims itself (a
 *   partnership agreement, a document, a training certificate): the row's own write then names the upload id.
 */

/** The longest side of an image after its conversion to JPEG: legible when printed full page on A4. */
export const EVIDENCE_IMAGE_MAX_SIDE = 2000;
/** The size limit while the workspace configuration has not answered (the default of the setting). */
export const EVIDENCE_MAX_MB_DEFAULT = 5;
/** What the file choosers offer. */
export const EVIDENCE_ACCEPT = 'application/pdf,image/jpeg,image/png,image/webp';
/** What a chooser of images only (a profile photo) offers. */
export const EVIDENCE_IMAGE_ACCEPT = 'image/jpeg,image/png,image/webp';

const MIB = 1024 * 1024;
const CAPTION_MAX = 191;

/** Why a file was refused before its upload (`not_image`: anything but an image where only an image is taken). */
export type EvidenceFileProblem = 'type' | 'not_image' | 'unreadable' | 'too_large';

/** A file refused before its upload (see {@link prepareEvidenceFile}). */
export class EvidenceFileError extends Error {
  override name = 'EvidenceFileError';
  readonly problem: EvidenceFileProblem;
  constructor(problem: EvidenceFileProblem) {
    super(problem);
    this.problem = problem;
  }
}

/** The sentence of a refused file, with the limit. */
export function evidenceProblemText(t: Translate, problem: EvidenceFileProblem, maxMb: number): string {
  switch (problem) {
    case 'type':
      return t('accreditation.registers.upload.error.type');
    case 'not_image':
      return t('accreditation.registers.upload.error.type_image');
    case 'unreadable':
      return t('accreditation.registers.upload.error.unreadable');
    case 'too_large':
      return t('accreditation.registers.upload.error.too_large', { mb: maxMb });
  }
}

const isPdf = (file: File): boolean => file.type === 'application/pdf' || (file.type === '' && /\.pdf$/i.test(file.name));
const isImage = (file: File): boolean => file.type.startsWith('image/') || (file.type === '' && /\.(jpe?g|png|webp)$/i.test(file.name));

/** `name` with its extension replaced by `.jpg` (`foto.png` → `foto.jpg`). */
function jpegName(name: string): string {
  const base = name.replace(/\.[^./\\]*$/, '');
  return `${base === '' ? 'gambar' : base}.jpg`;
}

/**
 * The file that goes up for `file`: a PDF as it is, an image converted to JPEG (longest side
 * {@link EVIDENCE_IMAGE_MAX_SIDE}, named `<name>.jpg`). Rejects with an {@link EvidenceFileError} for any other type
 * (with `imagesOnly`, also for a PDF), an image the browser cannot decode, or a result larger than `maxMb` MiB.
 */
export async function prepareEvidenceFile(file: File, maxMb: number, o: { imagesOnly?: boolean } = {}): Promise<File> {
  let prepared: File;
  if (o.imagesOnly === true && !isImage(file)) {
    throw new EvidenceFileError('not_image');
  } else if (isPdf(file)) {
    prepared = file;
  } else if (isImage(file)) {
    let jpeg: Blob;
    try {
      jpeg = await resizeImage(file, { maxSide: EVIDENCE_IMAGE_MAX_SIDE, type: 'image/jpeg' });
    } catch {
      throw new EvidenceFileError('unreadable');
    }
    prepared = new File([jpeg], jpegName(file.name), { type: 'image/jpeg' });
  } else {
    throw new EvidenceFileError('type');
  }
  if (prepared.size > maxMb * MIB) throw new EvidenceFileError('too_large');
  return prepared;
}

/** Prepares `file` ({@link prepareEvidenceFile}) and uploads it in context `accreditation.evidence`; resolves to the upload id. */
export async function uploadEvidenceFile(file: File, o: { maxMb: number; onProgress?(sent: number, total: number): void }): Promise<string> {
  const prepared = await prepareEvidenceFile(file, o.maxMb);
  const { uploadId } = await uploadFile(prepared, { context: 'accreditation.evidence', ...(o.onProgress === undefined ? {} : { onProgress: o.onProgress }) });
  return uploadId;
}

/** The query key of the workspace configuration (`GET accreditation/instruments`). */
export const ACCREDITATION_INSTRUMENTS_KEY = ['accreditation', 'instruments'] as const;

/**
 * The evidence size limit in MiB: the workspace configuration's, the default when it cannot be read, null while it is
 * being read.
 */
export function useEvidenceMaxMb(): number | null {
  const query = useApiQuery<InstrumentsResponse>({ queryKey: ACCREDITATION_INSTRUMENTS_KEY, path: 'accreditation/instruments', staleTime: 60_000 });
  if (query.data !== undefined) return query.data.config.evidenceMaxMb;
  return query.isError ? EVIDENCE_MAX_MB_DEFAULT : null;
}

/** Where an uploaded evidence file belongs: a period's indicator and evidence item, or a register row. */
export interface EvidenceUploadProps {
  periodId?: string;
  indicatorCode?: string;
  evidenceCode?: string;
  /** The register table of `entityId` (training certificates, partnership and document files). */
  entity?: EvidenceEntity;
  entityId?: string;
  /** Takes images only (a profile photo, which the profile names only as a JPEG): a PDF is refused before its upload. */
  imagesOnly?: boolean;
  label: string;
  /** Called once the evidence is stored. */
  onDone(): void;
}

type Phase = 'idle' | 'preparing' | 'sending' | 'saving';

/**
 * Uploads one evidence file (PDF, or an image converted to JPEG in the browser) in context `accreditation.evidence` and
 * records it (see the top of this file). A button labelled `label` opens the panel; after the record the evidence
 * lists are read again and `onDone` runs. Nothing is shown to a user without `accreditation.workspace.manage`.
 */
export function EvidenceUpload(props: EvidenceUploadProps): JSX.Element {
  const me = useMe();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!holds(me, 'accreditation.workspace.manage')) return <></>;
  return (
    <>
      <Button type="button" variant="outline" size="sm" aria-expanded={open} onClick={() => (busy ? undefined : setOpen((o) => !o))}>
        {props.label}
      </Button>
      {open && (
        <UploadForm
          {...props}
          busy={busy}
          onBusy={setBusy}
          onCancel={() => setOpen(false)}
          onStored={() => {
            setOpen(false);
            props.onDone();
          }}
        />
      )}
    </>
  );
}

/** The panel: the limit, the file, the caption, the progress and the outcome (Esc or Batal closes it, not while it works). */
function UploadForm(props: EvidenceUploadProps & { busy: boolean; onBusy(busy: boolean): void; onCancel(): void; onStored(): void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const maxMb = useEvidenceMaxMb();
  const errorId = useId();
  const [file, setFile] = useState<File | null>(null);
  const [caption, setCaption] = useState('');
  const [phase, setPhase] = useState<Phase>('idle');
  const [percent, setPercent] = useState(0);
  const [error, setError] = useState<{ text: string; file: boolean } | null>(null);
  const busy = phase !== 'idle';

  const record = (uploadId: string): Record<string, unknown> => {
    const body: Record<string, unknown> = { uploadId };
    if (props.periodId !== undefined) body['periodId'] = props.periodId;
    if (props.indicatorCode !== undefined) body['indicatorCode'] = props.indicatorCode;
    if (props.evidenceCode !== undefined) body['evidenceCode'] = props.evidenceCode;
    if (props.entity !== undefined) body['entity'] = props.entity;
    if (props.entityId !== undefined) body['entityId'] = props.entityId;
    body['caption'] = caption.trim();
    return body;
  };

  const submit = async (e: FormEvent): Promise<void> => {
    e.preventDefault();
    if (busy || maxMb === null) return;
    if (file === null) {
      setError({ text: t('accreditation.registers.upload.error.required'), file: true });
      return;
    }
    setError(null);
    setPercent(0);
    setPhase('preparing');
    props.onBusy(true);
    try {
      const prepared = await prepareEvidenceFile(file, maxMb, { imagesOnly: props.imagesOnly === true });
      setPhase('sending');
      const { uploadId } = await uploadFile(prepared, {
        context: 'accreditation.evidence',
        onProgress: (sent, total) => setPercent(total === 0 ? 100 : Math.floor((sent / total) * 100)),
      });
      setPhase('saving');
      await api<StoreResponse>('POST', 'accreditation/evidence', record(uploadId));
      setPhase('idle');
      props.onBusy(false);
      await queryClient.invalidateQueries({ queryKey: ['accreditation', 'evidence'] });
      props.onStored();
    } catch (err) {
      setPhase('idle');
      props.onBusy(false);
      setError(
        err instanceof EvidenceFileError ? { text: evidenceProblemText(t, err.problem, maxMb), file: true } : { text: problemText(t, err), file: false },
      );
    }
  };

  const status =
    phase === 'preparing'
      ? t('accreditation.registers.upload.preparing')
      : phase === 'sending'
        ? t('accreditation.registers.upload.sending', { percent })
        : phase === 'saving'
          ? t('accreditation.registers.upload.saving')
          : null;

  return (
    <InlinePanel
      title={props.label}
      onSubmit={(e) => void submit(e)}
      {...(props.busy ? {} : { onCancel: props.onCancel })}
      className="w-full max-w-xl basis-full">
      <p className="text-sm text-muted-foreground">
        {props.imagesOnly === true
          ? maxMb === null
            ? t('accreditation.registers.upload.hint_image_loading')
            : t('accreditation.registers.upload.hint_image', { mb: maxMb })
          : maxMb === null
            ? t('accreditation.registers.upload.hint_loading')
            : t('accreditation.registers.upload.hint', { mb: maxMb })}
      </p>
      <Field label={t('accreditation.registers.upload.file')}>
        {(c) => (
          <FileInput
            {...c}
            chosen={file?.name ?? null}
            accept={props.imagesOnly === true ? EVIDENCE_IMAGE_ACCEPT : EVIDENCE_ACCEPT}
            disabled={busy}
            aria-invalid={error?.file === true ? true : undefined}
            aria-describedby={error?.file === true ? errorId : undefined}
            onChange={(e) => {
              setFile(e.target.files?.[0] ?? null);
              setError(null);
            }}
          />
        )}
      </Field>
      <Field label={t('accreditation.registers.upload.caption')} hint={t('accreditation.registers.upload.caption_hint')}>
        {(c) => <Input {...c} autoComplete="off" maxLength={CAPTION_MAX} disabled={busy} value={caption} onChange={(e) => setCaption(e.target.value)} />}
      </Field>
      {status !== null && (
        <p role="status" className="text-sm text-muted-foreground">
          {status}
        </p>
      )}
      {error !== null && (
        <p id={errorId} role="alert" className="text-meta font-semibold text-bad">
          {error.text}
        </p>
      )}
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy || maxMb === null}>
          {t('accreditation.registers.upload.submit')}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={props.onCancel}>
          {t('form.cancel')}
        </Button>
      </div>
    </InlinePanel>
  );
}
