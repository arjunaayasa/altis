'use strict';
// Preloaded with `node --require` (boot.test.ts, ruling R64): what app.js sees under cPanel's Phusion Passenger.
// - a `PhusionPassenger` global, so that the runtime is detected as `passenger` (unless ALTIS_RUNTIME says otherwise);
// - Passenger's loader throws when a process calls http.Server#listen() a second time: so does this preload,
//   synchronously, for any http.Server. The first call listens as asked (on the test's port).
// Every call is appended to the file named by LISTEN_LOG as `<pid> <call number>`, so a test can count them.
const fs = require('fs');
const http = require('http');

global.PhusionPassenger = {};

const out = process.env.LISTEN_LOG;
const originalListen = http.Server.prototype.listen;
let calls = 0;

http.Server.prototype.listen = function listen() {
  calls += 1;
  if (out) fs.appendFileSync(out, process.pid + ' ' + calls + '\n');
  if (calls > 1) {
    throw new Error('passenger-preload: http.Server.listen() was called more than once in this process');
  }
  return originalListen.apply(this, arguments);
};
