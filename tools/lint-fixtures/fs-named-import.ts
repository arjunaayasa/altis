import { readFileSync } from 'node:fs';

declare const userPath: string;

export const contents = readFileSync(userPath);
