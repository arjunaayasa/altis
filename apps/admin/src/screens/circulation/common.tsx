import { diffDays, type MemberStatus } from '@altis/shared';
import type { MeResponse } from '@altis/shared/api/auth';
import type { BranchListResponse, BranchView } from '@altis/shared/api/branches';
import type { MemberTypeListResponse, MemberTypeRef, MemberTypeView } from '@altis/shared/api/members';
import { useCallback, useMemo, useState } from 'react';
import { Badge } from '@/components/form-field';
import { useLocale, useT, type Translate } from '@/i18n';
import { holdsAt } from '@/lib/access';
import { isWritableBranch } from '@/lib/branches';
import { useApiQuery, useMe } from '@/lib/me';

/**
 * What the circulation and member screens share: the desk branch (chosen once, kept per browser), calendar dates in the
 * UI language, the "due in n days" wording, the member status badge, the member type names, and the desk's sounds.
 *
 * Every date of a loan is a calendar date (`YYYY-MM-DD`) the server counted in the branch's time zone; the screens show
 * them as they are (formatted at UTC midnight, so no time zone moves a day). Only "due today" and "n days left" are
 * counted here, from the browser's own date: the server sends `daysLate` for anything past due.
 */

// ---- browser storage -------------------------------------------------------------------------------------------------

/** The desk branch of this browser. */
export const DESK_BRANCH_KEY = 'altis.desk-branch';
/** Whether the desk beeps ("1") or not ("0"). */
export const DESK_SOUND_KEY = 'altis.desk-sound';

/** A stored value, or null (none, or storage blocked). */
export function readStored(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

/** Stores a value; a blocked storage keeps nothing and says nothing. */
export function writeStored(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private windows and blocked site data: the choice lasts for this page only.
  }
}

// ---- the desk branch -----------------------------------------------------------------------------------------------

/** Whether `me` may serve at `b`: the desk grant there, and `b` live and active. */
export function servesAt(me: MeResponse | undefined, b: BranchView): boolean {
  return holdsAt(me, 'circulation.desk.use', b.id) && isWritableBranch(b);
}

/**
 * The branches where the user may serve, and the chosen one: the one kept in this browser when it is still among
 * them, else the default branch, else the first. Choosing one keeps it.
 */
export function useDeskBranch(): {
  branches: BranchView[] | undefined;
  branchId: string | null;
  choose(id: string): void;
  error: unknown;
  refetch(): void;
} {
  const me = useMe();
  const query = useApiQuery<BranchListResponse>({ queryKey: ['branches', { includeArchived: false }], path: 'branches', staleTime: 60_000 });
  const [chosen, setChosen] = useState<string | null>(() => readStored(DESK_BRANCH_KEY));
  const branches = useMemo(() => query.data?.items.filter((b) => servesAt(me, b)), [query.data, me]);
  const branchId = useMemo(() => {
    if (branches === undefined || branches.length === 0) return null;
    if (chosen !== null && branches.some((b) => b.id === chosen)) return chosen;
    return (branches.find((b) => b.isDefault) ?? branches[0])!.id;
  }, [branches, chosen]);
  const choose = useCallback((id: string) => {
    setChosen(id);
    writeStored(DESK_BRANCH_KEY, id);
  }, []);
  return { branches, branchId, choose, error: query.error, refetch: () => void query.refetch() };
}

// ---- dates ---------------------------------------------------------------------------------------------------------

/** Today in the browser's own calendar, `YYYY-MM-DD`. */
export function todayLocal(now: Date = new Date()): string {
  const pad = (n: number): string => String(n).padStart(2, '0');
  return `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
}

/** Formats a calendar date (`YYYY-MM-DD`) as "Sen, 21 Nov 2026" in the UI language; anything else as it is. */
export function useCalendarDate(): (date: string | null | undefined) => string {
  const locale = useLocale();
  return useMemo(() => {
    const format = new Intl.DateTimeFormat(locale === 'en' ? 'en-GB' : 'id-ID', {
      weekday: 'short',
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });
    return (date) => {
      if (date === null || date === undefined || date === '') return '—';
      const ms = Date.parse(`${date}T00:00:00Z`);
      return Number.isNaN(ms) ? date : format.format(ms);
    };
  }, [locale]);
}

export type DueTone = 'danger' | 'warning' | 'neutral';

/** The days from `from` to `to`, or 0 when either is not a calendar date. */
function daysBetween(from: string, to: string): number {
  try {
    return diffDays(from, to);
  } catch {
    return 0;
  }
}

/** "Terlambat 3 hari", "Jatuh tempo hari ini" or "2 hari lagi", with its tone. */
export function dueState(t: Translate, dueOn: string, daysLate: number, today: string = todayLocal()): { text: string; tone: DueTone } {
  if (daysLate > 0) return { text: t('circulation.due.late', { count: daysLate }), tone: 'danger' };
  const left = daysBetween(today, dueOn);
  if (left <= 0) return { text: t('circulation.due.today'), tone: 'warning' };
  return { text: t('circulation.due.left', { count: left }), tone: 'neutral' };
}

/** The badge of {@link dueState}. */
export function DueBadge({ dueOn, daysLate }: { dueOn: string; daysLate: number }) {
  const t = useT();
  const state = dueState(t, dueOn, daysLate);
  return <Badge tone={state.tone === 'neutral' ? 'neutral' : state.tone}>{state.text}</Badge>;
}

// ---- members -------------------------------------------------------------------------------------------------------

const STATUS_TONES: Readonly<Record<MemberStatus, 'info' | 'warning' | 'danger' | 'neutral'>> = {
  active: 'info',
  expired: 'danger',
  suspended: 'warning',
  archived: 'neutral',
  anonymized: 'neutral',
};

/** A member's shown status as a labelled badge. */
export function MemberStatusBadge({ status }: { status: MemberStatus }) {
  const t = useT();
  return <Badge tone={STATUS_TONES[status]}>{t(`vocab.member_status.${status}`)}</Badge>;
}

/** The member types (live ones; archived too on request), read once a minute at most. */
export function useMemberTypes(includeArchived = false) {
  return useApiQuery<MemberTypeListResponse>({
    queryKey: ['members', 'types', { includeArchived }],
    path: includeArchived ? 'members/types?includeArchived=true' : 'members/types',
    staleTime: 60_000,
  });
}

/** A member type's name in the UI language (the Indonesian name when it has no English one). */
export function useTypeName(): (type: Pick<MemberTypeRef, 'nameId' | 'nameEn'> | Pick<MemberTypeView, 'nameId' | 'nameEn'>) => string {
  const locale = useLocale();
  return useCallback((type) => (locale === 'en' && type.nameEn !== null && type.nameEn !== '' ? type.nameEn : type.nameId), [locale]);
}

/** "3", or "Tanpa batas" for no limit, or "Tidak boleh meminjam" for 0. */
export function limitText(t: Translate, limit: number | null): string {
  if (limit === null) return t('members.types.limit.none');
  if (limit === 0) return t('members.types.limit.zero');
  return String(limit);
}

// ---- sound ---------------------------------------------------------------------------------------------------------

type AudioContextCtor = typeof AudioContext;

let audio: AudioContext | null = null;

/**
 * A short sound for a scan's outcome, made with Web Audio (no sound file): one high beep for done, two for "look at
 * this", a low buzz for refused. Silent wherever the browser has no Web Audio or refuses it.
 */
export function beep(kind: 'success' | 'warning' | 'error'): void {
  try {
    const w = window as unknown as { AudioContext?: AudioContextCtor; webkitAudioContext?: AudioContextCtor };
    const Ctor = w.AudioContext ?? w.webkitAudioContext;
    if (Ctor === undefined) return;
    audio ??= new Ctor();
    const tones: [number, number, number][] =
      kind === 'success' ? [[1046, 0, 0.12]] : kind === 'warning' ? [[880, 0, 0.1], [880, 0.16, 0.1]] : [[196, 0, 0.35]];
    for (const [frequency, at, duration] of tones) {
      const osc = audio.createOscillator();
      const gain = audio.createGain();
      osc.type = kind === 'error' ? 'square' : 'sine';
      osc.frequency.value = frequency;
      gain.gain.value = 0.06;
      osc.connect(gain).connect(audio.destination);
      const start = audio.currentTime + at;
      osc.start(start);
      osc.stop(start + duration);
    }
  } catch {
    // No sound: the colour and the text still say it.
  }
}

/** A fresh `Idempotency-Key` for one desk transaction. */
export function newTransactionKey(prefix: string): string {
  const random = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, '0')).join('');
  return `${prefix}:${random}`;
}
