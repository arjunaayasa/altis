import { crc32, deflateRawSync } from 'node:zlib';

// A minimal classic ZIP builder for hostile fixtures (spec A6: "Arsip berisi ../ atau bom gzip ditolak"): every
// header field the reader looks at can be set by hand, which no well-behaved zip library allows.

export interface RawEntry {
  /** The name as stored (a Buffer to store bytes that are not UTF-8). */
  name: string | Buffer;
  /** The file data before compression. */
  data?: Buffer;
  /** 0 stored (default), 8 deflate, anything else as given. */
  method?: number;
  /** Stored as the compressed bytes instead of what `method` would produce (with `uncompressedSize`). */
  raw?: Buffer;
  /** Overrides the uncompressed size in the headers. */
  uncompressedSize?: number;
  /** General-purpose flags; bit 11 (UTF-8) is added for a string name unless `utf8: false`. */
  flags?: number;
  utf8?: boolean;
  /** `version made by` (default 0x031e: Unix, 3.0) and the external attributes (default a regular 0644 file). */
  versionMadeBy?: number;
  externalAttributes?: number;
}

/** Unix mode bits in the high half of the external attributes. */
export function unixAttributes(mode: number): number {
  return (mode << 16) >>> 0;
}

export const S_IFREG = 0o100000;
export const S_IFLNK = 0o120000;
export const S_IFDIR = 0o040000;

/** A classic (non-ZIP64) archive holding `entries` in order. */
export function rawZip(entries: readonly RawEntry[]): Buffer {
  const locals: Buffer[] = [];
  const centrals: Buffer[] = [];
  let offset = 0;
  for (const e of entries) {
    const name = typeof e.name === 'string' ? Buffer.from(e.name, 'utf8') : e.name;
    const data = e.data ?? Buffer.alloc(0);
    const method = e.method ?? 0;
    const stored = e.raw ?? (method === 8 ? deflateRawSync(data) : data);
    const size = e.uncompressedSize ?? data.byteLength;
    const flags = (e.flags ?? 0) | (typeof e.name === 'string' && e.utf8 !== false ? 0x800 : 0);
    const crc = crc32(data);

    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(flags, 6);
    local.writeUInt16LE(method, 8);
    local.writeUInt16LE(0, 10);
    local.writeUInt16LE(0x21, 12);
    local.writeUInt32LE(crc, 14);
    local.writeUInt32LE(stored.byteLength, 18);
    local.writeUInt32LE(size, 22);
    local.writeUInt16LE(name.byteLength, 26);
    local.writeUInt16LE(0, 28);
    locals.push(local, name, stored);

    const central = Buffer.alloc(46);
    central.writeUInt32LE(0x02014b50, 0);
    central.writeUInt16LE(e.versionMadeBy ?? 0x031e, 4);
    central.writeUInt16LE(20, 6);
    central.writeUInt16LE(flags, 8);
    central.writeUInt16LE(method, 10);
    central.writeUInt16LE(0, 12);
    central.writeUInt16LE(0x21, 14);
    central.writeUInt32LE(crc, 16);
    central.writeUInt32LE(stored.byteLength, 20);
    central.writeUInt32LE(size, 24);
    central.writeUInt16LE(name.byteLength, 28);
    central.writeUInt16LE(0, 30);
    central.writeUInt16LE(0, 32);
    central.writeUInt16LE(0, 34);
    central.writeUInt16LE(0, 36);
    central.writeUInt32LE(e.externalAttributes ?? unixAttributes(S_IFREG | 0o644), 38);
    central.writeUInt32LE(offset, 42);
    centrals.push(central, name);

    offset += 30 + name.byteLength + stored.byteLength;
  }
  const cd = Buffer.concat(centrals);
  const eocd = Buffer.alloc(22);
  eocd.writeUInt32LE(0x06054b50, 0);
  eocd.writeUInt16LE(0, 4);
  eocd.writeUInt16LE(0, 6);
  eocd.writeUInt16LE(entries.length, 8);
  eocd.writeUInt16LE(entries.length, 10);
  eocd.writeUInt32LE(cd.byteLength, 12);
  eocd.writeUInt32LE(offset, 16);
  eocd.writeUInt16LE(0, 20);
  return Buffer.concat([...locals, cd, eocd]);
}
