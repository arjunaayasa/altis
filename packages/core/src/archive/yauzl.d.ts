// Types of the parts of yauzl 3.4.0 (MIT, pinned exactly; it ships no declarations) that ALTIS uses: zip-reader.ts
// and the archive tests. Written from yauzl's index.js; only what is called is declared.

declare module 'yauzl' {
  import type { EventEmitter } from 'node:events';
  import type { Readable } from 'node:stream';

  export interface Options {
    autoClose?: boolean;
    lazyEntries?: boolean;
    /** false: `fileName` (and comments) stay Buffers, and yauzl does not check names itself. */
    decodeStrings?: boolean;
    validateEntrySizes?: boolean;
    strictFileNames?: boolean;
  }

  export interface ReadStreamOptions {
    /** false: the stored bytes as they are (no inflate); allows `start`/`end` on any entry. */
    decodeFileData?: boolean;
    start?: number;
    end?: number;
  }

  export interface ExtraField {
    id: number;
    data: Buffer;
  }

  export class Entry {
    /** A string with `decodeStrings` (the default), the raw bytes without it. */
    fileName: string | Buffer;
    extraFields: ExtraField[];
    versionMadeBy: number;
    versionNeededToExtract: number;
    generalPurposeBitFlag: number;
    compressionMethod: number;
    lastModFileTime: number;
    lastModFileDate: number;
    crc32: number;
    compressedSize: number;
    uncompressedSize: number;
    fileNameLength: number;
    extraFieldLength: number;
    fileCommentLength: number;
    internalFileAttributes: number;
    externalFileAttributes: number;
    relativeOffsetOfLocalHeader: number;
    isEncrypted(): boolean;
    isCompressed(): boolean;
  }

  export class ZipFile extends EventEmitter {
    entryCount: number;
    fileSize: number;
    isOpen: boolean;
    readEntry(): void;
    openReadStream(entry: Entry, callback: (error: Error | null, stream?: Readable) => void): void;
    openReadStream(entry: Entry, options: ReadStreamOptions, callback: (error: Error | null, stream?: Readable) => void): void;
    close(): void;
  }

  export function fromFd(fd: number, options: Options, callback: (error: Error | null, zipfile?: ZipFile) => void): void;
  export function fromBuffer(buffer: Buffer, options: Options, callback: (error: Error | null, zipfile?: ZipFile) => void): void;

  const yauzl: {
    fromFd: typeof fromFd;
    fromBuffer: typeof fromBuffer;
    Entry: typeof Entry;
    ZipFile: typeof ZipFile;
  };
  export default yauzl;
}
