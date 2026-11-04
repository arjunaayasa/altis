import type { LocationKind } from '@altis/shared';
import type { BranchListResponse, BranchView } from '@altis/shared/api/branches';
import type { StoreResponse } from '@altis/shared/api/catalog/common';
import type { LocationListResponse, LocationView } from '@altis/shared/api/catalog/locations';
import type { MeResponse } from '@altis/shared/api/auth';
import { keepPreviousData, useQueryClient } from '@tanstack/react-query';
import { useNavigate, useSearch } from '@tanstack/react-router';
import { MapIcon, PlusIcon } from 'lucide-react';
import { useMemo, useState, type ReactNode } from 'react';
import { ConfirmDialog } from '@/components/confirm-dialog';
import { CheckField, Field, Notice, NoticeAlert, SELECT_CLASS } from '@/components/form-field';
import { useReturnFocus } from '@/components/return-focus';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { useT } from '@/i18n';
import { holdsAt } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { isWritableBranch } from '@/lib/branches';
import { useApiQuery, useMe } from '@/lib/me';
import { countsIn, isStale } from '@/screens/catalog/masters/master-table';
import { LocationForm, type LocationSaved } from './location-form';
import { MapEditor } from './map-editor';
import { LocationTree, boxesMovedBy, buildTree } from './tree';

/**
 * Lokasi & Rak (Phase 2 spec §13, §3.6; plan Task 27; the API of Task 14): the locations of one branch as a tree
 * (room › area › shelf) with create, edit and archive, a shelf's call-number range, and each room's shelf map
 * (map-editor.tsx).
 *
 * - The branch lives in the URL (`?branchId=`); without one (or with one that is not a live branch) the screen opens a
 *   branch where the user may manage locations, the default branch first, else the default branch.
 * - Locations are branch-scoped (D2-02): every write is `branches/:branchId/locations…`, which needs
 *   `catalog.locations.manage` at that branch, and a branch the server marks writable (L13, `isWritableBranch`).
 *   Elsewhere the tree is read only (and says why).
 * - Archiving sends the row's `{version}`; a location that still holds live locations or items is refused with 409
 *   CATALOG_IN_USE (Review Focus 2) and the screen says what it holds: the counts of the problem's `detail` (Task 14
 *   writes them there), else what the tree shows. After a stale version (CONFLICT_STALE) the tree is read again, so
 *   confirming again, or the form opened again, works on the location as it is now.
 * - The open shelf map's unsaved boxes are never dropped without a question (L15): closing the map, opening another
 *   room's map or another branch asks first ({@link useDiscardGuard}); the "Tampilkan arsip" toggle keeps the tree (and
 *   the map) shown while the list is read again.
 * - Moving a location to another room clears the boxes drawn on the old room's plan: the server names them in its
 *   answer (`boxesCleared`, Task 40). After such a move the screen says so, marks those locations "Perlu digambar
 *   ulang" and opens the new room's map on request; the mark goes once their boxes are saved there. The mark lives on
 *   this page only (after a reload they show as having no box).
 */

/** Whether `me` may write the locations of `b`: the grant there, and `b` writable (live and active). */
function managesAt(me: MeResponse | undefined, b: BranchView): boolean {
  return holdsAt(me, 'catalog.locations.manage', b.id) && isWritableBranch(b);
}

/** The branch the screen opens without a usable `?branchId=`. */
function preferredBranch(branches: readonly BranchView[], me: MeResponse | undefined): BranchView | undefined {
  const manages = (b: BranchView): boolean => managesAt(me, b);
  return branches.find((b) => b.isDefault && manages(b)) ?? branches.find(manages) ?? branches.find((b) => b.isDefault) ?? branches[0];
}

/**
 * Asks before an action that would drop the open map's `count` unsaved boxes (L15); runs it at once when there are
 * none. `dialog` is the question, to render once.
 */
function useDiscardGuard(count: number): { guard(action: () => void): void; dialog: ReactNode } {
  const t = useT();
  const [pending, setPending] = useState<{ run(): void } | null>(null);
  const guard = (action: () => void): void => {
    if (count > 0) setPending({ run: action });
    else action();
  };
  const dialog = (
    <ConfirmDialog
      open={pending !== null}
      destructive
      title={t('catalog.locations.map.discard_title')}
      description={t('catalog.locations.map.discard_body', { count })}
      confirmLabel={t('catalog.locations.map.discard_confirm')}
      onConfirm={async () => {
        pending?.run();
        await Promise.resolve();
      }}
      onClose={() => setPending(null)}
    />
  );
  return { guard, dialog };
}

/** `/admin/catalog/locations` (`?branchId=`). */
export function LocationsScreen() {
  const t = useT();
  const me = useMe();
  const navigate = useNavigate();
  /** The open map's unsaved boxes (L15): another branch asks first while there are some. */
  const [mapDrafts, setMapDrafts] = useState(0);
  const discard = useDiscardGuard(mapDrafts);
  const wanted = (useSearch({ strict: false }) as Record<string, unknown>)['branchId'];
  const branches = useApiQuery<BranchListResponse>({ queryKey: ['branches', { includeArchived: false }], path: 'branches' });
  const list = branches.data?.items ?? [];
  const branch = list.find((b) => b.id === wanted) ?? preferredBranch(list, me);

  return (
    <div className="flex flex-col gap-4">
      <h1 className="text-2xl font-semibold">{t('nav.catalog.locations')}</h1>
      <p className="max-w-3xl text-sm text-muted-foreground">{t('catalog.locations.intro')}</p>
      {branches.data === undefined ? (
        branches.isError ? (
          <Notice kind="error">{problemText(t, branches.error)}</Notice>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {t('shell.loading')}
          </p>
        )
      ) : branch === undefined ? (
        <p className="text-sm text-muted-foreground">{t('catalog.locations.no_branches')}</p>
      ) : (
        <>
          <Field label={t('catalog.locations.branch')} className="max-w-sm">
            {(c) => (
              <select
                {...c}
                className={SELECT_CLASS}
                value={branch.id}
                onChange={(e) => {
                  const branchId = e.target.value;
                  discard.guard(() => void navigate({ to: '/admin/catalog/locations', search: { branchId } }));
                }}>
                {list.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name} ({b.code})
                  </option>
                ))}
              </select>
            )}
          </Field>
          <BranchLocations
            key={branch.id}
            branch={branch}
            canManage={managesAt(me, branch)}
            outside={!isWritableBranch(branch)}
            guard={discard.guard}
            onMapDrafts={setMapDrafts}
          />
          {discard.dialog}
        </>
      )}
    </div>
  );
}

type Editing = { mode: 'create'; kind: LocationKind; parentId: string | null } | { mode: 'edit'; location: LocationView };

/**
 * One branch's tree, its dialogs and its map; everything here starts over when the branch changes. `guard` runs an
 * action that closes or replaces the open map (asking first while it has unsaved boxes, which `onMapDrafts` hears).
 */
function BranchLocations({
  branch,
  canManage,
  outside,
  guard,
  onMapDrafts,
}: {
  branch: BranchView;
  canManage: boolean;
  outside: boolean;
  guard(action: () => void): void;
  onMapDrafts(count: number): void;
}) {
  const t = useT();
  const queryClient = useQueryClient();
  const focus = useReturnFocus();
  const [showArchived, setShowArchived] = useState(false);
  const [editing, setEditing] = useState<Editing | null>(null);
  const [archiving, setArchiving] = useState<LocationView | null>(null);
  const [notice, setNotice] = useState<{ tone: 'success' | 'error'; text: string } | null>(null);
  const [moved, setMoved] = useState<{ name: string; roomId: string; roomName: string; ids: readonly string[] } | null>(null);
  const [redraw, setRedraw] = useState<ReadonlySet<string>>(new Set());
  const [mapRoomId, setMapRoomId] = useState<string | null>(null);
  const locations = useApiQuery<LocationListResponse>({
    queryKey: ['catalog', 'locations', { branchId: branch.id, includeArchived: showArchived }],
    path: `catalog/locations?branchId=${encodeURIComponent(branch.id)}${showArchived ? '&includeArchived=true' : ''}`,
    // The tree (and the open map with its unsaved boxes) stays while the other list is read (L15).
    placeholderData: keepPreviousData,
  });
  const rows = useMemo(() => locations.data?.items ?? [], [locations.data]);
  const nodes = useMemo(() => buildTree(rows), [rows]);
  const mapRoom = rows.find((r) => r.id === mapRoomId && r.kind === 'room' && !r.archived) ?? null;
  /** Opens the map of `roomId` (or closes it: null), asking first when that drops unsaved boxes. */
  const showMap = (roomId: string | null): void => {
    if (roomId === mapRoomId) return;
    guard(() => setMapRoomId(roomId));
  };

  const refresh = (): Promise<void> => queryClient.invalidateQueries({ queryKey: ['catalog', 'locations'] });

  const saved = async (s: LocationSaved): Promise<void> => {
    if (s.id !== null && s.moved !== null && s.boxesCleared.length > 0) {
      const { room } = boxesMovedBy(rows, s.id, s.moved);
      if (room !== null) {
        const ids = [...s.boxesCleared];
        setRedraw((prev) => new Set([...prev, ...ids]));
        setMoved({ name: s.name, roomId: room.id, roomName: room.name, ids });
      }
    }
    await refresh();
    setNotice({ tone: 'success', text: t('catalog.locations.done.saved', { name: s.name }) });
    setEditing(null);
  };

  const archive = async (l: LocationView): Promise<void> => {
    setNotice(null);
    // The location as last read: after a stale refusal the tree is read again, and confirming again sends its version.
    const current = rows.find((r) => r.id === l.id) ?? l;
    try {
      await api<StoreResponse>('DELETE', `branches/${encodeURIComponent(branch.id)}/locations/${encodeURIComponent(l.id)}`, { version: current.version });
    } catch (e) {
      if (e instanceof ApiError && e.code === 'CATALOG_IN_USE') {
        const [children, items] = countsIn(e.detail);
        const liveChildren = rows.filter((r) => r.parentId === l.id && !r.archived).length;
        setNotice({
          tone: 'error',
          text: t('catalog.locations.in_use', { name: l.name, children: children ?? liveChildren, items: items ?? current.itemCount }),
        });
        await refresh();
        return;
      }
      if (isStale(e)) await refresh();
      throw e;
    }
    setNotice({ tone: 'success', text: t('catalog.locations.done.archived', { name: l.name }) });
    if (mapRoomId === l.id) setMapRoomId(null);
    await refresh();
  };

  const mapSaved = (ids: readonly string[]): void => {
    setRedraw((prev) => new Set([...prev].filter((id) => !ids.includes(id))));
  };

  const open = (next: Editing): void => {
    setNotice(null);
    setEditing(next);
  };

  const stillMoved = moved !== null && moved.ids.some((id) => redraw.has(id)) ? moved : null;
  const title =
    editing === null
      ? ''
      : editing.mode === 'create'
        ? t('catalog.locations.form.create_title')
        : canManage
          ? t('catalog.locations.form.edit_title')
          : t('catalog.locations.form.view_title', { name: editing.location.name });

  return (
    <div className="flex flex-col gap-4">
      {!canManage && (
        <p className="rounded-md border bg-muted/50 px-3 py-2 text-sm">{t(outside ? 'catalog.locations.outside_limit' : 'catalog.locations.read_only')}</p>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <CheckField label={t('catalog.locations.show_archived')} checked={showArchived} onChange={(e) => setShowArchived(e.target.checked)} />
        {canManage && (
          <Button onClick={() => open({ mode: 'create', kind: 'room', parentId: null })}>
            <PlusIcon aria-hidden="true" />
            {t('catalog.locations.add_room')}
          </Button>
        )}
      </div>
      {notice !== null && <Notice kind={notice.tone}>{notice.text}</Notice>}
      {stillMoved !== null && (
        <NoticeAlert>
          <span className="flex flex-wrap items-center gap-2">
            <span>{t('catalog.locations.redraw', { name: stillMoved.name, room: stillMoved.roomName })}</span>
            <Button type="button" variant="outline" size="sm" onClick={() => showMap(stillMoved.roomId)}>
              <MapIcon aria-hidden="true" />
              {t('catalog.locations.redraw_open', { room: stillMoved.roomName })}
            </Button>
          </span>
        </NoticeAlert>
      )}
      {locations.data === undefined ? (
        locations.isError ? (
          <Notice
            kind="error"
            action={
              <Button variant="outline" size="sm" onClick={() => void locations.refetch()}>
                {t('table.retry')}
              </Button>
            }>
            {problemText(t, locations.error)}
          </Notice>
        ) : (
          <p role="status" className="text-sm text-muted-foreground">
            {t('shell.loading')}
          </p>
        )
      ) : nodes.length === 0 ? (
        <p className="text-sm text-muted-foreground">{t('catalog.locations.empty')}</p>
      ) : (
        <LocationTree
          nodes={nodes}
          label={t('catalog.locations.tree_label', { branch: branch.name })}
          actions={{
            canManage,
            redraw,
            onAdd: (parent) => open({ mode: 'create', kind: 'shelf', parentId: parent.id }),
            onEdit: (location) => open({ mode: 'edit', location }),
            onArchive: (location) => setArchiving(location),
            onMap: (room) => showMap(room.id),
          }}
        />
      )}
      {mapRoom !== null && (
        <MapEditor
          key={mapRoom.id}
          branchId={branch.id}
          room={mapRoom}
          rows={rows}
          canManage={canManage}
          redraw={redraw}
          onSaved={mapSaved}
          onClose={() => showMap(null)}
          onDraftsChange={onMapDrafts}
        />
      )}
      <Dialog open={editing !== null} onOpenChange={(next) => (next ? undefined : setEditing(null))}>
        {editing !== null && (
          <DialogContent
            closeLabel={t('catalog.locations.form.close')}
            onOpenAutoFocus={focus.onOpenAutoFocus}
            onCloseAutoFocus={focus.onCloseAutoFocus}
            className="max-h-[90vh] overflow-y-auto sm:max-w-2xl">
            <DialogHeader>
              <DialogTitle>{title}</DialogTitle>
              <DialogDescription>{t('catalog.locations.intro')}</DialogDescription>
            </DialogHeader>
            <LocationForm
              branchId={branch.id}
              rows={rows}
              location={editing.mode === 'edit' ? editing.location : null}
              start={editing.mode === 'create' ? { kind: editing.kind, parentId: editing.parentId } : { kind: 'room', parentId: null }}
              canManage={canManage}
              onSaved={saved}
              onCancel={() => setEditing(null)}
            />
          </DialogContent>
        )}
      </Dialog>
      {archiving !== null && (
        <ConfirmDialog
          open
          destructive
          title={t('catalog.locations.confirm.archive.title', { name: archiving.name })}
          description={t('catalog.locations.confirm.archive.body')}
          confirmLabel={t('catalog.locations.action.archive')}
          onConfirm={() => archive(archiving)}
          onClose={() => setArchiving(null)}
        />
      )}
    </div>
  );
}
