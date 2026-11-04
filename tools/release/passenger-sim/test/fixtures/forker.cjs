'use strict';
// An app that forks a helper which runs its own http.Server. fork() inherits execArgv (--require shim),
// so the shim must stay inert in the helper or it would steal the worker's socket.
const http = require('node:http');
const { fork } = require('node:child_process');

if (process.argv[2] === 'helper') {
  process.on('disconnect', () => process.exit(0));
  const helper = http.createServer((req, res) => res.end('helper'));
  helper.listen(0, '127.0.0.1', () => process.send({ address: helper.address() }));
} else {
  let helperAddress = null;
  const child = fork(__filename, ['helper']);
  child.on('message', (message) => {
    helperAddress = message.address;
  });
  http
    .createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({ helperAddress }));
    })
    .listen(0, '127.0.0.1');
}
