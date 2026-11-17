import type { StoreResponse } from '@altis/shared/api/catalog/common';
import type { CustomFieldView, MasterListResponse } from '@altis/shared/api/catalog/masters';
import { MEMBER_PHOTO_HEIGHT, MEMBER_PHOTO_MAX_BYTES, MEMBER_PHOTO_WIDTH } from '@altis/shared/api/member-ops';
import type { MemberView } from '@altis/shared/api/members';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Field, Notice, ProblemAlert } from '@/components/form-field';
import { InlinePanel, MemberPhoto } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useT } from '@/i18n';
import { holds } from '@/lib/access';
import { api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { CustomFieldInputs } from '@/screens/catalog/records/custom-fields';
import { customBodyValue, customFormValue, type CustomFormValue } from '@/screens/catalog/records/draft-to-form';
import { uploadFile } from '@/lib/upload';
import { refreshMembers } from './common';
import { saveBlob } from './tools';

/**
 * The member page's extras: the photo (a file or the camera, cropped in the browser to 300 × 400 JPEG, at most
 * 500 KB, then uploaded as `members.photo` and claimed with `PUT members/:id/photo`), restoring an archived member, and
 * the personal-data actions (the member's data as a JSON download, and anonymisation after typing the member number).
 * Both personal-data actions need a fresh password confirmation, which the API client asks for. The camera and the
 * crop are steps inside the photo's panel, and anonymisation asks its question in a panel under its button: no dialog.
 */

/** Draws `img` into the 300 × 400 canvas: covering it at `zoom`, moved by `dx`/`dy` (-1…1 of the spare room). */
function drawCrop(canvas: HTMLCanvasElement, img: CanvasImageSource & { width: number; height: number }, zoom: number, dx: number, dy: number): void {
  const ctx = canvas.getContext('2d');
  if (ctx === null) return;
  const scale = Math.max(MEMBER_PHOTO_WIDTH / img.width, MEMBER_PHOTO_HEIGHT / img.height) * zoom;
  const w = img.width * scale;
  const h = img.height * scale;
  const x = (MEMBER_PHOTO_WIDTH - w) / 2 + (dx * (w - MEMBER_PHOTO_WIDTH)) / 2;
  const y = (MEMBER_PHOTO_HEIGHT - h) / 2 + (dy * (h - MEMBER_PHOTO_HEIGHT)) / 2;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, MEMBER_PHOTO_WIDTH, MEMBER_PHOTO_HEIGHT);
  ctx.drawImage(img, x, y, w, h);
}

/** The canvas as a JPEG of at most 500 KB (quality 0.85, lowered when needed). */
async function jpegOf(canvas: HTMLCanvasElement): Promise<Blob> {
  for (const quality of [0.85, 0.75, 0.6, 0.45]) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (blob !== null && blob.size <= MEMBER_PHOTO_MAX_BYTES) return blob;
  }
  throw new Error('photo too large');
}

/** A picture to crop: a decoded image or a frame of the camera, drawn on a canvas of its own size. */
type Source = HTMLCanvasElement;

async function sourceOfFile(file: Blob): Promise<Source> {
  const bitmap = await createImageBitmap(file);
  const canvas = document.createElement('canvas');
  canvas.width = bitmap.width;
  canvas.height = bitmap.height;
  canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
  bitmap.close();
  return canvas;
}

/** A step inside the photo's panel (the camera, the crop): an inline panel without a frame of its own, a rule above it. */
const STEP = 'rounded-none border-0 border-t bg-transparent px-0 pt-4 pb-0';

function CropStep({ source, onCancel, onSave }: { source: Source; onCancel(): void; onSave(blob: Blob): Promise<void> }) {
  const t = useT();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(1);
  const [dx, setDx] = useState(0);
  const [dy, setDy] = useState(0);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);

  useEffect(() => {
    if (canvas.current !== null) drawCrop(canvas.current, source, zoom, dx, dy);
  }, [source, zoom, dx, dy]);

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (canvas.current === null) return;
    setBusy(true);
    setProblem(null);
    try {
      await onSave(await jpegOf(canvas.current));
    } catch (e) {
      setProblem(e);
      setBusy(false);
    }
  };

  return (
    <InlinePanel title={t('members.tools.photo.crop_title')} onSubmit={(e) => void save(e)} onCancel={busy ? undefined : onCancel} className={STEP}>
      <p className="-mt-1.5 text-sm text-muted-foreground">{t('members.tools.photo.crop_hint')}</p>
      <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
        <canvas ref={canvas} width={MEMBER_PHOTO_WIDTH} height={MEMBER_PHOTO_HEIGHT} className="h-64 w-48 shrink-0 rounded border" />
        <div className="grid max-w-md min-w-0 flex-[1_1_12rem] content-start gap-4">
          {(
            [
              ['members.tools.photo.zoom', zoom, setZoom, 1, 3],
              ['members.tools.photo.offset_x', dx, setDx, -1, 1],
              ['members.tools.photo.offset_y', dy, setDy, -1, 1],
            ] as const
          ).map(([key, value, set, min, max]) => (
            <Field key={key} label={t(key)}>
              {(c) => <input {...c} type="range" min={min} max={max} step={0.01} value={value} className="w-full accent-primary" onChange={(e) => set(Number(e.target.value))} />}
            </Field>
          ))}
        </div>
      </div>
      <ProblemAlert error={problem} />
      <div className="flex flex-wrap gap-2">
        <Button type="submit" size="sm" disabled={busy}>
          {t(busy ? 'form.saving' : 'members.tools.photo.save')}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onCancel}>
          {t('form.cancel')}
        </Button>
      </div>
    </InlinePanel>
  );
}

function CameraStep({ onCancel, onFrame }: { onCancel(): void; onFrame(source: Source): void }) {
  const t = useT();
  const video = useRef<HTMLVideoElement>(null);
  const [problem, setProblem] = useState<unknown>(null);

  useEffect(() => {
    let stream: MediaStream | null = null;
    let stopped = false;
    void navigator.mediaDevices
      .getUserMedia({ video: { width: { ideal: 960 }, height: { ideal: 1280 } }, audio: false })
      .then((s) => {
        if (stopped) {
          for (const track of s.getTracks()) track.stop();
          return;
        }
        stream = s;
        if (video.current !== null) {
          video.current.srcObject = s;
          void video.current.play();
        }
      })
      .catch((e: unknown) => setProblem(e));
    return () => {
      stopped = true;
      if (stream !== null) for (const track of stream.getTracks()) track.stop();
    };
  }, []);

  const capture = (): void => {
    const v = video.current;
    if (v === null || v.videoWidth === 0) return;
    const canvas = document.createElement('canvas');
    canvas.width = v.videoWidth;
    canvas.height = v.videoHeight;
    canvas.getContext('2d')?.drawImage(v, 0, 0);
    onFrame(canvas);
  };

  return (
    <InlinePanel title={t('members.tools.photo.camera')} onCancel={onCancel} className={STEP}>
      <video ref={video} muted playsInline className="max-h-80 w-fit max-w-full rounded border" />
      {problem !== null && <Notice kind="error">{t('members.tools.photo.camera_unavailable')}</Notice>}
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" data-autofocus onClick={capture}>
          {t('members.tools.photo.capture')}
        </Button>
        <Button type="button" size="sm" variant="outline" onClick={onCancel}>
          {t('form.cancel')}
        </Button>
      </div>
    </InlinePanel>
  );
}

/** The photo of the member page's side panel. */
export function MemberPhotoPanel({ member, canManage, onDone }: { member: MemberView; canManage: boolean; onDone(text: string): void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const inputId = useId();
  const input = useRef<HTMLInputElement>(null);
  const [source, setSource] = useState<Source | null>(null);
  const [camera, setCamera] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const cameraAvailable = typeof navigator !== 'undefined' && navigator.mediaDevices !== undefined && window.isSecureContext;

  const put = async (fileId: string | null): Promise<void> => {
    await api<StoreResponse>('PUT', `members/${encodeURIComponent(member.id)}/photo`, { version: member.version, fileId });
    await refreshMembers(queryClient);
  };

  const choose = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    if (input.current !== null) input.current.value = '';
    if (file === undefined) return;
    setError(null);
    try {
      setSource(await sourceOfFile(file));
    } catch {
      setError(t('members.tools.photo.unreadable'));
    }
  };

  const save = async (blob: Blob): Promise<void> => {
    const { uploadId } = await uploadFile(blob, { context: 'members.photo' });
    await put(uploadId);
    setSource(null);
    onDone(t('members.tools.photo.saved'));
  };

  const remove = async (): Promise<void> => {
    setBusy(true);
    setError(null);
    try {
      await put(null);
      onDone(t('members.tools.photo.removed'));
    } catch (e) {
      setError(problemText(t, e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="grid gap-4" aria-label={t('members.tools.photo.title')}>
      <div className="flex flex-wrap items-start gap-x-6 gap-y-4">
        <MemberPhoto name={member.name} fileId={member.photoFileId} size="lg" alt={member.photoFileId === null ? t('members.tools.photo.none') : t('members.tools.photo.alt', { name: member.name })} />
        {canManage && (
          <div className="grid min-w-0 flex-[1_1_14rem] grid-cols-[minmax(0,1fr)] content-start gap-3">
            <div className="grid grid-cols-[minmax(0,1fr)] gap-1.5">
              <Label htmlFor={inputId} className="text-meta leading-snug">
                {t('members.tools.photo.choose')}
              </Label>
              <input ref={input} id={inputId} type="file" accept="image/jpeg,image/png,image/webp" className="w-full max-w-full text-sm file:mr-3 file:h-8 file:rounded-md file:border file:border-input file:bg-background file:px-3 file:text-meta file:font-semibold" onChange={(e) => void choose(e)} />
            </div>
            <div className="flex flex-wrap gap-2">
              <Button type="button" size="sm" variant="outline" onClick={() => (cameraAvailable ? setCamera(true) : setError(t('members.tools.photo.camera_unavailable')))}>
                {t('members.tools.photo.camera')}
              </Button>
              {member.photoFileId !== null && (
                <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void remove()}>
                  {t('members.tools.photo.remove')}
                </Button>
              )}
            </div>
          </div>
        )}
      </div>
      {error !== null && (
        <p role="alert" className="text-meta font-semibold text-bad">
          {error}
        </p>
      )}
      {camera && (
        <CameraStep
          onCancel={() => setCamera(false)}
          onFrame={(frame) => {
            setCamera(false);
            setSource(frame);
          }}
        />
      )}
      {source !== null && <CropStep source={source} onCancel={() => setSource(null)} onSave={save} />}
    </section>
  );
}

/** "Pulihkan dari arsip" for an archived member that was not anonymised. */
export function RestoreButton({ member, onDone }: { member: MemberView; onDone(text: string): void }) {
  const t = useT();
  const queryClient = useQueryClient();
  const [problem, setProblem] = useState<unknown>(null);
  const [busy, setBusy] = useState(false);
  const restore = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    try {
      await api<StoreResponse>('POST', `members/${encodeURIComponent(member.id)}/restore`, { version: member.version });
      await refreshMembers(queryClient);
      onDone(t('members.tools.restored'));
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  };
  return (
    <>
      <Button variant="outline" disabled={busy} onClick={() => void restore()}>
        {t('members.tools.restore')}
      </Button>
      <ProblemAlert error={problem} />
    </>
  );
}

/** The personal-data actions of the member page (`members.privacy.manage`). */
export function MemberPrivacyPanel({ member, onDone }: { member: MemberView; onDone(text: string): void }) {
  const t = useT();
  const me = useMe();
  const queryClient = useQueryClient();
  const [open, setOpen] = useState(false);
  const [typed, setTyped] = useState('');
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  if (!holds(me, 'members.privacy.manage') || member.status === 'anonymized') return null;

  const download = async (): Promise<void> => {
    setProblem(null);
    try {
      const data = await api<unknown>('POST', `members/${encodeURIComponent(member.id)}/privacy/export`);
      saveBlob(new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' }), `data-anggota-${member.memberNo.replace(/[^A-Za-z0-9-]+/g, '_')}.json`);
    } catch (e) {
      setProblem(e);
    }
  };

  const anonymize = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      await api<StoreResponse>('POST', `members/${encodeURIComponent(member.id)}/privacy/anonymize`, { version: member.version, confirmMemberNo: typed });
      setOpen(false);
      await refreshMembers(queryClient);
      onDone(t('members.tools.privacy.anonymized'));
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <section className="grid gap-x-8 gap-y-3 border-t pt-5 md:grid-cols-[200px_minmax(0,1fr)] lg:grid-cols-[220px_minmax(0,1fr)]" aria-label={t('members.tools.privacy.title')}>
      <div className="grid content-start gap-1">
        <h2 className="text-base font-bold">{t('members.tools.privacy.title')}</h2>
        <p className="text-sm text-muted-foreground">{t('members.tools.privacy.intro')}</p>
      </div>
      <div className="grid content-start gap-3">
        <div className="flex flex-wrap gap-2">
          <Button size="sm" variant="outline" onClick={() => void download()}>
            {t('members.tools.privacy.export')}
          </Button>
          <Button size="sm" variant="outline" className="text-bad" aria-expanded={open} onClick={() => setOpen((o) => !o)}>
            {t('members.tools.privacy.anonymize')}
          </Button>
        </div>
        {!open && <ProblemAlert error={problem} />}
        {open && (
          <InlinePanel
            title={t('members.tools.privacy.anonymize_title', { name: member.name })}
            onSubmit={(e) => void anonymize(e)}
            onCancel={busy ? undefined : () => setOpen(false)}>
            <p className="-mt-1.5 max-w-[75ch] text-sm text-muted-foreground">{t('members.tools.privacy.anonymize_intro')}</p>
            <Field label={t('members.tools.privacy.confirm_no', { no: member.memberNo })} className="max-w-md">
              {(c) => <Input {...c} autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />}
            </Field>
            <ProblemAlert error={problem} />
            <div className="flex flex-wrap gap-2">
              <Button type="submit" size="sm" variant="destructive" disabled={busy || typed.trim() === ''}>
                {t('members.tools.privacy.anonymize_submit')}
              </Button>
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => setOpen(false)}>
                {t('form.cancel')}
              </Button>
            </div>
          </InlinePanel>
        )}
      </div>
    </section>
  );
}

/**
 * The member's custom fields (the live `entity=members` definitions; read with `catalog.records.read`), saved with
 * `PATCH members/:id {version, custom}` apart from the member form. Nothing shows without definitions.
 */
export function MemberCustomPanel({ member, canManage, onDone }: { member: MemberView; canManage: boolean; onDone(text: string): void }) {
  const t = useT();
  const me = useMe();
  const queryClient = useQueryClient();
  const defsQuery = useApiQuery<MasterListResponse<CustomFieldView>>({
    queryKey: ['catalog', 'custom-fields', { entity: 'members' }],
    path: 'catalog/custom-fields?entity=members',
    staleTime: 60_000,
    enabled: holds(me, 'catalog.records.read'),
  });
  const defs = (defsQuery.data?.items ?? []).filter((d) => d.entity === 'members' && !d.archived);
  const [values, setValues] = useState<Record<string, CustomFormValue>>(() =>
    Object.fromEntries(Object.entries(member.custom ?? {}).map(([code, v]) => [code, customFormValue(v)])),
  );
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  if (defs.length === 0) return null;

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    try {
      const custom = Object.fromEntries(defs.map((d) => [d.code, customBodyValue(d, values[d.code])]));
      await api<StoreResponse>('PATCH', `members/${encodeURIComponent(member.id)}`, { version: member.version, custom });
      await refreshMembers(queryClient);
      onDone(t('members.saved'));
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form
      noValidate
      onSubmit={(e) => void save(e)}
      aria-label={t('catalog.records.section.custom')}
      className="grid gap-x-8 gap-y-3 border-t pt-5 md:grid-cols-[200px_minmax(0,1fr)] lg:grid-cols-[220px_minmax(0,1fr)]">
      <h2 className="text-base font-bold">{t('catalog.records.section.custom')}</h2>
      <div className="grid min-w-0 content-start gap-4">
        <CustomFieldInputs defs={defs} values={values} disabled={!canManage} onChange={(code, value) => setValues((prev) => ({ ...prev, [code]: value }))} />
        <ProblemAlert error={problem} />
        {canManage && (
          <div className="flex flex-wrap gap-2">
            <Button type="submit" disabled={busy}>
              {t(busy ? 'form.saving' : 'form.save')}
            </Button>
          </div>
        )}
      </div>
    </form>
  );
}
