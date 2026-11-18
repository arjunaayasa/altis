import type { DbHandle } from '@altis/db';
import { t, vocabKey, type Locale } from '@altis/shared';
import type { FacetName } from '@altis/core';
import { route, type RouteDecl } from '../../http/route.js';
import { opacText, type OpacKey } from './messages.js';
import { opacContext, opacPage, requestLang } from './page.js';
import {
  OPAC_ADVANCED_PATH,
  OPAC_ISBN_TEXT_MAX,
  OPAC_SEARCH_TEXT_MAX,
  OPAC_SORTS,
  masterName,
  parseOpacSearchParams,
  searchLookups,
  searchMasters,
  unscopedText,
  type OpacSearchEcho,
  type OpacSort,
  type SearchMaster,
  type SearchMasters,
} from './search-params.js';

// The advanced search (`GET /cari/lanjutan`, opac.search.advanced): one GET form to /cari over the parameters the search
// already takes, so it works without JavaScript and its answer is the normal results page, its filters shown there and
// each removable. The text fields: the keywords (every field), the title, the author, the subject and the publisher
// (search-params.ts folds those four into the query text with their field), and the ISBN or ISSN (matched exactly);
// then the year or range, and a select per master the search takes a code of (material type, language, collection
// type, the public rooms, the branch when there is more than one), "on the shelf only" and the order. A link from the
// results page carries that search, and the form opens filled in with it. Like every OPAC page: public, `session:
// 'none'`, read, `maintenance: allow`, no audit, no `query` schema (search-params.ts reads every value by hand).

type Db = DbHandle['db'];

/** A public room the location select offers: its id (the search's `lokasi`) and its name (with its branch's). */
interface RoomOption {
  id: string;
  name: string;
}

/** The public, live rooms, by branch, order and name; with more than one branch each name carries its branch's. */
async function publicRooms(db: Db, masters: SearchMasters): Promise<RoomOption[]> {
  const rows = await db
    .selectFrom('locations')
    .select(['id', 'name', 'branch_id'])
    .where('kind', '=', 'room')
    .where('is_public', '=', 1)
    .where('archived_at', 'is', null)
    .orderBy('branch_id')
    .orderBy('sort_order')
    .orderBy('name')
    .limit(500)
    .execute();
  const branchName = masters.branches.length > 1 ? new Map(masters.branches.map((b) => [b.id, b.nameId])) : null;
  return rows.map((r) => {
    const branch = branchName?.get(r.branch_id);
    return { id: r.id, name: branch === undefined ? r.name : `${r.name} (${branch})` };
  });
}

/** What the form opens with: the search a link carried (its text in the field it was searched in). */
interface Prefill {
  words: string;
  title: string;
  author: string;
  subject: string;
  isbn: string;
}

function prefillOf(echo: OpacSearchEcho): Prefill {
  const q = echo.q ?? '';
  const out: Prefill = { words: '', title: '', author: '', subject: '', isbn: echo.isbn ?? '' };
  switch (echo.ruas) {
    case 'judul':
      out.title = unscopedText(q, 'judul');
      break;
    case 'pengarang':
      out.author = unscopedText(q, 'pengarang');
      break;
    case 'subjek':
      out.subject = unscopedText(q, 'subjek');
      break;
    case 'isbn':
      out.isbn = q;
      break;
    default:
      out.words = q;
  }
  return out;
}

/** A labelled text field (its hint under it, tied by `aria-describedby`). */
function TextField(props: { id: string; name: string; label: string; value: string; max: number; hint?: string; inputmode?: 'numeric'; wide?: boolean }) {
  const hintId = props.hint === undefined ? undefined : `${props.id}-hint`;
  return (
    <div class={props.wide === true ? 'adv-field adv-wide' : 'adv-field'}>
      <label for={props.id}>{props.label}</label>
      <input id={props.id} type="text" name={props.name} value={props.value} maxlength={props.max} inputmode={props.inputmode} aria-describedby={hintId} />
      {props.hint === undefined ? null : (
        <span id={hintId} class="adv-hint">
          {props.hint}
        </span>
      )}
    </div>
  );
}

/** A labelled select of masters (by code), "Semua" first; nothing when there is no master to choose. */
function MasterSelect(props: { id: string; name: string; label: string; list: readonly SearchMaster[]; selected: string | undefined; locale: Locale }) {
  if (props.list.length === 0) return null;
  return (
    <div class="adv-field">
      <label for={props.id}>{props.label}</label>
      <select id={props.id} name={props.name}>
        <option value="">{opacText(props.locale, 'search.advanced.any')}</option>
        {props.list.map((m) => (
          <option value={m.code} selected={m.code === props.selected}>
            {masterName(m, props.locale)}
          </option>
        ))}
      </select>
    </div>
  );
}

/** The page's form (see the top of this file). */
function AdvancedForm(props: { locale: Locale; lang: Locale | null; echo: OpacSearchEcho; masters: SearchMasters; rooms: readonly RoomOption[] }) {
  const { locale, lang, echo, masters, rooms } = props;
  const facet = (f: FacetName): string => t(locale, vocabKey('facet', f));
  const p = prefillOf(echo);
  const text = (key: OpacKey): string => opacText(locale, key);
  return (
    <form class="advanced-form" method="get" action="/cari">
      <fieldset class="adv-group">
        <legend>{text('search.advanced.text_group')}</legend>
        <TextField id="lanjut-q" name="q" label={text('search.advanced.words')} value={p.words} max={OPAC_SEARCH_TEXT_MAX} hint={text('search.advanced.words_hint')} wide />
        <TextField id="lanjut-judul" name="judul" label={text('search.advanced.title_field')} value={p.title} max={OPAC_SEARCH_TEXT_MAX} />
        <TextField id="lanjut-pengarang" name="penulis" label={text('search.advanced.author')} value={p.author} max={OPAC_SEARCH_TEXT_MAX} />
        <TextField id="lanjut-subjek" name="topik" label={text('search.advanced.subject')} value={p.subject} max={OPAC_SEARCH_TEXT_MAX} />
        <TextField id="lanjut-penerbit" name="penerbit" label={text('search.advanced.publisher')} value="" max={OPAC_SEARCH_TEXT_MAX} />
        <TextField id="lanjut-isbn" name="isbn" label={text('search.advanced.isbn')} value={p.isbn} max={OPAC_ISBN_TEXT_MAX} hint={text('search.advanced.isbn_hint')} />
      </fieldset>
      <fieldset class="adv-group">
        <legend>{text('search.advanced.filter_group')}</legend>
        <TextField
          id="lanjut-tahun"
          name="tahun"
          label={text('search.year.label')}
          value={echo.tahun ?? ''}
          max={11}
          inputmode="numeric"
          hint={text('search.advanced.year_hint')}
        />
        <MasterSelect id="lanjut-jenis" name="jenis" label={facet('mt')} list={masters.materialTypes} selected={echo.jenis} locale={locale} />
        <MasterSelect id="lanjut-bahasa" name="bahasa" label={facet('lg')} list={masters.languages} selected={echo.bahasa} locale={locale} />
        <MasterSelect id="lanjut-koleksi" name="koleksi" label={facet('ct')} list={masters.collectionTypes} selected={echo.koleksi} locale={locale} />
        {rooms.length === 0 ? null : (
          <div class="adv-field">
            <label for="lanjut-lokasi">{facet('lc')}</label>
            <select id="lanjut-lokasi" name="lokasi">
              <option value="">{text('search.advanced.any')}</option>
              {rooms.map((r) => (
                <option value={r.id} selected={r.id === echo.lokasi}>
                  {r.name}
                </option>
              ))}
            </select>
          </div>
        )}
        {masters.branches.length > 1 ? (
          <MasterSelect id="lanjut-cabang" name="cabang" label={facet('br')} list={masters.branches} selected={echo.cabang} locale={locale} />
        ) : null}
        <div class="adv-field">
          <label for="lanjut-urut">{text('search.sort.label')}</label>
          <select id="lanjut-urut" name="urut">
            {(Object.keys(OPAC_SORTS) as OpacSort[]).map((s) => (
              <option value={s} selected={s === (echo.urut ?? 'relevansi')}>
                {opacText(locale, `search.sort.${s}` as OpacKey)}
              </option>
            ))}
          </select>
        </div>
        <div class="adv-field adv-check">
          <input id="lanjut-tersedia" type="checkbox" name="tersedia" value="1" checked={echo.tersedia === '1'} />
          <label for="lanjut-tersedia">{text('search.facet.available')}</label>
        </div>
      </fieldset>
      {lang === null ? null : <input type="hidden" name="lang" value={lang} />}
      <div class="adv-actions">
        <button type="submit">{text('search.advanced.submit')}</button>
        <a href={lang === null ? OPAC_ADVANCED_PATH : `${OPAC_ADVANCED_PATH}?lang=${lang}`}>{text('search.advanced.reset')}</a>
      </div>
    </form>
  );
}

const advanced = route({
  method: 'GET',
  public: true,
  session: 'none',
  maintenance: 'allow',
  idempotency: 'none',
  audit: null,
  id: 'opac.search.advanced',
  path: OPAC_ADVANCED_PATH,
  handler: async (rc) => {
    const ctx = await opacContext(rc);
    const db = rc.db.db;
    const masters = await searchMasters(db);
    const { echo } = parseOpacSearchParams(new URL(rc.c.req.url).searchParams, searchLookups(masters));
    const rooms = await publicRooms(db, masters);
    const lang = requestLang(rc.c);
    return opacPage(rc, ctx, {
      title: `${opacText(ctx.locale, 'search.advanced.title')} · ${ctx.libraryName}`,
      description: opacText(ctx.locale, 'search.advanced.description', { library: ctx.libraryName }),
      canonicalPath: OPAC_ADVANCED_PATH,
      robots: 'noindex-follow',
      body: () => (
        <div class="advanced-page">
          <h1>{opacText(ctx.locale, 'search.advanced.title')}</h1>
          <p class="advanced-intro">{opacText(ctx.locale, 'search.advanced.intro')}</p>
          <AdvancedForm locale={ctx.locale} lang={lang} echo={echo} masters={masters} rooms={rooms} />
        </div>
      ),
    });
  },
});

/** The advanced search page. */
export const OPAC_ADVANCED_ROUTES: RouteDecl[] = [advanced];
