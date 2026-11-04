import * as filesystem from 'node:fs';

declare const userPath: string;

export const contents = filesystem.readFileSync(userPath);
