import { statOrNull } from '@altis/platform';
import { REPORT_WARNINGS_MAX, REPORT_WARNING_MAX_CHARS } from '@altis/shared/api/reports';
import type { DocumentCtx, DocumentResume } from '../types.js';
import { internalFailure, workFile, type DocumentState, type ExportRun, type FinishState } from './state.js';

// A document report (the accreditation documents) writes its own `output.part` (spec §4.15, §10.9): the job calls its
// `render()` once per slice with the resume state its last call answered, which the job keeps in its checkpoint (at
// most 60 000 bytes of JSON). When it answers `done`, its counts and its warning codes go to the finish phase: the
// warnings (at most 20) are stored in the run's parameters, so the run views can list them.

/** The longest resume state a document may answer, as JSON (UTF-8 bytes). */
export const DOCUMENT_RESUME_MAX_BYTES = 60_000;

/** The context of a document's rendering in this slice. */
function documentCtx(run: ExportRun): DocumentCtx {
  if (run.format !== 'pdf' && run.format !== 'zip') throw internalFailure();
  return {
    ...run.report,
    runId: run.runId,
    format: run.format,
    dataDir: run.dataDir,
    storage: run.deps.storage,
    libraryName: run.libraryName,
    staffName: run.staffName,
    appVersion: run.deps.appVersion,
    budgetLeftMs: () => run.job.budgetLeftMs(),
    heartbeat: (progress, message) => run.job.heartbeat({ progress, ...(message === undefined ? {} : { message }) }),
    cancelled: async () => run.job.cancelled(),
  };
}

/** The warning codes a run keeps: non-empty strings within the length limit, each once, the first 20. */
function keptWarnings(warnings: unknown): string[] {
  if (!Array.isArray(warnings)) throw internalFailure();
  const kept: string[] = [];
  for (const w of warnings) {
    if (typeof w !== 'string' || w === '' || w.length > REPORT_WARNING_MAX_CHARS || kept.includes(w)) continue;
    kept.push(w);
    if (kept.length === REPORT_WARNINGS_MAX) break;
  }
  return kept;
}

const count = (n: unknown): n is number => typeof n === 'number' && Number.isSafeInteger(n) && n >= 0;

/**
 * One slice of a document's rendering: where to go on, or the finished file's counts and warnings.
 *
 * @throws ExportRunFailure `internal` for a resume state over 60 000 bytes, an answer of another shape, or a finished
 *   rendering without `output.part`
 */
export async function renderDocument(run: ExportRun, state: DocumentState): Promise<{ done: false; state: DocumentState } | { done: true; finish: FinishState }> {
  if (run.def.kind !== 'document') throw new TypeError('renderDocument: a document report only');
  const step = await run.def.render(documentCtx(run), state.resume as DocumentResume | null);
  if (!step.done) {
    const resume = step.resume;
    let json: string | undefined;
    try {
      json = JSON.stringify(resume);
    } catch {
      json = undefined;
    }
    const shaped = typeof resume?.phase === 'string' && (resume.cursor === null || typeof resume.cursor === 'string');
    if (!shaped || json === undefined || Buffer.byteLength(json, 'utf8') > DOCUMENT_RESUME_MAX_BYTES) throw internalFailure();
    return { done: false, state: { resume: JSON.parse(json) as DocumentResume } };
  }
  if (!count(step.rowCount) || !count(step.nonLatinRows)) throw internalFailure();
  const info = await statOrNull(workFile(run, 'output.part'));
  if (info === null || info.kind !== 'file') throw internalFailure();
  return {
    done: true,
    finish: {
      rows: step.rowCount,
      nonLatinRows: run.format === 'pdf' ? step.nonLatinRows : null,
      size: info.size,
      warnings: keptWarnings(step.warnings),
    },
  };
}
