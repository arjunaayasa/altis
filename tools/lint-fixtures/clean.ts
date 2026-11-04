import * as fs from 'node:fs';
import { join } from 'node:path';
import type { DatabaseSync } from 'node:sqlite';

export const banner = fs.readFileSync('banner.txt');
export const logo = join('static', 'logo.svg');

export function closeHandle(fd: number): void {
  fs.closeSync(fd);
}

export function archiveBanner(): void {
  fs.renameSync('banner.txt', 'banner.old');
}

export async function openDatabase(file: string): Promise<DatabaseSync> {
  const { DatabaseSync: Database } = await import('node:sqlite');
  return new Database(file);
}
