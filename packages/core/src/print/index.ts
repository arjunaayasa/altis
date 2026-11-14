// The `print` barrel (Phase 2 Task 7, spec §7): the PDF 1.4 writer, the standard-font widths and WinAnsi, the Code 128
// and Code 39 module patterns and the label sheet layout. Only the names of the task's interface are exported (M14);
// the width tables and the layout helpers stay internal.

export { PdfDocument } from './pdf.js';
export type { PdfColor, PdfImage, PdfPage } from './pdf.js';
export { textWidth } from './afm.js';
export { toWinAnsi } from './winansi.js';
export { code128Modules } from './code128.js';
export { code39Modules } from './code39.js';
export { buildLabelPdf, pageSizeMm, splitCallNumber } from './label-layout.js';
export type { LabelData } from './label-layout.js';
