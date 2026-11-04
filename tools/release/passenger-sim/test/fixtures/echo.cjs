'use strict';
// A well-behaved Passenger app: one http.Server, listen() with a port that Passenger ignores.
// Port 0 (not 3000) so that a broken shim can never collide with a real service.
const http = require('node:http');

const server = http.createServer((req, res) => {
  const chunks = [];
  req.on('data', (chunk) => chunks.push(chunk));
  req.on('end', () => {
    const url = new URL(req.url, 'http://placeholder.invalid');
    const ms = Number(url.searchParams.get('ms') || 0);
    const body = Buffer.concat(chunks).toString('utf8');

    if (url.pathname === '/cookies') {
      res.setHeader('set-cookie', ['a=1; Path=/', 'b=2; Path=/']);
      res.end('cookies');
      return;
    }
    if (url.pathname === '/chunks') {
      res.write('first,');
      setTimeout(() => res.end('second'), 50);
      return;
    }

    const respond = () => {
      res.setHeader('content-type', 'application/json');
      res.end(
        JSON.stringify({
          pid: process.pid,
          method: req.method,
          url: req.url,
          host: req.headers.host,
          body,
          remoteAddress: req.socket.remoteAddress,
          remoteFamily: req.socket.remoteFamily,
          xff: req.headers['x-forwarded-for'],
          xfp: req.headers['x-forwarded-proto'],
          inPassenger: process.env.IN_PASSENGER,
          appEnv: process.env.PASSENGER_APP_ENV,
          nodeEnv: process.env.NODE_ENV,
          passengerGlobal: typeof globalThis.PhusionPassenger,
          simSocketInEnv: 'SIM_SOCKET' in process.env,
          address: server.address(),
          cwd: process.cwd(),
        }),
      );
    };
    if (url.pathname === '/slow' && ms > 0) setTimeout(respond, ms);
    else respond();
  });
});

server.listen(0, '127.0.0.1');
