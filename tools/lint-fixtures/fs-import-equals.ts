import fs = require('node:fs');

declare const file: string;

export const content = fs.readFileSync(file);
