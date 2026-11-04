import * as path from 'node:path';

declare const name: string;

export const joined = path.join('/srv/public', name);
