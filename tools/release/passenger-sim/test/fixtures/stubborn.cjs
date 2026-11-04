'use strict';
// Listens normally but ignores SIGTERM, so only SIGKILL can stop it.
const http = require('node:http');

process.on('SIGTERM', () => {});
http.createServer((req, res) => res.end(String(process.pid))).listen(0, '127.0.0.1');
