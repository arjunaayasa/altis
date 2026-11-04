import * as fs from 'node:fs';

declare const userPath: string;

export const contents = await fs.promises.readFile(userPath);
