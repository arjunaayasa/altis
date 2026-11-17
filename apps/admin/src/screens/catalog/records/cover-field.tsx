import type { StoreResponse } from '@altis/shared/api/catalog/common';
import { useId, useRef, useState, type ChangeEvent } from 'react';
import { Notice } from '@/components/form-field';
import { Button } from '@/components/ui/button';
import { Label } from '@/components/ui/label';
import { FileInput } from '@/components/file-input';
import { useT } from '@/i18n';
import { api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { resizeImage } from '@/lib/image-resize';
import { uploadFile } from '@/lib/upload';

/**
 * The cover of a stored record (Phase 2 spec §3.1, §8, §13; plan Task 24): the image the OPAC shows, chosen here.
 *
 * 1. The browser shrinks the chosen image (`resizeImage`: longest side 600 px, WebP, else JPEG). An image it cannot
 *    decode is refused before anything is sent.
 * 2. The result goes up as a `catalog.cover` upload (`uploadFile`); the server checks the type by its magic bytes and
 *    strips the metadata (Task 18).
 * 3. `PUT catalog/records/:id/cover {fileId, version}` claims the file for the record (or `{fileId: null}` removes the
 *    cover). The answer is `{id, version}` only (S15): the editor takes the new version and reads the record again.
 *
 * It acts at once, apart from the form's save, and renders no `<form>` (it sits inside the editor's).
 */

/** The cover's longest side after the browser shrank it (§8). */
const COVER_MAX_SIDE = 600;

export function CoverField({
  recordId,
  title,
  coverFileId,
  version,
  canManage,
  onChanged,
}: {
  recordId: string;
  title: string;
  coverFileId: string | null;
  /** The record's version as the editor holds it. */
  version: number;
  canManage: boolean;
  /** After a change: the record's new version (the editor reads the record again). */
  onChanged(version: number): Promise<void>;
}) {
  const t = useT();
  const inputId = useId();
  const hintId = useId();
  const headingId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [done, setDone] = useState<'saved' | 'removed' | null>(null);

  const put = async (fileId: string | null): Promise<void> => {
    const r = await api<StoreResponse>('PUT', `catalog/records/${encodeURIComponent(recordId)}/cover`, { fileId, version });
    await onChanged(r.version);
  };

  const choose = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    if (file === undefined) return;
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      let small: Blob;
      try {
        small = await resizeImage(file, { maxSide: COVER_MAX_SIDE, type: 'image/webp' });
      } catch {
        setError(t('catalog.records.cover.unreadable'));
        return;
      }
      const { uploadId } = await uploadFile(small, { context: 'catalog.cover' });
      await put(uploadId);
      setDone('saved');
    } catch (err) {
      setError(problemText(t, err));
    } finally {
      setBusy(false);
      if (input.current !== null) input.current.value = '';
    }
  };

  const removeCover = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    setDone(null);
    try {
      await put(null);
      setDone('removed');
    } catch (err) {
      setError(problemText(t, err));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section aria-labelledby={headingId} className="grid content-start gap-3 p-4" aria-busy={busy || undefined}>
      <h2 id={headingId} className="text-base font-bold">
        {t('catalog.records.section.cover')}
      </h2>
      {coverFileId === null ? (
        <div aria-hidden="true" className="h-40 w-28 rounded border bg-layer-2" />
      ) : (
        <img
          src={`/files/${encodeURIComponent(coverFileId)}`}
          alt={t('catalog.records.cover.alt', { title })}
          className="h-40 w-auto max-w-full self-start rounded border object-contain"
        />
      )}
      {coverFileId === null && <p className="text-sm text-muted-foreground">{t('catalog.records.cover.none')}</p>}
      {canManage && (
        <div className="grid gap-2">
          <Label htmlFor={inputId} className="text-meta leading-snug">
            {t('catalog.records.cover.choose')}
          </Label>
          <FileInput
            ref={input}
            id={inputId}
            accept="image/jpeg,image/png,image/webp"
            aria-describedby={hintId}
            disabled={busy}
            onChange={(e) => void choose(e)}
          />
          <p id={hintId} className="text-xs text-muted-foreground">
            {t('catalog.records.cover.hint')}
          </p>
          {coverFileId !== null && (
            <div>
              <Button type="button" variant="outline" size="sm" className="bg-background" disabled={busy} onClick={() => void removeCover()}>
                {t('catalog.records.cover.remove')}
              </Button>
            </div>
          )}
        </div>
      )}
      {busy && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('catalog.records.cover.working')}
        </p>
      )}
      {done === 'saved' && <Notice kind="success">{t('catalog.records.cover.saved')}</Notice>}
      {done === 'removed' && <Notice kind="success">{t('catalog.records.cover.removed')}</Notice>}
      {error !== null && <Notice kind="error">{error}</Notice>}
    </section>
  );
}
