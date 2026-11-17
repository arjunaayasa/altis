import { OPAC_HOME_LOGO_SIZE, OPAC_HOME_PHOTO_MAX_BYTES } from '@altis/shared/api/opac-home';
import { useEffect, useState } from 'react';
import { Field, ProblemAlert } from '@/components/form-field';
import { InlinePanel, StatusText } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';

/**
 * The crop of a home page photo, in the browser: the chosen image is decoded (its EXIF orientation applied), drawn to
 * cover a canvas of the target size (the hero 1600 × 900, the other photos 1200 × 900) at the zoom and offset the admin
 * picks, and encoded as a JPEG of at most 500 KB (the quality lowered step by step), which is what gets uploaded. The
 * canvas re-encoding leaves no metadata behind; the server strips it anyway and checks the type and the size again.
 * The crop opens as a panel under the control that chose the photo (not a dialog). The logo is not cropped: it is
 * fitted whole onto a white tile (`fitLogo`).
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
export async function jpegOf(canvas: HTMLCanvasElement): Promise<Blob | null> {
  for (const quality of [0.85, 0.78, 0.7, 0.6, 0.5, 0.4]) {
    const blob = await new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, 'image/jpeg', quality));
    if (blob !== null && blob.size <= OPAC_HOME_PHOTO_MAX_BYTES) return blob;
  }
  return null;
}

/** The size of the logo's tile for an image of `width` × `height`: 240 px high, as wide as the logo (square to 4:1). */
export function logoTileSize(width: number, height: number): { width: number; height: number } {
  const { height: h, minWidth, maxWidth } = OPAC_HOME_LOGO_SIZE;
  const wide = Math.round((h * width) / Math.max(1, height));
  return { width: Math.min(maxWidth, Math.max(minWidth, wide)), height: h };
}

/** The logo fitted whole and centred on a white tile of {@link logoTileSize} (a JPEG has no transparency). */
export function fitLogo(img: PhotoSource): HTMLCanvasElement {
  const size = logoTileSize(img.width, img.height);
  const canvas = document.createElement('canvas');
  canvas.width = size.width;
  canvas.height = size.height;
  const ctx = canvas.getContext('2d');
  if (ctx === null) return canvas;
  const scale = Math.min(size.width / img.width, size.height / img.height);
  const w = img.width * scale;
  const h = img.height * scale;
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, size.width, size.height);
  ctx.imageSmoothingQuality = 'high';
  ctx.drawImage(img, (size.width - w) / 2, (size.height - h) / 2, w, h);
  return canvas;
}

/** The crop panel: the framed preview, zoom and offsets, then the JPEG handed to `onSave`. */
export function PhotoCropPanel({
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
  // The canvas is kept as state (a callback ref): drawing waits until it exists, and draws again whenever the crop
  // changes.
  const [canvas, setCanvas] = useState<HTMLCanvasElement | null>(null);
  const [zoom, setZoom] = useState(1);
  const [dx, setDx] = useState(0);
  const [dy, setDy] = useState(0);
  const [busy, setBusy] = useState(false);
  const [tooLarge, setTooLarge] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);

  useEffect(() => {
    if (canvas !== null) drawCrop(canvas, source, zoom, dx, dy);
  }, [canvas, source, zoom, dx, dy]);

  const save = async (): Promise<void> => {
    if (canvas === null) return;
    setBusy(true);
    setProblem(null);
    setTooLarge(false);
    try {
      const jpeg = await jpegOf(canvas);
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
    <InlinePanel title={t('opacHome.crop.title')} onCancel={busy ? undefined : onCancel} className="max-w-xl">
      <p className="text-sm text-muted-foreground">{t('opacHome.crop.hint')}</p>
      <canvas ref={setCanvas} width={width} height={height} className="w-full rounded border bg-background" style={{ aspectRatio: `${width} / ${height}` }} />
      <div className="grid gap-x-5 gap-y-3 sm:grid-cols-3">
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
      </div>
      {tooLarge && (
        <p role="alert">
          <StatusText tone="bad">{t('opacHome.crop.too_large')}</StatusText>
        </p>
      )}
      <ProblemAlert error={problem} />
      <div className="flex flex-wrap gap-2">
        <Button type="button" size="sm" disabled={busy} onClick={() => void save()}>
          {t(busy ? 'opacHome.photo.uploading' : 'opacHome.crop.use')}
        </Button>
        <Button type="button" size="sm" variant="outline" disabled={busy} onClick={onCancel}>
          {t('opacHome.crop.cancel')}
        </Button>
      </div>
    </InlinePanel>
  );
}
