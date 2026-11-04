import * as fs from 'node:fs';

declare const dest: string;

fs.renameSync('a', dest);
