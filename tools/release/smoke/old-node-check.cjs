#!/usr/bin/env node
'use strict';

// The NODE_TOO_OLD rescue, on a real old Node (ruling R56, Review Focus 4; the nightly `old-node` job).
//
//   node tools/release/smoke/old-node-check.cjs --app <unzipped release folder> [--port <n>] [--timeout-ms <n>]
//
// Hosting panels still offer Node 10 to 20 (cPanel, aaPanel), and app.js is frozen once an install has it, so what it
// does on those Nodes can never be fixed afterwards. The unit tests only fake the version on a new Node; this runs the
// built app.js on the Node it is started with and asserts what an operator would see:
//   1. `node app.js` listens (ALTIS_PORT, a fresh DATA_DIR that does not exist yet) and answers
//      - GET /_health: 503, JSON {"status":"rescue","reason":"NODE_TOO_OLD"}, Retry-After 30;
//      - GET / and any other path: 503, bilingual HTML that names "Node 22.16" and "Setup Node.js App";
//   2. DATA_DIR was not created: nothing after the version check ran;
//   3. `node app.js doctor` exits 1 and its stderr names NODE_TOO_OLD and "Node 22.16".
//
// This file itself runs on the old Node it tests, so it is CommonJS with ES2017 syntax at most (tools/release/smoke/
// run.test.ts parses it with acorn at ecmaVersion 2017) and uses only what Node 10 has: node:http (no global fetch),
// child_process, fs.mkdtempSync, no fs.rmSync, no URL, no optional chaining, no `??`.
//
// Output: one JSON line on stdout {node, ok, checks: [{name, ok, detail}]}; progress on stderr. Exit 0 when every
// check holds, 1 otherwise, 2 for a usage error.

const childProcess = require('child_process');
const fs = require('fs');
const http = require('http');
const net = require('net');
const os = require('os');
const path = require('path');

const NODE_TEXT = 'Node 22.16';
const PANEL_TEXT = 'Setup Node.js App';
const DEFAULT_TIMEOUT_MS = 30000;
const POLL_MS = 100;
const STOP_GRACE_MS = 5000;

function say(line) {
  process.stderr.write('old-node-check: ' + line + '\n');
}

function messageOf(error) {
  return error instanceof Error ? error.message : String(error);
}

function sleep(ms) {
  return new Promise(function (resolve) {
    setTimeout(resolve, ms);
  });
}

/** @returns {{app: string, port: number|null, timeoutMs: number}} @throws Error `USAGE: ...` */
function parseArgs(argv) {
  const out = { app: null, port: null, timeoutMs: DEFAULT_TIMEOUT_MS };
  for (let i = 0; i < argv.length; i += 2) {
    const name = argv[i];
    const value = argv[i + 1];
    if (value === undefined || value === '') throw new Error('USAGE: ' + name + ' needs a value');
    if (name === '--app') out.app = path.resolve(value);
    else if (name === '--port') out.port = parseInt(value, 10);
    else if (name === '--timeout-ms') out.timeoutMs = parseInt(value, 10);
    else throw new Error('USAGE: unknown argument ' + name);
  }
  if (out.app === null) throw new Error('USAGE: --app <folder holding app.js> is required');
  if (out.port !== null && !(out.port >= 1 && out.port <= 65535)) throw new Error('USAGE: --port must be 1-65535');
  if (!(out.timeoutMs >= 1000)) throw new Error('USAGE: --timeout-ms must be at least 1000');
  return out;
}

function freePort() {
  return new Promise(function (resolve, reject) {
    const server = net.createServer();
    server.once('error', reject);
    server.listen(0, '127.0.0.1', function () {
      const port = server.address().port;
      server.close(function () {
        resolve(port);
      });
    });
  });
}

/** One GET over node:http (http.get with an options object: the only form Node 10 has). */
function get(port, urlPath) {
  return new Promise(function (resolve, reject) {
    const req = http.get({ host: '127.0.0.1', port: port, path: urlPath, agent: false, headers: { connection: 'close' } }, function (res) {
      let body = '';
      res.setEncoding('utf8');
      res.on('data', function (chunk) {
        body += chunk;
      });
      res.on('end', function () {
        resolve({ status: res.statusCode, headers: res.headers, body: body });
      });
      res.on('error', reject);
    });
    req.setTimeout(5000, function () {
      req.abort();
    });
    req.on('error', reject);
  });
}

/** Removes a folder tree (fs.rmSync does not exist before Node 14.14); what is already gone is not an error. */
function removeTree(target) {
  let stat;
  try {
    stat = fs.lstatSync(target);
  } catch (error) {
    if (error.code !== 'ENOENT') say('cannot remove ' + target + ': ' + messageOf(error));
    return;
  }
  if (stat.isDirectory()) {
    fs.readdirSync(target).forEach(function (name) {
      removeTree(path.join(target, name));
    });
    fs.rmdirSync(target);
  } else {
    fs.unlinkSync(target);
  }
}

/** The environment of the app: this one, with the port and DATA_DIR of the check and no PORT of the runner. */
function appEnv(port, dataDir) {
  const env = {};
  Object.keys(process.env).forEach(function (name) {
    env[name] = process.env[name];
  });
  delete env.PORT;
  env.ALTIS_PORT = String(port);
  env.ALTIS_DATA_DIR = dataDir;
  return env;
}

/** `{value}` or `{error}`: JSON.parse without a throw. */
function parseJson(text) {
  try {
    return { value: JSON.parse(text), error: null };
  } catch (error) {
    return { value: null, error: messageOf(error) };
  }
}

/** The last lines of what the app wrote, for a failure message (a SyntaxError of app.js on an old Node lands here). */
function tail(text) {
  const lines = text.trim().split('\n');
  return lines.slice(-12).join(' | ');
}

function stopChild(child, exited) {
  return new Promise(function (resolve) {
    if (exited.value !== null) return resolve();
    const timer = setTimeout(function () {
      child.kill('SIGKILL');
    }, STOP_GRACE_MS);
    child.once('exit', function () {
      clearTimeout(timer);
      resolve();
    });
    child.kill('SIGTERM');
  });
}

async function run(opts) {
  const checks = [];
  const record = function (name, ok, detail) {
    checks.push({ name: name, ok: ok, detail: detail });
    say((ok ? 'ok     ' : 'FAILED ') + name + (detail === '' ? '' : ': ' + detail));
  };
  const expect = function (name, ok, detail) {
    record(name, ok, ok ? '' : detail);
    return ok;
  };

  const appJs = path.join(opts.app, 'app.js');
  if (!fs.existsSync(appJs)) throw new Error('USAGE: ' + appJs + ' does not exist');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'altis-old-node-'));
  const dataDir = path.join(scratch, 'altis-data'); // never created by the check
  const port = opts.port === null ? await freePort() : opts.port;
  const env = appEnv(port, dataDir);
  say('node ' + process.version + ' runs ' + appJs + ' on port ' + port);

  let child = null;
  const exited = { value: null };
  let output = '';
  try {
    child = childProcess.spawn(process.execPath, [appJs], { cwd: opts.app, env: env, stdio: ['ignore', 'pipe', 'pipe'] });
    const collect = function (chunk) {
      output += chunk.toString('utf8');
    };
    child.stdout.on('data', collect);
    child.stderr.on('data', collect);
    child.on('error', function (error) {
      exited.value = { code: null, signal: null, error: error };
    });
    child.on('exit', function (code, signal) {
      exited.value = { code: code, signal: signal };
    });

    // The first answer of the app, whatever it is; an app.js that dies on this Node never answers.
    let health = null;
    let lastError = 'no answer';
    const deadline = Date.now() + opts.timeoutMs;
    while (health === null) {
      if (exited.value !== null) {
        const e = exited.value;
        throw new Error(
          'app.js exited before it answered (' + (e.error ? messageOf(e.error) : 'code ' + e.code + ', signal ' + e.signal) + '); its output: ' + tail(output)
        );
      }
      if (Date.now() > deadline) {
        throw new Error('app.js did not answer on port ' + port + ' within ' + opts.timeoutMs + ' ms (' + lastError + '); its output: ' + tail(output));
      }
      try {
        health = await get(port, '/_health');
      } catch (error) {
        lastError = messageOf(error); // not listening yet
        await sleep(POLL_MS);
      }
    }

    const json = parseJson(health.body).value;
    expect('/_health is 503', health.status === 503, 'status ' + health.status + ', body ' + health.body.slice(0, 200));
    expect('/_health is JSON', /^application\/json/.test(String(health.headers['content-type'])), 'content-type ' + health.headers['content-type']);
    expect(
      '/_health says rescue / NODE_TOO_OLD',
      json !== null && json.status === 'rescue' && json.reason === 'NODE_TOO_OLD' && Object.keys(json).length === 2,
      'body ' + health.body.slice(0, 200)
    );
    expect('/_health carries Retry-After 30', health.headers['retry-after'] === '30', 'retry-after ' + health.headers['retry-after']);

    const paths = ['/', '/admin/anything?x=1'];
    for (let i = 0; i < paths.length; i += 1) {
      const page = await get(port, paths[i]);
      expect('GET ' + paths[i] + ' is 503 HTML', page.status === 503 && /^text\/html/.test(String(page.headers['content-type'])), 'status ' + page.status + ', content-type ' + page.headers['content-type']);
      expect('GET ' + paths[i] + ' names ' + NODE_TEXT, page.body.indexOf(NODE_TEXT) !== -1, 'the page does not contain "' + NODE_TEXT + '"');
      expect('GET ' + paths[i] + ' names "' + PANEL_TEXT + '"', page.body.indexOf(PANEL_TEXT) !== -1, 'the page does not contain "' + PANEL_TEXT + '"');
      expect(
        'GET ' + paths[i] + ' is bilingual, Indonesian first',
        page.body.indexOf('lang="id"') !== -1 && page.body.indexOf('lang="id"') < page.body.indexOf('lang="en"'),
        'no lang="id" section before lang="en"'
      );
    }
    expect('DATA_DIR was not created (nothing ran after the version check)', !fs.existsSync(dataDir), dataDir + ' exists');
  } catch (error) {
    record('app.js answers on Node ' + process.version, false, messageOf(error));
  } finally {
    if (child !== null) await stopChild(child, exited);
  }

  // `node app.js doctor`: a command, not a server: it must say the same on stderr and exit 1.
  const doctor = childProcess.spawnSync(process.execPath, [appJs, 'doctor'], { cwd: opts.app, env: env, encoding: 'utf8', timeout: opts.timeoutMs });
  const doctorText = String(doctor.stderr) + String(doctor.stdout);
  expect('`app.js doctor` exits 1', doctor.status === 1, 'exit status ' + doctor.status + (doctor.error ? ' (' + messageOf(doctor.error) + ')' : '') + ', output: ' + tail(doctorText));
  expect('`app.js doctor` names NODE_TOO_OLD and ' + NODE_TEXT, doctorText.indexOf('NODE_TOO_OLD') !== -1 && doctorText.indexOf(NODE_TEXT) !== -1, 'output: ' + tail(doctorText));
  expect('`app.js doctor` did not create DATA_DIR either', !fs.existsSync(dataDir), dataDir + ' exists');

  removeTree(scratch);
  return checks;
}

function main() {
  let opts;
  try {
    opts = parseArgs(process.argv.slice(2));
  } catch (error) {
    say(messageOf(error));
    say('usage: node old-node-check.cjs --app <folder holding app.js> [--port <n>] [--timeout-ms <n>]');
    return Promise.resolve(2);
  }
  return run(opts).then(
    function (checks) {
      const ok = checks.every(function (c) {
        return c.ok;
      });
      process.stdout.write(JSON.stringify({ node: process.version, ok: ok, checks: checks }) + '\n');
      return ok ? 0 : 1;
    },
    function (error) {
      say(messageOf(error));
      return messageOf(error).indexOf('USAGE') === 0 ? 2 : 1;
    }
  );
}

main().then(function (code) {
  // stdout and stderr are flushed before the process ends (a pipe may still be draining).
  process.stdout.write('', function () {
    process.stderr.write('', function () {
      process.exit(code);
    });
  });
});
