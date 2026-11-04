'use strict';
// Preloaded with `node --require` (boot.test.ts, fixNow 3): a loader such as an lsnode variant that patches
// http.Server#listen() and drops its callback. The server still listens and still emits 'listening'; only the
// callback handed to listen() is never called.
const http = require('http');

const originalListen = http.Server.prototype.listen;

http.Server.prototype.listen = function listen() {
  const args = Array.prototype.slice.call(arguments);
  if (args.length > 0 && typeof args[args.length - 1] === 'function') args.pop();
  return originalListen.apply(this, args);
};
