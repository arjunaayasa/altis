'use strict';
// A progress-style upload endpoint: the response head goes out first (flushHeaders), then the app reads the whole
// request body, and only then finishes the response.
const http = require('node:http');

http
  .createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.flushHeaders();
    let bytes = 0;
    req.on('data', (chunk) => (bytes += chunk.length));
    req.on('end', () => res.end(`got ${bytes}`));
  })
  .listen(0, '127.0.0.1');
