import { vocabKey } from '@altis/shared';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import type { LocationView, MapBox } from '@altis/shared/api/catalog/locations';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useRef, useState, type ChangeEvent, type KeyboardEvent, type PointerEvent } from 'react';
import { Notice } from '@/components/form-field';
import { LAYER, StatusText, Tag, type TagTone } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { FileInput } from '@/components/file-input';
import { useT, type TKey } from '@/i18n';
import { api } from '@/lib/api';
import { useDirtyGuard } from '@/lib/dirty-forms';
import { problemText } from '@/lib/form-errors';
import { uploadFile } from '@/lib/upload';
import { cn } from '@/lib/utils';
import { isStale } from '@/screens/catalog/masters/master-table';
import { descendantsOf } from './tree';

/**
 * The shelf map of a room (Phase 2 spec §3.6, §13; plan Task 27; the API of Task 14).
 *
 * - The floor plan: an image uploaded to the `catalog.floor_plan` context (JPEG, PNG or WebP, ≤ 5 MB; the server checks
 *   the magic bytes and strips the metadata), then claimed by `PUT branches/:branchId/locations/:roomId/map
 *   {floorPlanFileId, version}`; the room's plan becomes a public file the OPAC draws. `{floorPlanFileId: null}`
 *   removes it. After a stale version the tree is read again, so trying again goes with the room's current version.
 * - The boxes of the room's areas and shelves, in permil (0-1000) of the picture's width and height, so they fit the
 *   plan at any size. With the pointer: drag over the plan to draw the chosen location's box, drag a box to move it,
 *   drag its bottom-right corner to resize it. With the keyboard: the arrow keys move the focused box by 5‰, with
 *   Shift by 1‰, and four fields give its exact position and size. A box never leaves the picture.
 * - Changes stay on the page until "Simpan kotak": each changed box goes as `PUT …/:id/map {box, version}` (one request
 *   per location, each with its own version). A refusal keeps the drawing; after a stale version the tree is read
 *   again, so saving again goes with the version the server holds now. The page hears how many boxes are unsaved
 *   (`onDraftsChange`), so that closing the map or opening another one asks first (index.tsx, L15).
 * - A location moved from another room loses its box (the server clears it, Task 40): the screen marks it "Perlu
 *   digambar ulang" until its new box is saved here.
 * - Only the boxes of locations still below this room are kept: once the tree read again no longer has one here (a
 *   move took it, or an area above it, to another room; it was archived or became a room), its unsaved box is dropped,
 *   so it is neither counted (the unsaved text, the dirty guard, `onDraftsChange`) nor put on the location in its new
 *   room, where a box drawn on this plan means nothing (T14: the move raised its version so that such a save is
 *   refused; after that refusal the tree is read again, and the box must not go with the new version).
 * - Without `catalog.locations.manage` at the branch the map is shown, not edited.
 */

/** The size limit of the `catalog.floor_plan` upload context. */
const FLOOR_PLAN_MAX_BYTES = 5 * 1024 * 1024;
/** The smallest box the pointer draws, in permil; a click without a drag draws nothing. */
const MIN_DRAWN = 5;
/** A box made without the pointer: a small square in the middle. */
const NEW_BOX: MapBox = { x: 450, y: 450, w: 100, h: 100 };

const clamp = (v: number, lo: number, hi: number): number => Math.min(Math.max(v, lo), hi);

const sameBox = (a: MapBox | null, b: MapBox | null): boolean =>
  a === b || (a !== null && b !== null && a.x === b.x && a.y === b.y && a.w === b.w && a.h === b.h);

/** `box` moved by (dx, dy), kept inside the picture. */
function moved(box: MapBox, dx: number, dy: number): MapBox {
  return { ...box, x: clamp(box.x + dx, 0, 1000 - box.w), y: clamp(box.y + dy, 0, 1000 - box.h) };
}

type Point = { x: number; y: number };

/** What a pointer is doing: drawing a new box from `start`, moving a box, or resizing it by its corner. */
interface Drag {
  mode: 'draw' | 'move' | 'resize';
  id: string;
  pointerId: number;
  start: Point;
  origin: MapBox | null;
}

export function MapEditor({
  branchId,
  room,
  rows,
  canManage,
  redraw,
  onSaved,
  onClose,
  onDraftsChange,
}: {
  branchId: string;
  room: LocationView;
  /** The branch's locations (the room's areas and shelves among them). */
  rows: readonly LocationView[];
  canManage: boolean;
  /** The locations whose box must be drawn again. */
  redraw: ReadonlySet<string>;
  /** After boxes were saved: their locations. */
  onSaved(ids: readonly string[]): void;
  onClose(): void;
  /** How many boxes are unsaved, each time that changes (0 once the editor is gone). */
  onDraftsChange?(count: number): void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const ids = useId();
  const headingId = `${ids}-heading`;
  const hintId = `${ids}-hint`;
  const fileId = `${ids}-file`;
  const surface = useRef<HTMLDivElement>(null);
  const heading = useRef<HTMLHeadingElement>(null);
  const fileInput = useRef<HTMLInputElement>(null);
  const drag = useRef<Drag | null>(null);
  const children = descendantsOf(rows, room.id).filter((l) => !l.archived && l.kind !== 'room');
  /** The ids of `children` as one key: when it changes, the drafts of locations no longer here are dropped. */
  const childKey = children.map((c) => c.id).join(' ');
  const [drafts, setDrafts] = useState<ReadonlyMap<string, MapBox | null>>(new Map());
  useEffect(() => {
    const here = new Set(childKey.split(' '));
    setDrafts((prev) => ([...prev.keys()].every((id) => here.has(id)) ? prev : new Map([...prev].filter(([id]) => here.has(id)))));
  }, [childKey]);
  const [selected, setSelected] = useState<string | null>(() => (children.find((c) => redraw.has(c.id)) ?? children[0])?.id ?? null);
  const [busy, setBusy] = useState<'plan' | 'boxes' | null>(null);
  const [planNotice, setPlanNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [boxNotice, setBoxNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  useDirtyGuard(drafts.size > 0);
  useEffect(() => onDraftsChange?.(drafts.size), [drafts.size, onDraftsChange]);
  useEffect(() => () => onDraftsChange?.(0), [onDraftsChange]);

  useEffect(() => {
    heading.current?.focus();
  }, []);

  const boxOf = (id: string): MapBox | null => {
    if (drafts.has(id)) return drafts.get(id) ?? null;
    return children.find((c) => c.id === id)?.box ?? null;
  };

  const setDraft = (id: string, box: MapBox | null): void => {
    setBoxNotice(null);
    const stored = children.find((c) => c.id === id)?.box ?? null;
    setDrafts((prev) => {
      const next = new Map(prev);
      if (sameBox(stored, box)) next.delete(id);
      else next.set(id, box);
      return next;
    });
  };

  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: ['catalog', 'locations'] });
  const mapPath = (id: string): string => `branches/${encodeURIComponent(branchId)}/locations/${encodeURIComponent(id)}/map`;

  // ---- the floor plan ----

  const putPlan = async (fileIdValue: string | null, done: TKey): Promise<void> => {
    try {
      await api<StoreResponse>('PUT', mapPath(room.id), { version: room.version, floorPlanFileId: fileIdValue });
    } catch (err) {
      // Someone else changed the room: the tree is read again, so trying again goes with its current version.
      if (isStale(err)) await refresh();
      throw err;
    }
    await refresh();
    setPlanNotice({ tone: 'success', text: t(done) });
  };

  const choosePlan = async (e: ChangeEvent<HTMLInputElement>): Promise<void> => {
    const file = e.target.files?.[0];
    if (file === undefined) return;
    setPlanNotice(null);
    if (file.size > FLOOR_PLAN_MAX_BYTES) {
      setPlanNotice({ tone: 'error', text: t('catalog.locations.map.too_large') });
      if (fileInput.current !== null) fileInput.current.value = '';
      return;
    }
    setBusy('plan');
    try {
      const { uploadId } = await uploadFile(file, { context: 'catalog.floor_plan' });
      await putPlan(uploadId, 'catalog.locations.map.plan_saved');
    } catch (err) {
      setPlanNotice({ tone: 'error', text: problemText(t, err) });
    } finally {
      setBusy(null);
      if (fileInput.current !== null) fileInput.current.value = '';
    }
  };

  const removePlan = async (): Promise<void> => {
    setPlanNotice(null);
    setBusy('plan');
    try {
      await putPlan(null, 'catalog.locations.map.plan_removed');
    } catch (err) {
      setPlanNotice({ tone: 'error', text: problemText(t, err) });
    } finally {
      setBusy(null);
    }
  };

  // ---- the boxes ----

  /** The pointer's position in permil of the picture, or null when the picture has no size yet. */
  const pointOf = (e: PointerEvent): Point | null => {
    const rect = surface.current?.getBoundingClientRect();
    if (rect === undefined || rect.width <= 0 || rect.height <= 0) return null;
    return {
      x: clamp(Math.round(((e.clientX - rect.left) / rect.width) * 1000), 0, 1000),
      y: clamp(Math.round(((e.clientY - rect.top) / rect.height) * 1000), 0, 1000),
    };
  };

  /** The box a drag makes at `p`. */
  const dragged = (d: Drag, p: Point): MapBox | null => {
    if (d.mode === 'draw') return { x: Math.min(d.start.x, p.x), y: Math.min(d.start.y, p.y), w: Math.abs(p.x - d.start.x), h: Math.abs(p.y - d.start.y) };
    if (d.origin === null) return null;
    if (d.mode === 'move') return moved(d.origin, p.x - d.start.x, p.y - d.start.y);
    return { ...d.origin, w: clamp(p.x - d.origin.x, MIN_DRAWN, 1000 - d.origin.x), h: clamp(p.y - d.origin.y, MIN_DRAWN, 1000 - d.origin.y) };
  };

  const pointerDown = (e: PointerEvent<HTMLDivElement>): void => {
    if (!canManage || e.button !== 0) return;
    const p = pointOf(e);
    if (p === null) return;
    const target = e.target as HTMLElement;
    const boxElement = target.closest<HTMLElement>('[data-box-id]');
    const boxId = boxElement?.dataset['boxId'];
    let d: Drag;
    if (boxElement !== null && boxId !== undefined) {
      d = { mode: target.closest('[data-box-handle]') !== null ? 'resize' : 'move', id: boxId, pointerId: e.pointerId, start: p, origin: boxOf(boxId) };
      setSelected(boxId);
      boxElement.focus();
    } else {
      if (selected === null) return;
      d = { mode: 'draw', id: selected, pointerId: e.pointerId, start: p, origin: boxOf(selected) };
    }
    drag.current = d;
    e.preventDefault();
    try {
      surface.current?.setPointerCapture?.(e.pointerId);
    } catch {
      // A pointer the browser no longer tracks: the drag still follows the events that reach the plan.
    }
  };

  const pointerMove = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (d === null || e.pointerId !== d.pointerId) return;
    const p = pointOf(e);
    const box = p === null ? null : dragged(d, p);
    if (box !== null && (d.mode !== 'draw' || (box.w >= MIN_DRAWN && box.h >= MIN_DRAWN))) setDraft(d.id, box);
  };

  const pointerUp = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (d === null || e.pointerId !== d.pointerId) return;
    drag.current = null;
    const p = pointOf(e);
    const box = p === null ? null : dragged(d, p);
    // A click without a drag draws nothing: the box stays as it was.
    if (d.mode === 'draw' && (box === null || box.w < MIN_DRAWN || box.h < MIN_DRAWN)) setDraft(d.id, d.origin);
    else if (box !== null) setDraft(d.id, box);
    try {
      surface.current?.releasePointerCapture?.(e.pointerId);
    } catch {
      // Already released.
    }
  };

  const pointerCancel = (e: PointerEvent<HTMLDivElement>): void => {
    const d = drag.current;
    if (d === null || e.pointerId !== d.pointerId) return;
    drag.current = null;
    setDraft(d.id, d.origin);
  };

  const nudge = (e: KeyboardEvent<HTMLDivElement>, id: string): void => {
    const step = e.shiftKey ? 1 : 5;
    const dx = e.key === 'ArrowLeft' ? -step : e.key === 'ArrowRight' ? step : 0;
    const dy = e.key === 'ArrowUp' ? -step : e.key === 'ArrowDown' ? step : 0;
    if (dx === 0 && dy === 0) return;
    e.preventDefault();
    const box = boxOf(id);
    if (box !== null) setDraft(id, moved(box, dx, dy));
  };

  /** A position field typed: kept inside the picture (a size of at least 1‰). */
  const typed = (id: string, field: keyof MapBox, raw: string): void => {
    const box = boxOf(id);
    const v = Number.parseInt(raw, 10);
    if (box === null || !Number.isFinite(v)) return;
    const limits: Record<keyof MapBox, [number, number]> = {
      x: [0, 1000 - box.w],
      y: [0, 1000 - box.h],
      w: [1, 1000 - box.x],
      h: [1, 1000 - box.y],
    };
    const [lo, hi] = limits[field];
    setDraft(id, { ...box, [field]: clamp(v, lo, hi) });
  };

  const saveBoxes = async (): Promise<void> => {
    setBusy('boxes');
    setBoxNotice(null);
    const done: string[] = [];
    try {
      for (const [id, box] of drafts) {
        // Still below this room (a draft of one a move took elsewhere is dropped, never put with its new version).
        const location = children.find((c) => c.id === id);
        if (location === undefined) continue;
        await api<StoreResponse>('PUT', mapPath(id), { version: location.version, box });
        done.push(id);
      }
      setBoxNotice({ tone: 'success', text: t('catalog.locations.map.saved') });
    } catch (err) {
      setBoxNotice({ tone: 'error', text: problemText(t, err) });
      // Someone else changed that location: the tree is read again, so saving again goes with its current version.
      if (done.length === 0 && isStale(err)) await refresh();
    } finally {
      if (done.length > 0) {
        await refresh();
        setDrafts((prev) => {
          const next = new Map(prev);
          for (const id of done) next.delete(id);
          return next;
        });
        onSaved(done);
      }
      setBusy(null);
    }
  };

  const chosen = children.find((c) => c.id === selected) ?? null;
  const chosenBox = chosen === null ? null : boxOf(chosen.id);
  const status = (l: LocationView): { text: string; tone: TagTone } => {
    if (drafts.has(l.id)) return { text: t('catalog.locations.map.status.changed'), tone: 'warn' };
    if (redraw.has(l.id)) return { text: t('catalog.locations.badge.redraw'), tone: 'bad' };
    if (l.box !== null) return { text: t('catalog.locations.map.status.saved'), tone: 'ok' };
    return { text: t('catalog.locations.map.status.none'), tone: 'neutral' };
  };

  return (
    <section aria-labelledby={headingId} className={cn('grid gap-4 rounded-lg border p-4', LAYER)}>
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 id={headingId} ref={heading} tabIndex={-1} className="text-base font-bold outline-none">
          {t('catalog.locations.map.title', { name: room.name })}
        </h2>
        <Button type="button" variant="outline" size="sm" className="bg-background" onClick={onClose}>
          {t('catalog.locations.map.close')}
        </Button>
      </div>

      {room.mapFileId === null ? (
        <p className="max-w-[75ch] text-sm text-muted-foreground">{t('catalog.locations.map.no_plan')}</p>
      ) : (
        <div
          ref={surface}
          data-map-surface
          className={cn('relative w-full max-w-4xl touch-none overflow-hidden rounded-md border bg-background select-none', canManage && selected !== null && 'cursor-crosshair')}
          onPointerDown={pointerDown}
          onPointerMove={pointerMove}
          onPointerUp={pointerUp}
          onPointerCancel={pointerCancel}>
          <img
            src={`/files/${encodeURIComponent(room.mapFileId)}`}
            alt={t('catalog.locations.map.plan_alt', { name: room.name })}
            draggable={false}
            className="pointer-events-none block h-auto w-full"
          />
          {children.map((l) => {
            const box = boxOf(l.id);
            if (box === null) return null;
            const isChosen = l.id === selected;
            const style = { left: `${box.x / 10}%`, top: `${box.y / 10}%`, width: `${box.w / 10}%`, height: `${box.h / 10}%` };
            const caption = (
              <span className="pointer-events-none absolute top-0 left-0 max-w-full truncate bg-background px-1 text-xs leading-4">{l.shelfHint ?? l.name}</span>
            );
            if (!canManage) {
              return (
                <div key={l.id} role="img" aria-label={t('catalog.locations.map.box_label', { name: l.name })} className="absolute border-2 border-primary bg-primary/15" style={style}>
                  {caption}
                </div>
              );
            }
            return (
              <div
                key={l.id}
                data-box-id={l.id}
                role="button"
                tabIndex={0}
                aria-pressed={isChosen}
                aria-label={t('catalog.locations.map.box_label', { name: l.name })}
                aria-describedby={hintId}
                className={cn(
                  'absolute cursor-move border-2 outline-none focus-visible:ring-2 focus-visible:ring-ring',
                  isChosen ? 'z-10 border-primary bg-primary/25' : 'border-warn bg-warn-bg/60',
                )}
                style={style}
                onFocus={() => setSelected(l.id)}
                onKeyDown={(e) => nudge(e, l.id)}>
                {caption}
                {isChosen && (
                  <span data-box-handle aria-hidden="true" className="absolute -right-1.5 -bottom-1.5 size-3 cursor-nwse-resize rounded-sm border-2 border-primary bg-background" />
                )}
              </div>
            );
          })}
        </div>
      )}

      {canManage && (
        <div className="flex flex-wrap items-end gap-3">
          <div className="grid gap-1">
            <Label htmlFor={fileId}>{t(room.mapFileId === null ? 'catalog.locations.map.upload' : 'catalog.locations.map.replace')}</Label>
            <FileInput
              ref={fileInput}
              id={fileId}
              accept="image/jpeg,image/png,image/webp"
              aria-describedby={`${fileId}-hint`}
              disabled={busy !== null}
              onChange={(e) => void choosePlan(e)}
            />
            <p id={`${fileId}-hint`} className="text-xs text-muted-foreground">
              {t('catalog.locations.map.upload_hint')}
            </p>
          </div>
          {room.mapFileId !== null && (
            <Button type="button" variant="outline" size="sm" className="bg-background" disabled={busy !== null} onClick={() => void removePlan()}>
              {t('catalog.locations.map.remove_plan')}
            </Button>
          )}
        </div>
      )}
      {busy === 'plan' && (
        <p role="status" className="text-sm text-muted-foreground">
          {t('catalog.locations.map.uploading')}
        </p>
      )}
      {planNotice !== null && <Notice kind={planNotice.tone}>{planNotice.text}</Notice>}

      {canManage && room.mapFileId !== null && (
        <p id={hintId} className="text-sm text-muted-foreground">
          {t('catalog.locations.map.draw_hint')}
        </p>
      )}

      <fieldset className="grid gap-2">
        <legend className="mb-1 text-sm font-bold">{t('catalog.locations.map.children')}</legend>
        {children.length === 0 ? (
          <p className="text-sm text-muted-foreground">{t('catalog.locations.map.no_children')}</p>
        ) : (
          <ul className="grid gap-1">
            {children.map((l) => {
              const s = status(l);
              const radioId = `${ids}-child-${l.id}`;
              return (
                <li key={l.id} className="flex flex-wrap items-center gap-2 text-sm">
                  {canManage ? (
                    <>
                      <input
                        id={radioId}
                        type="radio"
                        name={`${ids}-child`}
                        className="size-4 accent-primary"
                        checked={selected === l.id}
                        onChange={() => setSelected(l.id)}
                      />
                      <label htmlFor={radioId}>{l.name}</label>
                    </>
                  ) : (
                    <span>{l.name}</span>
                  )}
                  <Tag>{t(vocabKey('location_kind', l.kind))}</Tag>
                  <Tag tone={s.tone}>{s.text}</Tag>
                </li>
              );
            })}
          </ul>
        )}
      </fieldset>

      {canManage && chosen !== null && (
        <fieldset className="grid gap-3">
          <legend className="mb-1 text-sm font-bold">{t('catalog.locations.map.coords', { name: chosen.name })}</legend>
          {chosenBox === null ? (
            <div>
              <Button type="button" variant="outline" size="sm" className="bg-background" disabled={room.mapFileId === null} onClick={() => setDraft(chosen.id, NEW_BOX)}>
                {t('catalog.locations.map.new_box')}
              </Button>
            </div>
          ) : (
            <div className="flex flex-wrap items-end gap-3">
              {(['x', 'y', 'w', 'h'] as const).map((field) => (
                <div key={field} className="grid w-24 gap-1">
                  <Label htmlFor={`${ids}-${field}`}>{t(`catalog.locations.map.${field}`)}</Label>
                  <Input
                    id={`${ids}-${field}`}
                    type="number"
                    inputMode="numeric"
                    min={field === 'w' || field === 'h' ? 1 : 0}
                    max={1000}
                    step={1}
                    value={String(chosenBox[field])}
                    onChange={(e) => typed(chosen.id, field, e.target.value)}
                  />
                </div>
              ))}
              <Button type="button" variant="outline" size="sm" className="bg-background" onClick={() => setDraft(chosen.id, null)}>
                {t('catalog.locations.map.remove_box')}
              </Button>
            </div>
          )}
        </fieldset>
      )}

      {canManage && (
        <div className="flex flex-wrap items-center gap-2">
          <Button type="button" size="sm" disabled={drafts.size === 0 || busy !== null} onClick={() => void saveBoxes()}>
            {t(busy === 'boxes' ? 'form.saving' : 'catalog.locations.map.save')}
          </Button>
          {drafts.size > 0 && (
            <>
              <Button type="button" variant="outline" size="sm" className="bg-background" disabled={busy !== null} onClick={() => setDrafts(new Map())}>
                {t('catalog.locations.map.discard')}
              </Button>
              <StatusText tone="warn" className="text-meta">
                {t('catalog.locations.map.unsaved', { count: drafts.size })}
              </StatusText>
            </>
          )}
        </div>
      )}
      {boxNotice !== null && <Notice kind={boxNotice.tone}>{boxNotice.text}</Notice>}
    </section>
  );
}
