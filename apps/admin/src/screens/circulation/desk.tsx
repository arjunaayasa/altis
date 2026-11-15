import { MEMBER_BLOCK_REASONS, RENEW_REFUSALS, VOID_REFUSALS, type ForceableReason, type MemberBlockReason, type RenewRefusal, type VoidRefusal } from '@altis/shared';
import type { PaymentView } from '@altis/shared/api/charges';
import type {
  CirculationWarningView,
  DeskLoanView,
  DeskMemberSearchResponse,
  DeskMemberSummary,
  DeskMemberView,
  InLibraryUseResponse,
  LoanListResponse,
  LoanResponse,
  LoanVoidResponse,
  RenewAllResponse,
  RenewResponse,
  ReturnResponse,
} from '@altis/shared/api/circulation';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import {
  CircleAlertIcon,
  CircleCheckIcon,
  InfoIcon,
  KeyboardIcon,
  ScanBarcodeIcon,
  TriangleAlertIcon,
  UserRoundIcon,
  Volume2Icon,
  VolumeXIcon,
} from 'lucide-react';
import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Badge, Notice, SELECT_CLASS } from '@/components/form-field';
import { Alert, AlertDescription } from '@/components/ui/alert';
import { Button } from '@/components/ui/button';
import { Dialog, DialogContent, DialogDescription, DialogHeader, DialogTitle } from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger } from '@/components/ui/tabs';
import { useT, type TKey, type Translate } from '@/i18n';
import { holds, holdsAt } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useMe } from '@/lib/me';
import { useScannerInput } from '@/lib/scanner';
import { useShortcuts } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import { ExtendDialog } from '@/screens/members/common';
import { DueDialog, LostDialog } from './desk-dialogs';
import {
  DESK_SOUND_KEY,
  DueBadge,
  MemberStatusBadge,
  beep,
  limitText,
  newTransactionKey,
  readStored,
  todayLocal,
  useCalendarDate,
  useDeskBranch,
  useTypeName,
  writeStored,
} from './common';
// ---- Komunitas (holds) ----
import { HoldSlipPrint, MemberHoldsPanel, type HoldSlip } from './holds';
// ---- Komunitas (charges and payments) ----
import { MemberChargesPanel, printSlip, receiptHref, useMoney } from './charges';

/**
 * Meja Layanan (`/admin/layanan`) and Kembali Cepat (`/admin/layanan/kembali`): the circulation desk, built for a
 * barcode scanner and the keyboard.
 *
 * - **One box.** The scan box takes a member card, an item barcode or a name, by mode: Anggota & pinjam (F2: no member
 *   yet → find the member by number; a member loaded → lend the scanned item), Kembali (F3: return by barcode alone)
 *   and Cari nama (F6: up to ten suggestions while typing; Enter takes the highlighted one, and always acts on the text
 *   in the box: before the suggestions of that text have arrived, it searches for it first). A scanner anywhere on the
 *   page counts (`useScannerInput`), and the box takes the focus back after every action and dialog. An item scanned
 *   while the member's panel is still loading waits for it; a scan while a dialog is open is not processed and the desk
 *   says so.
 * - **One scan, one transaction.** Each loan, return and renewal is its own request with its own `Idempotency-Key`; a
 *   request that met no server at all keeps its key, so scanning the same barcode again cannot lend twice. Scans that
 *   come faster than the server answers wait in line, in order; none is dropped.
 * - **Feedback in three layers.** A colour (the top edge of the scan card and a short flash of the box), a sentence big
 *   enough to read from across the desk, and an optional beep. Screen readers hear the same sentence from two fixed
 *   live regions outside the area that re-renders: `status` for done and "look at this", `alert` for refused.
 * - **Offers, never guesses.** An item the member already holds offers "Kembalikan sekarang?" and a barcode that is
 *   another member's card offers "Ganti ke anggota ini?"; both wait for Enter (or the button) and Esc cancels them.
 * - **Esc** steps back one level at a time: the suggestions, an offer, the name search, then "done with this member"
 *   (the visit list is cleared).
 * - The desk branch is chosen once and kept in this browser; the member panel lists the member's open loans at every
 *   branch, with Kembalikan (K), Perpanjang (P) and Perpanjang semua (Shift+P) on the focused row.
 * - Baca di tempat (F4, and `/admin/layanan/baca` as a page of its own) counts each scanned item as read in the
 *   library; an item on loan or recorded missing or lost is still counted and the desk says so.
 * - With `circulation.desk.override` at the branch: a refusal the desk may force (a collection type or a rule that does
 *   not allow the loan, a limit) offers "Paksa pinjam" (Enter), which asks for the reason and sends the loan again with
 *   it; "Pinjaman tercatat mundur" enters loans of an earlier day (at most 30 days back) with a note; and a loan row
 *   offers "Ubah jatuh tempo". Ctrl+Z voids the last loan of this visit (within the library's void window). A loan row
 *   offers "Hilang" (H). An item recorded lost that comes back offers "Terima kembali" (Enter).
 * - Charges (charges.tsx): an overdue loan shows its running fine; the Denda tab shows the balance, the open charges and
 *   the last payments, takes payments (B on a loan or charge row, Shift+B for all) with a link to print the receipt,
 *   waives and books charges by hand. A member blocked by the library's optional blocks is told why.
 */

type Mode = 'member' | 'return' | 'name' | 'read';
type Tone = 'idle' | 'success' | 'warning' | 'error' | 'info';

interface Feedback {
  tone: Tone;
  title: string;
  detail?: string;
  seq: number;
}

type Offer =
  | { kind: 'switch'; memberNo: string }
  | { kind: 'return'; barcode: string }
  // ---- Komunitas (circulation core) ----
  | { kind: 'force'; barcode: string; reasons: ForceableReason[] }
  | { kind: 'found_lost'; barcode: string };

interface VisitRow {
  seq: number;
  kind: 'loan' | 'return' | 'renew' | 'refused' | 'voided';
  title: string;
  barcode: string;
  note: string;
  /** The loan of a loan, renewal or return (the slip lists it). */
  refId?: string;
}

interface ReturnRow {
  seq: number;
  barcode: string;
  title: string;
  memberNo: string | null;
  dueOn: string;
  daysLate: number;
  otherBranch: string | null;
  /** The member number the copy is kept for on the hold shelf. */
  keptFor: string | null;
}

type PanelTab = 'visit' | 'loans' | 'holds' | 'charges' | 'history';

/** One item read in place at this desk, the newest first. */
interface ReadRow {
  seq: number;
  barcode: string;
  title: string;
  note: string | null;
}

/** The forceable reason of a refused loan, or null when the desk cannot force it. */
export function forceableOf(e: unknown): ForceableReason | null {
  if (!(e instanceof ApiError)) return null;
  const code: string = e.code;
  if (code === 'CIRC_NOT_LOANABLE' && (e.reason === 'collection_type' || e.reason === 'policy')) return e.reason;
  if (code === 'CIRC_LIMIT_REACHED') return 'limit';
  if (code === 'CIRC_ITEM_ON_HOLD') return 'hold';
  if (code === 'CIRC_MEMBER_BLOCKED') return 'blocked';
  return null;
}

const isVoidRefusal = (s: string | undefined): s is VoidRefusal => s !== undefined && (VOID_REFUSALS as readonly string[]).includes(s);

/** The query key of a member's desk panel at a branch. */
const deskMemberKey = (branchId: string, memberId: string) => ['circulation', 'desk', branchId, 'member', memberId] as const;

/** A barcode as the server compares it: no CR, LF or TAB, trimmed, one space per run of spaces, upper case. */
const normalizeCode = (s: string): string => s.replace(/[\r\n\t]/g, '').trim().replace(/ {2,}/g, ' ').toUpperCase();

const isRenewRefusal = (s: string | undefined): s is RenewRefusal => s !== undefined && (RENEW_REFUSALS as readonly string[]).includes(s);

const isBlockReason = (s: string | undefined | null): s is MemberBlockReason => typeof s === 'string' && (MEMBER_BLOCK_REASONS as readonly string[]).includes(s);

type DeskAction = 'lookup' | 'loan' | 'return' | 'renew';

/**
 * The sentence for a refused desk action, from the problem's code and, when the server sends one, its reason word
 * (`status`/`collection_type`/`policy` for an item that may not be lent, the renewal refusal, `member_no` for a barcode
 * that is a member card, `same_member`). Without a reason the panel the desk already shows fills in what it can (the
 * member's own loans, the type's limit).
 */
export function deskRefusal(t: Translate, e: unknown, o: { action: DeskAction; code: string; member: DeskMemberView | null }): { title: string; offer?: Offer } {
  if (e instanceof TypeError) return { title: t('circulation.problem.network') };
  if (!(e instanceof ApiError)) return { title: problemText(t, e) };
  const member = o.member;
  switch (e.code) {
    case 'NOT_FOUND':
      if (o.action === 'lookup') return { title: t('circulation.problem.member_not_found', { no: o.code }) };
      if (o.action === 'loan' && e.reason === 'member_no') {
        return { title: t('circulation.problem.member_card', { no: o.code }), offer: { kind: 'switch', memberNo: o.code } };
      }
      if (o.action === 'renew') return { title: t('circulation.problem.closed_elsewhere') };
      return { title: t('circulation.problem.barcode_not_found', { barcode: o.code }) };
    case 'VALIDATION_FAILED':
      if (e.errors?.some((f) => f.code === 'isbn_not_barcode') === true) return { title: t('circulation.problem.isbn') };
      return { title: t(o.action === 'lookup' ? 'circulation.problem.member_not_found' : 'circulation.problem.barcode_not_found', { no: o.code, barcode: o.code }) };
    case 'MEMBER_EXPIRED':
      return { title: t('circulation.problem.member_expired') };
    case 'MEMBER_SUSPENDED':
      return { title: t('circulation.problem.member_suspended') };
    case 'CIRC_OTHER_BRANCH':
      return { title: t('circulation.problem.other_branch') };
    case 'CIRC_NOT_LOANABLE':
      if (e.reason === 'status') return { title: t('circulation.problem.not_available') };
      if (e.reason === 'collection_type') return { title: t('circulation.problem.reference') };
      if (e.reason === 'policy') return { title: t('circulation.problem.policy') };
      return { title: t('error.CIRC_NOT_LOANABLE') };
    case 'CIRC_ITEM_ON_LOAN': {
      const own = e.reason === 'same_member' || (member?.loans.some((l) => normalizeCode(l.item.barcode) === normalizeCode(o.code)) ?? false);
      if (own) return { title: t('circulation.problem.same_member'), offer: { kind: 'return', barcode: o.code } };
      return { title: t('circulation.problem.on_loan') };
    }
    case 'CIRC_LIMIT_REACHED': {
      const limit = member?.type.loanLimit ?? null;
      if (limit === 0) return { title: t('circulation.problem.cannot_borrow') };
      if (e.reason !== 'policy' && limit !== null && member !== null) {
        return { title: t('circulation.problem.limit', { count: member.counts.openLoans, limit }) };
      }
      return { title: t('error.CIRC_LIMIT_REACHED') };
    }
    case 'CIRC_LOAN_NOT_OPEN':
      return { title: t(o.action === 'renew' ? 'circulation.problem.closed_elsewhere' : 'circulation.problem.not_on_loan') };
    case 'CIRC_ITEM_ON_HOLD':
      return { title: t('holds.problem.item_on_hold') };
    case 'CIRC_MEMBER_BLOCKED':
      return { title: isBlockReason(e.reason) ? t('charges.member.blocked', { reason: t(`vocab.member_block_reason.${e.reason}`) }) : t('error.CIRC_MEMBER_BLOCKED') };
    case 'CIRC_RENEW_REFUSED':
      if (e.reason === 'changed') return { title: t('circulation.problem.conflict') };
      if (isRenewRefusal(e.reason)) return { title: t(`vocab.renew_refusal.${e.reason}`) };
      return { title: t('error.CIRC_RENEW_REFUSED') };
    case 'TX_CONFLICT':
    case 'CONFLICT_STALE':
      return { title: t('circulation.problem.conflict') };
    default:
      return { title: problemText(t, e) };
  }
}

/** Why the member may not borrow now, as the panel and the feedback say it. */
function borrowRefusalText(t: Translate, m: DeskMemberView): string | null {
  switch (m.borrowRefusal) {
    case 'MEMBER_SUSPENDED':
      return t('circulation.problem.member_suspended');
    case 'MEMBER_EXPIRED':
      return t('circulation.problem.member_expired');
    case 'CIRC_LIMIT_REACHED':
      if (m.type.loanLimit === 0) return t('circulation.problem.cannot_borrow');
      return m.type.loanLimit === null ? t('error.CIRC_LIMIT_REACHED') : t('circulation.problem.limit', { count: m.counts.openLoans, limit: m.type.loanLimit });
    case 'CIRC_MEMBER_BLOCKED':
      return isBlockReason(m.charges.blocked) ? t('charges.member.blocked', { reason: t(`vocab.member_block_reason.${m.charges.blocked}`) }) : t('error.CIRC_MEMBER_BLOCKED');
    default:
      return null;
  }
}

/** The warnings of an action that went through, as one sentence each. */
function warningTexts(t: Translate, day: (d: string) => string, warnings: readonly CirculationWarningView[] | undefined, dueOn?: string): string[] {
  return (warnings ?? []).map((w) => {
    switch (w.code) {
      case 'due_capped_by_expiry':
        return t('circulation.warning.due_capped', { date: day(dueOn ?? w.expiresOn ?? '') });
      case 'member_expires_soon':
        return t('circulation.warning.expires_soon', { date: day(w.expiresOn ?? '') });
      case 'return_to_branch':
        return t('circulation.warning.return_to_branch', { code: w.branchCode ?? '' });
      case 'due_moved_closed':
        return t('circulation.warning.due_moved_closed', { date: day(dueOn ?? '') });
      default:
        return t(`vocab.circulation_warning.${w.code}`);
    }
  });
}

const TONE_CARD: Record<Tone, string> = {
  idle: 'border-t-border',
  info: 'border-t-primary',
  success: 'border-t-success',
  warning: 'border-t-warning-foreground',
  error: 'border-t-destructive',
};

const TONE_FEEDBACK: Record<Tone, string> = {
  idle: 'bg-card text-card-foreground',
  info: 'bg-card text-card-foreground',
  success: 'border-success/40 bg-success-soft text-success-foreground',
  warning: 'border-warning-foreground/30 bg-warning text-warning-foreground',
  error: 'border-destructive/40 bg-destructive/10 text-destructive',
};

const TONE_FLASH: Record<Tone, string> = {
  idle: '',
  info: '',
  success: 'ring-4 ring-success/60',
  warning: 'ring-4 ring-warning-foreground/40',
  error: 'ring-4 ring-destructive/50',
};

function ToneIcon({ tone }: { tone: Tone }) {
  const cls = 'size-8 shrink-0';
  if (tone === 'success') return <CircleCheckIcon className={cls} aria-hidden="true" />;
  if (tone === 'warning') return <TriangleAlertIcon className={cls} aria-hidden="true" />;
  if (tone === 'error') return <CircleAlertIcon className={cls} aria-hidden="true" />;
  return <InfoIcon className={cn(cls, 'text-muted-foreground')} aria-hidden="true" />;
}

export function DeskScreen() {
  return <Desk quickReturn={false} />;
}

export function QuickReturnScreen() {
  return <Desk quickReturn />;
}

/** Baca di Tempat (`/admin/layanan/baca`): the desk's read-in-place mode as a page of its own. */
export function InLibraryScreen() {
  return <Desk quickReturn={false} inLibrary />;
}

function Desk({ quickReturn, inLibrary = false }: { quickReturn: boolean; inLibrary?: boolean }) {
  const t = useT();
  const me = useMe();
  const day = useCalendarDate();
  const typeName = useTypeName();
  const navigate = useNavigate();
  const queryClient = useQueryClient();
  const search = useSearch({ strict: false }) as { member?: string };
  const desk = useDeskBranch();
  const branchId = desk.branchId;
  const ids = useId();
  const input = useRef<HTMLInputElement>(null);
  const loanRows = useRef<(HTMLTableRowElement | null)[]>([]);

  const homeMode: Mode = quickReturn ? 'return' : inLibrary ? 'read' : 'member';
  const [mode, setMode] = useState<Mode>(homeMode);
  const [memberId, setMemberId] = useState<string | null>(quickReturn || inLibrary ? null : (search.member ?? null));
  const [value, setValue] = useState('');
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<Feedback>({ tone: 'idle', title: t('circulation.feedback.ready'), seq: 0 });
  const [live, setLive] = useState<{ status: string; alert: string; seq: number }>({ status: '', alert: '', seq: 0 });
  const [flash, setFlash] = useState<Tone>('idle');
  const [offer, setOffer] = useState<Offer | null>(null);
  const [visit, setVisit] = useState<VisitRow[]>([]);
  const [returns, setReturns] = useState<ReturnRow[]>([]);
  const [tab, setTab] = useState<PanelTab>('visit');
  const [sound, setSound] = useState(() => readStored(DESK_SOUND_KEY) !== '0');
  const [extendOpen, setExtendOpen] = useState(false);
  const [helpOpen, setHelpOpen] = useState(false);
  const [slip, setSlip] = useState<HoldSlip | null>(null);
  const [printing, setPrinting] = useState(0);
  // ---- Komunitas (circulation core) ----
  const [reads, setReads] = useState<ReadRow[]>([]);
  const [forcing, setForcing] = useState<{ barcode: string; reasons: ForceableReason[] } | null>(null);
  const [forceNote, setForceNote] = useState('');
  const [backdate, setBackdate] = useState<{ on: boolean; date: string; note: string }>({ on: false, date: '', note: '' });
  const [lastLoan, setLastLoan] = useState<{ id: string; title: string; barcode: string } | null>(null);
  const [lostLoan, setLostLoan] = useState<DeskLoanView | null>(null);
  const [dueLoan, setDueLoan] = useState<DeskLoanView | null>(null);
  // ---- Komunitas (charges and payments) ----
  const [chargesDialog, setChargesDialog] = useState(false);
  // ---- Komunitas (holds): the Reservasi tab's dialogs (place a hold, cancel one) ----
  const [holdsDialog, setHoldsDialog] = useState(false);
  const [payNow, setPayNow] = useState(0);
  const [receipt, setReceipt] = useState<{ href: string; number: string } | null>(null);
  const [visitPayments, setVisitPayments] = useState<string[]>([]);
  const money = useMoney();
  const forceInput = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [active, setActive] = useState(-1);
  const seq = useRef(0);
  const retry = useRef<{ body: string; key: string } | null>(null);

  const canExtend = holds(me, 'members.records.manage');
  const canReadMembers = holds(me, 'members.records.read');
  const canReadLoans = holds(me, 'circulation.records.read');
  const canOverride = branchId !== null && holdsAt(me, 'circulation.desk.override', branchId);
  const dialogOpen = extendOpen || helpOpen || lostLoan !== null || dueLoan !== null || chargesDialog || holdsDialog;

  // A member opened from another page (`?member=`): its panel, once the branch is known.
  useEffect(() => {
    if (!quickReturn && !inLibrary && search.member !== undefined) {
      setMemberId(search.member);
      setMode('member');
    }
  }, [quickReturn, search.member]);

  const fetchPanel = (branch: string, id: string) => api<DeskMemberView>('GET', `branches/${encodeURIComponent(branch)}/circulation/members/${encodeURIComponent(id)}`);
  const memberQuery = useQuery({
    queryKey: deskMemberKey(branchId ?? '', memberId ?? ''),
    queryFn: () => fetchPanel(branchId!, memberId!),
    enabled: me !== undefined && branchId !== null && memberId !== null,
  });
  const member = memberId === null ? null : (memberQuery.data ?? null);

  // The name suggestions: the box's text, a moment after the last key.
  useEffect(() => {
    const id = setTimeout(() => setQuery(value.trim()), 250);
    return () => clearTimeout(id);
  }, [value]);
  const suggesting = !quickReturn && !inLibrary && (mode === 'name' || (mode === 'member' && memberId === null));
  const searchKey = (q: string) => ['circulation', 'desk', branchId ?? '', 'search', q] as const;
  const searchFor = (q: string) => api<DeskMemberSearchResponse>('POST', `branches/${encodeURIComponent(branchId!)}/circulation/members/search`, { q });
  const suggestions = useQuery({
    queryKey: searchKey(query),
    queryFn: () => searchFor(query),
    enabled: me !== undefined && branchId !== null && suggesting && query.length >= 2 && value.trim() !== '',
  });
  const options = suggesting && value.trim() !== '' && query.length >= 2 ? (suggestions.data?.items ?? []) : [];
  const listboxId = `${ids}-suggestions`;

  const history = useInfiniteQuery({
    queryKey: ['circulation', 'loans', { memberId, state: 'closed' }],
    queryFn: ({ pageParam }) => {
      const q = new URLSearchParams({ state: 'closed', memberId: memberId!, limit: '20' });
      if (pageParam !== null) q.set('cursor', pageParam);
      return api<LoanListResponse>('GET', `circulation/loans?${q.toString()}`);
    },
    initialPageParam: null as string | null,
    getNextPageParam: (last) => last.nextCursor,
    enabled: me !== undefined && memberId !== null && canReadLoans && tab === 'history',
  });

  const focusBox = (): void => {
    requestAnimationFrame(() => input.current?.focus());
  };

  useEffect(() => {
    if (flash === 'idle') return;
    const id = setTimeout(() => setFlash('idle'), 900);
    return () => clearTimeout(id);
  }, [flash, feedback.seq]);

  const say = (tone: Tone, title: string, detail?: string): void => {
    seq.current += 1;
    setFeedback({ tone, title, ...(detail === undefined || detail === '' ? {} : { detail }), seq: seq.current });
    const text = detail === undefined || detail === '' ? title : `${title} ${detail}`;
    setLive({ status: tone === 'error' ? '' : text, alert: tone === 'error' ? text : '', seq: seq.current });
    setFlash(tone);
    if (sound && (tone === 'success' || tone === 'warning' || tone === 'error')) beep(tone);
  };

  const addVisit = (row: Omit<VisitRow, 'seq'>): void => {
    seq.current += 1;
    const next = { ...row, seq: seq.current };
    setVisit((rows) => [next, ...rows].slice(0, 100));
  };

  /** The key of a write: kept while its request met no server (a repeat of the same body sends it again). */
  const keyFor = (prefix: string, body: unknown): string => {
    const text = `${prefix}:${JSON.stringify(body)}`;
    if (retry.current?.body !== text) retry.current = { body: text, key: newTransactionKey(prefix) };
    return retry.current.key;
  };
  const settle = (e?: unknown): void => {
    if (!(e instanceof TypeError)) retry.current = null;
  };

  const refreshPanel = async (): Promise<void> => {
    await queryClient.invalidateQueries({ queryKey: ['circulation'] });
    await queryClient.invalidateQueries({ queryKey: ['members'] });
  };

  const showMember = (view: DeskMemberView): void => {
    if (branchId !== null) queryClient.setQueryData(deskMemberKey(branchId, view.id), view);
    setMemberId(view.id);
    setMode('member');
    setVisit([]);
    setTab('visit');
    setValue('');
    setActive(-1);
    setReceipt(null);
    setVisitPayments([]);
    const refusal = borrowRefusalText(t, view);
    const notes = warningTexts(t, day, view.warnings);
    if (refusal !== null) say(view.borrowRefusal === 'CIRC_LIMIT_REACHED' || view.borrowRefusal === 'MEMBER_SUSPENDED' ? 'warning' : 'error', t('circulation.feedback.member_loaded', { name: view.name }), refusal);
    else say(notes.length > 0 ? 'warning' : 'success', t('circulation.feedback.member_loaded', { name: view.name }), [t('circulation.feedback.scan_items'), ...notes].join(' '));
  };

  const lookup = async (no: string): Promise<void> => {
    if (branchId === null) return;
    try {
      const view = await api<DeskMemberView>('POST', `branches/${encodeURIComponent(branchId)}/circulation/members/lookup`, { no });
      showMember(view);
    } catch (e) {
      say('error', deskRefusal(t, e, { action: 'lookup', code: no, member: null }).title);
    }
  };

  const openMember = async (id: string): Promise<void> => {
    if (branchId === null) return;
    try {
      const view = await api<DeskMemberView>('GET', `branches/${encodeURIComponent(branchId)}/circulation/members/${encodeURIComponent(id)}`);
      showMember(view);
    } catch (e) {
      say('error', deskRefusal(t, e, { action: 'lookup', code: '', member: null }).title);
    }
  };

  /** The panel of the member `id`: the one on screen, else (still loading) the one the server answers; null when it cannot be read. */
  const panelOf = async (id: string): Promise<DeskMemberView | null> => {
    if (member !== null && member.id === id) return member;
    if (branchId === null) return null;
    try {
      return await queryClient.fetchQuery({ queryKey: deskMemberKey(branchId, id), queryFn: () => fetchPanel(branchId, id) });
    } catch {
      return null;
    }
  };

  const lend = async (panel: DeskMemberView, barcode: string, force?: { reasons: ForceableReason[]; note: string }): Promise<void> => {
    if (branchId === null) return;
    const dated = backdate.on && backdate.date !== '';
    const note = force?.note ?? (dated ? backdate.note.trim() : '');
    if (dated && note === '') {
      say('error', t('circulation.backdate.note_required'));
      return;
    }
    const body = {
      memberId: panel.id,
      barcode,
      ...(dated ? { loanedOn: backdate.date } : {}),
      ...(force !== undefined || dated ? { override: { reasons: force?.reasons ?? [], note } } : {}),
    };
    try {
      const loan = await api<LoanResponse>('POST', `branches/${encodeURIComponent(branchId)}/circulation/loans`, body, { idempotencyKey: keyFor('desk-loan', body) });
      settle();
      const notes = warningTexts(t, day, loan.warnings, loan.dueOn);
      if (loan.overrides !== undefined && loan.overrides.length > 0) {
        notes.push(t('circulation.override.recorded', { reasons: loan.overrides.map((r) => t(`vocab.override_reason.${r}`)).join(', ') }));
      }
      const limit = panel.type.loanLimit;
      const next = limit === null ? t('circulation.feedback.scan_next') : t('circulation.feedback.loan_count', { count: panel.counts.openLoans + 1, limit });
      addVisit({ kind: 'loan', title: loan.record.title, barcode: loan.item.barcode, note: t('circulation.visit.due', { date: day(loan.dueOn) }), refId: loan.id });
      setLastLoan({ id: loan.id, title: loan.record.title, barcode: loan.item.barcode });
      say(notes.length > 0 ? 'warning' : 'success', t('circulation.feedback.lent', { title: loan.record.title, date: day(loan.dueOn) }), [...notes, next].join(' '));
      await refreshPanel();
    } catch (e) {
      settle(e);
      const refusal = deskRefusal(t, e, { action: 'loan', code: barcode, member: panel });
      addVisit({ kind: 'refused', title: refusal.title, barcode, note: t('circulation.visit.refused') });
      const reason = forceableOf(e);
      if (refusal.offer === undefined && reason !== null && canOverride) {
        setOffer({ kind: 'force', barcode, reasons: [...new Set([...(force?.reasons ?? []), reason])] });
        if (force !== undefined) setForceNote(force.note);
        say('warning', refusal.title, t('circulation.override.hint'));
        return;
      }
      if (refusal.offer !== undefined) setOffer(refusal.offer);
      say(refusal.offer !== undefined ? 'warning' : 'error', refusal.title, refusal.offer === undefined ? undefined : t('circulation.offer.hint'));
    }
  };

  /** Ctrl+Z: voids the last loan of this visit. */
  const voidLast = async (): Promise<void> => {
    if (branchId === null || lastLoan === null || busy) return;
    const target = lastLoan;
    setBusy(true);
    try {
      await api<LoanVoidResponse>('POST', `branches/${encodeURIComponent(branchId)}/circulation/loans/${encodeURIComponent(target.id)}/void`, undefined, {
        idempotencyKey: keyFor('desk-void', { id: target.id }),
      });
      settle();
      setLastLoan(null);
      addVisit({ kind: 'voided', title: target.title, barcode: target.barcode, note: t('circulation.void.visit') });
      say('success', t('circulation.void.done', { title: target.title }));
      await refreshPanel();
    } catch (e) {
      settle(e);
      const why = e instanceof ApiError && e.code === 'CIRC_VOID_REFUSED' && isVoidRefusal(e.reason) ? t(`vocab.void_refusal.${e.reason}`) : deskRefusal(t, e, { action: 'renew', code: '', member }).title;
      say('error', t('circulation.void.refused'), why);
    } finally {
      setBusy(false);
      focusBox();
    }
  };

  /** Baca di tempat: counts one item read in the library. */
  const readUse = async (barcode: string): Promise<void> => {
    if (branchId === null) return;
    const body = { barcode };
    try {
      const done = await api<InLibraryUseResponse>('POST', `branches/${encodeURIComponent(branchId)}/circulation/in-library-uses`, body, { idempotencyKey: keyFor('desk-read', body) });
      settle();
      const onLoan = done.warnings?.some((w) => w.code === 'item_on_loan') === true;
      const offShelf = done.warnings?.some((w) => w.code === 'item_status') === true;
      const note = onLoan ? t('circulation.read.on_loan') : offShelf ? t('circulation.read.off_shelf', { status: t(`vocab.item_status.${done.status as 'missing'}`) }) : null;
      say(note === null ? 'success' : 'warning', t('circulation.read.done', { title: done.record.title }), note ?? done.item.barcode);
      seq.current += 1;
      const row: ReadRow = { seq: seq.current, barcode: done.item.barcode, title: done.record.title, note };
      setReads((rows) => [row, ...rows].slice(0, 200));
    } catch (e) {
      settle(e);
      say('error', deskRefusal(t, e, { action: 'return', code: barcode, member: null }).title);
    }
  };

  const giveBack = async (barcode: string, foundLost = false): Promise<void> => {
    if (branchId === null) return;
    const body = foundLost ? { barcode, foundLost: true } : { barcode };
    try {
      const done = await api<ReturnResponse>('POST', `branches/${encodeURIComponent(branchId)}/circulation/returns`, body, { idempotencyKey: keyFor('desk-return', body) });
      settle();
      const otherBranch = done.warnings?.find((w) => w.code === 'return_to_branch')?.branchCode ?? null;
      const title =
        done.foundLost === true
          ? t('circulation.lost.found')
          : otherBranch !== null
          ? t('circulation.feedback.returned_branch', { code: otherBranch })
          : done.daysLate > 0
            ? t('circulation.feedback.returned_late', { count: done.daysLate })
            : t('circulation.feedback.returned');
      const detail = `${done.record.title} · ${done.item.barcode}`;
      if (done.hold !== undefined) {
        // The copy is kept for a hold: that is what the desk must do now, whatever else the return says.
        setSlip({ trap: done.hold, title: done.record.title, barcode: done.item.barcode });
        say(
          'warning',
          t('holds.desk.keep_for', { no: done.hold.memberNo }),
          [t('holds.desk.keep_detail', { name: done.hold.memberName, date: day(done.hold.pickupUntil), title: done.record.title }), done.daysLate > 0 ? title : ''].join(' ').trim(),
        );
      } else {
        setSlip(null);
        say(otherBranch !== null || done.daysLate > 0 ? 'warning' : 'success', title, detail);
      }
      addVisit({ kind: 'return', title: done.record.title, barcode: done.item.barcode, note: done.daysLate > 0 ? t('circulation.due.late', { count: done.daysLate }) : t('circulation.due.on_time'), refId: done.id });
      seq.current += 1;
      const row: ReturnRow = {
        seq: seq.current,
        barcode: done.item.barcode,
        title: done.record.title,
        memberNo: done.memberNo,
        dueOn: done.dueOn,
        daysLate: done.daysLate,
        otherBranch,
        keptFor: done.hold?.memberNo ?? null,
      };
      setReturns((rows) => [row, ...rows].slice(0, 200));
      await refreshPanel();
    } catch (e) {
      settle(e);
      if (e instanceof ApiError && e.code === 'CIRC_LOAN_NOT_OPEN' && e.reason === 'lost_item') {
        setOffer({ kind: 'found_lost', barcode });
        say('warning', t('circulation.lost.offer_title'), t('circulation.offer.hint'));
        return;
      }
      const refusal = deskRefusal(t, e, { action: 'return', code: barcode, member });
      if (!quickReturn) addVisit({ kind: 'refused', title: refusal.title, barcode, note: t('circulation.visit.refused') });
      say('error', refusal.title);
    }
  };

  const renew = async (loan: DeskLoanView): Promise<void> => {
    if (branchId === null || busy) return;
    setBusy(true);
    try {
      const done = await api<RenewResponse>('POST', `branches/${encodeURIComponent(branchId)}/circulation/loans/${encodeURIComponent(loan.id)}/renew`, undefined, {
        idempotencyKey: keyFor('desk-renew', { id: loan.id, renewals: loan.renewals }),
      });
      settle();
      const notes = warningTexts(t, day, done.warnings, done.dueOn);
      addVisit({ kind: 'renew', title: loan.record.title, barcode: loan.item.barcode, note: t('circulation.visit.due', { date: day(done.dueOn) }), refId: done.id });
      say(notes.length > 0 ? 'warning' : 'success', t('circulation.feedback.renewed', { date: day(done.dueOn) }), [loan.record.title, ...notes].join(' · '));
      await refreshPanel();
    } catch (e) {
      settle(e);
      say('error', deskRefusal(t, e, { action: 'renew', code: loan.item.barcode, member }).title, loan.record.title);
    } finally {
      setBusy(false);
      focusBox();
    }
  };

  const renewAll = async (): Promise<void> => {
    if (branchId === null || member === null || busy || member.loans.length === 0) return;
    setBusy(true);
    try {
      const done = await api<RenewAllResponse>('POST', `branches/${encodeURIComponent(branchId)}/circulation/members/${encodeURIComponent(member.id)}/renew-all`, undefined, {
        idempotencyKey: keyFor('desk-renew-all', { id: member.id, loans: member.loans.map((l) => [l.id, l.renewals]) }),
      });
      settle();
      const reasons = done.refused.map((r) => {
        const loan = member.loans.find((l) => l.id === r.id);
        const why = r.reason === 'not_open' ? t('circulation.problem.closed_elsewhere') : t(`vocab.renew_refusal.${r.reason}`);
        return loan === undefined ? why : `${loan.record.title}: ${why}`;
      });
      say(
        done.refused.length > 0 ? 'warning' : 'success',
        t('circulation.feedback.renewed_all', { ok: done.renewed.length, refused: done.refused.length }),
        reasons.join(' · '),
      );
      await refreshPanel();
    } catch (e) {
      settle(e);
      say('error', deskRefusal(t, e, { action: 'renew', code: '', member }).title);
    } finally {
      setBusy(false);
      focusBox();
    }
  };

  const done = (): void => {
    const name = member?.name;
    setMemberId(null);
    setVisit([]);
    setOffer(null);
    setMode(homeMode);
    setValue('');
    setTab('visit');
    setLastLoan(null);
    setForcing(null);
    setReceipt(null);
    setVisitPayments([]);
    if (search.member !== undefined) void navigate({ href: '/admin/layanan', replace: true });
    say('info', name === undefined ? t('circulation.feedback.ready') : t('circulation.feedback.done', { name }));
    focusBox();
  };

  /** F9: the slip of this visit (the loans, renewals and returns of the list, and the payments taken). */
  const slipNow = async (): Promise<void> => {
    if (branchId === null) return;
    const ids = (kinds: VisitRow['kind'][]) => [...new Set(visit.filter((r) => kinds.includes(r.kind) && r.refId !== undefined).map((r) => r.refId!))].slice(0, 50);
    const body = { loanIds: ids(['loan', 'renew']), returnedLoanIds: ids(['return']), paymentIds: visitPayments.slice(0, 10) };
    if (body.loanIds.length + body.returnedLoanIds.length + body.paymentIds.length === 0) {
      say('info', t('charges.slip.empty'));
      return;
    }
    try {
      await printSlip(branchId, body);
      say('success', t('charges.slip.printed'));
    } catch (e) {
      say('error', deskRefusal(t, e, { action: 'renew', code: '', member }).title);
    } finally {
      focusBox();
    }
  };

  const confirmOffer = async (): Promise<void> => {
    if (offer === null) return;
    const current = offer;
    setOffer(null);
    setBusy(true);
    try {
      if (current.kind === 'switch') await lookup(current.memberNo);
      else if (current.kind === 'return') await giveBack(current.barcode);
      else if (current.kind === 'found_lost') await giveBack(current.barcode, true);
      else {
        // Forcing: the reason is asked for first (the panel under the feedback); Enter there sends the loan again.
        setForcing({ barcode: current.barcode, reasons: current.reasons });
        requestAnimationFrame(() => forceInput.current?.focus());
        return;
      }
    } finally {
      setBusy(false);
      focusBox();
    }
  };

  /**
   * The suggestions for exactly `text`, and whether they are the ones on screen (so a highlighted row means something).
   * The list on screen follows the box a moment late; when it is not yet the list of `text`, the name search asks for
   * `text` now, and the member box (which looks a number up when nothing is picked) uses none.
   */
  const suggestionsFor = async (text: string): Promise<{ items: DeskMemberSummary[]; shown: boolean }> => {
    if (query === text && suggestions.data !== undefined) return { items: options, shown: true };
    if (mode !== 'name' || text.length < 2) return { items: [], shown: false };
    return { items: (await queryClient.fetchQuery({ queryKey: searchKey(text), queryFn: () => searchFor(text) })).items, shown: false };
  };

  /** One scan, with the state of the latest render (see {@link process}). */
  const handle = async (raw: string): Promise<void> => {
    if (branchId === null) return;
    const code = raw.replace(/[\r\n\t]/g, '').trim();
    if (code === '') {
      if (offer !== null) await confirmOffer();
      return;
    }
    setOffer(null);
    setBusy(true);
    try {
      if (mode === 'return') {
        setValue('');
        await giveBack(code);
      } else if (mode === 'read') {
        setValue('');
        await readUse(code);
      } else if (mode === 'name' || memberId === null) {
        let list: { items: DeskMemberSummary[]; shown: boolean };
        try {
          list = await suggestionsFor(code);
        } catch (e) {
          say('error', deskRefusal(t, e, { action: 'lookup', code, member: null }).title);
          return;
        }
        const pick = list.items[list.shown && active >= 0 ? active : mode === 'name' ? 0 : -1];
        setValue('');
        if (pick !== undefined) await openMember(pick.id);
        else if (mode === 'name') say('error', t('circulation.problem.member_not_found', { no: code }));
        else await lookup(code);
      } else {
        setValue('');
        const panel = await panelOf(memberId);
        if (panel === null) say('error', t('circulation.problem.scan_no_member', { code }));
        else await lend(panel, code);
      }
    } finally {
      setBusy(false);
      setActive(-1);
      focusBox();
    }
  };

  // Scans that come while a request is in flight wait their turn instead of being dropped: each runs after the one
  // before it has ended and the page has rendered its outcome (so a card scanned just before an item lends to that
  // member).
  const latestHandle = useRef(handle);
  latestHandle.current = handle;
  const queue = useRef<Promise<void>>(Promise.resolve());
  const process = (raw: string): Promise<void> => {
    const next = queue.current.then(() => new Promise<void>((resolve) => setTimeout(resolve, 0))).then(() => latestHandle.current(raw));
    queue.current = next.catch(() => undefined);
    return next;
  };

  useScannerInput({
    onScan: (code) => {
      if (dialogOpen) {
        say('error', t('circulation.problem.scan_dialog_open', { code }));
        return;
      }
      void process(code);
    },
    minLength: 3,
  });

  const switchMode = (next: Mode): void => {
    setMode(next);
    setOffer(null);
    setActive(-1);
    focusBox();
  };

  const tabs: PanelTab[] = ['visit', 'loans', 'holds', 'charges', ...(canReadLoans ? (['history'] as const) : [])];

  // The function keys and Esc work wherever the focus is (also in the scan box, where shortcuts usually rest).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (dialogOpen || e.isComposing) return;
      const key = e.key;
      if (key === 'F2') {
        e.preventDefault();
        if (quickReturn) void navigate({ href: '/admin/layanan' });
        else switchMode('member');
      } else if (key === 'F3' && !quickReturn) {
        e.preventDefault();
        switchMode('return');
      } else if (key === 'F4' && !quickReturn) {
        e.preventDefault();
        switchMode('read');
      } else if ((key === 'z' || key === 'Z') && (e.ctrlKey || e.metaKey) && !e.shiftKey && value === '' && forcing === null && lastLoan !== null) {
        e.preventDefault();
        void voidLast();
      } else if (key === 'F9' && !quickReturn && !inLibrary) {
        e.preventDefault();
        void slipNow();
      } else if (key === 'F6' && !quickReturn) {
        e.preventDefault();
        switchMode('name');
      } else if ((key === 'F7' || key === 'F8') && !quickReturn && memberId !== null) {
        e.preventDefault();
        const at = tabs.indexOf(tab);
        const step = key === 'F7' ? 1 : tabs.length - 1;
        setTab(tabs[(at + step) % tabs.length]!);
      } else if (key === 'Escape') {
        if (options.length > 0 && value !== '') {
          setValue('');
          setActive(-1);
        } else if (forcing !== null) {
          setForcing(null);
          say('info', t('circulation.offer.cancelled'));
        } else if (offer !== null) {
          setOffer(null);
          say('info', t('circulation.offer.cancelled'));
        } else if (mode === 'name') {
          switchMode('member');
        } else if ((mode === 'return' && !quickReturn) || (mode === 'read' && !inLibrary)) {
          switchMode('member');
        } else if (memberId !== null) {
          done();
        } else {
          setValue('');
        }
        focusBox();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  useShortcuts({ 'shift+?': () => setHelpOpen(true) });

  useEffect(() => {
    focusBox();
  }, [branchId]);

  const submit = (event: FormEvent<HTMLFormElement>): void => {
    event.preventDefault();
    void process(value);
  };

  const onBoxKey = (e: ReactKeyboardEvent<HTMLInputElement>): void => {
    if (options.length > 0 && (e.key === 'ArrowDown' || e.key === 'ArrowUp')) {
      e.preventDefault();
      setActive((at) => (e.key === 'ArrowDown' ? Math.min(options.length - 1, at + 1) : Math.max(-1, at - 1)));
      return;
    }
    if (e.key === 'ArrowDown' && member !== null && member.loans.length > 0) {
      e.preventDefault();
      setTab('loans');
      requestAnimationFrame(() => loanRows.current[0]?.focus());
    }
  };

  const onRowKey = (e: ReactKeyboardEvent<HTMLTableRowElement>, index: number, loan: DeskLoanView): void => {
    if (e.key === 'ArrowDown') {
      e.preventDefault();
      loanRows.current[index + 1]?.focus();
    } else if (e.key === 'ArrowUp') {
      e.preventDefault();
      if (index === 0) input.current?.focus();
      else loanRows.current[index - 1]?.focus();
    } else if (e.key === 'P' && e.shiftKey) {
      e.preventDefault();
      void renewAll();
    } else if (e.key === 'k' || e.key === 'K') {
      e.preventDefault();
      void giveBack(loan.item.barcode).then(focusBox);
    } else if (e.key === 'p') {
      e.preventDefault();
      void renew(loan);
    } else if (e.key === 'h' || e.key === 'H') {
      e.preventDefault();
      setLostLoan(loan);
    } else if (e.key === 'b' || e.key === 'B') {
      // Pay: the member's open charges at this branch (the Denda tab opens with the pay dialog).
      e.preventDefault();
      setTab('charges');
      setPayNow((n) => n + 1);
    }
  };

  /** A click on the page's empty space gives the scan box its focus back (never taken from a control). */
  const refocus = (e: ReactMouseEvent<HTMLDivElement>): void => {
    if (dialogOpen) return;
    const target = e.target as HTMLElement;
    if (target.closest('a,button,input,select,textarea,[tabindex],[role="tab"],label') !== null) return;
    if ((window.getSelection()?.toString() ?? '') !== '') return;
    input.current?.focus();
  };

  const scanLabel =
    mode === 'return'
      ? t('circulation.scan.return')
      : mode === 'read'
        ? t('circulation.scan.read')
        : mode === 'name'
        ? t('circulation.scan.name')
        : member !== null
          ? t('circulation.scan.item', { name: member.name })
          : t('circulation.scan.member');

  const toggleSound = (): void => {
    setSound((on) => {
      writeStored(DESK_SOUND_KEY, on ? '0' : '1');
      return !on;
    });
    focusBox();
  };

  const branchName = desk.branches?.find((b) => b.id === branchId)?.name ?? '';

  return (
    <div className="flex flex-col gap-4" onMouseUp={refocus}>
      {/* The two fixed live regions: what the desk says, heard once per scan (a new node each time). */}
      <div role="status" aria-live="polite" className="sr-only">
        {live.status !== '' && <p key={live.seq}>{live.status}</p>}
      </div>
      <div role="alert" className="sr-only">
        {live.alert !== '' && <p key={live.seq}>{live.alert}</p>}
      </div>

      <div className="flex flex-wrap items-end justify-between gap-3">
        <h1 className="text-2xl font-semibold">{t(quickReturn ? 'nav.circulation.quick_return' : inLibrary ? 'nav.circulation.in_library' : 'nav.circulation.desk')}</h1>
        <div className="flex flex-wrap items-end gap-2">
          {desk.branches !== undefined && desk.branches.length > 1 && (
            <div className="grid gap-1">
              <Label htmlFor={`${ids}-branch`}>{t('circulation.desk.branch')}</Label>
              <select
                id={`${ids}-branch`}
                className={cn(SELECT_CLASS, 'w-56')}
                value={branchId ?? ''}
                onChange={(e) => {
                  desk.choose(e.target.value);
                  done();
                }}>
                {desk.branches.map((b) => (
                  <option key={b.id} value={b.id}>
                    {b.name}
                  </option>
                ))}
              </select>
            </div>
          )}
          {desk.branches !== undefined && desk.branches.length === 1 && (
            <p className="text-sm text-muted-foreground">{t('circulation.desk.branch_named', { name: branchName })}</p>
          )}
          <Button type="button" variant="outline" aria-pressed={sound} onClick={toggleSound}>
            {sound ? <Volume2Icon aria-hidden="true" /> : <VolumeXIcon aria-hidden="true" />}
            {t(sound ? 'circulation.desk.sound_on' : 'circulation.desk.sound_off')}
          </Button>
          <Button type="button" variant="outline" onClick={() => setHelpOpen(true)}>
            <KeyboardIcon aria-hidden="true" />
            {t('circulation.desk.shortcuts')}
          </Button>
        </div>
      </div>

      {desk.error !== null && desk.branches === undefined && <Notice kind="error">{problemText(t, desk.error)}</Notice>}
      {desk.branches !== undefined && desk.branches.length === 0 && <Notice kind="error">{t('circulation.desk.no_branch')}</Notice>}

      {branchId !== null && (
        <>
          {quickReturn && <ReturnCounts rows={returns} />}
          <form noValidate onSubmit={submit} className={cn('flex flex-col gap-3 rounded-lg border border-t-4 bg-card p-4', TONE_CARD[feedback.tone])}>
            {!quickReturn && !inLibrary && (
              <div role="group" aria-label={t('circulation.mode.label')} className="flex flex-wrap gap-2">
                {(['member', 'return', 'read', 'name'] as const).map((m) => (
                  <Button key={m} type="button" size="sm" variant={mode === m ? 'default' : 'outline'} aria-pressed={mode === m} onClick={() => switchMode(m)}>
                    {t(`circulation.mode.${m}`)}
                  </Button>
                ))}
              </div>
            )}
            <Label htmlFor={`${ids}-scan`} className="text-base">
              {scanLabel}
            </Label>
            <div className="relative flex flex-wrap gap-2">
              <Input
                id={`${ids}-scan`}
                ref={input}
                autoFocus
                autoComplete="off"
                spellCheck={false}
                maxLength={200}
                value={value}
                onChange={(e) => {
                  setValue(e.target.value);
                  setActive(mode === 'name' ? 0 : -1);
                }}
                onKeyDown={onBoxKey}
                aria-describedby={`${ids}-scan-hint`}
                {...(suggesting
                  ? {
                      role: 'combobox',
                      'aria-expanded': options.length > 0,
                      'aria-controls': listboxId,
                      'aria-autocomplete': 'list' as const,
                      'aria-activedescendant': active >= 0 && options[active] !== undefined ? `${listboxId}-${active}` : undefined,
                    }
                  : {})}
                className={cn('h-14 min-w-0 flex-1 font-mono text-xl md:text-xl motion-safe:transition-shadow', TONE_FLASH[flash])}
              />
              <Button type="submit" size="lg" className="h-14" disabled={busy}>
                <ScanBarcodeIcon aria-hidden="true" />
                {t('circulation.scan.process')}
              </Button>
              {suggesting && options.length > 0 && (
                <ul id={listboxId} role="listbox" aria-label={t('circulation.scan.suggestions')} className="absolute top-full right-0 left-0 z-20 mt-1 max-h-80 overflow-y-auto rounded-md border bg-popover p-1 shadow-md">
                  {options.map((o, i) => (
                    <li
                      key={o.id}
                      id={`${listboxId}-${i}`}
                      role="option"
                      aria-selected={i === active}
                      className={cn('flex cursor-pointer items-center justify-between gap-2 rounded-sm px-2 py-1.5 text-sm', i === active && 'bg-accent text-accent-foreground')}
                      onMouseDown={(e) => e.preventDefault()}
                      onClick={() => {
                        setValue('');
                        void openMember(o.id).then(focusBox);
                      }}>
                      <span>
                        <span className="font-medium">{o.name}</span>
                        <span className="ml-2 font-mono text-muted-foreground">{o.memberNo}</span>
                        {o.className !== null && <span className="ml-2 text-muted-foreground">{o.className}</span>}
                      </span>
                      <MemberStatusBadge status={o.status} />
                    </li>
                  ))}
                </ul>
              )}
            </div>
            <p id={`${ids}-scan-hint`} className="text-xs text-muted-foreground">
              {t(quickReturn ? 'circulation.scan.hint_return' : inLibrary ? 'circulation.scan.hint_read' : 'circulation.scan.hint')}
            </p>
            {canOverride && !quickReturn && !inLibrary && mode === 'member' && member !== null && (
              <BackdatePanel value={backdate} onChange={setBackdate} />
            )}
          </form>

          <div className={cn('flex items-start gap-3 rounded-lg border p-4', TONE_FEEDBACK[feedback.tone])} data-testid="desk-feedback">
            <ToneIcon tone={feedback.tone} />
            <div className="grid min-w-0 flex-1 gap-1">
              <p className="text-xl leading-snug font-semibold">{feedback.title}</p>
              {feedback.detail !== undefined && <p className="text-sm">{feedback.detail}</p>}
              {slip !== null && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button type="button" variant="outline" onClick={() => setPrinting((n) => n + 1)}>
                    {t('holds.action.print_slip')}
                  </Button>
                </div>
              )}
              {receipt !== null && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button asChild variant="outline">
                    <a href={receipt.href} target="_blank" rel="noopener">
                      {t('charges.pay.print', { number: receipt.number })}
                    </a>
                  </Button>
                </div>
              )}
              {offer !== null && (
                <div className="mt-2 flex flex-wrap gap-2">
                  <Button type="button" onClick={() => void confirmOffer()}>
                    {offer.kind === 'switch'
                      ? t('circulation.offer.switch', { no: offer.memberNo })
                      : offer.kind === 'force'
                        ? t('circulation.override.offer')
                        : offer.kind === 'found_lost'
                          ? t('circulation.lost.offer')
                          : t('circulation.offer.return')}
                  </Button>
                  <Button
                    type="button"
                    variant="outline"
                    onClick={() => {
                      setOffer(null);
                      focusBox();
                    }}>
                    {t('circulation.offer.cancel')}
                  </Button>
                </div>
              )}
            </div>
          </div>

          {forcing !== null && member !== null && (
            <form
              noValidate
              className="flex flex-wrap items-end gap-2 rounded-lg border border-warning-foreground/30 bg-warning p-3 text-warning-foreground"
              onSubmit={(e) => {
                e.preventDefault();
                const note = forceNote.trim();
                if (note === '') return;
                const target = forcing;
                setForcing(null);
                setBusy(true);
                void lend(member, target.barcode, { reasons: target.reasons, note }).finally(() => {
                  setBusy(false);
                  focusBox();
                });
              }}>
              <div className="grid min-w-64 flex-1 gap-1">
                <Label htmlFor={`${ids}-force`}>{t('circulation.override.note', { reasons: forcing.reasons.map((r) => t(`vocab.override_reason.${r}`)).join(', ') })}</Label>
                <Input id={`${ids}-force`} ref={forceInput} maxLength={191} autoComplete="off" value={forceNote} onChange={(e) => setForceNote(e.target.value)} className="bg-background text-foreground" />
              </div>
              <Button type="submit" disabled={forceNote.trim() === ''}>
                {t('circulation.override.submit')}
              </Button>
              <Button
                type="button"
                variant="outline"
                onClick={() => {
                  setForcing(null);
                  focusBox();
                }}>
                {t('circulation.offer.cancel')}
              </Button>
            </form>
          )}

          {quickReturn ? (
            <ReturnsTable rows={returns} />
          ) : mode === 'read' ? (
            <ReadsTable rows={reads} />
          ) : (
            <div className="grid gap-4 min-[1100px]:grid-cols-[320px_minmax(0,1fr)]">
              <MemberCard
                member={member}
                loading={memberId !== null && memberQuery.isPending}
                error={memberId !== null && memberQuery.isError ? memberQuery.error : null}
                canExtend={canExtend}
                canOpen={canReadMembers}
                typeName={member === null ? '' : typeName(member.type)}
                onExtend={() => setExtendOpen(true)}
                onDone={done}
              />
              {member !== null && (
                <Tabs value={tab} onValueChange={(v) => setTab(v as PanelTab)} className="min-w-0">
                  <TabsList>
                    <TabsTrigger value="visit">{t('circulation.tab.visit', { count: visit.length })}</TabsTrigger>
                    <TabsTrigger value="loans">{t('circulation.tab.loans', { count: member.loans.length })}</TabsTrigger>
                    <TabsTrigger value="holds">{t('holds.member.tab', { count: member.holds.length })}</TabsTrigger>
                    <TabsTrigger value="charges">{t('charges.member.tab', { count: member.charges.charges.length })}</TabsTrigger>
                    {canReadLoans && <TabsTrigger value="history">{t('circulation.tab.history')}</TabsTrigger>}
                  </TabsList>
                  <TabsContent value="visit" className="flex flex-col gap-2">
                    <div className="flex justify-end">
                      <Button type="button" variant="outline" size="sm" onClick={() => void slipNow()}>
                        {t('charges.slip.print')}
                      </Button>
                    </div>
                    <VisitList rows={visit} />
                  </TabsContent>
                  <TabsContent value="loans" className="flex flex-col gap-2">
                    <div className="flex justify-end">
                      <Button type="button" variant="outline" size="sm" disabled={busy || member.loans.length === 0} onClick={() => void renewAll()}>
                        {t('circulation.action.renew_all')}
                      </Button>
                    </div>
                    <div className="overflow-x-auto rounded-md border">
                      <table className="w-full text-sm">
                        <caption className="sr-only">{t('circulation.loans.caption', { name: member.name })}</caption>
                        <thead className="bg-muted/50 text-left">
                          <tr>
                            <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                              {t('circulation.col.item')}
                            </th>
                            <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                              {t('circulation.col.due')}
                            </th>
                            <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                              {t('circulation.col.renewals')}
                            </th>
                            <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                              {t('table.actions')}
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {member.loans.length === 0 ? (
                            <tr>
                              <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
                                {t('circulation.loans.empty')}
                              </td>
                            </tr>
                          ) : (
                            member.loans.map((loan, i) => (
                              <tr
                                key={loan.id}
                                ref={(el) => {
                                  loanRows.current[i] = el;
                                }}
                                tabIndex={0}
                                aria-label={t('circulation.loans.row', { title: loan.record.title, date: day(loan.dueOn) })}
                                onKeyDown={(e) => onRowKey(e, i, loan)}
                                className={cn('border-t align-top outline-none focus-visible:bg-accent', loan.daysLate > 0 && 'border-l-4 border-l-destructive')}>
                                <td className="px-3 py-2">
                                  <p className="font-medium">{loan.record.title}</p>
                                  <p className="font-mono text-xs text-muted-foreground">
                                    {loan.item.barcode}
                                    {loan.item.callNumber !== null && ` · ${loan.item.callNumber}`}
                                  </p>
                                </td>
                                <td className="px-3 py-2 whitespace-nowrap">
                                  <p>{day(loan.dueOn)}</p>
                                  <DueBadge dueOn={loan.dueOn} daysLate={loan.daysLate} />
                                  {loan.finePreview !== null && (
                                    <p className="mt-1 text-xs text-destructive">{t('charges.fine_preview', { amount: money(loan.finePreview.amount, loan.finePreview.currency), days: loan.finePreview.days })}</p>
                                  )}
                                </td>
                                <td className="px-3 py-2 whitespace-nowrap">{t('circulation.loans.renewals', { count: loan.renewals, limit: loan.renewLimit })}</td>
                                <td className="px-3 py-2">
                                  <div className="flex flex-wrap gap-1">
                                    <Button type="button" size="sm" variant="outline" tabIndex={-1} disabled={busy} onClick={() => void giveBack(loan.item.barcode).then(focusBox)}>
                                      {t('circulation.action.return')}
                                    </Button>
                                    <Button type="button" size="sm" variant="outline" tabIndex={-1} disabled={busy} onClick={() => void renew(loan)}>
                                      {t('circulation.action.renew')}
                                    </Button>
                                    <Button type="button" size="sm" variant="outline" tabIndex={-1} disabled={busy || loan.branchId !== branchId} onClick={() => setLostLoan(loan)}>
                                      {t('circulation.action.lost')}
                                    </Button>
                                    {canOverride && (
                                      <Button type="button" size="sm" variant="outline" tabIndex={-1} disabled={busy || loan.branchId !== branchId} onClick={() => setDueLoan(loan)}>
                                        {t('circulation.action.due')}
                                      </Button>
                                    )}
                                  </div>
                                </td>
                              </tr>
                            ))
                          )}
                        </tbody>
                      </table>
                    </div>
                  </TabsContent>
                  {branchId !== null && (
                    <TabsContent value="holds">
                      <MemberHoldsPanel
                        member={member}
                        branchId={branchId}
                        onChanged={async () => {
                          await refreshPanel();
                          focusBox();
                        }}
                        onSaid={(tone, text) => say(tone === 'success' ? 'success' : 'error', text)}
                        onDialog={setHoldsDialog}
                      />
                    </TabsContent>
                  )}
                  {branchId !== null && (
                    <TabsContent value="charges">
                      <MemberChargesPanel
                        member={member}
                        branchId={branchId}
                        payNow={payNow}
                        onDialog={setChargesDialog}
                        onChanged={async () => {
                          await refreshPanel();
                          focusBox();
                        }}
                        onPaid={(p: PaymentView) => {
                          const number = p.receiptNo ?? '-';
                          setReceipt({ href: receiptHref(p.branchId, p.id), number });
                          setVisitPayments((list) => [...list, p.id]);
                          say('success', t('charges.pay.done', { amount: money(p.amount, p.currency), number }));
                        }}
                        onSaid={(tone, text) => say(tone, text)}
                      />
                    </TabsContent>
                  )}
                  {canReadLoans && (
                    <TabsContent value="history" className="flex flex-col gap-2">
                      <LoanHistory query={history} />
                    </TabsContent>
                  )}
                </Tabs>
              )}
            </div>
          )}
        </>
      )}

      {memberId !== null && (
        <ExtendDialog
          memberId={memberId}
          open={extendOpen}
          onClose={() => {
            setExtendOpen(false);
            focusBox();
          }}
          onDone={() => say('success', t('circulation.feedback.extended'), t('circulation.feedback.scan_items'))}
        />
      )}
      <HoldSlipPrint slip={slip} printing={printing} onPrinted={() => setPrinting(0)} />
      {branchId !== null && (
        <>
          <LostDialog
            branchId={branchId}
            loan={lostLoan}
            onClose={() => {
              setLostLoan(null);
              focusBox();
            }}
            onDone={(r, loan) => {
              setLostLoan(null);
              addVisit({ kind: 'refused', title: loan.record.title, barcode: loan.item.barcode, note: t('circulation.lost.visit') });
              say('warning', t('circulation.lost.done', { title: loan.record.title }), t(r.charged ? 'circulation.lost.charged' : 'circulation.lost.not_charged', { amount: r.replacement, currency: r.currency }));
              void refreshPanel();
              focusBox();
            }}
          />
          <DueDialog
            branchId={branchId}
            loan={dueLoan}
            onClose={() => {
              setDueLoan(null);
              focusBox();
            }}
            onDone={(r, loan) => {
              setDueLoan(null);
              const closedDay = r.warnings?.some((w) => w.code === 'due_on_closed_day') === true;
              say(closedDay ? 'warning' : 'success', t('circulation.due_change.done', { title: loan.record.title, date: day(r.dueOn) }), closedDay ? t('vocab.circulation_warning.due_on_closed_day') : undefined);
              void refreshPanel();
              focusBox();
            }}
          />
        </>
      )}
      <ShortcutsDialog
        open={helpOpen}
        quickReturn={quickReturn}
        onClose={() => {
          setHelpOpen(false);
          focusBox();
        }}
      />
    </div>
  );
}

/** The compact member card of the desk: who, the counts, the status and why lending may be refused. */
function MemberCard({
  member,
  loading,
  error,
  canExtend,
  canOpen,
  typeName,
  onExtend,
  onDone,
}: {
  member: DeskMemberView | null;
  loading: boolean;
  error: unknown;
  canExtend: boolean;
  canOpen: boolean;
  typeName: string;
  onExtend(): void;
  onDone(): void;
}) {
  const t = useT();
  const day = useCalendarDate();
  if (error !== null) {
    return <Notice kind="error">{problemText(t, error)}</Notice>;
  }
  if (loading) {
    return (
      <section aria-busy="true" aria-label={t('circulation.member.loading')} className="flex flex-col gap-2 rounded-lg border bg-card p-4">
        <div className="h-5 w-2/3 animate-pulse rounded bg-muted" />
        <div className="h-4 w-1/2 animate-pulse rounded bg-muted" />
        <div className="h-16 animate-pulse rounded bg-muted" />
      </section>
    );
  }
  if (member === null) {
    return (
      <section className="flex flex-col items-center gap-2 rounded-lg border border-dashed bg-card p-6 text-center">
        <UserRoundIcon className="size-8 text-muted-foreground" aria-hidden="true" />
        <p className="font-medium">{t('circulation.member.none')}</p>
        <p className="text-sm text-muted-foreground">{t('circulation.member.none_hint')}</p>
      </section>
    );
  }
  const limit = member.type.loanLimit;
  const full = limit !== null && member.counts.openLoans >= limit;
  const refusal = member.borrowRefusal;
  return (
    <section aria-label={t('circulation.member.card', { name: member.name })} className="flex flex-col gap-3 rounded-lg border bg-card p-4">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <p className="text-lg leading-tight font-semibold">{member.name}</p>
          <p className="text-sm text-muted-foreground">
            <span className="font-mono">{member.memberNo}</span> · {typeName}
            {member.className !== null && ` · ${member.className}`}
          </p>
        </div>
        <MemberStatusBadge status={member.status} />
      </div>
      <dl className="grid grid-cols-3 gap-2 text-center text-sm">
        <div className={cn('rounded-md border p-2', full && 'border-warning-foreground/30 bg-warning text-warning-foreground')}>
          <dt className="text-xs text-muted-foreground">{t('circulation.member.on_loan')}</dt>
          <dd className="text-lg font-semibold">
            {member.counts.openLoans}/{limit === null ? '∞' : limit}
          </dd>
        </div>
        <div className={cn('rounded-md border p-2', member.counts.overdue > 0 && 'border-destructive/40 bg-destructive/10 text-destructive')}>
          <dt className="text-xs text-muted-foreground">{t('circulation.member.overdue')}</dt>
          <dd className="text-lg font-semibold">{member.counts.overdue}</dd>
        </div>
        <div className="rounded-md border p-2">
          <dt className="text-xs text-muted-foreground">{t('circulation.member.valid_until')}</dt>
          <dd className="text-xs font-medium">{member.expiresOn === null ? t('members.never_expires') : day(member.expiresOn)}</dd>
        </div>
      </dl>
      <p className="text-xs text-muted-foreground">{t('circulation.member.limit', { limit: limitText(t, limit) })}</p>
      {member.counts.holdsReady > 0 && (
        <Badge tone="info" className="w-fit">
          {t('holds.member.ready_count', { count: member.counts.holdsReady })}
        </Badge>
      )}
      {Number(member.charges.balance) > 0 && <MemberBalance member={member} />}
      {refusal === 'CIRC_MEMBER_BLOCKED' && member.charges.blocked !== null && (
        <Badge tone="danger" className="w-fit">
          {t('charges.member.blocked', { reason: t(`vocab.member_block_reason.${member.charges.blocked}`) })}
        </Badge>
      )}
      {refusal === 'MEMBER_EXPIRED' && (
        <Alert variant="destructive">
          <CircleAlertIcon aria-hidden="true" />
          <AlertDescription className="grid gap-2">
            <p>{t('circulation.problem.member_expired')}</p>
            {canExtend && (
              <Button type="button" size="sm" variant="outline" className="w-fit" onClick={onExtend}>
                {t('circulation.member.extend')}
              </Button>
            )}
          </AlertDescription>
        </Alert>
      )}
      {refusal === 'MEMBER_SUSPENDED' && (
        <Alert className="border-warning-foreground/30 bg-warning text-warning-foreground">
          <TriangleAlertIcon aria-hidden="true" />
          <AlertDescription className="text-current">
            <p>{t('circulation.problem.member_suspended')}</p>
            {member.statusNote !== null && <p>{member.statusNote}</p>}
          </AlertDescription>
        </Alert>
      )}
      {refusal === 'CIRC_LIMIT_REACHED' && (
        <Badge tone="warning" className="w-fit">
          {limit === 0 ? t('circulation.problem.cannot_borrow') : t('circulation.member.limit_full')}
        </Badge>
      )}
      {member.notes !== null && member.notes !== '' && <p className="rounded-md bg-muted/50 px-2 py-1 text-sm">{member.notes}</p>}
      <div className="flex flex-wrap gap-2">
        {canOpen && (
          <Button asChild size="sm" variant="outline">
            <Link to={`/admin/anggota/${encodeURIComponent(member.id)}`}>{t('circulation.member.open')}</Link>
          </Button>
        )}
        <Button type="button" size="sm" variant="outline" onClick={onDone}>
          {t('circulation.member.done')}
        </Button>
      </div>
    </section>
  );
}

/** The member's unpaid balance on the desk card. */
function MemberBalance({ member }: { member: DeskMemberView }) {
  const t = useT();
  const money = useMoney();
  return (
    <Badge tone="warning" className="w-fit">
      {t('charges.member.balance_value', { amount: money(member.charges.balance, member.charges.currency) })}
    </Badge>
  );
}

const VISIT_TONE: Record<VisitRow['kind'], 'info' | 'neutral' | 'danger' | 'warning'> = {
  loan: 'info',
  return: 'neutral',
  renew: 'neutral',
  refused: 'danger',
  voided: 'warning',
};

/** "Transaksi kali ini": what happened since the member was loaded, the newest first. */
function VisitList({ rows }: { rows: readonly VisitRow[] }) {
  const t = useT();
  if (rows.length === 0) return <p className="rounded-md border px-3 py-6 text-center text-sm text-muted-foreground">{t('circulation.visit.empty')}</p>;
  return (
    <ul aria-label={t('circulation.visit.caption')} className="flex flex-col divide-y rounded-md border">
      {rows.map((row) => (
        <li key={row.seq} className="flex flex-wrap items-center justify-between gap-2 px-3 py-2 text-sm">
          <span className="flex min-w-0 items-center gap-2">
            <Badge tone={VISIT_TONE[row.kind]}>{t(`circulation.visit.kind.${row.kind}`)}</Badge>
            <span className="truncate font-medium">{row.title}</span>
            <span className="font-mono text-xs text-muted-foreground">{row.barcode}</span>
          </span>
          <span className="text-muted-foreground">{row.note}</span>
        </li>
      ))}
    </ul>
  );
}

/** The member's closed loans, newest first, a page at a time. */
function LoanHistory({
  query,
}: {
  query: { data?: { pages: LoanListResponse[] }; isPending: boolean; isError: boolean; error: unknown; hasNextPage: boolean; isFetchingNextPage: boolean; fetchNextPage(): unknown };
}) {
  const t = useT();
  const day = useCalendarDate();
  if (query.isError) return <Notice kind="error">{problemText(t, query.error)}</Notice>;
  if (query.data === undefined) return <p role="status" className="text-sm text-muted-foreground">{t('shell.loading')}</p>;
  const rows = query.data.pages.flatMap((p) => p.items);
  return (
    <>
      <div className="overflow-x-auto rounded-md border">
        <table className="w-full text-sm">
          <caption className="sr-only">{t('circulation.tab.history')}</caption>
          <thead className="bg-muted/50 text-left">
            <tr>
              <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                {t('circulation.col.item')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                {t('circulation.col.loaned')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                {t('circulation.col.returned')}
              </th>
              <th scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                {t('circulation.col.late')}
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
                  {t('circulation.history.empty')}
                </td>
              </tr>
            ) : (
              rows.map((loan) => (
                <tr key={loan.id} className="border-t align-top">
                  <td className="px-3 py-2">
                    <p className="font-medium">{loan.record?.title ?? '—'}</p>
                    <p className="font-mono text-xs text-muted-foreground">{loan.item?.barcode ?? '—'}</p>
                  </td>
                  <td className="px-3 py-2 whitespace-nowrap">{day(loan.loanedOn)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">{day(loan.returnedOn)}</td>
                  <td className="px-3 py-2 whitespace-nowrap">
                    {loan.daysLate > 0 ? <Badge tone="danger">{t('circulation.due.late', { count: loan.daysLate })}</Badge> : <Badge tone="neutral">{t('circulation.due.on_time')}</Badge>}
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
      {query.hasNextPage && (
        <Button type="button" variant="outline" size="sm" className="w-fit" disabled={query.isFetchingNextPage} onClick={() => void query.fetchNextPage()}>
          {t('circulation.load_more')}
        </Button>
      )}
    </>
  );
}

/** Kembali Cepat's tally of this session: returned, late, for another branch. */
function ReturnCounts({ rows }: { rows: readonly ReturnRow[] }) {
  const t = useT();
  const cells: [TKey, number, string][] = [
    ['circulation.returns.count', rows.length, ''],
    ['circulation.returns.late', rows.filter((r) => r.daysLate > 0).length, 'text-destructive'],
    ['circulation.returns.other_branch', rows.filter((r) => r.otherBranch !== null).length, 'text-warning-foreground'],
  ];
  return (
    <dl className="grid grid-cols-3 gap-2">
      {cells.map(([key, count, cls]) => (
        <div key={key} className="rounded-lg border bg-card p-3">
          <dt className="text-sm text-muted-foreground">{t(key)}</dt>
          <dd className={cn('text-2xl font-semibold', count > 0 && cls)}>{count}</dd>
        </div>
      ))}
    </dl>
  );
}

/** Kembali Cepat's list of this session's returns, the newest first; a late one stands out. */
function ReturnsTable({ rows }: { rows: readonly ReturnRow[] }) {
  const t = useT();
  const day = useCalendarDate();
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <caption className="sr-only">{t('circulation.returns.caption')}</caption>
        <thead className="bg-muted/50 text-left">
          <tr>
            {(['circulation.col.item', 'circulation.col.borrower', 'circulation.col.due', 'circulation.col.state'] as const).map((key) => (
              <th key={key} scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                {t(key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4} className="px-3 py-6 text-center text-muted-foreground">
                {t('circulation.returns.empty')}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.seq} className={cn('border-t align-top', row.daysLate > 0 && 'bg-destructive/5')}>
                <td className="px-3 py-2">
                  <p className="font-medium">{row.title}</p>
                  <p className="font-mono text-xs text-muted-foreground">{row.barcode}</p>
                </td>
                <td className="px-3 py-2 font-mono">{row.memberNo ?? '—'}</td>
                <td className="px-3 py-2 whitespace-nowrap">{day(row.dueOn)}</td>
                <td className="px-3 py-2">
                  <div className="flex flex-wrap gap-1">
                    {row.daysLate > 0 ? <Badge tone="danger">{t('circulation.due.late', { count: row.daysLate })}</Badge> : <Badge tone="info">{t('circulation.due.on_time')}</Badge>}
                    {row.otherBranch !== null && <Badge tone="warning">{t('circulation.returns.to_branch', { code: row.otherBranch })}</Badge>}
                    {row.keptFor !== null && <Badge tone="warning">{t('holds.returns.kept', { no: row.keptFor })}</Badge>}
                  </div>
                </td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

const SHORTCUTS: readonly [string, TKey, boolean][] = [
  ['F2', 'circulation.help.f2', true],
  ['F3', 'circulation.help.f3', false],
  ['F4', 'circulation.help.f4', false],
  ['F6', 'circulation.help.f6', false],
  ['F7 / F8', 'circulation.help.f7', false],
  ['Enter', 'circulation.help.enter', true],
  ['Esc', 'circulation.help.esc', true],
  ['↓ / ↑', 'circulation.help.arrows', false],
  ['K', 'circulation.help.k', false],
  ['P', 'circulation.help.p', false],
  ['Shift+P', 'circulation.help.shift_p', false],
  ['H', 'circulation.help.h', false],
  // ---- Komunitas (charges and payments) ----
  ['B', 'charges.help.b', false],
  ['F9', 'charges.help.f9', false],
  ['Ctrl+Z', 'circulation.help.ctrl_z', false],
  ['?', 'circulation.help.question', true],
];

/** The list of the desk's keys. */
function ShortcutsDialog({ open, quickReturn, onClose }: { open: boolean; quickReturn: boolean; onClose(): void }) {
  const t = useT();
  const rows: ReactNode[] = SHORTCUTS.filter(([, , both]) => both || !quickReturn).map(([key, text]) => (
    <tr key={key} className="border-t">
      <th scope="row" className="px-3 py-1.5 text-left font-mono font-medium whitespace-nowrap">
        {key}
      </th>
      <td className="px-3 py-1.5">{t(text)}</td>
    </tr>
  ));
  return (
    <Dialog open={open} onOpenChange={(next) => (next ? undefined : onClose())}>
      {open && (
        <DialogContent closeLabel={t('form.cancel')}>
          <DialogHeader>
            <DialogTitle>{t('circulation.help.title')}</DialogTitle>
            <DialogDescription>{t('circulation.help.intro')}</DialogDescription>
          </DialogHeader>
          <table className="w-full text-sm">
            <caption className="sr-only">{t('circulation.help.title')}</caption>
            <tbody>{rows}</tbody>
          </table>
        </DialogContent>
      )}
    </Dialog>
  );
}

/** "Pinjaman tercatat mundur": loans entered after the fact carry this day and the note (override holders only). */
function BackdatePanel({ value, onChange }: { value: { on: boolean; date: string; note: string }; onChange(v: { on: boolean; date: string; note: string }): void }) {
  const t = useT();
  const ids = useId();
  return (
    <div className="flex flex-col gap-2 rounded-md border border-dashed p-2">
      <label className="flex items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 accent-primary" checked={value.on} onChange={(e) => onChange({ ...value, on: e.target.checked })} />
        {t('circulation.backdate.toggle')}
      </label>
      {value.on && (
        <div className="flex flex-wrap items-end gap-2">
          <div className="grid gap-1">
            <Label htmlFor={`${ids}-date`}>{t('circulation.backdate.date')}</Label>
            <Input id={`${ids}-date`} type="date" max={todayLocal()} value={value.date} onChange={(e) => onChange({ ...value, date: e.target.value })} className="w-44" />
          </div>
          <div className="grid min-w-64 flex-1 gap-1">
            <Label htmlFor={`${ids}-note`}>{t('circulation.backdate.note')}</Label>
            <Input id={`${ids}-note`} maxLength={191} autoComplete="off" value={value.note} onChange={(e) => onChange({ ...value, note: e.target.value })} />
          </div>
        </div>
      )}
      {value.on && <p className="text-xs text-muted-foreground">{t('circulation.backdate.hint')}</p>}
    </div>
  );
}

/** Baca di tempat's list of this session's reads, the newest first; one that warns stands out. */
function ReadsTable({ rows }: { rows: readonly ReadRow[] }) {
  const t = useT();
  return (
    <div className="overflow-x-auto rounded-md border">
      <table className="w-full text-sm">
        <caption className="sr-only">{t('circulation.read.caption')}</caption>
        <thead className="bg-muted/50 text-left">
          <tr>
            {(['circulation.col.item', 'circulation.col.state'] as const).map((key) => (
              <th key={key} scope="col" className="px-3 py-2 font-medium text-muted-foreground">
                {t(key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={2} className="px-3 py-6 text-center text-muted-foreground">
                {t('circulation.read.empty')}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.seq} className={cn('border-t align-top', row.note !== null && 'bg-warning/30')}>
                <td className="px-3 py-2">
                  <p className="font-medium">{row.title}</p>
                  <p className="font-mono text-xs text-muted-foreground">{row.barcode}</p>
                </td>
                <td className="px-3 py-2">{row.note === null ? <Badge tone="info">{t('circulation.read.counted')}</Badge> : <Badge tone="warning">{row.note}</Badge>}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}
