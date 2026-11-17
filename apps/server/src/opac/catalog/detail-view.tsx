import {
  dublinCoreMeta,
  openGraph,
  recordJsonLd,
  recordUrlPath,
  type CustomFieldDef,
  type RecordRenderOptions,
} from '@altis/core';
import { RDA_CARRIER_TYPES, RDA_CONTENT_TYPES, RDA_MEDIA_TYPES, t, type Locale, type RdaTerm } from '@altis/shared';
import type { RecordData } from '@altis/shared/api/catalog/record-data';
import type { PropsWithChildren } from 'hono/jsx';
import type { JSX } from 'hono/jsx/jsx-runtime';
import { linkableUrl, attachmentMedia } from './attachment-viewer.js';
import { AvailabilitySection, type Availability } from './availability.js';
import { CitationsSection } from './citations-view.js';
import { BookCover } from './cover.js';
import { opacText } from './messages.js';
import type { OpacContext, OpacPageOptions } from './page.js';
import { absoluteUrl, withLang } from './urls.js';

// The OPAC record detail (Phase 2 Task 34; spec §9.3, §9.4), the page of `/katalog/:id/:slug`:
//
//   header         the cover (or the substitute cover: cover.tsx), the title and subtitle, the material type, the
//                  statement of responsibility, the agents linking to `/cari?pengarang=<id>`
//   sections       summary, notes, availability (availability.tsx, with the shelf maps), the full description,
//                  subjects linking to `/cari?subjek=<id>`, relations both ways, the public custom fields ("Informasi
//                  lain"), at most 20 public attachments (each to its viewer), the citations (citations-view.tsx)
//   <head>         a description of at most 160 characters, Dublin Core (`<link rel="schema.DC">` + `DC.*`), the
//                  OpenGraph properties the frame does not write (`book:*`, ...), the Twitter card, and the JSON-LD
//                  (`opacPage` writes it through `jsonLdScript` with the nonce, S6)
//
// Everything shown is catalogue data, so untrusted: it is text that JSX escapes, a URL is linked only when it is
// http(s) (S4, checked again here), and nothing reaches the page as markup. The record is a public load
// (`loadRecordData` with `publicOnly`): no staff attachment, staff custom value, withdrawn or lost item, or acquisition
// data is part of it. Every link keeps the page's `?lang=` when the request named one.

/** At most this many attachments are listed (§9.3). */
export const ATTACHMENTS_MAX = 20;
/** The meta description's length (§9.3), in characters. */
export const DESCRIPTION_MAX = 160;

/** What the page shows besides the record itself. */
export interface DetailExtras {
  /** The record's cover when it is a public, stored file; else null (the substitute cover). */
  coverFileId: string | null;
  availability: Availability;
  /** The live custom field definitions (their types and option labels). */
  customDefs: readonly CustomFieldDef[];
  // ---- Komunitas (member area) ----
  /**
   * The member links of the page: "Pesan judul ini" when members may place holds online and the record has copies,
   * "Tandai" when members may sign in; the attachments of access `members` (listed "khusus anggota", opened through
   * the member area). The page itself never reads a member session: these are plain links to `/akun`.
   */
  member?: { hold: boolean; bookmark: boolean; attachments: readonly { id: string; title: string; kind: string; mime: string | null }[] };
}

/** The title with its subtitle (`Title: subtitle`), its trailing ISBD punctuation dropped. */
export function displayTitle(d: Pick<RecordData, 'title' | 'subtitle'>): string {
  const title = d.title.replace(/[\s/:;=,]+$/u, '').trim() || d.title.trim();
  const subtitle = d.subtitle?.trim() ?? '';
  return subtitle === '' ? title : `${title}: ${subtitle}`;
}

/** `text` on one line, cut to `max` characters (whole code points) at a word when it can be, with an ellipsis. */
export function cutDescription(text: string, max = DESCRIPTION_MAX): string {
  const line = text
    .replace(/[\s\p{Cc}]+/gu, ' ')
    .trim();
  const chars = Array.from(line);
  if (chars.length <= max) return line;
  const head = chars.slice(0, max - 1).join('');
  const space = head.lastIndexOf(' ');
  // The ellipsis replaces what ends the cut text: spaces and a sentence's punctuation.
  return `${(space > max / 2 ? head.slice(0, space) : head).replace(/[\s.,;:!?]+$/u, '')}…`;
}

/** The meta description: the summary, else the notes, else "Title (type) in the library's catalogue"; ≤ 160 characters. */
export function recordDescription(d: RecordData, locale: Locale, libraryName: string): string {
  const own = (d.summary ?? '').trim() || (d.notes ?? '').trim();
  const text = own !== '' ? own : opacText(locale, 'detail.description_fallback', { title: displayTitle(d), type: typeName(d, locale), library: libraryName });
  return cutDescription(text);
}

/** The options of Task 22's renderers for `d` on this install (absolute URLs from baseUrl, never from the Host). */
export function renderOptions(baseUrl: string, d: RecordData, locale: Locale, coverFileId: string | null): RecordRenderOptions {
  const absolute = (path: string): string => (baseUrl === '' ? path : absoluteUrl(baseUrl, path));
  return {
    baseUrl,
    canonicalUrl: absolute(recordUrlPath(d.id, d.title)),
    locale,
    coverUrl: coverFileId === null ? null : absolute(`/files/${encodeURIComponent(coverFileId)}`),
  };
}

function typeName(d: RecordData, locale: Locale): string {
  return (locale === 'en' ? d.materialType.nameEn : d.materialType.nameId) || d.materialType.code;
}

/** The OpenGraph properties `opacPage` writes itself (from its `openGraph` option), not written twice. */
const FRAME_OPEN_GRAPH: ReadonlySet<string> = new Set(['og:type', 'og:site_name', 'og:title', 'og:description', 'og:locale', 'og:url', 'og:image']);

/** The `<head>` additions (see the top of this file). */
function DetailHead(props: { d: RecordData; o: RecordRenderOptions }) {
  const { d, o } = props;
  return (
    <>
      <link rel="schema.DC" href="http://purl.org/dc/elements/1.1/" />
      {dublinCoreMeta(d, o).map((m) => (
        <meta name={m.name} content={m.content} />
      ))}
      {openGraph(d, o)
        .filter((p) => !FRAME_OPEN_GRAPH.has(p.property))
        .map((p) => (
          <meta property={p.property} content={p.content} />
        ))}
      <meta name="twitter:card" content="summary" />
    </>
  );
}

// ---- the parts of the page ---------------------------------------------------------------------------------------------

type Keep = (path: string) => string;

function Section(props: PropsWithChildren<{ id: string; title: string }>) {
  return (
    <section class="record-section" aria-labelledby={props.id}>
      <h2 id={props.id}>{props.title}</h2>
      {props.children}
    </section>
  );
}

function Agents(props: { d: RecordData; locale: Locale; keep: Keep }) {
  const { d, locale, keep } = props;
  if (d.agents.length === 0) return null;
  return (
    <ul class="record-agents">
      {d.agents.map((a) => (
        <li>
          <a href={keep(`/cari?pengarang=${encodeURIComponent(a.id)}`)}>
            {a.name}
            {a.dates === undefined || a.dates.trim() === '' ? null : <span class="record-dates"> ({a.dates})</span>}
          </a>
          {a.role === 'aut' ? null : <span class="record-role"> ({t(locale, `vocab.relator.${a.role}`)})</span>}
        </li>
      ))}
    </ul>
  );
}

/** The RDA term of `code` in `list`, or the code itself. */
function rdaTerm(list: readonly RdaTerm[], code: string | undefined): string | null {
  if (code === undefined || code === '') return null;
  return list.find((e) => e.code === code)?.term ?? code;
}

/** A format's own name (ISBN, ISSN, DOI): the same in both languages, so not a message. */
const IDENTIFIER_NAMES: Readonly<Record<string, string>> = { isbn: 'ISBN', issn: 'ISSN', doi: 'DOI' };

function Description(props: { d: RecordData; locale: Locale }) {
  const { d, locale } = props;
  const rows: [label: string, value: string][] = [];
  const add = (label: string, value: string | null | undefined): void => {
    if (value !== null && value !== undefined && value.trim() !== '') rows.push([label, value.trim()]);
  };
  add(opacText(locale, 'detail.material_type'), typeName(d, locale));
  add(t(locale, 'vocab.field.edition'), d.edition);
  add(t(locale, 'vocab.field.material_detail'), d.materialDetail);
  add(t(locale, 'vocab.field.publisher'), d.publisher?.name);
  add(t(locale, 'vocab.field.publication_place'), d.publicationPlace ?? d.publisher?.place);
  add(t(locale, 'vocab.field.publication_year'), d.publicationDateText ?? d.publicationYear);
  add(t(locale, 'vocab.field.physical_desc'), d.physicalDesc);
  add(t(locale, 'vocab.field.series'), d.series);
  add(t(locale, 'vocab.field.classification'), d.classification);
  add(t(locale, 'vocab.field.call_number'), d.callNumber);
  add(t(locale, 'vocab.field.language'), d.language === null ? null : locale === 'en' ? d.language.nameEn : d.language.nameId);
  for (const i of d.identifiers) {
    const label = IDENTIFIER_NAMES[i.type] ?? t(locale, `vocab.identifier_type.${i.type}`);
    add(label, i.qualifier === null || i.qualifier === undefined || i.qualifier.trim() === '' ? i.value : `${i.value} (${i.qualifier})`);
  }
  const rda = [rdaTerm(RDA_CONTENT_TYPES, d.contentType), rdaTerm(RDA_MEDIA_TYPES, d.mediaType), rdaTerm(RDA_CARRIER_TYPES, d.carrierType)].filter(
    (s): s is string => s !== null,
  );
  if (rda.length > 0) add(t(locale, 'vocab.field.rda'), rda.join(' / '));
  return (
    <Section id="deskripsi" title={opacText(locale, 'detail.description')}>
      <dl class="record-fields">
        {rows.map(([label, value]) => (
          <>
            <dt>{label}</dt>
            <dd>{value}</dd>
          </>
        ))}
      </dl>
    </Section>
  );
}

function Subjects(props: { d: RecordData; locale: Locale; keep: Keep }) {
  const { d, locale, keep } = props;
  if (d.subjects.length === 0) return null;
  return (
    <Section id="subjek" title={opacText(locale, 'detail.subjects')}>
      <ul class="record-subjects">
        {d.subjects.map((s) => (
          <li>
            <a href={keep(`/cari?subjek=${encodeURIComponent(s.id)}`)}>{s.term}</a>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** The label of a relation as this record's page reads it: `part_of` and `translation_of` read the other way inward. */
function relationLabel(r: RecordData['relations'][number], locale: Locale): string {
  if (r.direction === 'in' && r.type === 'part_of') return opacText(locale, 'detail.relation.has_part');
  if (r.direction === 'in' && r.type === 'translation_of') return opacText(locale, 'detail.relation.translated_as');
  return t(locale, `vocab.relation_type.${r.type}`);
}

function Relations(props: { d: RecordData; locale: Locale; keep: Keep }) {
  const { d, locale, keep } = props;
  if (d.relations.length === 0) return null;
  return (
    <Section id="relasi" title={opacText(locale, 'detail.relations')}>
      <ul class="record-relations">
        {d.relations.map((r) => (
          <li>
            <span class="relation-type">{relationLabel(r, locale)}</span> <a href={keep(recordUrlPath(r.recordId, r.title))}>{r.title}</a>
          </li>
        ))}
      </ul>
    </Section>
  );
}

/** A custom value as text (or a link, for an http(s) `url` value), by its definition's type. */
function customValue(def: CustomFieldDef | undefined, value: unknown, locale: Locale): JSX.Element | string | null {
  const optionLabel = (v: unknown): string => {
    const o = def?.options.find((x) => x.value === v);
    return o === undefined ? String(v) : locale === 'en' ? (o.labelEn ?? o.labelId) : o.labelId;
  };
  if (value === null || value === undefined || value === '') return null;
  switch (def?.type) {
    case 'boolean':
      return opacText(locale, value === true ? 'detail.yes' : 'detail.no');
    case 'select':
      return optionLabel(value);
    case 'multiselect':
      return Array.isArray(value) ? value.map(optionLabel).join(', ') : optionLabel(value);
    case 'number':
      return typeof value === 'number' ? new Intl.NumberFormat(locale === 'id' ? 'id-ID' : 'en-GB').format(value) : String(value);
    case 'url':
      return typeof value === 'string' && linkableUrl(value) ? (
        <a href={value} rel="noopener nofollow">
          {value}
        </a>
      ) : (
        String(value)
      );
    default:
      return Array.isArray(value) ? value.map(String).join(', ') : typeof value === 'object' ? null : String(value);
  }
}

function CustomFields(props: { d: RecordData; defs: readonly CustomFieldDef[]; locale: Locale }) {
  const { d, defs, locale } = props;
  const rows = d.customPublic.flatMap((c) => {
    const value = customValue(
      defs.find((x) => x.code === c.code),
      c.value,
      locale,
    );
    return value === null ? [] : [{ label: locale === 'en' ? (c.labelEn ?? c.labelId) : c.labelId, value }];
  });
  if (rows.length === 0) return null;
  return (
    <Section id="informasi-lain" title={opacText(locale, 'detail.custom')}>
      <dl class="record-fields">
        {rows.map((r) => (
          <>
            <dt>{r.label}</dt>
            <dd class="record-text">{r.value}</dd>
          </>
        ))}
      </dl>
    </Section>
  );
}

/**
 * `d` with only the attachments the page lists (public, the first {@link ATTACHMENTS_MAX} in their order) and the
 * links among them: the page, its Dublin Core and its JSON-LD then describe the same attachments, and a record with
 * hundreds of links does not grow its `<head>` without bound.
 */
export function withListedAttachments(d: RecordData): RecordData {
  const attachments = d.attachments.filter((a) => a.access === 'public').slice(0, ATTACHMENTS_MAX);
  const links = attachments.flatMap((a) => (a.kind === 'url' && linkableUrl(a.url) ? [{ url: a.url, title: a.title }] : []));
  return { ...d, attachments, links };
}

/** The path of an attachment's viewer. */
export function viewerPath(recordId: string, attachmentId: string): string {
  return `/katalog/${encodeURIComponent(recordId)}/lampiran/${encodeURIComponent(attachmentId)}`;
}

function Attachments(props: { d: RecordData; locale: Locale; keep: Keep; members?: DetailExtras['member'] }) {
  const { d, locale, keep } = props;
  const list = d.attachments.filter((a) => a.access === 'public').slice(0, ATTACHMENTS_MAX);
  const forMembers = (props.members?.attachments ?? []).slice(0, Math.max(0, ATTACHMENTS_MAX - list.length));
  if (list.length === 0 && forMembers.length === 0) return null;
  return (
    <Section id="lampiran" title={opacText(locale, 'detail.attachments')}>
      <ul class="attachment-list">
        {list.map((a) => {
          const media = attachmentMedia(a.kind, a.mime);
          const kind = <span class="attachment-kind">{t(locale, `vocab.attachment_media.${media}`)}</span>;
          // S4: a URL attachment is linked (to its viewer) only when its URL is http(s), checked again here.
          if (a.kind === 'url' && !linkableUrl(a.url)) {
            return (
              <li>
                <span class="attachment-title">{a.title}</span> {kind} <span class="attachment-note">({opacText(locale, 'detail.attachment_unlinked')})</span>
              </li>
            );
          }
          return (
            <li>
              <a class="attachment-title" href={keep(viewerPath(d.id, a.id))}>
                {a.title}
              </a>{' '}
              {kind}
            </li>
          );
        })}
        {/* Komunitas (member area): an attachment for signed-in members, opened through the member area. */}
        {forMembers.map((a) => (
          <li>
            <span class="attachment-title">{a.title}</span>{' '}
            <span class="attachment-kind">{t(locale, `vocab.attachment_media.${attachmentMedia(a.kind, a.mime)}`)}</span>{' '}
            <span class="attachment-members">({opacText(locale, 'akun.detail.members_only')})</span>{' '}
            <a href={keep(`/akun/lampiran/${encodeURIComponent(a.id)}`)}>{opacText(locale, 'akun.detail.sign_in_to_open')}</a>
          </li>
        ))}
      </ul>
    </Section>
  );
}

// ---- Komunitas (member area) ----
/** "Pesan judul ini" and "Tandai": GET links to the member area's confirmation pages (they carry its CSRF token). */
function MemberActions(props: { id: string; member: DetailExtras['member']; locale: Locale; keep: Keep }) {
  const { member, locale, keep } = props;
  if (member === undefined || (!member.hold && !member.bookmark)) return null;
  const id = encodeURIComponent(props.id);
  return (
    <p class="record-actions" aria-label={opacText(locale, 'akun.detail.actions')}>
      {member.hold ? <a href={keep(`/akun/reservasi/baru?cantuman=${id}`)}>{opacText(locale, 'akun.detail.hold')}</a> : null}
      {member.bookmark ? <a href={keep(`/akun/penanda/baru?cantuman=${id}`)}>{opacText(locale, 'akun.detail.bookmark')}</a> : null}
    </p>
  );
}

function TextSection(props: { id: string; title: string; text: string | undefined }) {
  if (props.text === undefined || props.text.trim() === '') return null;
  return (
    <Section id={props.id} title={props.title}>
      <p class="record-text">{props.text.trim()}</p>
    </Section>
  );
}

/** The page's content (see the top of this file). */
function RecordView(props: { d: RecordData; extras: DetailExtras; locale: Locale; lang: Locale | null }) {
  const { d, extras, locale, lang } = props;
  const keep: Keep = (path) => (lang === null ? path : withLang(path, lang));
  const subtitle = d.subtitle?.trim() ?? '';
  return (
    <article class="record">
      <header class="record-header">
        <BookCover
          book={{
            title: d.title,
            author: (d.agents.find((a) => a.isMain) ?? d.agents[0])?.name ?? null,
            callNumber: d.callNumber ?? null,
            classification: d.classification ?? null,
            coverFileId: extras.coverFileId,
          }}
          size="detail"
          imgClass="record-cover"
          width={200}
          height={300}
          lazy={false}
        />
        <div class="record-heading">
          <h1>
            {d.title}
            {subtitle === '' ? null : <span class="record-subtitle">: {subtitle}</span>}
          </h1>
          <p class="record-type">{typeName(d, locale)}</p>
          {d.responsibility === undefined || d.responsibility.trim() === '' ? null : <p class="record-responsibility">{d.responsibility}</p>}
          <Agents d={d} locale={locale} keep={keep} />
          <MemberActions id={d.id} member={extras.member} locale={locale} keep={keep} />
        </div>
      </header>
      <TextSection id="ringkasan" title={opacText(locale, 'detail.summary')} text={d.summary} />
      <TextSection id="catatan" title={opacText(locale, 'detail.notes')} text={d.notes} />
      <AvailabilitySection availability={extras.availability} locale={locale} />
      <Description d={d} locale={locale} />
      <Subjects d={d} locale={locale} keep={keep} />
      <Relations d={d} locale={locale} keep={keep} />
      <CustomFields d={d} defs={extras.customDefs} locale={locale} />
      <Attachments d={d} locale={locale} keep={keep} {...(extras.member === undefined ? {} : { members: extras.member })} />
      <CitationsSection data={d} locale={locale} lang={lang} />
    </article>
  );
}

/** The `opacPage` options of the detail of `d` (a public load with its items) in `ctx`. */
export function recordPageOptions(ctx: OpacContext, loaded: RecordData, extras: DetailExtras, lang: Locale | null): OpacPageOptions {
  const d = withListedAttachments(loaded);
  const o = renderOptions(ctx.baseUrl, d, ctx.locale, extras.coverFileId);
  const ogType = openGraph(d, o).find((p) => p.property === 'og:type')?.content ?? 'website';
  return {
    title: `${displayTitle(d)} · ${ctx.libraryName}`,
    description: recordDescription(d, ctx.locale, ctx.libraryName),
    canonicalPath: recordUrlPath(d.id, d.title),
    robots: 'index',
    openGraph: { type: ogType, image: extras.coverFileId === null ? null : `/files/${encodeURIComponent(extras.coverFileId)}` },
    head: () => <DetailHead d={d} o={o} />,
    jsonLd: [recordJsonLd(d, o)],
    body: () => <RecordView d={d} extras={extras} locale={ctx.locale} lang={lang} />,
  };
}
