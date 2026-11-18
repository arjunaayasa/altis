import { CARD_FIELDS, CARD_SHEETS, qrMatrix, type CardField } from '@altis/shared';
import { MEMBER_CARDS_MAX, type CardProfile } from '@altis/shared/api/member-ops';
import type { MemberView } from '@altis/shared/api/members';
import type { MembersSettingsView } from '@altis/shared/api/settings';
import { useQueryClient } from '@tanstack/react-query';
import { useEffect, useId, useState, type FormEvent } from 'react';
import { CheckField, Field, Notice, ProblemAlert, SELECT_CLASS, TEXTAREA_CLASS } from '@/components/form-field';
import { DenseTable, FORM_FULL, FormBar, FormSection, PageHead, Section, type DenseColumn, PANEL } from '@/components/layout';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { useT } from '@/i18n';
import { holds } from '@/lib/access';
import { ApiError, api } from '@/lib/api';
import { problemText } from '@/lib/form-errors';
import { useApiQuery, useMe } from '@/lib/me';
import { cn } from '@/lib/utils';
import { postForPdf, readCardQueue, useCardQueue, writeCardQueue, type CardQueueEntry } from './tools';

/**
 * Cetak Kartu (`/admin/anggota/kartu`): the card queue of this browser (from the member list, or a scanned number),
 * the start position on the first sheet, and "Buat PDF", which asks for the cards 200 at a time (`POST members/cards`)
 * and opens each PDF. A user who manages the settings edits the card layout here too (`PUT settings/members`), with a
 * preview whose QR code is drawn by the same encoder the server prints with. The preview is paper: white in both
 * themes, in the card's own colours.
 */

/** The QR code of `text` as SVG rects (black on white, 2-module margin). */
export function QrPreview({ text, size }: { text: string; size: number }) {
  let matrix: ReturnType<typeof qrMatrix>;
  try {
    matrix = qrMatrix(text);
  } catch {
    return null;
  }
  const n = matrix.size + 4;
  const rects: { x: number; y: number; w: number }[] = [];
  matrix.dark.forEach((row, y) => {
    let start = -1;
    for (let x = 0; x <= row.length; x += 1) {
      const dark = x < row.length && row[x] === true;
      if (dark && start < 0) start = x;
      if (!dark && start >= 0) {
        rects.push({ x: start + 2, y: y + 2, w: x - start });
        start = -1;
      }
    }
  });
  return (
    <svg viewBox={`0 0 ${n} ${n}`} width={size} height={size} shapeRendering="crispEdges" aria-hidden="true">
      <rect width={n} height={n} fill="#fff" />
      {rects.map((r) => (
        <rect key={`${r.x}-${r.y}`} x={r.x} y={r.y} width={r.w} height={1} fill="#000" />
      ))}
    </svg>
  );
}

function CardPreview({ profile, sample }: { profile: CardProfile; sample: CardQueueEntry }) {
  const t = useT();
  return (
    <div className="w-[342px] max-w-full overflow-hidden rounded-md border bg-white text-black" style={{ aspectRatio: '85.6 / 54' }}>
      <div className="px-3 py-1.5" style={{ background: profile.front.bandColor, color: profile.front.textColor }}>
        <p className="truncate text-xs font-bold">{profile.front.title}</p>
        <p className="truncate text-[10px]">{profile.front.subtitle}</p>
      </div>
      <div className="flex gap-2 p-2 text-[10px]">
        {profile.front.showPhoto && <div className="h-20 w-[60px] shrink-0 border bg-neutral-100" />}
        <div className="min-w-0 flex-1">
          {profile.front.fields.map((f) => (
            <p key={f} className="truncate">
              <span className="text-neutral-500">{t(`vocab.card_field.${f}`)}: </span>
              {f === 'memberNo' ? sample.memberNo : f === 'name' ? sample.name : '…'}
            </p>
          ))}
        </div>
        {profile.qr && <QrPreview text={sample.memberNo} size={64} />}
      </div>
    </div>
  );
}

function ProfileEditor({ profile, onSaved }: { profile: CardProfile; onSaved(): void }) {
  const t = useT();
  const ids = useId();
  const queryClient = useQueryClient();
  const [p, setP] = useState<CardProfile>(profile);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [saved, setSaved] = useState(false);
  useEffect(() => setP(profile), [profile]);

  const front = (patch: Partial<CardProfile['front']>): void => setP({ ...p, front: { ...p.front, ...patch } });
  const back = (patch: Partial<CardProfile['back']>): void => setP({ ...p, back: { ...p.back, ...patch } });
  const toggleField = (f: CardField): void =>
    front({ fields: p.front.fields.includes(f) ? p.front.fields.filter((x) => x !== f) : CARD_FIELDS.filter((x) => x === f || p.front.fields.includes(x)) });

  const save = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    setBusy(true);
    setProblem(null);
    setSaved(false);
    try {
      await api('PUT', 'settings/members', { card: { profile: p } });
      await queryClient.invalidateQueries({ queryKey: ['settings'] });
      setSaved(true);
      onSaved();
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  };

  return (
    <form noValidate onSubmit={(e) => void save(e)} aria-label={t('members.tools.cards.profile')} className="border-t pt-4">
      <FormSection title={t('members.tools.cards.profile')}>
        <Field label={t('members.tools.cards.profile_title')}>{(c) => <Input {...c} maxLength={60} value={p.front.title} onChange={(e) => front({ title: e.target.value })} />}</Field>
        <Field label={t('members.tools.cards.profile_subtitle')}>
          {(c) => <Input {...c} maxLength={80} value={p.front.subtitle} onChange={(e) => front({ subtitle: e.target.value })} />}
        </Field>
        <Field id={`${ids}-sheet`} label={t('members.tools.cards.profile_sheet')}>
          <select id={`${ids}-sheet`} className={SELECT_CLASS} value={p.sheet} onChange={(e) => setP({ ...p, sheet: e.target.value as CardProfile['sheet'] })}>
            {CARD_SHEETS.map((s) => (
              <option key={s} value={s}>
                {s}
              </option>
            ))}
          </select>
        </Field>
        <Field id={`${ids}-symbology`} label={t('members.tools.cards.profile_symbology')}>
          <select id={`${ids}-symbology`} className={SELECT_CLASS} value={p.symbology} onChange={(e) => setP({ ...p, symbology: e.target.value as CardProfile['symbology'] })}>
            <option value="code128">Code 128</option>
            <option value="code39">Code 39</option>
          </select>
        </Field>
        <Field label={t('members.tools.cards.profile_band')}>{(c) => <Input {...c} type="color" value={p.front.bandColor} onChange={(e) => front({ bandColor: e.target.value })} />}</Field>
        <Field label={t('members.tools.cards.profile_text')}>{(c) => <Input {...c} type="color" value={p.front.textColor} onChange={(e) => front({ textColor: e.target.value })} />}</Field>
        <fieldset className={`grid gap-2 ${FORM_FULL}`}>
          <legend className="mb-1.5 text-meta font-semibold">{t('members.tools.cards.profile_fields')}</legend>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            {CARD_FIELDS.map((f) => (
              <label key={f} className="flex items-center gap-2 text-sm">
                <input type="checkbox" className="size-4 accent-primary" checked={p.front.fields.includes(f)} onChange={() => toggleField(f)} />
                {t(`vocab.card_field.${f}`)}
              </label>
            ))}
          </div>
        </fieldset>
        <CheckField label={t('members.tools.cards.profile_photo')} checked={p.front.showPhoto} onChange={(e) => front({ showPhoto: e.target.checked })} />
        <CheckField label={t('members.tools.cards.profile_qr')} checked={p.qr} onChange={(e) => setP({ ...p, qr: e.target.checked })} />
        <CheckField label={t('members.tools.cards.profile_back')} checked={p.back.enabled} onChange={(e) => back({ enabled: e.target.checked })} />
        {p.back.enabled && (
          <>
            <Field label={t('members.tools.cards.profile_rules')} className={FORM_FULL}>
              {(c) => <textarea {...c} className={TEXTAREA_CLASS} maxLength={1000} value={p.back.rulesText} onChange={(e) => back({ rulesText: e.target.value })} />}
            </Field>
            <Field label={t('members.tools.cards.profile_city')}>{(c) => <Input {...c} maxLength={60} value={p.back.city} onChange={(e) => back({ city: e.target.value })} />}</Field>
            <Field label={t('members.tools.cards.profile_signer_title')}>
              {(c) => <Input {...c} maxLength={60} value={p.back.signerTitle} onChange={(e) => back({ signerTitle: e.target.value })} />}
            </Field>
            <Field label={t('members.tools.cards.profile_signer_name')}>
              {(c) => <Input {...c} maxLength={80} value={p.back.signerName} onChange={(e) => back({ signerName: e.target.value })} />}
            </Field>
          </>
        )}
        <div className={`grid gap-2 ${FORM_FULL}`}>
          <p className="text-meta font-semibold">{t('members.tools.cards.preview')}</p>
          <CardPreview profile={p} sample={{ id: '', memberNo: 'SISWA-0001', name: 'Nama Anggota' }} />
        </div>
      </FormSection>
      {(problem !== null || saved) && (
        <div className="grid gap-3 pb-4">
          <ProblemAlert error={problem} />
          {saved && <Notice kind="success">{t('members.tools.cards.profile_saved')}</Notice>}
        </div>
      )}
      <FormBar>
        <Button type="submit" disabled={busy}>
          {t(busy ? 'form.saving' : 'members.tools.cards.profile_save')}
        </Button>
      </FormBar>
    </form>
  );
}

export function MemberCardsScreen() {
  const t = useT();
  const me = useMe();
  const ids = useId();
  const queue = useCardQueue();
  const [scan, setScan] = useState('');
  const [scanError, setScanError] = useState<string | null>(null);
  const [startAt, setStartAt] = useState(1);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState<unknown>(null);
  const [made, setMade] = useState<string[]>([]);
  const canSettings = holds(me, 'system.settings.read');
  const canEdit = holds(me, 'system.settings.manage');
  const settings = useApiQuery<MembersSettingsView>({ queryKey: ['settings', 'members'], path: 'settings/members', enabled: canSettings });

  const add = async (event: FormEvent<HTMLFormElement>): Promise<void> => {
    event.preventDefault();
    const no = scan.trim();
    if (no === '') return;
    setScanError(null);
    try {
      const m = await api<MemberView>('POST', 'members/lookup', { no });
      if (!readCardQueue().some((e) => e.id === m.id)) writeCardQueue([...readCardQueue(), { id: m.id, memberNo: m.memberNo, name: m.name }]);
      setScan('');
    } catch (e) {
      setScanError(e instanceof ApiError && e.status === 404 ? t('members.tools.cards.not_found', { no }) : problemText(t, e));
    }
  };

  const make = async (): Promise<void> => {
    setBusy(true);
    setProblem(null);
    for (const url of made) URL.revokeObjectURL(url);
    setMade([]);
    const urls: string[] = [];
    try {
      for (let i = 0; i < queue.length; i += MEMBER_CARDS_MAX) {
        const part = queue.slice(i, i + MEMBER_CARDS_MAX);
        const blob = await postForPdf('members/cards', { memberIds: part.map((e) => e.id), startAt: i === 0 ? startAt : 1 });
        urls.push(URL.createObjectURL(blob));
      }
      setMade(urls);
      if (urls.length === 1) window.open(urls[0], '_blank', 'noopener');
    } catch (e) {
      setProblem(e);
    } finally {
      setBusy(false);
    }
  };

  const columns: DenseColumn<CardQueueEntry>[] = [
    { id: 'no', header: t('members.col.member_no'), className: 'font-semibold tracking-wide whitespace-nowrap', cell: (r) => r.memberNo },
    { id: 'name', header: t('members.col.name'), cell: (r) => r.name },
    {
      id: 'remove',
      header: <span className="sr-only">{t('table.actions')}</span>,
      className: 'w-px py-1.5 text-right whitespace-nowrap',
      cell: (r) => (
        <Button size="sm" variant="ghost" aria-label={`${t('members.tools.cards.remove')} ${r.memberNo}`} onClick={() => writeCardQueue(readCardQueue().filter((e) => e.id !== r.id))}>
          {t('members.tools.cards.remove')}
        </Button>
      ),
    },
  ];

  return (
    <div className="grid max-w-5xl gap-6">
      <PageHead title={t('members.tools.cards.title')} intro={t('members.tools.cards.intro')} />
      <form noValidate onSubmit={(e) => void add(e)} className={cn(PANEL, 'grid gap-1.5')}>
        <div className="flex flex-wrap items-end gap-2">
          <Field label={t('members.tools.cards.scan')} className="min-w-0 flex-[1_1_260px]">
            {(c) => <Input {...c} autoComplete="off" maxLength={200} value={scan} onChange={(e) => setScan(e.target.value)} />}
          </Field>
          <Button type="submit" variant="outline">
            {t('members.tools.cards.add')}
          </Button>
        </div>
        {scanError !== null && (
          <p role="alert" className="text-meta font-semibold text-bad">
            {scanError}
          </p>
        )}
      </form>
      <Section
        title={t('members.tools.cards.queue', { count: queue.length })}
        aside={
          queue.length > 0 ? (
            <Button size="sm" variant="ghost" onClick={() => writeCardQueue([])}>
              {t('members.tools.cards.clear')}
            </Button>
          ) : undefined
        }>
        <DenseTable caption={t('members.tools.cards.queue', { count: queue.length })} columns={columns} rows={queue} rowKey={(r) => r.id} empty={t('members.tools.cards.queue_empty')} />
        <div className="flex flex-wrap items-end gap-3">
          <Field id={`${ids}-start`} label={t('members.tools.cards.start_at')} hint={t('members.tools.cards.start_hint')} className="max-w-sm">
            <select id={`${ids}-start`} className={SELECT_CLASS} value={startAt} onChange={(e) => setStartAt(Number(e.target.value))}>
              {Array.from({ length: 10 }, (_, i) => i + 1).map((n) => (
                <option key={n} value={n}>
                  {n}
                </option>
              ))}
            </select>
          </Field>
        </div>
        <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
          <Button disabled={busy || queue.length === 0} onClick={() => void make()}>
            {t(busy ? 'members.tools.cards.making' : 'members.tools.cards.make')}
          </Button>
          {made.length > 0 && (
            <ul className="flex flex-wrap gap-x-4 gap-y-1">
              {made.map((url, i) => (
                <li key={url}>
                  <a href={url} target="_blank" rel="noopener" className="text-sm font-semibold text-accent-text underline-offset-4 hover:underline">
                    {made.length === 1 ? t('members.tools.cards.open') : t('members.tools.cards.part', { n: i + 1, total: made.length })}
                  </a>
                </li>
              ))}
            </ul>
          )}
        </div>
        <ProblemAlert error={problem} />
      </Section>
      {canSettings && settings.data !== undefined && canEdit && <ProfileEditor profile={settings.data.card.profile} onSaved={() => void settings.refetch()} />}
    </div>
  );
}
