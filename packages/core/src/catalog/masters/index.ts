// The catalog's `masters` barrel (Phase 2 Task 12; created empty by Task 3): material types with their templates,
// languages, collection types, suppliers and custom fields, and the usage count that keeps a master in use from being
// archived (Review Focus 2). Only the names of the task's Interfaces (M14); the shared helpers stay internal.

export { archiveMaterialType, createMaterialType, listMaterialTypes, updateMaterialType } from './material-types.js';
export { archiveLanguage, createLanguage, listLanguages, updateLanguage } from './languages.js';
export { archiveCollectionType, createCollectionType, listCollectionTypes, updateCollectionType } from './collection-types.js';
export { archiveSupplier, createSupplier, listSuppliers, updateSupplier } from './suppliers.js';
export { archiveCustomField, createCustomField, listCustomFields, updateCustomField } from './custom-fields.js';
export type { CustomFieldWriteOptions } from './custom-fields.js';
export { masterUsage } from './in-use.js';
export type { MasterKind } from './in-use.js';
