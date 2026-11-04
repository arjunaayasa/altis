'use strict';
// A server-sent-events style response: the head goes out at once (flushHeaders), the first event much later.
const http = require('node:http');

http
  .createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache' });
    res.flushHeaders();
    const timer = setTimeout(() => res.end('data: late\n\n'), 4000);
    res.on('close', () => clearTimeout(timer));
  })
  .listen(0, '127.0.0.1');
