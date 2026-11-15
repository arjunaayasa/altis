import { readOpacHome, saveOpacHome } from '@altis/core';
import { OPAC_ACCENTS, type OpacAccent } from '@altis/shared/api/settings';
import { OpacHomePutBody, type OpacHomePutResponse, type OpacHomeView } from '@altis/shared/api/opac-home';
import type { RouteDecl } from '../http/route.js';
import { route } from '../http/route.js';

// The admin API of the OPAC home page (screen OPAC › Halaman awal): `GET opac/home` reads the page's content, both
// welcome texts and their revision (with the library's name and accent for the screen's preview), `PUT opac/home` saves
// them (core opac-home: CONFLICT_STALE when the revision moved on, the photos claimed as public files, audit
// `opac.home.update`). Both `opac.pages.manage`, as Halaman & Berita: the home page is part of the public site. After
// the commit the settings cache is emptied, so this process serves the new page at once (others within its 30 s).

const PATH = '/api/v1/opac/home';

const homeGet = route({
  id: 'opac.home.get',
  method: 'GET',
  path: PATH,
  permission: 'opac.pages.manage',
  idempotency: 'none',
  audit: null,
  handler: async (rc) => {
    // Read afresh, not through the settings cache: the screen shows what is stored now.
    const state = await readOpacHome(rc.db.db);
    const [libraryName, accent] = await Promise.all([
      rc.services.settings.get<string>(rc.db.db, 'library.name'),
      rc.services.settings.get<string>(rc.db.db, 'opac.accent'),
    ]);
    const body: OpacHomeView = {
      home: state.home,
      welcome: state.welcome,
      revision: state.revision,
      libraryName,
      accent: (OPAC_ACCENTS as readonly string[]).includes(accent) ? (accent as OpacAccent) : 'teal',
    };
    return { body };
  },
});

const homePut = route({
  id: 'opac.home.put',
  method: 'PUT',
  path: PATH,
  permission: 'opac.pages.manage',
  idempotency: 'store',
  audit: 'opac.home.update',
  body: OpacHomePutBody,
  handler: async (rc) => {
    const saved = await saveOpacHome(rc.tx(), rc.body, { keyring: rc.config.keyring });
    rc.afterCommit(() => rc.services.settings.invalidate());
    const body: OpacHomePutResponse = { revision: saved.revision, changed: saved.changed };
    return { body };
  },
});

/** The routes of the OPAC home page's admin screen. */
export const OPAC_HOME_ROUTES: RouteDecl[] = [homeGet, homePut];
