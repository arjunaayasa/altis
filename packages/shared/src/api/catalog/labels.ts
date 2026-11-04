/**
 * The label API vocabulary (Phase 2 spec §7, §12.2; plan Tasks 30, 36): `POST catalog/labels` answers a PDF at once.
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/catalog/labels`.
 */
import { z } from 'zod';
import { ulidField } from '../common.js';
import { settingIdField } from './common.js';

/** The longest id list the body takes; the handler allows 1000 labels' worth (422 `CATALOG_LABEL_LIMIT`, Task 36). */
export const LABEL_IDS_MAX = 10_000;

/**
 * `POST catalog/labels`: the labels of the items **or** of the records (each record's items), exactly one of the two
 * lists (both: `{path: 'recordIds', code: 'exclusive'}`; neither: `{path: 'itemIds', code: 'required'}`).
 * `startPosition` is the first free label on the first sheet (1-based); `copies` of each label.
 */
export const LabelBody = z
  .strictObject({
    /** A label profile of `catalog.labelProfiles`. */
    profileId: settingIdField,
    itemIds: z.array(ulidField).min(1).max(LABEL_IDS_MAX).optional(),
    recordIds: z.array(ulidField).min(1).max(LABEL_IDS_MAX).optional(),
    startPosition: z.int().min(1).max(1000),
    copies: z.int().min(1).max(5),
  })
  .check((ctx) => {
    const { itemIds, recordIds } = ctx.value;
    if (itemIds !== undefined && recordIds !== undefined) {
      ctx.issues.push({ code: 'custom', path: ['recordIds'], params: { code: 'exclusive' }, message: 'exclusive', input: recordIds });
    } else if (itemIds === undefined && recordIds === undefined) {
      ctx.issues.push({ code: 'custom', path: ['itemIds'], params: { code: 'required' }, message: 'required', input: itemIds });
    }
  });

export type LabelBody = z.infer<typeof LabelBody>;
