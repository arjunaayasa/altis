/**
 * The masters API vocabulary (Phase 2 spec §2.2, §2.6, §3.7, §3.8, §12.2; plan Tasks 12, 27): material types with their
 * templates, languages, collection types, suppliers and custom fields.
 *
 * Codes are unique on their normalized key (`codeField`; a taken one is `{path: 'code', code: 'taken'}`). A master in
 * use cannot be archived (409 `CATALOG_IN_USE` with `meta.count`, decision P2-16); custom fields always can (§3.7).
 * The `store` routes answer `StoreResponse` (S15).
 *
 * No Node built-ins here: the browser bundles this module. Import it as `@altis/shared/api/catalog/masters`.
 */
import { z } from 'zod';
import {
  CUSTOM_FIELD_ENTITIES,
  CUSTOM_FIELD_TYPES,
  FIELD_STATES,
  RDA_CARRIER_CODES,
  RDA_CONTENT_CODES,
  RDA_MEDIA_CODES,
  RECORD_FIELD_NAMES,
  type CustomFieldEntity,
  type CustomFieldType,
  type RdaCarrierCode,
  type RdaContentCode,
  type RdaMediaCode,
} from '../../catalog-vocab.js';
import { emailField, ulidField, versionField } from '../common.js';
import { TEXT_MAX_BYTES, codeField, longText, shortText, sortOrderField, utf8Length } from './common.js';

// ---- material types ------------------------------------------------------------------------------------------------

/**
 * `material_types.template` (§3.8): how the record editor and the server treat each field of a record of this type
 * (a field not named is `optional`; `title` is always required), the defaults of a new record's items and language,
 * and the custom-field codes the editor shows. Stored as JSON, so it is strict too.
 */
export const MaterialTypeTemplate = z.strictObject({
  fields: z.partialRecord(z.enum(RECORD_FIELD_NAMES), z.enum(FIELD_STATES)),
  defaults: z.strictObject({ collectionTypeId: ulidField.optional(), languageId: ulidField.optional() }),
  customFields: z.array(codeField).max(100),
});

export type MaterialTypeTemplate = z.infer<typeof MaterialTypeTemplate>;

/** The template a new material type starts with (the seed's). */
export const EMPTY_TEMPLATE: Readonly<MaterialTypeTemplate> = Object.freeze({
  fields: Object.freeze({}),
  defaults: Object.freeze({}),
  customFields: Object.freeze([]) as unknown as string[],
});

/** A leader position (06 type of record, 07 bibliographic level): one lower-case letter. */
const leaderCode = z.string().regex(/^[a-z]$/);

/** A schema.org or DCMI type name (`Book`, `MovingImage`), VARCHAR 32. */
const typeName = z.string().regex(/^[A-Za-z]{1,32}$/);

const materialTypeFields = {
  code: codeField,
  nameId: shortText(191).min(1),
  nameEn: shortText(191).min(1),
  marcType: leaderCode,
  marcLevel: leaderCode,
  contentType: z.enum(RDA_CONTENT_CODES as readonly [RdaContentCode, ...RdaContentCode[]]),
  mediaType: z.enum(RDA_MEDIA_CODES as readonly [RdaMediaCode, ...RdaMediaCode[]]),
  carrierType: z.enum(RDA_CARRIER_CODES as readonly [RdaCarrierCode, ...RdaCarrierCode[]]),
  schemaType: typeName,
  dcmiType: typeName,
  template: MaterialTypeTemplate,
  sortOrder: sortOrderField,
};

/** `POST catalog/material-types`: the RDA defaults come from the official lists. */
export const MaterialTypeBody = z.strictObject(materialTypeFields);

export type MaterialTypeBody = z.infer<typeof MaterialTypeBody>;

/** `PATCH catalog/material-types/:id`. */
export const MaterialTypePatchBody = z.strictObject({ version: versionField, ...partialShape(materialTypeFields) });

export type MaterialTypePatchBody = z.infer<typeof MaterialTypePatchBody>;

// ---- languages, collection types, suppliers ----------------------------------------------------------------------

const languageFields = { code: codeField, nameId: shortText(191).min(1), nameEn: shortText(191).min(1) };

/** `POST catalog/languages`: `code` is the MARC language code (≈ ISO 639-2/B, `ind`). */
export const LanguageBody = z.strictObject(languageFields);

export type LanguageBody = z.infer<typeof LanguageBody>;

/** `PATCH catalog/languages/:id`. */
export const LanguagePatchBody = z.strictObject({ version: versionField, ...partialShape(languageFields) });

export type LanguagePatchBody = z.infer<typeof LanguagePatchBody>;

const collectionTypeFields = {
  code: codeField,
  nameId: shortText(191).min(1),
  nameEn: shortText(191).min(1),
  /** Items of this type may be lent (§2.5). */
  loanable: z.boolean(),
  /** And lent at a self-service kiosk. */
  selfService: z.boolean(),
  sortOrder: sortOrderField,
};

/** `POST catalog/collection-types`. */
export const CollectionTypeBody = z.strictObject(collectionTypeFields);

export type CollectionTypeBody = z.infer<typeof CollectionTypeBody>;

/** `PATCH catalog/collection-types/:id`. */
export const CollectionTypePatchBody = z.strictObject({ version: versionField, ...partialShape(collectionTypeFields) });

export type CollectionTypePatchBody = z.infer<typeof CollectionTypePatchBody>;

const supplierFields = {
  code: codeField,
  name: shortText(191).min(1),
  // The contact fields are personal data (§2.2 *): never shown on a public page.
  contactName: shortText(191).nullable().optional(),
  phone: shortText(64).nullable().optional(),
  email: emailField.nullable().optional(),
  address: longText.nullable().optional(),
  note: longText.nullable().optional(),
};

/** `POST catalog/suppliers`. */
export const SupplierBody = z.strictObject(supplierFields);

export type SupplierBody = z.infer<typeof SupplierBody>;

/** `PATCH catalog/suppliers/:id`. */
export const SupplierPatchBody = z.strictObject({ version: versionField, ...partialShape(supplierFields) });

export type SupplierPatchBody = z.infer<typeof SupplierPatchBody>;

// ---- custom fields -------------------------------------------------------------------------------------------------

/** One option of a `select`/`multiselect` field (`options` JSON, §3.7). */
export const CustomFieldOption = z.strictObject({
  value: shortText(191).min(1),
  labelId: shortText(191).min(1),
  labelEn: shortText(191).nullable().optional(),
});

export type CustomFieldOption = z.infer<typeof CustomFieldOption>;

/**
 * The JSON `custom_field_defs.options` stores (§3.7: `[{value, label_id, label_en}]`), for its size: the column is
 * TEXT, so the encoding is capped at {@link TEXT_MAX_BYTES} UTF-8 bytes like any free TEXT value (Review Focus 3).
 */
function storedOptionsJson(options: readonly CustomFieldOption[]): string {
  return JSON.stringify(options.map((o) => ({ value: o.value, label_id: o.labelId, label_en: o.labelEn ?? null })));
}

/**
 * Option values must differ: the second of two equal ones is `{path: 'options.<i>.value', code: 'duplicate'}`. Their
 * stored JSON above {@link TEXT_MAX_BYTES} bytes is `{path: 'options', code: 'too_big'}`.
 */
const customFieldOptions = z
  .array(CustomFieldOption)
  .max(100)
  .check((ctx) => {
    const seen = new Set<string>();
    ctx.value.forEach((o, i) => {
      if (seen.has(o.value)) ctx.issues.push({ code: 'custom', path: [i, 'value'], params: { code: 'duplicate' }, message: 'duplicate', input: o.value });
      seen.add(o.value);
    });
    if (utf8Length(storedOptionsJson(ctx.value)) > TEXT_MAX_BYTES) {
      ctx.issues.push({ code: 'too_big', origin: 'string', maximum: TEXT_MAX_BYTES, inclusive: true, input: ctx.value });
    }
  });

const customFieldFields = {
  code: codeField,
  labelId: shortText(191).min(1),
  labelEn: shortText(191).nullable().optional(),
  options: customFieldOptions.optional(),
  required: z.boolean(),
  sortOrder: sortOrderField,
  /** Shown on the OPAC under "Informasi lain". */
  isPublic: z.boolean(),
  /** Its text goes into the search index (public fields only in Phase 2, S20). */
  isSearchable: z.boolean(),
};

/** The types whose value is one or more of the field's options. */
const CHOICE_TYPES: readonly CustomFieldType[] = ['select', 'multiselect'];

/**
 * `POST catalog/custom-fields`. A `select` or `multiselect` field needs at least one option (`{path: 'options', code:
 * 'required'}`).
 */
export const CustomFieldBody = z
  .strictObject({ entity: z.enum(CUSTOM_FIELD_ENTITIES), type: z.enum(CUSTOM_FIELD_TYPES), ...customFieldFields })
  .check((ctx) => {
    if (CHOICE_TYPES.includes(ctx.value.type) && (ctx.value.options === undefined || ctx.value.options.length === 0)) {
      ctx.issues.push({ code: 'custom', path: ['options'], params: { code: 'required' }, message: 'required', input: ctx.value.options });
    }
  });

export type CustomFieldBody = z.infer<typeof CustomFieldBody>;

/** `PATCH catalog/custom-fields/:id`: `entity` and `type` never change (a strict body refuses them). */
export const CustomFieldPatchBody = z.strictObject({ version: versionField, ...partialShape(customFieldFields) });

export type CustomFieldPatchBody = z.infer<typeof CustomFieldPatchBody>;

/** `GET catalog/{material-types|languages|collection-types|suppliers|custom-fields}`; `entity` filters custom fields. */
export const MasterListQuery = z.strictObject({
  q: shortText(191).optional(),
  entity: z.enum(CUSTOM_FIELD_ENTITIES).optional(),
  includeArchived: z.stringbool().optional(),
});

export type MasterListQuery = z.infer<typeof MasterListQuery>;

// ---- views ---------------------------------------------------------------------------------------------------------

/** What every master view carries: how many live rows use it, and its archive state. */
interface MasterState {
  /** Material types and languages: live records; collection types and suppliers: live items; custom fields: values. */
  usage: number;
  archived: boolean;
  version: number;
}

export interface MaterialTypeView extends MasterState {
  id: string;
  code: string;
  nameId: string;
  nameEn: string;
  marcType: string;
  marcLevel: string;
  contentType: string;
  mediaType: string;
  carrierType: string;
  schemaType: string;
  dcmiType: string;
  template: MaterialTypeTemplate;
  sortOrder: number;
}

export interface LanguageView extends MasterState {
  id: string;
  code: string;
  nameId: string;
  nameEn: string;
}

export interface CollectionTypeView extends MasterState {
  id: string;
  code: string;
  nameId: string;
  nameEn: string;
  loanable: boolean;
  selfService: boolean;
  sortOrder: number;
}

export interface SupplierView extends MasterState {
  id: string;
  code: string;
  name: string;
  contactName: string | null;
  phone: string | null;
  email: string | null;
  address: string | null;
  note: string | null;
}

export interface CustomFieldView extends MasterState {
  id: string;
  entity: CustomFieldEntity;
  code: string;
  type: CustomFieldType;
  labelId: string;
  labelEn: string | null;
  options: { value: string; labelId: string; labelEn: string | null }[];
  required: boolean;
  sortOrder: number;
  isPublic: boolean;
  isSearchable: boolean;
}

/** A master list (≤ 500 rows, by `sort_order` then code). */
export interface MasterListResponse<T> {
  items: T[];
}

// ---- helpers -------------------------------------------------------------------------------------------------------

/**
 * The fields of a create shape, each optional: a patch changes only what it sends. Written out (not `.partial()`) so
 * that a patch never inherits a default.
 */
function partialShape<S extends Record<string, z.ZodType>>(shape: S): { [K in keyof S]: z.ZodOptional<S[K]> } {
  const out: Record<string, z.ZodType> = {};
  for (const [key, schema] of Object.entries(shape)) out[key] = schema.optional();
  return out as { [K in keyof S]: z.ZodOptional<S[K]> };
}
