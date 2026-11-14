import type { StoreResponse } from '@altis/shared/api/catalog/common';
import { MEMBER_PHOTO_HEIGHT, MEMBER_PHOTO_MAX_BYTES, MEMBER_PHOTO_WIDTH } from '@altis/shared/api/member-ops';
import type { MemberView } from '@altis/shared/api/members';
import { useQueryClient } from '@tanstack/react-query';
import { CameraIcon, ImageIcon, TrashIcon } from 'lucide-react';
import { useEffect, useId, useRef, useState, type ChangeEvent, type FormEvent } from 'react';
import { Field, Notice, ProblemAlert } from '@/components/form-field';
import { useReturnFocus } from '@/components/return-focus';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { useT } from '@/i18n';
import { holds } from '@/lib/access';
import { api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useMe } from '@/lib/me';
import { uploadFile } from '@/lib/upload';
import { refreshMembers } from './common';
import { saveBlob } from './tools';

/**
 * The member page's extras: the photo (a file or the camera, cropped in the browser to 300 × 400 JPEG, at most
 * 500 KB, then uploaded as `members.photo` and claimed with `PUT members/:id/photo`), restoring an archived member, and
 * the personal-data actions (the member's data as a JSON download, and anonymisation after typing the member number).
 * Both personal-data actions need a fresh password confirmation, which the API client asks for.
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

function CropDialog({ source, onCancel, onSave }: { source: Source; onCancel(): void; onSave(blob: Blob): Promise<void> }) {
  const t = useT();
  const focus = useReturnFocus();
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
    <Dialog open onOpenChange={(next) => (next || busy ? undefined : onCancel())}>
      <DialogContent closeLabel={t('form.cancel')} onOpenAutoFocus={focus.onOpenAutoFocus} onCloseAutoFocus={focus.onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{t('members.tools.photo.crop_title')}</DialogTitle>
          <DialogDescription>{t('members.tools.photo.crop_hint')}</DialogDescription>
        </DialogHeader>
        <form noValidate className="grid gap-3" onSubmit={(e) => void save(e)}>
          <canvas ref={canvas} width={MEMBER_PHOTO_WIDTH} height={MEMBER_PHOTO_HEIGHT} className="mx-auto h-64 w-48 rounded border" />
          {(
            [
              ['members.tools.photo.zoom', zoom, setZoom, 1, 3],
              ['members.tools.photo.offset_x', dx, setDx, -1, 1],
              ['members.tools.photo.offset_y', dy, setDy, -1, 1],
            ] as const
          ).map(([key, value, set, min, max]) => (
            <Field key={key} label={t(key)}>
              {(c) => <input {...c} type="range" min={min} max={max} step={0.01} value={value} onChange={(e) => set(Number(e.target.value))} />}
            </Field>
          ))}
          <ProblemAlert error={problem} />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
              {t('form.cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {t(busy ? 'form.saving' : 'members.tools.photo.save')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}

function CameraDialog({ onCancel, onFrame }: { onCancel(): void; onFrame(source: Source): void }) {
  const t = useT();
  const focus = useReturnFocus();
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
    <Dialog open onOpenChange={(next) => (next ? undefined : onCancel())}>
      <DialogContent closeLabel={t('form.cancel')} onOpenAutoFocus={focus.onOpenAutoFocus} onCloseAutoFocus={focus.onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{t('members.tools.photo.camera')}</DialogTitle>
        </DialogHeader>
        <video ref={video} muted playsInline className="mx-auto max-h-80 rounded border" />
        {problem !== null && <Notice kind="error">{t('members.tools.photo.camera_unavailable')}</Notice>}
        <DialogFooter>
          <Button type="button" variant="outline" onClick={onCancel}>
            {t('form.cancel')}
          </Button>
          <Button type="button" onClick={capture}>
            {t('members.tools.photo.capture')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
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
    <section className="grid gap-2" aria-label={t('members.tools.photo.title')}>
      {member.photoFileId === null ? (
        <div className="flex aspect-[3/4] w-32 items-center justify-center rounded border bg-muted text-muted-foreground">
          <ImageIcon className="size-6" aria-hidden="true" />
          <span className="sr-only">{t('members.tools.photo.none')}</span>
        </div>
      ) : (
        <img src={`/files/${encodeURIComponent(member.photoFileId)}`} alt={t('members.tools.photo.alt', { name: member.name })} className="aspect-[3/4] w-32 rounded border object-cover" />
      )}
      {canManage && (
        <div className="grid gap-2">
          <Label htmlFor={inputId} className="text-xs">
            {t('members.tools.photo.choose')}
          </Label>
          <input ref={input} id={inputId} type="file" accept="image/jpeg,image/png,image/webp" className="text-xs" onChange={(e) => void choose(e)} />
          <div className="flex flex-wrap gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              onClick={() => (cameraAvailable ? setCamera(true) : setError(t('members.tools.photo.camera_unavailable')))}
            >
              <CameraIcon aria-hidden="true" />
              {t('members.tools.photo.camera')}
            </Button>
            {member.photoFileId !== null && (
              <Button type="button" size="sm" variant="outline" disabled={busy} onClick={() => void remove()}>
                <TrashIcon aria-hidden="true" />
                {t('members.tools.photo.remove')}
              </Button>
            )}
          </div>
        </div>
      )}
      {error !== null && (
        <p role="alert" className="text-xs text-destructive">
          {error}
        </p>
      )}
      {camera && (
        <CameraDialog
          onCancel={() => setCamera(false)}
          onFrame={(frame) => {
            setCamera(false);
            setSource(frame);
          }}
        />
      )}
      {source !== null && <CropDialog source={source} onCancel={() => setSource(null)} onSave={save} />}
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
  const focus = useReturnFocus();
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
    <section className="grid gap-2 border-t pt-3" aria-label={t('members.tools.privacy.title')}>
      <h2 className="text-sm font-semibold">{t('members.tools.privacy.title')}</h2>
      <p className="text-xs text-muted-foreground">{t('members.tools.privacy.intro')}</p>
      <Button size="sm" variant="outline" onClick={() => void download()}>
        {t('members.tools.privacy.export')}
      </Button>
      <Button size="sm" variant="outline" className="text-destructive" onClick={() => setOpen(true)}>
        {t('members.tools.privacy.anonymize')}
      </Button>
      {!open && <ProblemAlert error={problem} />}
      {open && (
        <Dialog open onOpenChange={(next) => (next || busy ? undefined : setOpen(false))}>
          <DialogContent closeLabel={t('form.cancel')} onOpenAutoFocus={focus.onOpenAutoFocus} onCloseAutoFocus={focus.onCloseAutoFocus}>
            <DialogHeader>
              <DialogTitle>{t('members.tools.privacy.anonymize_title', { name: member.name })}</DialogTitle>
              <DialogDescription>{t('members.tools.privacy.anonymize_intro')}</DialogDescription>
            </DialogHeader>
            <form noValidate className="grid gap-3" onSubmit={(e) => void anonymize(e)}>
              <Field label={t('members.tools.privacy.confirm_no', { no: member.memberNo })}>
                {(c) => <Input {...c} autoComplete="off" value={typed} onChange={(e) => setTyped(e.target.value)} />}
              </Field>
              <ProblemAlert error={problem} />
              <DialogFooter>
                <Button type="button" variant="outline" disabled={busy} onClick={() => setOpen(false)}>
                  {t('form.cancel')}
                </Button>
                <Button type="submit" variant="destructive" disabled={busy || typed.trim() === ''}>
                  {t('members.tools.privacy.anonymize_submit')}
                </Button>
              </DialogFooter>
            </form>
          </DialogContent>
        </Dialog>
      )}
    </section>
  );
}
