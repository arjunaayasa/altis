import { vocabKey, type LocationKind } from '@altis/shared';
import type { LocationView } from '@altis/shared/api/catalog/locations';
import { Tag } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { useT } from '@/i18n';
import { useCount } from '@/screens/catalog/masters/master-table';

/**
 * The location tree of one branch (Phase 2 spec §3.6; plan Task 27): rooms › areas › shelves as nested lists, in the
 * server's tree order (each room, then its subtree), drawn as one bordered list with thin lines between the rows and
 * each level indented. Each line shows the kind, the code, a shelf's call-number range and the live items placed
 * directly on it, plus its actions. The helpers below also answer which room a location
 * belongs to, for the shelf map: a box is drawn on its room's floor plan.
 */

export interface LocationNode {
  location: LocationView;
  children: LocationNode[];
}

/**
 * The rows as a forest, in their order: a row whose parent is not listed is a root. Hand-made data with a loop is still
 * shown once (a row already placed is never placed again; what no root reaches becomes a root).
 */
export function buildTree(rows: readonly LocationView[]): LocationNode[] {
  const ids = new Set(rows.map((r) => r.id));
  const childrenOf = new Map<string, LocationView[]>();
  const roots: LocationView[] = [];
  for (const r of rows) {
    if (r.parentId === null || r.parentId === r.id || !ids.has(r.parentId)) {
      roots.push(r);
      continue;
    }
    const list = childrenOf.get(r.parentId);
    if (list === undefined) childrenOf.set(r.parentId, [r]);
    else list.push(r);
  }
  const placed = new Set<string>();
  const make = (r: LocationView): LocationNode => {
    placed.add(r.id);
    const node: LocationNode = { location: r, children: [] };
    for (const c of childrenOf.get(r.id) ?? []) if (!placed.has(c.id)) node.children.push(make(c));
    return node;
  };
  const forest = roots.map(make);
  for (const r of rows) if (!placed.has(r.id)) forest.push(make(r));
  return forest;
}

/** Every location below `id` (its areas and shelves), in the rows' order. */
export function descendantsOf(rows: readonly LocationView[], id: string): LocationView[] {
  const below = new Set<string>([id]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const r of rows) {
      if (r.parentId !== null && below.has(r.parentId) && !below.has(r.id)) {
        below.add(r.id);
        grew = true;
      }
    }
  }
  below.delete(id);
  return rows.filter((r) => below.has(r.id));
}

type Placed = Pick<LocationView, 'id' | 'kind' | 'parentId'>;

/** The room `id` belongs to (itself for a room), or null. */
export function roomOf(byId: ReadonlyMap<string, Placed>, id: string): string | null {
  const seen = new Set<string>();
  let current = byId.get(id);
  while (current !== undefined && !seen.has(current.id)) {
    if (current.kind === 'room') return current.id;
    seen.add(current.id);
    current = current.parentId === null ? undefined : byId.get(current.parentId);
  }
  return null;
}

/**
 * The boxes that a change of `id`'s parent or kind leaves on the wrong floor plan: the location and the ones below it
 * that have a box and now belong to another room (the server clears them and names them, Task 40). `room` is the
 * room they belong to now.
 */
export function boxesMovedBy(
  rows: readonly LocationView[],
  id: string,
  patch: { parentId?: string | null; kind?: LocationKind },
): { moved: LocationView[]; room: LocationView | null } {
  const self = rows.find((r) => r.id === id);
  if (self === undefined) return { moved: [], room: null };
  const before = new Map<string, Placed>(rows.map((r) => [r.id, r]));
  const after = new Map(before);
  const changed: Placed = { id, kind: patch.kind ?? self.kind, parentId: patch.parentId !== undefined ? patch.parentId : self.parentId };
  after.set(id, changed);
  const moved = [self, ...descendantsOf(rows, id)].filter(
    (l) => l.box !== null && (after.get(l.id)?.kind ?? l.kind) !== 'room' && roomOf(before, l.id) !== roomOf(after, l.id),
  );
  const roomId = roomOf(after, id);
  return { moved, room: rows.find((r) => r.id === roomId) ?? null };
}

/** What a line of the tree may do. */
export interface TreeActions {
  canManage: boolean;
  /** The locations whose box must be drawn again. */
  redraw: ReadonlySet<string>;
  onAdd(parent: LocationView): void;
  onEdit(location: LocationView): void;
  onArchive(location: LocationView): void;
  onMap(room: LocationView): void;
}

export function LocationTree({ nodes, label, actions }: { nodes: readonly LocationNode[]; label: string; actions: TreeActions }) {
  return (
    <ul aria-label={label} className="overflow-hidden rounded-lg border text-sm [&>li:first-child>[data-location-row]]:border-t-0">
      {nodes.map((node) => (
        <TreeItem key={node.location.id} node={node} depth={0} actions={actions} />
      ))}
    </ul>
  );
}

/** The indent of a row at `depth` (rooms at 0): 12 px, then 24 px per level. */
const indent = (depth: number): { paddingLeft: string } => ({ paddingLeft: `${12 + Math.min(depth, 6) * 24}px` });

function TreeItem({ node, depth, actions }: { node: LocationNode; depth: number; actions: TreeActions }) {
  const t = useT();
  const count = useCount();
  const l = node.location;
  const live = !l.archived;
  return (
    <li>
      <div data-location-row className="flex flex-wrap items-center gap-x-3 gap-y-1 border-t py-2 pr-2" style={indent(depth)}>
        <span data-location-name className={l.kind === 'room' ? 'font-bold' : 'font-semibold'}>
          {l.name}
        </span>
        <Tag>{t(vocabKey('location_kind', l.kind))}</Tag>
        <span className="text-muted-foreground">{l.code}</span>
        {l.classFrom !== null && l.classTo !== null && <span>{t('catalog.locations.class_range', { from: l.classFrom, to: l.classTo })}</span>}
        <span className="text-muted-foreground tabular-nums">{t('catalog.locations.items', { count: count(l.itemCount) })}</span>
        {l.archived && <Tag>{t('catalog.locations.badge.archived')}</Tag>}
        {!l.isPublic && <Tag>{t('catalog.locations.badge.hidden')}</Tag>}
        {l.kind === 'room' && l.mapFileId !== null && <Tag>{t('catalog.locations.badge.plan')}</Tag>}
        {actions.redraw.has(l.id) && <Tag tone="bad">{t('catalog.locations.badge.redraw')}</Tag>}
        <span className="ml-auto flex flex-wrap">
          {actions.canManage && live && l.kind !== 'shelf' && (
            <Button variant="ghost" size="sm" aria-label={t('catalog.locations.action.add_inside', { name: l.name })} onClick={() => actions.onAdd(l)}>
              {t('catalog.locations.action.add')}
            </Button>
          )}
          {live && l.kind === 'room' && (
            <Button variant="ghost" size="sm" aria-label={t('catalog.locations.action.map_named', { name: l.name })} onClick={() => actions.onMap(l)}>
              {t('catalog.locations.action.map')}
            </Button>
          )}
          <Button
            variant="ghost"
            size="sm"
            aria-label={t(actions.canManage ? 'catalog.locations.action.edit_named' : 'catalog.locations.action.view_named', { name: l.name })}
            onClick={() => actions.onEdit(l)}>
            {t(actions.canManage ? 'catalog.locations.action.edit' : 'catalog.locations.action.view')}
          </Button>
          {actions.canManage && live && (
            <Button variant="ghost" size="sm" aria-label={t('catalog.locations.action.archive_named', { name: l.name })} onClick={() => actions.onArchive(l)}>
              {t('catalog.locations.action.archive')}
            </Button>
          )}
        </span>
      </div>
      {node.children.length > 0 && (
        <ul>
          {node.children.map((child) => (
            <TreeItem key={child.location.id} node={child} depth={depth + 1} actions={actions} />
          ))}
        </ul>
      )}
    </li>
  );
}
