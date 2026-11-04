import net from 'node:net';
import tls from 'node:tls';

// An in-process SMTP server for the mail tests: a small state machine over node:net (and node:tls), so the unit suite
// needs no Docker and no mailpit. It speaks only what nodemailer sends (EHLO, STARTTLS, AUTH PLAIN/LOGIN, MAIL, RCPT,
// DATA, RSET, NOOP, QUIT) and records what it received. Mail goes nowhere: nothing leaves the process.

export interface FakeSmtpMessage {
  /** The MAIL FROM address (the envelope sender). */
  from: string;
  /** The RCPT TO addresses (the envelope recipients). */
  to: string[];
  /** The DATA section as received (dot-unstuffed), headers and body. */
  data: string;
  /** The user that authenticated, or null. */
  user: string | null;
}

export interface FakeSmtpOptions {
  /**
   * `implicit`: the whole connection is TLS (SMTPS); `starttls`: plain until the client asks for STARTTLS, which the
   * server then offers. The certificate is {@link TEST_TLS}'s, which no client trusts.
   */
  tls?: 'implicit' | 'starttls';
  /** Offer AUTH PLAIN and LOGIN and accept only these credentials (anything else gets `535`). Without it no AUTH is offered. */
  auth?: { user: string; pass: string };
  /** The reply to every RCPT TO (default `250 OK`), e.g. `550 5.1.1 mailbox unavailable`. */
  rcptReply?: string;
  /** The reply to AUTH when the credentials are wrong (default `535 5.7.8 authentication failed`). */
  authFailureReply?: string;
  /**
   * A tarpit: how long (ms) the reply to `verb` is held back. `verb` is the command in upper case (`GREETING` for the
   * banner, `AUTH` for every step of a login, `.` for the end of DATA). Default: no reply is held back. The reply to
   * STARTTLS never is (the TLS handshake follows it at once).
   */
  replyDelayMs?: (verb: string) => number;
  /** Answer STARTTLS with `220` and then never start TLS: a handshake that hangs. Needs `tls: 'starttls'`. */
  stallStartTls?: boolean;
}

export interface FakeSmtp {
  port: number;
  /** Messages accepted so far. */
  messages: FakeSmtpMessage[];
  /** Every command line received, upper-cased verb first (credentials are not recorded). */
  commands: string[];
  /** The client connections still open. */
  openConnections(): number;
  close(): Promise<void>;
}

const CRLF = '\r\n';

/** The address of a `MAIL FROM:<a@b>` / `RCPT TO:<a@b>` argument. */
function addressOf(argument: string): string {
  const angle = /<([^>]*)>/.exec(argument);
  return angle === null ? argument.trim() : angle[1]!;
}

/** Starts the fake server on 127.0.0.1 at a free port. */
export async function startFakeSmtp(options: FakeSmtpOptions = {}): Promise<FakeSmtp> {
  const messages: FakeSmtpMessage[] = [];
  const commands: string[] = [];
  const sockets = new Set<net.Socket>();
  /** Replies held back by `replyDelayMs`, cleared at close. */
  const held = new Set<NodeJS.Timeout>();
  const secureContext = options.tls === undefined ? undefined : tls.createSecureContext({ key: TEST_TLS.key, cert: TEST_TLS.cert });

  function serve(initial: net.Socket): void {
    let socket: net.Socket = initial;
    sockets.add(initial);
    initial.on('close', () => sockets.delete(initial));
    // A client that goes away mid-session is not a test failure.
    initial.on('error', () => undefined);

    let buffer = '';
    let secure = options.tls === 'implicit';
    let mode: 'command' | 'data' | 'auth-plain' | 'auth-user' | 'auth-pass' = 'command';
    let authUser: string | null = null;
    let pendingUser = '';
    let from = '';
    let to: string[] = [];
    let data = '';
    /** The command being answered, for `replyDelayMs`. */
    let verb = 'GREETING';

    const reply = (...lines: string[]): void => {
      const text = lines.map((line, i) => `${line.slice(0, 3)}${i < lines.length - 1 ? '-' : ' '}${line.slice(4)}`).join(CRLF) + CRLF;
      const target = socket;
      const delay = verb === 'STARTTLS' ? 0 : (options.replyDelayMs?.(verb) ?? 0);
      if (delay <= 0) {
        target.write(text);
        return;
      }
      const timer = setTimeout(() => {
        held.delete(timer);
        if (!target.destroyed) target.write(text);
      }, delay);
      held.add(timer);
    };
    const reset = (): void => {
      from = '';
      to = [];
      data = '';
    };
    const checkCredentials = (user: string, pass: string): void => {
      if (options.auth !== undefined && user === options.auth.user && pass === options.auth.pass) {
        authUser = user;
        reply('235 2.7.0 authenticated');
      } else {
        reply(options.authFailureReply ?? '535 5.7.8 authentication failed');
      }
      mode = 'command';
    };

    const line = (text: string): void => {
      if (mode === 'data') {
        if (text === '.') {
          verb = '.';
          messages.push({ from, to, data, user: authUser });
          reset();
          mode = 'command';
          reply('250 2.0.0 queued');
        } else {
          data += `${text.startsWith('.') ? text.slice(1) : text}${CRLF}`;
        }
        return;
      }
      if (mode !== 'command') verb = 'AUTH';
      if (mode === 'auth-plain') {
        const [, user = '', pass = ''] = Buffer.from(text, 'base64').toString('utf8').split('\0');
        checkCredentials(user, pass);
        return;
      }
      if (mode === 'auth-user') {
        pendingUser = Buffer.from(text, 'base64').toString('utf8');
        mode = 'auth-pass';
        reply(`334 ${Buffer.from('Password:').toString('base64')}`);
        return;
      }
      if (mode === 'auth-pass') {
        checkCredentials(pendingUser, Buffer.from(text, 'base64').toString('utf8'));
        return;
      }

      const [word = '', ...rest] = text.split(' ');
      const argument = rest.join(' ');
      const upper = word.toUpperCase();
      verb = upper;
      commands.push(upper === 'AUTH' ? `AUTH ${argument.split(' ')[0] ?? ''}`.trim() : upper);
      switch (upper) {
        case 'EHLO':
        case 'HELO': {
          const lines = ['250 smtp.invalid greets you'];
          if (options.tls === 'starttls' && !secure) lines.push('250 STARTTLS');
          if (options.auth !== undefined) lines.push('250 AUTH PLAIN LOGIN');
          lines.push('250 8BITMIME');
          reply(...lines);
          return;
        }
        case 'STARTTLS': {
          if (options.tls !== 'starttls' || secure || secureContext === undefined) {
            reply('502 5.5.1 STARTTLS is not available');
            return;
          }
          reply('220 2.0.0 ready to start TLS');
          if (options.stallStartTls === true) {
            socket.removeAllListeners('data');
            return;
          }
          const upgraded = new tls.TLSSocket(socket, { isServer: true, secureContext });
          upgraded.on('error', () => undefined);
          upgraded.on('data', (chunk) => feed(chunk));
          upgraded.on('close', () => sockets.delete(initial));
          socket.removeAllListeners('data');
          socket = upgraded;
          secure = true;
          buffer = '';
          reset();
          return;
        }
        case 'AUTH': {
          if (options.auth === undefined) {
            reply('503 5.5.1 AUTH is not available');
            return;
          }
          const [mechanism = '', initialResponse] = argument.split(' ');
          if (mechanism.toUpperCase() === 'PLAIN') {
            if (initialResponse === undefined) {
              mode = 'auth-plain';
              reply('334 ');
            } else {
              const [, user = '', pass = ''] = Buffer.from(initialResponse, 'base64').toString('utf8').split('\0');
              checkCredentials(user, pass);
            }
          } else if (mechanism.toUpperCase() === 'LOGIN') {
            mode = 'auth-user';
            reply(`334 ${Buffer.from('Username:').toString('base64')}`);
          } else {
            reply('504 5.5.4 unrecognized authentication type');
          }
          return;
        }
        case 'MAIL':
          from = addressOf(argument);
          reply('250 2.1.0 OK');
          return;
        case 'RCPT': {
          const rcpt = options.rcptReply ?? '250 2.1.5 OK';
          if (rcpt.startsWith('2')) to.push(addressOf(argument));
          reply(rcpt);
          return;
        }
        case 'DATA':
          if (to.length === 0) {
            reply('503 5.5.1 no valid recipients');
            return;
          }
          mode = 'data';
          reply('354 end data with <CR><LF>.<CR><LF>');
          return;
        case 'RSET':
          reset();
          reply('250 2.0.0 OK');
          return;
        case 'NOOP':
          reply('250 2.0.0 OK');
          return;
        case 'QUIT':
          reply('221 2.0.0 bye');
          socket.end();
          return;
        default:
          reply('502 5.5.2 command not recognized');
      }
    };

    function feed(chunk: Buffer): void {
      buffer += chunk.toString('utf8');
      for (;;) {
        const end = buffer.indexOf(CRLF);
        if (end === -1) return;
        const text = buffer.slice(0, end);
        buffer = buffer.slice(end + CRLF.length);
        line(text);
      }
    }

    initial.on('data', (chunk) => feed(chunk));
    reply('220 smtp.invalid ESMTP fake');
  }

  const server = options.tls === 'implicit' ? tls.createServer({ key: TEST_TLS.key, cert: TEST_TLS.cert }, serve) : net.createServer(serve);
  // A client that fails the TLS handshake is the point of some tests; it is not an error of the server.
  server.on('tlsClientError', () => undefined);
  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(0, '127.0.0.1', () => {
      server.off('error', reject);
      resolve();
    });
  });
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('fake SMTP server has no port');

  return {
    port: address.port,
    messages,
    commands,
    openConnections: () => sockets.size,
    close: () =>
      new Promise<void>((resolve) => {
        for (const timer of held) clearTimeout(timer);
        held.clear();
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A TCP server that accepts connections and never says a word (a mail server that hangs before its greeting). */
export async function startSilentServer(): Promise<{ port: number; close(): Promise<void> }> {
  const sockets = new Set<net.Socket>();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    socket.on('close', () => sockets.delete(socket));
    socket.on('error', () => undefined);
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('silent server has no port');
  return {
    port: address.port,
    close: () =>
      new Promise<void>((resolve) => {
        for (const socket of sockets) socket.destroy();
        server.close(() => resolve());
      }),
  };
}

/** A port nobody listens on: bound once, then released. */
export async function closedPort(): Promise<number> {
  const server = net.createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  if (address === null || typeof address === 'string') throw new Error('no port');
  await new Promise<void>((resolve) => server.close(() => resolve()));
  return address.port;
}

/** The value of header `name` of a received message (folded lines joined), or null. */
export function headerOf(data: string, name: string): string | null {
  const head = data.split(`${CRLF}${CRLF}`)[0] ?? '';
  const unfolded = head.replace(/\r\n[ \t]+/g, ' ');
  const wanted = `${name.toLowerCase()}:`;
  for (const text of unfolded.split(CRLF)) {
    if (text.toLowerCase().startsWith(wanted)) return text.slice(wanted.length).trim();
  }
  return null;
}

/** The body of a received message with its transfer encoding undone (7bit and quoted-printable). */
export function bodyOf(data: string): string {
  const at = data.indexOf(`${CRLF}${CRLF}`);
  const body = at === -1 ? '' : data.slice(at + 4);
  if ((headerOf(data, 'Content-Transfer-Encoding') ?? '').toLowerCase() !== 'quoted-printable') return body;
  return body
    .replace(/=\r\n/g, '')
    .replace(/=([0-9A-F]{2})/gi, (_whole, hex: string) => String.fromCharCode(parseInt(hex, 16)));
}

/**
 * A self-signed certificate for CN=smtp.invalid (ECDSA P-256, valid for 100 years from 2026-10-27), made with
 * `openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:prime256v1 -nodes -days 36500`. Test only: it protects
 * nothing, and the tests rely on no client trusting it (they prove that the mailer verifies certificates).
 */
export const TEST_TLS = {
  cert: `-----BEGIN CERTIFICATE-----
MIIBnjCCAUSgAwIBAgIUFpgIFm5COuw4tDJY6m5PfQAvQZEwCgYIKoZIzj0EAwIw
FzEVMBMGA1UEAwwMc210cC5pbnZhbGlkMCAXDTI2MTAyNzE2MDYyMloYDzIxMjYx
MDAzMTYwNjIyWjAXMRUwEwYDVQQDDAxzbXRwLmludmFsaWQwWTATBgcqhkjOPQIB
BggqhkjOPQMBBwNCAARTaHnnoFeJOkLYgN3Tt+7G21sIJQBNkOMiYhMDTcq4MQpL
y67Lkwg5qND2He76qxnIcxX9w1lcVGYnDlG6sMBWo2wwajAdBgNVHQ4EFgQUMUk+
cEsdZKOQ6PlST5Vf5qgrnf0wHwYDVR0jBBgwFoAUMUk+cEsdZKOQ6PlST5Vf5qgr
nf0wDwYDVR0TAQH/BAUwAwEB/zAXBgNVHREEEDAOggxzbXRwLmludmFsaWQwCgYI
KoZIzj0EAwIDSAAwRQIgFP67/NQKsL1mmQ1a32bObwzA8CIBu36BN1fLK0k4UIgC
IQD9hghhZiIDqQYtnQpI/mjInGRlfnXOnem+Ykfyr222CQ==
-----END CERTIFICATE-----
`,
  key: `-----BEGIN PRIVATE KEY-----
MIGHAgEAMBMGByqGSM49AgEGCCqGSM49AwEHBG0wawIBAQQgLZ5rN4AFKMDSttbL
g/IbNRnqIs/yu1heZlbqDm+HPf6hRANCAARTaHnnoFeJOkLYgN3Tt+7G21sIJQBN
kOMiYhMDTcq4MQpLy67Lkwg5qND2He76qxnIcxX9w1lcVGYnDlG6sMBW
-----END PRIVATE KEY-----
`,
} as const;
