/**
 * The shared texts of the OPAC home page as a profile site: the audit action of its admin screen. `OPAC_HOME_ID` is the
 * source of the keys and `OPAC_HOME_EN` is typed against it, so a key without its English text fails `tsc`; both are
 * spread once into the shared catalogs.
 *
 * No Node built-ins here: the browser bundles this module.
 */

export const OPAC_HOME_ID = {
  // ---- audit.<action> ----
  'audit.opac.home.update': 'Mengubah halaman awal OPAC',
  'audit.site.identity.update': 'Mengubah identitas situs',
};

export const OPAC_HOME_EN: Record<keyof typeof OPAC_HOME_ID, string> = {
  'audit.opac.home.update': 'Changed the OPAC home page',
  'audit.site.identity.update': 'Changed the site identity',
};
