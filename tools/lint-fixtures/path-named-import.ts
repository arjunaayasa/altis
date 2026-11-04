import { join } from 'node:path';

declare const base: string;
declare const name: string;

export const joined = join(base, name);
