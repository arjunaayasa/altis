'use strict';
// The classic cPanel mistake: two listeners in one process. Under Passenger the second listen() throws.
const http = require('node:http');

const first = http.createServer((req, res) => res.end('first'));
const second = http.createServer((req, res) => res.end('second'));
first.listen(0, '127.0.0.1');
second.listen(0, '127.0.0.1');
