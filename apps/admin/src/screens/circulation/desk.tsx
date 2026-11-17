import { ITEM_STATUSES, MEMBER_BLOCK_REASONS, RENEW_REFUSALS, VOID_REFUSALS, type ForceableReason, type ItemStatus, type MemberBlockReason, type RenewRefusal, type VoidRefusal } from '@altis/shared';
import type { PaymentView } from '@altis/shared/api/charges';
import type {
  CirculationWarningView,
  DeskItemGlance,
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
  TypeLoanRule,
} from '@altis/shared/api/circulation';
import { useInfiniteQuery, useQuery, useQueryClient } from '@tanstack/react-query';
import { Link, useNavigate, useSearch } from '@tanstack/react-router';
import { CircleAlertIcon, CircleCheckIcon, InfoIcon, TriangleAlertIcon } from 'lucide-react';
import { useCallback, useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent as ReactKeyboardEvent, type MouseEvent as ReactMouseEvent, type ReactNode } from 'react';
import { Notice, SELECT_CLASS } from '@/components/form-field';
import { Callout, FactList, Kbd, LAYER, MemberPhoto, StatusText, TABLE, TONE_SURFACE, TONE_TEXT, Tag, type StatusTone } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Tabs, TabsContent, TabsList, TabsTrigger, WRAPPING_TABS } from '@/components/ui/tabs';
import { useLocale, useT, type TKey, type Translate } from '@/i18n';
import { holds, holdsAt } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useMe } from '@/lib/me';
import { useScannerInput } from '@/lib/scanner';
import { isTypingTarget } from '@/lib/shortcuts';
import { cn } from '@/lib/utils';
import { ExtendPanel } from '@/screens/members/common';
import { DueDialog, LostDialog } from './desk-dialogs';
import {
  DESK_SOUND_KEY,
  MemberStatusBadge,
  beep,
  dueState,
  newTransactionKey,
  readStored,
  todayLocal,
  useCalendarDate,
  useDeskBranch,
  useTypeName,
  writeStored,
} from './common';
// ---- Komunitas (holds) ----
import { MemberHoldsPanel, holdSlipHref } from './holds';
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
 * - **Two columns.** The left one holds the mode switch, the scan box, the result of the last scan (the status as a
 *   colour, an icon and a sentence, with its main fact on the right: the due date or the days late) and the member's
 *   tabs; the right one is the member panel (photo or initials, the facts, the warnings, "Perpanjang masa
 *   keanggotaan" opened in place, Selesai and the profile), or in Kembali the tally of the returns. Under 1120 px the
 *   columns stack.
 * - **Feedback in three layers.** A colour (the scan box's edge and a short flash of it), a sentence big
 *   enough to read from across the desk, and an optional beep. Screen readers hear the same sentence from two fixed
 *   live regions outside the area that re-renders: `status` for done and "look at this", `alert` for refused.
 * - **Offers, never guesses.** An item the member already holds offers "Kembalikan sekarang?" and a barcode that is
 *   another member's card offers "Ganti ke anggota ini?"; both wait for Enter (or the button) and Esc cancels them.
 * - **Esc** steps back one level at a time: the suggestions, an offer, the name search, then "done with this member"
 *   (the visit list is cleared). "Pintasan" (or `?` while the box is empty) shows the keys as a panel in the page, not
 *   a dialog: scans keep working while it is open.
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
  /** The main fact of the outcome, shown on the right: the due date, the new due date, the days late. */
  fact?: { label: string; value: string };
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
  /** The clock time of the transaction (HH:MM). */
  time: string;
  kind: 'loan' | 'return' | 'renew' | 'refused' | 'voided';
  title: string;
  barcode: string;
  note: string;
  /** The loan of a loan, renewal or return (the slip lists it), or of a void (the slip leaves that loan out). */
  refId?: string;
}

interface ReturnRow {
  seq: number;
  time: string;
  barcode: string;
  title: string;
  memberNo: string | null;
  // ---- Komunitas (staff screens' data): who gave it back, linked for a member reader ----
  memberId: string | null;
  memberName: string | null;
  dueOn: string;
  daysLate: number;
  /** The days its overdue fine counted, when a fine was booked and they differ from `daysLate` (closed days). */
  finedDays: number | null;
  otherBranch: string | null;
  /** The member number the copy is kept for on the hold shelf. */
  keptFor: string | null;
}

type PanelTab = 'visit' | 'loans' | 'holds' | 'charges' | 'history';

/** One item read in place at this desk, the newest first. */
interface ReadRow {
  seq: number;
  time: string;
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

/** "N days late", with the days its fine counted when they differ (closed days are not fined); "on time" at 0. */
function lateText(t: Translate, daysLate: number, finedDays: number | null): string {
  if (daysLate <= 0) return t('circulation.due.on_time');
  return finedDays === null ? t('circulation.due.late', { count: daysLate }) : t('circulation.due.late_fined', { count: daysLate, fined: finedDays });
}

/** The refusals of a loan that are about the scanned item: the desk asks what it may say about it. */
const REFUSALS_ABOUT_ITEM: ReadonlySet<string> = new Set([
  'CIRC_OTHER_BRANCH',
  'CIRC_NOT_LOANABLE',
  'CIRC_ITEM_ON_LOAN',
  'CIRC_ITEM_ON_HOLD',
  'CIRC_LIMIT_REACHED',
  'CIRC_MEMBER_BLOCKED',
  'CIRC_NO_POLICY',
  'TX_CONFLICT',
  'CONFLICT_STALE',
]);

/** The detail line of a refused loan from the item's glance: "Judul · B001, jatuh tempo Sen, 21 Nov 2026." and the like. */
export function glanceText(t: Translate, day: (d: string) => string, g: DeskItemGlance, e: ApiError): string {
  const item = `${g.title} · ${g.barcode}`;
  if (e.code === 'CIRC_ITEM_ON_LOAN' && g.dueOn !== null) return t('circulation.refusal.due', { item, date: day(g.dueOn) });
  if (e.code === 'CIRC_OTHER_BRANCH') return t('circulation.refusal.branch', { item, code: g.branchCode });
  if (e.code === 'CIRC_NOT_LOANABLE' && e.reason === 'status' && (ITEM_STATUSES as readonly string[]).includes(g.status)) {
    return t('circulation.refusal.status', { item, status: t(`vocab.item_status.${g.status as ItemStatus}`) });
  }
  if (e.code === 'CIRC_ITEM_ON_HOLD' || g.onHoldShelf) return t('circulation.refusal.hold_shelf', { item });
  return `${item}.`;
}

/** "14 hari, perpanjang 2×" ("Hari itu juga" for 0 days; "tidak bisa diperpanjang" for no renewal). */
function loanPeriodText(t: Translate, rule: TypeLoanRule): string {
  const days = rule.loanDays === 0 ? t('members.types.rule.same_day') : t('members.types.days', { count: rule.loanDays });
  return rule.renewLimit === 0 ? t('circulation.member.loan_period_no_renewal', { days }) : t('circulation.member.loan_period_value', { days, count: rule.renewLimit });
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
  const clock = useClock();
  /** The hold shelf slip (a roll PDF) of the copy the last return kept for a hold. */
  const [slip, setSlip] = useState<string | null>(null);
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
  // The desk's own panels (the keys, extending the membership) open in the page: only a real dialog stops the desk.
  const dialogOpen = lostLoan !== null || dueLoan !== null || chargesDialog || holdsDialog;

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

  const say = (tone: Tone, title: string, detail?: string, fact?: { label: string; value: string }): void => {
    seq.current += 1;
    setFeedback({ tone, title, ...(detail === undefined || detail === '' ? {} : { detail }), ...(fact === undefined ? {} : { fact }), seq: seq.current });
    const said = [title, detail ?? '', fact === undefined ? '' : `${fact.label}: ${fact.value}`].filter((x) => x !== '');
    const text = said.join(' ');
    setLive({ status: tone === 'error' ? '' : text, alert: tone === 'error' ? text : '', seq: seq.current });
    setFlash(tone);
    if (sound && (tone === 'success' || tone === 'warning' || tone === 'error')) beep(tone);
  };

  const addVisit = (row: Omit<VisitRow, 'seq' | 'time'>): void => {
    seq.current += 1;
    const next = { ...row, seq: seq.current, time: clock() };
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
    // Overdue loans do not stop lending, but the desk should see them at once: the card turns to a warning and says so.
    const late = view.counts.overdue > 0 ? [`${t('circulation.member.late_title', { count: view.counts.overdue })}.`, t('circulation.member.late_body')] : [];
    const notes = [...late, ...warningTexts(t, day, view.warnings)];
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
      say(notes.length > 0 ? 'warning' : 'success', t('circulation.feedback.lent', { title: loan.record.title, date: day(loan.dueOn) }), [...notes, next].join(' '), {
        label: t('circulation.col.due'),
        value: day(loan.dueOn),
      });
      await refreshPanel();
    } catch (e) {
      settle(e);
      const refusal = deskRefusal(t, e, { action: 'loan', code: barcode, member: panel });
      addVisit({ kind: 'refused', title: '', barcode, note: refusal.title });
      const reason = forceableOf(e);
      if (refusal.offer === undefined && reason !== null && canOverride) {
        setOffer({ kind: 'force', barcode, reasons: [...new Set([...(force?.reasons ?? []), reason])] });
        if (force !== undefined) setForceNote(force.note);
        say('warning', refusal.title, t('circulation.override.hint'));
        void explain(e, barcode, panel, t('circulation.override.hint'));
        return;
      }
      if (refusal.offer !== undefined) setOffer(refusal.offer);
      const hint = refusal.offer === undefined ? undefined : t('circulation.offer.hint');
      say(refusal.offer !== undefined ? 'warning' : 'error', refusal.title, hint);
      void explain(e, barcode, panel, hint);
    }
  };

  // ---- Komunitas (staff screens' data) ----
  /**
   * Fills the detail line under a refused loan once the server has said what it may about the item (its title, and its
   * due date, branch, status or hold shelf; never who holds it) or the member (the suspension note, the expiry date),
   * unless another result has replaced the card meanwhile. The live regions keep the first sentence.
   */
  const explain = async (e: unknown, barcode: string, member: DeskMemberView, hint: string | undefined): Promise<void> => {
    const at = seq.current;
    if (!(e instanceof ApiError) || branchId === null) return;
    let line: string | null = null;
    if (e.code === 'MEMBER_SUSPENDED') line = member.statusNote;
    else if (e.code === 'MEMBER_EXPIRED') line = member.expiresOn === null ? null : t('circulation.refusal.expired_on', { date: day(member.expiresOn) });
    else if (REFUSALS_ABOUT_ITEM.has(e.code)) {
      try {
        const glance = await api<DeskItemGlance>('POST', `branches/${encodeURIComponent(branchId)}/circulation/items/glance`, { barcode });
        line = glanceText(t, day, glance, e);
      } catch {
        line = null;
      }
    }
    if (line === null || line === '') return;
    const detail = [line, hint ?? ''].filter((x) => x !== '').join(' ');
    setFeedback((f) => (f.seq === at ? { ...f, detail } : f));
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
      addVisit({ kind: 'voided', title: target.title, barcode: target.barcode, note: t('circulation.void.visit'), refId: target.id });
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
      const row: ReadRow = { seq: seq.current, time: clock(), barcode: done.item.barcode, title: done.record.title, note };
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
      // The fine leaves out the days the library was closed: say both counts when they differ, or the fine looks wrong.
      const finedDays = done.finedDays !== undefined && done.finedDays !== done.daysLate ? done.finedDays : null;
      const title =
        done.foundLost === true
          ? t('circulation.lost.found')
          : otherBranch !== null
          ? t('circulation.feedback.returned_branch', { code: otherBranch })
          : done.daysLate > 0
            ? finedDays !== null
              ? t('circulation.feedback.returned_late_fined', { count: done.daysLate, fined: finedDays })
              : t('circulation.feedback.returned_late', { count: done.daysLate })
            : t('circulation.feedback.returned');
      const detail = `${done.record.title} · ${done.item.barcode}`;
      const fact =
        done.daysLate > 0
          ? { label: t('circulation.member.overdue'), value: t('circulation.fact.days', { count: done.daysLate }) }
          : { label: t('circulation.col.due'), value: day(done.dueOn) };
      if (done.hold !== undefined) {
        // The copy is kept for a hold: that is what the desk must do now, whatever else the return says.
        setSlip(holdSlipHref(branchId, done.hold.holdId));
        say(
          'warning',
          t('holds.desk.keep_for', { no: done.hold.memberNo }),
          [t('holds.desk.keep_detail', { name: done.hold.memberName, date: day(done.hold.pickupUntil), title: done.record.title }), done.daysLate > 0 ? title : ''].join(' ').trim(),
          fact,
        );
      } else {
        setSlip(null);
        say(otherBranch !== null || done.daysLate > 0 ? 'warning' : 'success', title, detail, fact);
      }
      addVisit({ kind: 'return', title: done.record.title, barcode: done.item.barcode, note: lateText(t, done.daysLate, finedDays), refId: done.id });
      seq.current += 1;
      const row: ReturnRow = {
        seq: seq.current,
        time: clock(),
        barcode: done.item.barcode,
        title: done.record.title,
        memberNo: done.memberNo,
        memberId: done.memberId,
        memberName: done.memberName ?? null,
        dueOn: done.dueOn,
        daysLate: done.daysLate,
        finedDays,
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
      if (!quickReturn) addVisit({ kind: 'refused', title: '', barcode, note: refusal.title });
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
      say(notes.length > 0 ? 'warning' : 'success', t('circulation.feedback.renewed', { date: day(done.dueOn) }), [loan.record.title, ...notes].join(' · '), {
        label: t('circulation.fact.new_due'),
        value: day(done.dueOn),
      });
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
    // What this visit did, in one line ("2 dipinjam, 1 dikembalikan, 0 diperpanjang").
    const tally = t('circulation.feedback.done_tally', {
      loans: visit.filter((r) => r.kind === 'loan').length,
      returns: visit.filter((r) => r.kind === 'return').length,
      renewals: visit.filter((r) => r.kind === 'renew').length,
    });
    setMemberId(null);
    setExtendOpen(false);
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
    if (name === undefined) say('info', t('circulation.feedback.ready'));
    else say('info', t('circulation.feedback.done', { name }), `${tally} ${t('circulation.feedback.next_member')}`);
    focusBox();
  };

  /** F9: the slip of this visit (the loans, renewals and returns of the list, and the payments taken). */
  const slipNow = async (): Promise<void> => {
    if (branchId === null) return;
    const voided = new Set(visit.filter((r) => r.kind === 'voided').map((r) => r.refId));
    const ids = (kinds: VisitRow['kind'][]) => [...new Set(visit.filter((r) => kinds.includes(r.kind) && r.refId !== undefined && !voided.has(r.refId)).map((r) => r.refId!))].slice(0, 50);
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
    if (current.kind === 'force') {
      // Forcing: the reason is asked for first (the panel under the feedback) and the focus goes to its field, not back
      // to the box; Enter there sends the loan again.
      setForcing({ barcode: current.barcode, reasons: current.reasons });
      requestAnimationFrame(() => forceInput.current?.focus());
      return;
    }
    setBusy(true);
    try {
      if (current.kind === 'switch') await lookup(current.memberNo);
      else if (current.kind === 'return') await giveBack(current.barcode);
      else await giveBack(current.barcode, true);
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
      // A key another layer already used is not the desk's: a dialog closes on Esc (and marks the key as used) before
      // this listener runs, by which time the desk may already see the dialog as closed; that Esc must not also end
      // the visit.
      if (dialogOpen || e.isComposing || e.defaultPrevented) return;
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
      } else if (key === '?' && !e.ctrlKey && !e.metaKey && !e.altKey && (value === '' || !isTypingTarget(e.target))) {
        // `?` shows or hides the keys (in the box only while it is empty: a name or barcode never holds one).
        e.preventDefault();
        setHelpOpen((open) => !open);
      } else if ((key === 'F7' || key === 'F8') && !quickReturn && memberId !== null && mode === 'member') {
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
    // A control, or anything that takes the focus itself, inside the desk (the page's own focusable frame, such as the
    // main region the skip link reaches, does not count).
    const control = target.closest('a,button,input,select,textarea,[tabindex]:not([tabindex="-1"]),[role="tab"],label,[data-keep-focus]');
    if (control !== null && e.currentTarget.contains(control)) return;
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

  const placeholder =
    mode === 'name'
      ? t('circulation.scan.placeholder.name')
      : mode === 'member' && memberId === null
        ? t('circulation.scan.placeholder.member')
        : t('circulation.scan.placeholder.item');

  const scanHint = quickReturn
    ? t('circulation.scan.hint_return')
    : mode === 'read'
      ? t('circulation.scan.hint_read')
      : mode === 'return'
        ? t('circulation.scan.hint.return')
        : mode === 'name'
          ? t('circulation.scan.hint.name')
          : memberId !== null
            ? t('circulation.scan.hint.item')
            : t('circulation.scan.hint.member');

  const toggleSound = (): void => {
    setSound((on) => {
      writeStored(DESK_SOUND_KEY, on ? '0' : '1');
      return !on;
    });
    focusBox();
  };

  const branchName = desk.branches?.find((b) => b.id === branchId)?.name ?? '';
  const showReturns = quickReturn || mode === 'return';
  const showReads = !quickReturn && mode === 'read';
  const keysId = `${ids}-keys`;
  const idle = feedback.tone === 'idle';
  const tone = FEEDBACK_TONE[feedback.tone];

  return (
    <div className="grid gap-6" onMouseUp={refocus}>
      {/* The two fixed live regions: what the desk says, heard once per scan (a new node each time). */}
      <div role="status" aria-live="polite" className="sr-only">
        {live.status !== '' && <p key={live.seq}>{live.status}</p>}
      </div>
      <div role="alert" className="sr-only">
        {live.alert !== '' && <p key={live.seq}>{live.alert}</p>}
      </div>

      <div className="flex flex-wrap items-end justify-between gap-x-4 gap-y-3">
        <div className="grid max-w-[75ch] min-w-0 gap-1">
          <h1 className="text-xl leading-tight font-bold">{t(quickReturn ? 'nav.circulation.quick_return' : inLibrary ? 'nav.circulation.in_library' : 'nav.circulation.desk')}</h1>
          <p className="text-sm text-muted-foreground">{t(quickReturn ? 'circulation.desk.intro_quick' : inLibrary ? 'circulation.desk.intro_read' : 'circulation.desk.intro')}</p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {desk.branches !== undefined && desk.branches.length > 1 && (
            <div className="flex items-center gap-2">
              <Label htmlFor={`${ids}-branch`} className="text-sm font-normal">
                {t('circulation.desk.branch')}
              </Label>
              <select
                id={`${ids}-branch`}
                className={cn(SELECT_CLASS, 'h-7.5 w-auto max-w-56 md:text-meta')}
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
          {desk.branches !== undefined && desk.branches.length === 1 && <p className="text-sm text-muted-foreground">{t('circulation.desk.branch_named', { name: branchName })}</p>}
          <Button type="button" size="sm" variant="outline" aria-pressed={sound} onClick={toggleSound}>
            {t(sound ? 'circulation.desk.sound_on' : 'circulation.desk.sound_off')}
          </Button>
          <Button
            type="button"
            size="sm"
            variant="outline"
            aria-expanded={helpOpen}
            aria-controls={keysId}
            aria-keyshortcuts="Shift+?"
            onClick={() => {
              setHelpOpen((open) => !open);
              focusBox();
            }}>
            {t('circulation.desk.shortcuts')}
            <Kbd hidden>?</Kbd>
          </Button>
        </div>
      </div>

      {helpOpen && <KeysPanel id={keysId} quickReturn={quickReturn} />}

      {desk.error !== null && desk.branches === undefined && <Notice kind="error">{problemText(t, desk.error)}</Notice>}
      {desk.branches !== undefined && desk.branches.length === 0 && <Notice kind="error">{t('circulation.desk.no_branch')}</Notice>}

      {branchId !== null && (
        <div className="grid items-start gap-6 min-[1120px]:grid-cols-[minmax(0,1fr)_320px]">
          <div className="grid min-w-0 gap-4">
            {!quickReturn && !inLibrary && <ModeSwitch mode={mode} onSwitch={switchMode} />}
            <form noValidate autoComplete="off" onSubmit={submit} className="grid gap-1.5">
              <label htmlFor={`${ids}-scan`} className="text-base font-bold">
                {scanLabel}
              </label>
              <div className="relative flex flex-wrap gap-2">
                <div
                  data-tone={idle ? undefined : feedback.tone}
                  className={cn(
                    'flex h-13 min-w-0 flex-[1_1_320px] items-center rounded-lg border-2 bg-background px-3.5 focus-within:border-primary focus-within:ring-3 focus-within:ring-accent-soft motion-safe:transition-[border-color,box-shadow,background-color] motion-safe:duration-500',
                    tone === null ? 'border-input' : BOX_TONE[tone],
                    flash !== 'idle' && tone !== null && FLASH_TONE[tone],
                  )}>
                  <input
                    id={`${ids}-scan`}
                    ref={input}
                    // The desk opens on the scan box: a scanner works at once.
                    autoFocus
                    type="text"
                    autoComplete="off"
                    autoCapitalize="off"
                    spellCheck={false}
                    enterKeyHint="go"
                    maxLength={200}
                    value={value}
                    placeholder={placeholder}
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
                    className="min-w-0 flex-1 border-0 bg-transparent text-[22px] font-semibold tracking-wide tabular-nums outline-none placeholder:text-[15px] placeholder:font-normal placeholder:tracking-normal placeholder:text-muted-foreground"
                  />
                </div>
                <Button type="submit" size="lg" className="h-12 self-center px-5 text-[15px]" disabled={busy} aria-keyshortcuts="Enter">
                  {t('circulation.scan.process')}
                  <Kbd hidden>Enter</Kbd>
                </Button>
                {suggesting && options.length > 0 && (
                  <ul
                    id={listboxId}
                    role="listbox"
                    aria-label={t('circulation.scan.suggestions')}
                    className="absolute top-full right-0 left-0 z-30 mt-1 max-h-90 overflow-y-auto rounded-lg border bg-popover p-1 text-popover-foreground shadow-pop">
                    {options.map((o, i) => (
                      <li
                        key={o.id}
                        id={`${listboxId}-${i}`}
                        role="option"
                        aria-selected={i === active}
                        className={cn('flex cursor-pointer items-center gap-3 rounded-md px-2.5 py-2', i === active && 'bg-accent-soft')}
                        onMouseDown={(e) => e.preventDefault()}
                        onClick={() => {
                          setValue('');
                          void openMember(o.id).then(focusBox);
                        }}>
                        <span className="grid min-w-0">
                          <span className="font-semibold">{o.name}</span>
                          <span className="text-sm text-muted-foreground">
                            <span className="font-semibold tabular-nums">{o.memberNo}</span>
                            {o.className !== null && ` · ${o.className}`}
                          </span>
                        </span>
                        <span className="ml-auto">
                          <MemberStatusBadge status={o.status} />
                        </span>
                      </li>
                    ))}
                  </ul>
                )}
              </div>
              <p id={`${ids}-scan-hint`} className="text-xs text-muted-foreground">
                {scanHint}
              </p>
              {canOverride && !quickReturn && !inLibrary && mode === 'member' && member !== null && <BackdatePanel value={backdate} onChange={setBackdate} />}
            </form>

            <div
              data-testid="desk-feedback"
              data-tone={feedback.tone}
              className={cn(
                'grid min-h-19 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3.5 gap-y-1 rounded-lg border px-4 py-3.5 sm:grid-cols-[auto_minmax(0,1fr)_auto]',
                tone === null ? cn('border-border', LAYER) : TONE_SURFACE[tone],
              )}>
              <ToneIcon tone={feedback.tone} />
              <div className="grid min-w-0 gap-0.5">
                <p className={cn(idle ? 'text-base font-bold' : 'text-xl leading-snug font-bold', tone !== null && TONE_TEXT[tone])}>{feedback.title}</p>
                {idle && <p className="text-sm text-muted-foreground">{t('circulation.feedback.ready_hint')}</p>}
                {feedback.detail !== undefined && <p className="text-sm">{feedback.detail}</p>}
                {slip !== null && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button asChild size="sm" variant="outline">
                      <a href={slip} target="_blank" rel="noopener">
                        {t('holds.action.print_slip')}
                      </a>
                    </Button>
                  </div>
                )}
                {receipt !== null && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button asChild size="sm" variant="outline">
                      <a href={receipt.href} target="_blank" rel="noopener">
                        {t('charges.pay.print', { number: receipt.number })}
                      </a>
                    </Button>
                  </div>
                )}
                {offer !== null && (
                  <div className="mt-2 flex flex-wrap gap-2">
                    <Button type="button" size="sm" onClick={() => void confirmOffer()}>
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
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setOffer(null);
                        focusBox();
                      }}>
                      {t('circulation.offer.cancel')}
                    </Button>
                  </div>
                )}
                {forcing !== null && member !== null && (
                  <form
                    noValidate
                    data-keep-focus
                    className="mt-2 flex flex-wrap items-end gap-2"
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
                    <div className="grid min-w-0 flex-[1_1_16rem] gap-1">
                      <Label htmlFor={`${ids}-force`}>{t('circulation.override.note', { reasons: forcing.reasons.map((r) => t(`vocab.override_reason.${r}`)).join(', ') })}</Label>
                      <Input id={`${ids}-force`} ref={forceInput} maxLength={191} autoComplete="off" value={forceNote} onChange={(e) => setForceNote(e.target.value)} className="h-7.5 bg-background md:text-meta" />
                    </div>
                    <Button type="submit" size="sm" disabled={forceNote.trim() === ''}>
                      {t('circulation.override.submit')}
                    </Button>
                    <Button
                      type="button"
                      size="sm"
                      variant="outline"
                      onClick={() => {
                        setForcing(null);
                        focusBox();
                      }}>
                      {t('circulation.offer.cancel')}
                    </Button>
                  </form>
                )}
              </div>
              {feedback.fact !== undefined && (
                <div className="col-start-2 grid justify-items-start sm:col-start-auto sm:min-w-38 sm:justify-items-end sm:border-l sm:border-current/15 sm:pl-4 sm:text-right">
                  <span className="text-xs text-muted-foreground">{feedback.fact.label}</span>
                  <strong className={cn('text-lg leading-snug tabular-nums', tone !== null && TONE_TEXT[tone])}>{feedback.fact.value}</strong>
                </div>
              )}
            </div>

            {showReturns ? (
              <ReturnsTable rows={returns} />
            ) : showReads ? (
              <ReadsTable rows={reads} />
            ) : (
              member !== null && (
                <Tabs value={tab} onValueChange={(v) => setTab(v as PanelTab)} className="min-w-0">
                  <div className="flex items-end gap-2 border-b">
                    <TabsList className={cn(WRAPPING_TABS.list, 'w-auto min-w-0 flex-1 border-b-0')} aria-label={t('circulation.tabs.label')}>
                      <TabsTrigger value="visit" className={WRAPPING_TABS.trigger}>
                        {t('circulation.tab.visit', { count: visit.length })}
                      </TabsTrigger>
                      <TabsTrigger value="loans" className={WRAPPING_TABS.trigger}>
                        {t('circulation.tab.loans', { count: member.loans.length })}
                      </TabsTrigger>
                      <TabsTrigger value="holds" className={WRAPPING_TABS.trigger}>
                        {t('holds.member.tab', { count: member.holds.length })}
                      </TabsTrigger>
                      <TabsTrigger value="charges" className={WRAPPING_TABS.trigger}>
                        {t('charges.member.tab', { count: member.charges.charges.length })}
                      </TabsTrigger>
                      {canReadLoans && (
                        <TabsTrigger value="history" className={WRAPPING_TABS.trigger}>
                          {t('circulation.tab.history')}
                        </TabsTrigger>
                      )}
                    </TabsList>
                    <span aria-hidden="true" className="hidden pb-1.5 text-muted-foreground sm:inline">
                      <Kbd>F7</Kbd> <Kbd>F8</Kbd>
                    </span>
                  </div>
                  <TabsContent value="visit" className="grid gap-2">
                    <div className="flex justify-end">
                      <Button type="button" variant="outline" size="sm" onClick={() => void slipNow()}>
                        {t('charges.slip.print')}
                      </Button>
                    </div>
                    <VisitTable rows={visit} />
                  </TabsContent>
                  <TabsContent value="loans" className="grid gap-2">
                    <div className="flex flex-wrap items-center justify-between gap-2">
                      <p className="text-xs text-muted-foreground">{t('circulation.loans.keys_hint')}</p>
                      <Button type="button" variant="outline" size="sm" aria-keyshortcuts="Shift+P" disabled={busy || member.loans.length === 0} onClick={() => void renewAll()}>
                        {t('circulation.action.renew_all')}
                        <Kbd hidden>Shift P</Kbd>
                      </Button>
                    </div>
                    <div className={TABLE.wrap}>
                      <table className={TABLE.table}>
                        <caption className="sr-only">{t('circulation.loans.caption', { name: member.name })}</caption>
                        <thead>
                          <tr>
                            <th scope="col" className={TABLE.th}>
                              {t('circulation.col.barcode')}
                            </th>
                            <th scope="col" className={TABLE.th}>
                              {t('circulation.col.title')}
                            </th>
                            <th scope="col" className={TABLE.th}>
                              {t('circulation.col.due')}
                            </th>
                            <th scope="col" className={TABLE.th}>
                              {t('circulation.col.renewals')}
                            </th>
                            <th scope="col" className={TABLE.th}>
                              {t('circulation.col.state')}
                            </th>
                            <th scope="col" className={TABLE.th}>
                              <span className="sr-only">{t('table.actions')}</span>
                            </th>
                          </tr>
                        </thead>
                        <tbody>
                          {member.loans.length === 0 ? (
                            <tr>
                              <td colSpan={6} className={TABLE.empty}>
                                {t('circulation.loans.empty')}
                              </td>
                            </tr>
                          ) : (
                            member.loans.map((loan, i) => {
                              const state = dueState(t, loan.dueOn, loan.daysLate);
                              return (
                                <tr
                                  key={loan.id}
                                  ref={(el) => {
                                    loanRows.current[i] = el;
                                  }}
                                  tabIndex={0}
                                  aria-label={t('circulation.loans.row', { title: loan.record.title, date: day(loan.dueOn) })}
                                  onKeyDown={(e) => onRowKey(e, i, loan)}
                                  className={TABLE.focusRow}>
                                  <td className={cn(TABLE.td, 'whitespace-nowrap')}>
                                    <span className="font-semibold tracking-wide">{loan.item.barcode}</span>
                                    {loan.item.callNumber !== null && <span className="block text-xs text-muted-foreground">{loan.item.callNumber}</span>}
                                  </td>
                                  <td className={TABLE.td}>{loan.record.title}</td>
                                  <td className={cn(TABLE.td, 'whitespace-nowrap')}>{day(loan.dueOn)}</td>
                                  <td className={cn(TABLE.td, 'whitespace-nowrap')}>{t('circulation.loans.renewals', { count: loan.renewals, limit: loan.renewLimit })}</td>
                                  <td className={TABLE.td}>
                                    {state.tone === 'neutral' ? <span className="text-muted-foreground">{state.text}</span> : <StatusText tone={state.tone === 'danger' ? 'bad' : 'warn'}>{state.text}</StatusText>}
                                    {loan.finePreview !== null && (
                                      <span className="mt-0.5 block text-xs text-bad">
                                        {t('charges.fine_preview', { amount: money(loan.finePreview.amount, loan.finePreview.currency), days: loan.finePreview.days })}
                                      </span>
                                    )}
                                  </td>
                                  <td className={cn(TABLE.td, 'text-right whitespace-nowrap')}>
                                    <Button type="button" size="sm" variant="ghost" tabIndex={-1} disabled={busy} onClick={() => void giveBack(loan.item.barcode).then(focusBox)}>
                                      {t('circulation.action.return')}
                                    </Button>
                                    <Button type="button" size="sm" variant="ghost" tabIndex={-1} disabled={busy} onClick={() => void renew(loan)}>
                                      {t('circulation.action.renew')}
                                    </Button>
                                    <Button type="button" size="sm" variant="ghost" tabIndex={-1} disabled={busy || loan.branchId !== branchId} onClick={() => setLostLoan(loan)}>
                                      {t('circulation.action.lost')}
                                    </Button>
                                    {canOverride && (
                                      <Button type="button" size="sm" variant="ghost" tabIndex={-1} disabled={busy || loan.branchId !== branchId} onClick={() => setDueLoan(loan)}>
                                        {t('circulation.action.due')}
                                      </Button>
                                    )}
                                  </td>
                                </tr>
                              );
                            })
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
                    <TabsContent value="history" className="grid gap-2">
                      <LoanHistory query={history} />
                    </TabsContent>
                  )}
                </Tabs>
              )
            )}
          </div>

          {showReturns ? (
            <ReturnSide rows={returns} back={quickReturn ? null : (member?.name ?? '')} />
          ) : showReads ? (
            <ReadSide rows={reads} back={inLibrary ? null : (member?.name ?? '')} />
          ) : (
            <MemberPanel
              member={member}
              loading={memberId !== null && memberQuery.isPending}
              error={memberId !== null && memberQuery.isError ? memberQuery.error : null}
              canExtend={canExtend}
              canOpen={canReadMembers}
              typeName={member === null ? '' : typeName(member.type)}
              extending={extendOpen}
              onExtend={() => setExtendOpen(true)}
              onExtendClose={() => {
                setExtendOpen(false);
                focusBox();
              }}
              onExtended={() => say('success', t('circulation.feedback.extended'), t('circulation.feedback.scan_items'))}
              onDone={done}
            />
          )}
        </div>
      )}

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
              say('warning', t('circulation.lost.done', { title: loan.record.title }), t(r.charged ? 'circulation.lost.charged' : 'circulation.lost.not_charged', { amount: money(r.replacement, r.currency) }));
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
              say(closedDay ? 'warning' : 'success', t('circulation.due_change.done', { title: loan.record.title, date: day(r.dueOn) }), closedDay ? t('vocab.circulation_warning.due_on_closed_day') : undefined, {
                label: t('circulation.fact.new_due'),
                value: day(r.dueOn),
              });
              void refreshPanel();
              focusBox();
            }}
          />
        </>
      )}
    </div>
  );
}

/** The desk's tones as the status tones of the page (null: the neutral "ready" and "info" card). */
const FEEDBACK_TONE: Readonly<Record<Tone, StatusTone | null>> = { idle: null, info: null, success: 'ok', warning: 'warn', error: 'bad' };

/** The scan box's edge after a scan: the outcome's colour. */
const BOX_TONE: Readonly<Record<StatusTone, string>> = {
  ok: 'border-ok-line',
  warn: 'border-warn-line',
  bad: 'border-bad-line',
};

/** The short flash of the scan box (gone after 0.9 s; without movement when the system asks for less motion). */
const FLASH_TONE: Readonly<Record<StatusTone, string>> = {
  ok: 'bg-ok-bg',
  warn: 'bg-warn-bg',
  bad: 'bg-bad-bg',
};

function ToneIcon({ tone }: { tone: Tone }) {
  const status = FEEDBACK_TONE[tone];
  const cls = cn('mt-0.5 size-6 shrink-0 [stroke-width:2.2]', status === null ? 'text-muted-foreground' : TONE_TEXT[status]);
  if (tone === 'success') return <CircleCheckIcon className={cls} aria-hidden="true" />;
  if (tone === 'warning') return <TriangleAlertIcon className={cls} aria-hidden="true" />;
  if (tone === 'error') return <CircleAlertIcon className={cls} aria-hidden="true" />;
  return <InfoIcon className={cls} aria-hidden="true" />;
}

/** The clock time now, "14.05" or "14:05" by the UI language. */
function useClock(): () => string {
  const locale = useLocale();
  return useCallback(() => new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'id-ID', { hour: '2-digit', minute: '2-digit' }).format(new Date()), [locale]);
}

const MODES: readonly { mode: Mode; key: string; label: TKey }[] = [
  { mode: 'member', key: 'F2', label: 'circulation.mode.member_short' },
  { mode: 'return', key: 'F3', label: 'circulation.mode.return_short' },
  { mode: 'read', key: 'F4', label: 'circulation.mode.read_short' },
  { mode: 'name', key: 'F6', label: 'circulation.mode.name_short' },
];

/** The desk's modes as one segmented switch; each names its function key. */
function ModeSwitch({ mode, onSwitch }: { mode: Mode; onSwitch(mode: Mode): void }) {
  const t = useT();
  return (
    <div role="group" aria-label={t('circulation.mode.label')} className="flex w-fit max-w-full flex-wrap overflow-hidden rounded-md border border-input">
      {MODES.map((m) => (
        <button
          key={m.mode}
          type="button"
          aria-pressed={mode === m.mode}
          aria-keyshortcuts={m.key}
          onClick={() => onSwitch(m.mode)}
          className={cn(
            '-mr-px -mb-px inline-flex h-8 flex-auto items-center justify-center gap-2 border-r border-b border-input px-3 text-sm font-semibold outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset',
            mode === m.mode ? 'bg-accent-soft text-accent-text' : 'bg-background text-muted-foreground hover:bg-layer-2 hover:text-foreground',
          )}>
          {t(m.label)}
          <Kbd hidden>{m.key}</Kbd>
        </button>
      ))}
    </div>
  );
}

/** The member panel of the desk: who (photo or initials), the facts, why lending may be refused, and the ways out. */
function MemberPanel({
  member,
  loading,
  error,
  canExtend,
  canOpen,
  typeName,
  extending,
  onExtend,
  onExtendClose,
  onExtended,
  onDone,
}: {
  member: DeskMemberView | null;
  loading: boolean;
  error: unknown;
  canExtend: boolean;
  canOpen: boolean;
  typeName: string;
  extending: boolean;
  onExtend(): void;
  onExtendClose(): void;
  onExtended(): void;
  onDone(): void;
}) {
  const t = useT();
  const day = useCalendarDate();
  const money = useMoney();
  const nameId = useId();
  const box = cn('grid content-start gap-3.5 rounded-lg border p-4', LAYER);
  if (error !== null) {
    return (
      <aside aria-label={t('circulation.member.panel')} className={box}>
        <Callout tone="bad" role="alert" title={problemText(t, error)} />
      </aside>
    );
  }
  if (loading) {
    return (
      <aside aria-busy="true" aria-label={t('circulation.member.loading')} className={box}>
        <div className="flex items-start gap-3">
          <span className="h-20 w-15 shrink-0 rounded border bg-layer-2" />
          <div className="grid flex-1 gap-2 pt-1">
            <span className="h-3 w-4/5 animate-pulse rounded bg-layer-2 motion-reduce:animate-none" />
            <span className="h-3 w-2/5 animate-pulse rounded bg-layer-2 motion-reduce:animate-none" />
          </div>
        </div>
      </aside>
    );
  }
  if (member === null) {
    return (
      <aside aria-labelledby={nameId} className={box}>
        <h2 id={nameId} className="text-base font-bold">
          {t('circulation.member.none')}
        </h2>
        <p className="text-sm text-muted-foreground">{t('circulation.member.none_scan')}</p>
        <p className="text-sm text-muted-foreground">{t('circulation.member.none_return')}</p>
      </aside>
    );
  }
  const limit = member.type.loanLimit;
  const refusal = member.borrowRefusal;
  const expiresSoon = member.warnings.find((w) => w.code === 'member_expires_soon');
  let block: ReactNode = null;
  if (refusal === 'MEMBER_EXPIRED') {
    block = (
      <Callout
        tone="bad"
        title={member.expiresOn === null ? t('vocab.member_status.expired') : t('circulation.member.expired_title', { date: day(member.expiresOn) })}
        action={
          canExtend && !extending ? (
            <Button type="button" size="sm" variant="outline" className="bg-background" onClick={onExtend}>
              {t('circulation.member.extend')}
            </Button>
          ) : undefined
        }>
        <p>{t('circulation.member.expired_body')}</p>
      </Callout>
    );
  } else if (refusal === 'MEMBER_SUSPENDED') {
    block = (
      <Callout tone="warn" title={t('vocab.member_status.suspended')}>
        {member.statusNote !== null && <p>{member.statusNote}</p>}
        <p>{t('circulation.member.suspended_body')}</p>
      </Callout>
    );
  } else if (refusal === 'CIRC_MEMBER_BLOCKED') {
    block = (
      <Callout tone="bad" title={member.charges.blocked === null ? t('error.CIRC_MEMBER_BLOCKED') : t('charges.member.blocked', { reason: t(`vocab.member_block_reason.${member.charges.blocked}`) })}>
        <p>{t('circulation.member.returns_still')}</p>
      </Callout>
    );
  } else if (refusal === 'CIRC_LIMIT_REACHED') {
    block = (
      <Callout tone="warn" title={limit === 0 ? t('circulation.problem.cannot_borrow') : t('circulation.member.limit_full')}>
        <p>{limit === 0 ? t('circulation.member.returns_still') : t('circulation.member.limit_full_body')}</p>
      </Callout>
    );
  } else if (member.counts.overdue > 0) {
    block = (
      <Callout tone="warn" title={t('circulation.member.late_title', { count: member.counts.overdue })}>
        <p>{t('circulation.member.late_body')}</p>
      </Callout>
    );
  } else if (expiresSoon !== undefined) {
    block = (
      <Callout tone="warn" title={t('circulation.warning.expires_soon', { date: day(expiresSoon.expiresOn ?? member.expiresOn ?? '') })}>
        <p>{t('circulation.member.expires_soon_body')}</p>
      </Callout>
    );
  }
  return (
    <aside aria-labelledby={nameId} className={box}>
      <div className="flex items-start gap-3">
        <MemberPhoto name={member.name} fileId={member.photoFileId} />
        <div className="grid min-w-0 gap-0.5">
          <h2 id={nameId} className="text-lg leading-tight font-bold break-words">
            {member.name}
          </h2>
          <span className="font-semibold tracking-wide tabular-nums">{member.memberNo}</span>
          <span className="text-sm text-muted-foreground">
            {typeName}
            {member.className !== null && `, ${member.className}`}
          </span>
          <span className="mt-1 flex flex-wrap gap-1">
            <MemberStatusBadge status={member.status} />
            {refusal === 'CIRC_LIMIT_REACHED' && <Tag tone="warn">{limit === 0 ? t('members.types.limit.zero') : t('circulation.member.limit_full')}</Tag>}
            {member.counts.holdsReady > 0 && <Tag tone="accent">{t('holds.member.ready_count', { count: member.counts.holdsReady })}</Tag>}
          </span>
        </div>
      </div>
      <FactList
        items={[
          {
            key: 'loans',
            label: t('circulation.member.on_loan'),
            value: limit === null ? t('circulation.member.loans_no_limit', { count: member.counts.openLoans }) : t('circulation.member.loans_of', { count: member.counts.openLoans, limit }),
            ...(limit !== null && limit > 0 && member.counts.openLoans >= limit ? { tone: 'warn' as const } : {}),
          },
          { key: 'late', label: t('circulation.member.overdue'), value: String(member.counts.overdue), ...(member.counts.overdue > 0 ? { tone: 'bad' as const } : {}) },
          { key: 'until', label: t('circulation.member.valid_until'), value: member.expiresOn === null ? t('members.never_expires') : day(member.expiresOn) },
          // ---- Komunitas (staff screens' data): the loan period and renewals of the type's general rule ----
          ...(member.loanRule === undefined || member.loanRule === null || !member.loanRule.loanable
            ? []
            : [{ key: 'period', label: t('circulation.member.loan_period'), value: loanPeriodText(t, member.loanRule) }]),
          ...(Number(member.charges.balance) > 0
            ? [{ key: 'balance', label: t('charges.member.balance'), value: money(member.charges.balance, member.charges.currency), tone: 'warn' as const }]
            : []),
        ]}
      />
      {block}
      {member.notes !== null && member.notes !== '' && (
        <Callout title={t('members.field.notes')}>
          <p className="whitespace-pre-line">{member.notes}</p>
        </Callout>
      )}
      {extending && canExtend && (
        <div data-keep-focus>
          <ExtendPanel memberId={member.id} onClose={onExtendClose} onDone={onExtended} />
        </div>
      )}
      <div className="flex flex-wrap items-center justify-between gap-2">
        <Button type="button" size="sm" variant="outline" className="bg-background" aria-keyshortcuts="Escape" onClick={onDone}>
          {t('circulation.member.done')}
        </Button>
        {canOpen && (
          <Link to={`/admin/anggota/${encodeURIComponent(member.id)}`} className="text-sm font-semibold text-accent-text underline-offset-4 hover:underline">
            {t('circulation.member.open')}
          </Link>
        )}
      </div>
    </aside>
  );
}

/** "Transaksi kali ini": what happened since the member was loaded, the newest first. */
function VisitTable({ rows }: { rows: readonly VisitRow[] }) {
  const t = useT();
  return (
    <div className={TABLE.wrap}>
      <table className={TABLE.table}>
        <caption className="sr-only">{t('circulation.visit.caption')}</caption>
        <thead>
          <tr>
            {(['circulation.col.time', 'circulation.col.action', 'circulation.col.barcode', 'circulation.col.title', 'circulation.col.due_note'] as const).map((key) => (
              <th key={key} scope="col" className={TABLE.th}>
                {t(key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={5} className={TABLE.empty}>
                {t('circulation.visit.empty')}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.seq}>
                <td className={cn(TABLE.td, 'whitespace-nowrap text-muted-foreground')}>{row.time}</td>
                <td className={cn(TABLE.td, 'whitespace-nowrap')}>
                  {row.kind === 'refused' ? (
                    <StatusText tone="bad">{t('circulation.visit.kind.refused')}</StatusText>
                  ) : row.kind === 'voided' ? (
                    <StatusText tone="warn">{t('circulation.visit.kind.voided')}</StatusText>
                  ) : (
                    t(`circulation.visit.kind.${row.kind}`)
                  )}
                </td>
                <td className={cn(TABLE.td, 'font-semibold tracking-wide whitespace-nowrap')}>{row.barcode}</td>
                <td className={TABLE.td}>{row.title === '' ? '—' : row.title}</td>
                <td className={TABLE.td}>{row.kind === 'refused' ? <StatusText tone="bad">{row.note}</StatusText> : row.note}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
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
      <div className={TABLE.wrap}>
        <table className={TABLE.table}>
          <caption className="sr-only">{t('circulation.tab.history')}</caption>
          <thead>
            <tr>
              {(['circulation.col.barcode', 'circulation.col.title', 'circulation.col.loaned', 'circulation.col.returned', 'circulation.col.remark'] as const).map((key) => (
                <th key={key} scope="col" className={TABLE.th}>
                  {t(key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={5} className={TABLE.empty}>
                  {t('circulation.history.empty')}
                </td>
              </tr>
            ) : (
              rows.map((loan) => (
                <tr key={loan.id}>
                  <td className={cn(TABLE.td, 'font-semibold tracking-wide whitespace-nowrap')}>{loan.item?.barcode ?? '—'}</td>
                  <td className={TABLE.td}>{loan.record?.title ?? '—'}</td>
                  <td className={cn(TABLE.td, 'whitespace-nowrap')}>{day(loan.loanedOn)}</td>
                  <td className={cn(TABLE.td, 'whitespace-nowrap')}>{day(loan.returnedOn)}</td>
                  <td className={TABLE.td}>
                    {loan.daysLate > 0 ? (
                      <StatusText tone="bad">{t('circulation.due.late', { count: loan.daysLate })}</StatusText>
                    ) : (
                      <span className="text-muted-foreground">{t('circulation.due.on_time')}</span>
                    )}
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

/** The tally of the returns of this session beside the list: returned, late, for another branch. */
function ReturnSide({ rows, back }: { rows: readonly ReturnRow[]; back: string | null }) {
  const t = useT();
  const id = useId();
  const late = rows.filter((r) => r.daysLate > 0).length;
  const other = rows.filter((r) => r.otherBranch !== null).length;
  return (
    <aside aria-labelledby={id} className={cn('grid content-start gap-3.5 rounded-lg border p-4', LAYER)}>
      <h2 id={id} className="text-base font-bold">
        {t('circulation.returns.summary')}
      </h2>
      <FactList
        items={[
          { key: 'count', label: t('circulation.returns.count'), value: String(rows.length) },
          { key: 'late', label: t('circulation.returns.late'), value: String(late), ...(late > 0 ? { tone: 'bad' as const } : {}) },
          { key: 'other', label: t('circulation.returns.other_branch'), value: String(other), ...(other > 0 ? { tone: 'warn' as const } : {}) },
        ]}
      />
      {back !== null && <p className="text-sm text-muted-foreground">{back === '' ? t('circulation.returns.back_loan') : t('circulation.returns.back_to', { name: back })}</p>}
    </aside>
  );
}

/** Kembali Cepat's and F3's list of this session's returns, the newest first; a late one stands out. */
/** The borrower of a return: the name (a link to the member for a member reader) and the number beside it. */
function BorrowerCell({ row }: { row: ReturnRow }) {
  const me = useMe();
  if (row.memberNo === null) return <span className="text-muted-foreground">—</span>;
  const no = <span className="text-meta font-semibold tracking-wide whitespace-nowrap text-muted-foreground tabular-nums">{row.memberNo}</span>;
  if (row.memberName === null) return no;
  return (
    <span className="flex flex-wrap items-baseline gap-x-2">
      {row.memberId !== null && holds(me, 'members.records.read') ? (
        <Link to={`/admin/anggota/${encodeURIComponent(row.memberId)}`} className="font-semibold text-accent-text underline-offset-4 hover:underline">
          {row.memberName}
        </Link>
      ) : (
        <span className="font-semibold">{row.memberName}</span>
      )}
      {no}
    </span>
  );
}

function ReturnsTable({ rows }: { rows: readonly ReturnRow[] }) {
  const t = useT();
  const day = useCalendarDate();
  const id = useId();
  return (
    <section aria-labelledby={id} className="grid gap-3">
      <h2 id={id} className="text-base font-bold">
        {t('circulation.returns.caption')}
      </h2>
      <div className={TABLE.wrap}>
        <table className={TABLE.table}>
          <caption className="sr-only">{t('circulation.returns.caption')}</caption>
          <thead>
            <tr>
              {(['circulation.col.time', 'circulation.col.barcode', 'circulation.col.title', 'circulation.col.borrower', 'circulation.col.due', 'circulation.col.state'] as const).map((key) => (
                <th key={key} scope="col" className={TABLE.th}>
                  {t(key)}
                </th>
              ))}
            </tr>
          </thead>
          <tbody>
            {rows.length === 0 ? (
              <tr>
                <td colSpan={6} className={TABLE.empty}>
                  {t('circulation.returns.empty')}
                </td>
              </tr>
            ) : (
              rows.map((row) => (
                <tr key={row.seq} className={cn(row.daysLate > 0 && 'bg-bad-bg')}>
                  <td className={cn(TABLE.td, 'whitespace-nowrap text-muted-foreground')}>{row.time}</td>
                  <td className={cn(TABLE.td, 'font-semibold tracking-wide whitespace-nowrap')}>{row.barcode}</td>
                  <td className={TABLE.td}>{row.title}</td>
                  <td className={TABLE.td}>
                    <BorrowerCell row={row} />
                  </td>
                  <td className={cn(TABLE.td, 'whitespace-nowrap')}>{day(row.dueOn)}</td>
                  <td className={TABLE.td}>
                    <span className="grid gap-0.5">
                      {row.daysLate > 0 ? <StatusText tone="bad">{lateText(t, row.daysLate, row.finedDays)}</StatusText> : <StatusText tone="ok">{t('circulation.due.on_time')}</StatusText>}
                      {row.otherBranch !== null && <StatusText tone="warn">{t('circulation.returns.to_branch', { code: row.otherBranch })}</StatusText>}
                      {row.keptFor !== null && <StatusText tone="warn">{t('holds.returns.kept', { no: row.keptFor })}</StatusText>}
                    </span>
                  </td>
                </tr>
              ))
            )}
          </tbody>
        </table>
      </div>
    </section>
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

/** The desk's keys, as a panel in the page (scans keep working while it is shown). */
function KeysPanel({ id, quickReturn }: { id: string; quickReturn: boolean }) {
  const t = useT();
  return (
    <section id={id} aria-label={t('circulation.help.title')} data-keep-focus className="grid gap-x-6 rounded-lg border px-4 py-2 text-sm sm:grid-cols-2 xl:grid-cols-3">
      {SHORTCUTS.filter(([, , both]) => both || !quickReturn).map(([key, text]) => (
        <div key={key} className="flex items-baseline justify-between gap-3 border-b py-1.5">
          <span>{t(text)}</span>
          <span className="flex shrink-0 gap-1">
            {key.split(' / ').map((k) => (
              <Kbd key={k}>{k}</Kbd>
            ))}
          </span>
        </div>
      ))}
    </section>
  );
}

/** "Pinjaman tercatat mundur": loans entered after the fact carry this day and the note (override holders only). */
function BackdatePanel({ value, onChange }: { value: { on: boolean; date: string; note: string }; onChange(v: { on: boolean; date: string; note: string }): void }) {
  const t = useT();
  const ids = useId();
  return (
    <div data-keep-focus className="mt-1 grid gap-2">
      <label className="flex w-fit items-center gap-2 text-sm">
        <input type="checkbox" className="size-4 accent-primary" checked={value.on} onChange={(e) => onChange({ ...value, on: e.target.checked })} />
        {t('circulation.backdate.toggle')}
      </label>
      {value.on && (
        <div className={cn('grid gap-2 rounded-lg border p-3', LAYER)}>
          <div className="flex flex-wrap items-end gap-2">
            <div className="grid gap-1">
              <Label htmlFor={`${ids}-date`}>{t('circulation.backdate.date')}</Label>
              <Input id={`${ids}-date`} type="date" max={todayLocal()} value={value.date} onChange={(e) => onChange({ ...value, date: e.target.value })} className="w-44 bg-background" />
            </div>
            <div className="grid min-w-0 flex-[1_1_16rem] gap-1">
              <Label htmlFor={`${ids}-note`}>{t('circulation.backdate.note')}</Label>
              <Input id={`${ids}-note`} maxLength={191} autoComplete="off" value={value.note} onChange={(e) => onChange({ ...value, note: e.target.value })} className="bg-background" />
            </div>
          </div>
          <p className="text-xs text-muted-foreground">{t('circulation.backdate.hint')}</p>
        </div>
      )}
    </div>
  );
}

/** Baca di tempat's list of this session's reads, the newest first; one that warns stands out. */
function ReadsTable({ rows }: { rows: readonly ReadRow[] }) {
  const t = useT();
  return (
    <div className={TABLE.wrap}>
      <table className={TABLE.table}>
        <caption className="sr-only">{t('circulation.read.caption')}</caption>
        <thead>
          <tr>
            {(['circulation.col.time', 'circulation.col.barcode', 'circulation.col.title', 'circulation.col.state'] as const).map((key) => (
              <th key={key} scope="col" className={TABLE.th}>
                {t(key)}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.length === 0 ? (
            <tr>
              <td colSpan={4} className={TABLE.empty}>
                {t('circulation.read.empty')}
              </td>
            </tr>
          ) : (
            rows.map((row) => (
              <tr key={row.seq}>
                <td className={cn(TABLE.td, 'whitespace-nowrap text-muted-foreground')}>{row.time}</td>
                <td className={cn(TABLE.td, 'font-semibold tracking-wide whitespace-nowrap')}>{row.barcode}</td>
                <td className={TABLE.td}>{row.title}</td>
                <td className={TABLE.td}>{row.note === null ? <StatusText tone="ok">{t('circulation.read.counted')}</StatusText> : <StatusText tone="warn">{row.note}</StatusText>}</td>
              </tr>
            ))
          )}
        </tbody>
      </table>
    </div>
  );
}

/** The tally beside the reads: counted, and how many need a look. */
function ReadSide({ rows, back }: { rows: readonly ReadRow[]; back: string | null }) {
  const t = useT();
  const id = useId();
  const flagged = rows.filter((r) => r.note !== null).length;
  return (
    <aside aria-labelledby={id} className={cn('grid content-start gap-3.5 rounded-lg border p-4', LAYER)}>
      <h2 id={id} className="text-base font-bold">
        {t('circulation.returns.summary')}
      </h2>
      <FactList
        items={[
          { key: 'count', label: t('circulation.read.counted'), value: String(rows.length) },
          { key: 'flagged', label: t('circulation.read.flagged'), value: String(flagged), ...(flagged > 0 ? { tone: 'warn' as const } : {}) },
        ]}
      />
      {back !== null && <p className="text-sm text-muted-foreground">{back === '' ? t('circulation.returns.back_loan') : t('circulation.returns.back_to', { name: back })}</p>}
    </aside>
  );
}
