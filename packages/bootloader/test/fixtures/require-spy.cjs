'use strict';
// Preloaded with `node --require` (ruling R56 test): appends every module that app.js itself requires to the
// file named by SPY_FILE, one per line, so a test can see what app.js loaded before it gave up.
const fs = require('fs');
const path = require('path');
const Module = require('module');

const out = process.env.SPY_FILE;
const original = Module.prototype.require;

Module.prototype.require = function spiedRequire(id) {
  if (out && typeof this.filename === 'string' && path.basename(this.filename) === 'app.js') {
    fs.appendFileSync(out, id + '\n');
  }
  return original.apply(this, arguments);
};
