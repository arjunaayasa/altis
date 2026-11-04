'use strict';
// An app that refuses an upload with 413 without reading a single byte of the body.
// GET /connections reports how many connections the app's server currently has open.
const http = require('node:http');

const server = http.createServer((req, res) => {
  if (req.url === '/connections') {
    server.getConnections((err, count) => res.end(String(err ? -1 : count)));
    return;
  }
  res.writeHead(413, { 'content-type': 'text/plain' });
  res.end('payload too large');
});
server.listen(0, '127.0.0.1');
