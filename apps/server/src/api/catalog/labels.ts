import { buildLabelPdf, labelDataFor, readSettings } from '@altis/core';
import { LabelBody } from '@altis/shared/api/catalog/labels';
import type { BarcodeSymbology, LabelProfile } from '@altis/shared/api/settings';
import { route, type RouteDecl } from '../../http/route.js';
import { validationFailed } from '../../http/validate.js';

// The catalog API route of the label PDF (Phase 2 spec §7, §12.2, §12.3; plan Task 36, route catalog; K13).
//
// `POST catalog/labels {profileId, itemIds | recordIds, startPosition, copies}` answers the sheet at once as
// `application/pdf` (`inline; filename="label.pdf"`), with `X-Altis-Label-Skipped: <n>`: how many of the ids gave no
// label (an unknown or archived item, a record without a live item; core catalog/labels/data.ts).
//
// - Access: `catalog.records.read` (printing labels is part of reading the catalog, §12.1). A read-only POST: `mode:
//   read`, `idempotency: none`, no audit.
// - `tx: 'self'`: the settings and the items are read without a transaction, so none is held open while the PDF is
//   built (up to 1 000 labels × 5 copies, well under the 20 s request slice).
// - The profile is one of `catalog.labelProfiles` (unknown → VALIDATION_FAILED `{path: 'profileId', code:
//   'not_found'}`). The library name is `library.name`, shown when the profile asks for it; the bars use the profile's
//   own symbology, else `catalog.barcode.symbology` (print/label-layout.ts).
// - More than 1 000 ids, or records making more than 1 000 labels → 422 `CATALOG_LABEL_LIMIT` (labelDataFor).
// - `startPosition` is taken up to the contract's 1 000 (§7 does not limit it to one sheet): past the end of a sheet it
//   counts on into the same slot of a fresh sheet, so no blank sheet is ever emitted.
// - Nothing is kept between requests; every request reads the settings it needs.

const labelsCreate = route({
  id: 'catalog.labels.create',
  method: 'POST',
  path: '/api/v1/catalog/labels',
  permission: 'catalog.records.read',
  mode: 'read',
  idempotency: 'none',
  audit: null,
  tx: 'self',
  body: LabelBody,
  handler: async (rc) => {
    const settings = await readSettings(rc.db.db, ['catalog.labelProfiles', 'catalog.barcode.symbology', 'library.name'], rc.config.keyring);
    const profile = (settings['catalog.labelProfiles'] as LabelProfile[]).find((p) => p.id === rc.body.profileId);
    if (profile === undefined) throw validationFailed([{ path: 'profileId', code: 'not_found' }]);
    const { itemIds, recordIds } = rc.body;
    const { labels, skipped } = await labelDataFor(rc.db.db, itemIds !== undefined ? { itemIds } : { recordIds: recordIds ?? [] });
    const pdf = buildLabelPdf({
      profile,
      labels,
      startPosition: rc.body.startPosition,
      copies: rc.body.copies,
      libraryName: settings['library.name'] as string,
      symbology: settings['catalog.barcode.symbology'] as BarcodeSymbology,
    });
    return new Response(pdf, {
      status: 200,
      headers: {
        'Content-Type': 'application/pdf',
        'Content-Disposition': 'inline; filename="label.pdf"',
        'Content-Length': String(pdf.byteLength),
        'Cache-Control': 'private, no-store',
        'X-Altis-Label-Skipped': String(skipped),
      },
    });
  },
});

export const LABELS_ROUTES: RouteDecl[] = [labelsCreate];
