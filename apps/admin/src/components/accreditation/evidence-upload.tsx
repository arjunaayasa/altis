import type { EvidenceEntity } from '@altis/shared';
import type { InstrumentsResponse } from '@altis/shared/api/accreditation';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import { useQueryClient } from '@tanstack/react-query';
import { UploadIcon } from 'lucide-react';
import { useId, useState, type FormEvent, type JSX } from 'react';
import { Field } from '@/components/form-field';
import { useReturnFocus } from '@/components/return-focus';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
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
 * - {@link EvidenceUpload}: a button that opens a small dialog (file, caption); "Unggah" prepares the file, uploads it
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

const MIB = 1024 * 1024;
const CAPTION_MAX = 191;

/** Why a file was refused before its upload. */
export type EvidenceFileProblem = 'type' | 'unreadable' | 'too_large';

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
 * {@link EVIDENCE_IMAGE_MAX_SIDE}, named `<name>.jpg`). Rejects with an {@link EvidenceFileError} for any other type,
 * an image the browser cannot decode, or a result larger than `maxMb` MiB.
 */
export async function prepareEvidenceFile(file: File, maxMb: number): Promise<File> {
  let prepared: File;
  if (isPdf(file)) {
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
  label: string;
  /** Called once the evidence is stored. */
  onDone(): void;
}

type Phase = 'idle' | 'preparing' | 'sending' | 'saving';

/**
 * Uploads one evidence file (PDF, or an image converted to JPEG in the browser) in context `accreditation.evidence` and
 * records it (see the top of this file). A button labelled `label` opens the dialog; after the record the evidence
 * lists are read again and `onDone` runs. Nothing is shown to a user without `accreditation.workspace.manage`.
 */
export function EvidenceUpload(props: EvidenceUploadProps): JSX.Element {
  const t = useT();
  const me = useMe();
  const focus = useReturnFocus();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState(false);
  if (!holds(me, 'accreditation.workspace.manage')) return <></>;
  return (
    <>
      <Button type="button" variant="outline" size="sm" onClick={() => setOpen(true)}>
        <UploadIcon aria-hidden="true" />
        {props.label}
      </Button>
      <Dialog open={open} onOpenChange={(next) => (next || busy ? undefined : setOpen(false))}>
        {open && (
          <DialogContent
            closeLabel={t('accreditation.registers.close')}
            onOpenAutoFocus={focus.onOpenAutoFocus}
            onCloseAutoFocus={focus.onCloseAutoFocus}
            className="sm:max-w-lg">
            <UploadForm
              {...props}
              onBusy={setBusy}
              onCancel={() => setOpen(false)}
              onStored={() => {
                setOpen(false);
                props.onDone();
              }}
            />
          </DialogContent>
        )}
      </Dialog>
    </>
  );
}

/** The dialog's content: the limit, the file, the caption, the progress and the outcome. */
function UploadForm(props: EvidenceUploadProps & { onBusy(busy: boolean): void; onCancel(): void; onStored(): void }) {
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
      const prepared = await prepareEvidenceFile(file, maxMb);
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
    <>
      <DialogHeader>
        <DialogTitle>{props.label}</DialogTitle>
        <DialogDescription>
          {maxMb === null ? t('accreditation.registers.upload.hint_loading') : t('accreditation.registers.upload.hint', { mb: maxMb })}
        </DialogDescription>
      </DialogHeader>
      <form noValidate className="grid gap-4" onSubmit={(e) => void submit(e)}>
        <Field label={t('accreditation.registers.upload.file')}>
          {(c) => (
            <input
              {...c}
              type="file"
              accept={EVIDENCE_ACCEPT}
              disabled={busy}
              aria-invalid={error?.file === true ? true : undefined}
              aria-describedby={error?.file === true ? errorId : undefined}
              className="text-sm file:mr-2 file:rounded-md file:border file:bg-background file:px-2 file:py-1"
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
          <p id={errorId} role="alert" className="text-sm text-destructive">
            {error.text}
          </p>
        )}
        <DialogFooter>
          <Button type="button" variant="outline" disabled={busy} onClick={props.onCancel}>
            {t('form.cancel')}
          </Button>
          <Button type="submit" disabled={busy || maxMb === null}>
            {t('accreditation.registers.upload.submit')}
          </Button>
        </DialogFooter>
      </form>
    </>
  );
}
