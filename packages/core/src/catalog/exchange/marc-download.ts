import type { DB } from '@altis/db';
import { DomainError } from '@altis/shared';
import type { MarcFormatQuery } from '@altis/shared/api/catalog/exchange';
import type { Kysely } from 'kysely';
import { marcJsonRecord } from '../../marc/marcjson.js';
import { MARCXML_COLLECTION_CLOSE, MARCXML_COLLECTION_OPEN, writeMarcXmlRecord } from '../../marc/marcxml.js';
import { MarcTooLongError } from '../../marc/record.js';
import { writeIso2709 } from '../../marc/iso2709.js';
import { loadRecordData } from '../records/data.js';
import { staffMarc } from './writers.js';

// The MARC of one record, synchronously (Phase 2 spec §5.4 "Unduh MARC satu cantuman (admin)", §12.2; plan Task 31,
// decision P2-11, M9): `GET catalog/records/:id/marc?format=mrc|xml|json` for the editor's MARC tab and a download. The
// staff audience (S5: the record's MARC extra fields as stored); no 852, so the generated fields never carry item or
// acquisition data. Any stored record answers (archived or merged ones too: the staff may look at them).

/** What the route answers: the bytes, their type and a file name. */
export interface RecordMarcFile {
  body: Uint8Array;
  mime: string;
  fileName: string;
}

/**
 * The MARC of record `id` as `format` (`mrc` ISO 2709, `xml` a MARCXML collection of one, `json` one MarcJsonRecord).
 *
 * @throws DomainError NOT_FOUND for no such record; VALIDATION_FAILED `{path: 'format', code: 'marc_too_long'}` when
 *   ISO 2709 cannot hold it (P2-21)
 */
export async function recordMarcFile(
  db: Kysely<DB>,
  id: string,
  format: MarcFormatQuery['format'],
  o: { orgCode: string | null; baseUrl: string },
): Promise<RecordMarcFile> {
  const d = (await loadRecordData(db, [id], { publicOnly: false, includeItems: false })).get(id);
  if (d === undefined) throw new DomainError('NOT_FOUND', { detail: 'Cantuman tidak ditemukan / Record not found' });
  const rec = staffMarc(d, { orgCode: o.orgCode, baseUrl: o.baseUrl, includeItems: false });
  const name = `altis-${id}`;
  switch (format) {
    case 'mrc':
      try {
        return { body: writeIso2709(rec), mime: 'application/marc', fileName: `${name}.mrc` };
      } catch (error) {
        if (!(error instanceof MarcTooLongError)) throw error;
        throw new DomainError('VALIDATION_FAILED', {
          detail: 'Cantuman terlalu panjang untuk ISO 2709; pakai MARCXML / The record is too long for ISO 2709; use MARCXML',
          meta: { errors: [{ path: 'format', code: 'marc_too_long' }] },
        });
      }
    case 'xml':
      return {
        body: Buffer.from(MARCXML_COLLECTION_OPEN + writeMarcXmlRecord(rec) + MARCXML_COLLECTION_CLOSE, 'utf8'),
        mime: 'application/marcxml+xml; charset=utf-8',
        fileName: `${name}.xml`,
      };
    case 'json':
      return { body: Buffer.from(JSON.stringify(marcJsonRecord(rec)), 'utf8'), mime: 'application/json; charset=utf-8', fileName: `${name}.json` };
  }
}
