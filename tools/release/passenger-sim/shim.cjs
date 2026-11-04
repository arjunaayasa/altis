'use strict';
/*
 * passenger-sim worker loader, the counterpart of Phusion Passenger's node-loader.js (spec 12.2).
 *
 * Loaded with `node --require shim.cjs <app>/app.js` by the supervisor (sim.ts), which sets IN_PASSENGER=1,
 * PASSENGER_APP_ENV=production and SIM_SOCKET=<unix socket | named pipe>. It makes the app see what it sees under
 * Passenger:
 *   - a `PhusionPassenger` global;
 *   - the first http.Server#listen() call binds SIM_SOCKET whatever its arguments (the port is ignored),
 *     and every later call throws (Passenger allows exactly one listener per process);
 *   - requests whose socket peer is always 127.0.0.1 (the real client is only known from X-Forwarded-For).
 *
 * Plain CommonJS, ES2017 syntax, no dependencies (enforced by the ecmaVersion override in eslint.config.js).
 */
var http = require('http');

var PEER_FORCED = Symbol('passenger-sim.peer');

function forcePeer(socket) {
  if (socket[PEER_FORCED]) return;
  Object.defineProperty(socket, PEER_FORCED, { value: true });
  // Unix sockets have no peer address; own properties shadow the net.Socket accessors.
  Object.defineProperty(socket, 'remoteAddress', { value: '127.0.0.1', configurable: true, enumerable: true });
  Object.defineProperty(socket, 'remoteFamily', { value: 'IPv4', configurable: true, enumerable: true });
}

function reportListening() {
  if (typeof process.send === 'function' && process.connected) {
    // The callback swallows ERR_IPC_CHANNEL_CLOSED: a supervisor that vanished is handled by 'disconnect'.
    process.send({ type: 'listening' }, function () {});
  }
}

function install(socketPath) {
  globalThis.PhusionPassenger = {};

  var originalListen = http.Server.prototype.listen;
  var listenCalls = 0;
  http.Server.prototype.listen = function listen() {
    listenCalls += 1;
    if (listenCalls > 1) {
      throw new Error(
        'passenger-sim: second listen() - Passenger allows exactly one listen() per process, ' +
          'and the first one is already bound to the worker socket',
      );
    }
    var args = Array.prototype.slice.call(arguments);
    var callbacks = args.filter(function (arg) {
      return typeof arg === 'function';
    });
    this.once('listening', reportListening);
    // Port, host and backlog are ignored, as under Passenger; only the 'listening' callback is honoured.
    return callbacks.length > 0
      ? originalListen.call(this, socketPath, callbacks[callbacks.length - 1])
      : originalListen.call(this, socketPath);
  };

  var originalEmit = http.Server.prototype.emit;
  http.Server.prototype.emit = function emit(type, req) {
    if (type === 'request' && req && req.socket) forcePeer(req.socket);
    return originalEmit.apply(this, arguments);
  };

  // The supervisor is the only parent: when its IPC channel closes (it exited or was killed) this worker is an
  // orphan. SIGTERM first so that the app can shut down gracefully, then insist.
  process.on('disconnect', function () {
    process.kill(process.pid, 'SIGTERM');
    setTimeout(function () {
      process.exit(0);
    }, 5000).unref();
  });
  // A 'disconnect' listener refs the IPC channel, which would keep a worker alive after its app has finished.
  // The supervisor must see the exit of an app that simply ends, as Passenger does.
  if (process.channel && typeof process.channel.unref === 'function') process.channel.unref();
}

var socketPath = process.env.SIM_SOCKET;
if (socketPath) {
  // Consume the variable: processes forked by the app inherit both env and execArgv (`--require shim.cjs`), and
  // without SIM_SOCKET the shim stays inert there instead of stealing the worker's socket.
  delete process.env.SIM_SOCKET;
  install(socketPath);
}
