import * as fs from 'node:fs';

declare const userPath: string;

export const contents = fs.readFileSync(userPath);
