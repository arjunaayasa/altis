import { OPAC_HOME_PHOTO_MAX_BYTES } from '@altis/shared/api/opac-home';
import { useEffect, useRef, useState, type FormEvent } from 'react';
import { Field, ProblemAlert } from '@/components/form-field';
import { useReturnFocus } from '@/components/return-focus';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useT } from '@/i18n';

/**
 * The crop of a home page photo, in the browser: the chosen image is decoded (its EXIF orientation applied), drawn to
 * cover a canvas of the target size (the hero 1600 × 900, the other photos 1200 × 900) at the zoom and offset the admin
 * picks, and encoded as a JPEG of at most 500 KB (the quality lowered step by step), which is what gets uploaded. The
 * canvas re-encoding leaves no metadata behind; the server strips it anyway and checks the type and the size again.
 */

/** The largest file the browser is asked to decode. */
export const PHOTO_SOURCE_MAX_BYTES = 8 * 1024 * 1024;
/** The types a chosen file may be. */
export const PHOTO_SOURCE_TYPES: readonly string[] = ['image/jpeg', 'image/png', 'image/webp'];

/** A decoded image, drawn on a canvas of its own size. */
export type PhotoSource = HTMLCanvasElement;

/** `file` decoded onto a canvas; a TypeError when the browser cannot read it. */
export async function photoSourceOf(file: Blob): Promise<PhotoSource> {
  let bitmap: ImageBitmap;
  try {
    bitmap = await createImageBitmap(file, { imageOrientation: 'from-image' });
  } catch {
    throw new TypeError('the image cannot be decoded');
  }
  try {
    if (bitmap.width < 1 || bitmap.height < 1) throw new TypeError('the image is empty');
    const canvas = document.createElement('canvas');
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    canvas.getContext('2d')?.drawImage(bitmap, 0, 0);
    return canvas;
  } finally {
    bitmap.close();
  }
}

/** Draws `img` covering the `width` × `height` canvas at `zoom`, moved by `dx`/`dy` (-1…1 of the spare room). */
function drawCrop(canvas: HTMLCanvasElement, img: PhotoSource, zoom: number, dx: number, dy: number): void {
  const ctx = canvas.getContext('2d');
  if (ctx === null) return;
  const { width, height } = canvas;
  const scale = Math.max(width / img.width, height / img.height) * zoom;
  const w = img.width * scale;
  const h = img.height * scale;
  const x = (width - w) / 2 + (dx * (w - width)) / 2;
  const y = (height - h) / 2 + (dy * (h - height)) / 2;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, width, height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, x, y, w, h);
}

/** The canvas as a JPEG of at most 500 KB; null when even the lowest quality is larger. */
async function jpegOf(canvas: HTMLCanvasElement): Promise<Blob | null> {
  for (const quality of [0.85, 0.78, 0.7, 0.6, 0.5, 0.4]) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (blob !== null && blob.size <= OPAC_HOME_PHOTO_MAX_BYTES) return blob;
  }
  return null;
}

/** The crop dialog: the framed preview, zoom and offsets, then the JPEG handed to `onSave`. */
export function PhotoCropDialog({
  source,
  width,
  height,
  onCancel,
  onSave,
}: {
  source: PhotoSource;
  width: number;
  height: number;
  onCancel(): void;
  onSave(jpeg: Blob): Promise<void>;
}) {
  const t = useT();
  const focus = useReturnFocus();
  const canvas = useRef<HTMLCanvasElement>(null);
  const [zoom, setZoom] = useState(1);
  const [dx, setDx] = useState(0);
  const [dy, setDy] = useState(0);
  const [busy, setBusy] = useState(false);
  const [tooLarge, setTooLarge] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);

  useEffect(() => {
    if (canvas.current !== null) drawCrop(canvas.current, source, zoom, dx, dy);
  }, [source, zoom, dx, dy]);

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    if (canvas.current === null) return;
    setBusy(true);
    setProblem(null);
    setTooLarge(false);
    try {
      const jpeg = await jpegOf(canvas.current);
      if (jpeg === null) {
        setTooLarge(true);
        setBusy(false);
        return;
      }
      await onSave(jpeg);
    } catch (e) {
      setProblem(e);
      setBusy(false);
    }
  };

  return (
    <Dialog open onOpenChange={(next) => (next || busy ? undefined : onCancel())}>
      <DialogContent closeLabel={t('opacHome.crop.cancel')} onOpenAutoFocus={focus.onOpenAutoFocus} onCloseAutoFocus={focus.onCloseAutoFocus}>
        <DialogHeader>
          <DialogTitle>{t('opacHome.crop.title')}</DialogTitle>
          <DialogDescription>{t('opacHome.crop.hint')}</DialogDescription>
        </DialogHeader>
        <form noValidate className="grid gap-3" onSubmit={(e) => void save(e)}>
          <canvas ref={canvas} width={width} height={height} className="w-full rounded border" style={{ aspectRatio: `${width} / ${height}` }} />
          {(
            [
              ['opacHome.crop.zoom', zoom, setZoom, 1, 3],
              ['opacHome.crop.x', dx, setDx, -1, 1],
              ['opacHome.crop.y', dy, setDy, -1, 1],
            ] as const
          ).map(([key, value, set, min, max]) => (
            <Field key={key} label={t(key)}>
              {(c) => <input {...c} type="range" min={min} max={max} step={0.01} value={value} onChange={(e) => set(Number(e.target.value))} />}
            </Field>
          ))}
          {tooLarge && (
            <p role="alert" className="text-sm text-destructive">
              {t('opacHome.crop.too_large')}
            </p>
          )}
          <ProblemAlert error={problem} />
          <DialogFooter>
            <Button type="button" variant="outline" disabled={busy} onClick={onCancel}>
              {t('opacHome.crop.cancel')}
            </Button>
            <Button type="submit" disabled={busy}>
              {t(busy ? 'opacHome.photo.uploading' : 'opacHome.crop.use')}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
