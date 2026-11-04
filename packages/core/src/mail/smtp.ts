import type { DB } from '@altis/db';
import { DomainError } from '@altis/shared';
import type { Kysely, Transaction } from 'kysely';
import type { MailMessage, SentMessageInfo, Transport } from 'nodemailer';
import type { KeyringEntry } from '../crypto/secret-box.js';
import { readSecret, readSettings } from '../settings/service.js';
import { oneLine } from './templates.js';

// Sending mail over the library's own SMTP server (spec §7.1 password reset, §9.10; decision D17), through
// nodemailer (MIT-0, no dependencies of its own). The configuration lives in `settings` (scope `data`, the password
// sealed with the keyring), so it is read at every send: a change an admin saved applies to the next mail in every
// process, and nothing about the connection is kept between mails (P6). Plain text only; no pooling, no queue (D18).
//
// A failure is a DomainError `SMTP_FAILED` whose `meta.reason` says at which stage it went wrong (connect, tls, auth,
// send; the problem sends it as the registered `reason` extension, D10) and whose `detail` is a fixed bilingual
// sentence for that stage. What the server said, and what the connection looked like, stay in the error's `cause` for
// the log; neither the response text nor the password is ever in `message`, `detail` or `meta`.
//
// The session is run by a transport of this module over nodemailer's SMTPConnection (its documented low-level client),
// the same steps as nodemailer's own SMTP transport, so that it stays in hand: a caller with a request budget gives the
// whole session a deadline, and when that runs out the connection is closed (the mail is not sent after the failure
// was reported) and the send fails at the stage it had reached.

type Handle = Kysely<DB> | Transaction<DB>;

export type SmtpSecurity = 'none' | 'starttls' | 'tls';

export interface SmtpConfig {
  host: string;
  port: number;
  /** `none`: plain text, STARTTLS ignored; `starttls`: upgrade is mandatory; `tls`: TLS from the first byte (SMTPS). */
  security: SmtpSecurity;
  username: string | null;
  password: string | null;
  /** The sender's address (`smtp.from`). */
  from: string;
  /** The sender's display name: `email.sender_name`, else `library.name`. */
  senderName: string;
}

export interface Mailer {
  /**
   * Sends one plain-text mail to one address.
   *
   * @throws DomainError `SMTP_NOT_CONFIGURED` (no SMTP host or sender address saved), `SMTP_FAILED` (`meta.reason`:
   *   `connect | tls | auth | send`)
   * @throws TypeError when `to` is not one plain address (the caller validates addresses; this stops a header injection)
   */
  send(m: { to: string; subject: string; text: string }): Promise<void>;
}

/** The time each phase of an SMTP session may take (connecting, the greeting, an idle socket), in ms. */
export const DEFAULT_SMTP_TIMEOUT_MS = 20_000;

/** The `o.timeoutMs` / `o.deadlineMs` of {@link createSmtpMailer}. */
export interface SmtpMailerOptions {
  /** The longest each phase of a session may take (connecting, the greeting, a quiet socket); default 20 s. */
  timeoutMs?: number;
  /**
   * The longest a whole session may take, from connecting to the server's last reply, however quickly each step is
   * answered (a server that holds every reply back just inside `timeoutMs`); default none.
   */
  deadlineMs?: number;
}

/**
 * The configuration an admin saved, or null when the SMTP host or the sender address is not set (a mail cannot be
 * sent, `SMTP_NOT_CONFIGURED`). The port defaults to 587 and the security to `starttls`; a sender name that is not set
 * (or blank) is the library's name.
 *
 * `keyring` opens the password, which is read only when a username is set: without one there is no login
 * (smtpTransportOptions sends no `auth`), so a stored password is neither needed nor a reason to fail.
 *
 * @throws DomainError `SECRET_UNREADABLE` when a username is set and the stored password does not open with `keyring`
 *   (a database restored without its keys: the admin saves the password again)
 */
export async function loadSmtpConfig(db: Handle, keyring: readonly KeyringEntry[]): Promise<SmtpConfig | null> {
  const s = await readSettings(
    db,
    ['smtp.host', 'smtp.port', 'smtp.security', 'smtp.username', 'smtp.from', 'email.sender_name', 'library.name'],
    keyring,
  );
  const host = s['smtp.host'] as string | null;
  const from = s['smtp.from'] as string | null;
  if (host === null || host === '' || from === null || from === '') return null;
  const named = s['email.sender_name'] as string | null;
  const username = s['smtp.username'] as string | null;
  return {
    host,
    port: s['smtp.port'] as number,
    security: s['smtp.security'] as SmtpSecurity,
    username,
    password: username === null ? null : await readSecret(db, 'smtp.password', keyring),
    from,
    senderName: named !== null && named.trim() !== '' ? named : (s['library.name'] as string),
  };
}

/** What nodemailer is given (a subset of its SMTPTransportOptions). Certificates are verified: nothing here relaxes TLS. */
export interface SmtpTransportOptions {
  host: string;
  port: number;
  secure: boolean;
  requireTLS: boolean;
  ignoreTLS: boolean;
  auth: { user: string; pass: string } | undefined;
  connectionTimeout: number;
  greetingTimeout: number;
  socketTimeout: number;
}

/**
 * The nodemailer transport options of `config`: `none` ignores STARTTLS (`ignoreTLS`), `starttls` requires it
 * (`requireTLS`: the mail is not sent in clear when the server cannot upgrade), `tls` is `secure`. Every timeout is
 * `timeoutMs`. There is no `tls` option: the certificate chain and the host name are checked against the system's
 * trusted roots, as Node does by default.
 */
export function smtpTransportOptions(config: SmtpConfig, timeoutMs: number): SmtpTransportOptions {
  return {
    host: config.host,
    port: config.port,
    secure: config.security === 'tls',
    requireTLS: config.security === 'starttls',
    ignoreTLS: config.security === 'none',
    auth: config.username === null ? undefined : { user: config.username, pass: config.password ?? '' },
    connectionTimeout: timeoutMs,
    greetingTimeout: timeoutMs,
    socketTimeout: timeoutMs,
  };
}

type Reason = 'connect' | 'tls' | 'auth' | 'send';

/** A session's deadline ran out at `stage`: the connection was closed there. */
class SessionDeadline extends Error {
  readonly code = 'ETIMEDOUT';
  constructor(
    readonly stage: Reason,
    deadlineMs: number,
  ) {
    super(`The SMTP session did not end within ${deadlineMs} ms (stage ${stage})`);
    this.name = 'SessionDeadline';
  }
}

/** Fixed, Indonesian first (the library's staff read it), then English; never the server's own words. */
const DETAIL: Readonly<Record<Reason, string>> = Object.freeze({
  connect: 'Tidak dapat tersambung ke server SMTP / Could not connect to the SMTP server',
  tls: 'Koneksi aman (TLS) ke server SMTP gagal / The secure (TLS) connection to the SMTP server failed',
  auth: 'Server SMTP menolak nama pengguna atau kata sandi / The SMTP server rejected the username or password',
  send: 'Server SMTP tidak menerima pesan / The SMTP server did not accept the message',
});

/** The error properties nodemailer sets (its `code` names the step that failed, see nodemailer's errors.d.ts). */
interface NodemailerErrorLike {
  code?: unknown;
  originalCode?: unknown;
  timeoutType?: unknown;
  command?: unknown;
  responseCode?: unknown;
}

/** OpenSSL and Node TLS error codes: a certificate that is untrusted, expired or for another host, or a protocol failure. */
const TLS_ERROR_CODE = /^(?:CERT_|UNABLE_TO_|DEPTH_ZERO_SELF_SIGNED_CERT$|SELF_SIGNED_CERT_IN_CHAIN$|HOSTNAME_MISMATCH$|ERR_TLS_|ERR_SSL_|EPROTO$)/;

/** The stage a nodemailer error (or a session's deadline) belongs to. */
function reasonOf(error: unknown): Reason {
  if (error instanceof SessionDeadline) return error.stage;
  const e = (typeof error === 'object' && error !== null ? error : {}) as NodemailerErrorLike;
  const code = typeof e.code === 'string' ? e.code : '';
  const original = typeof e.originalCode === 'string' ? e.originalCode : '';
  switch (code) {
    case 'EAUTH':
    case 'ENOAUTH':
    case 'EOAUTH2':
      return 'auth';
    case 'ETLS':
    case 'EREQUIRETLS':
      return 'tls';
    case 'ETIMEDOUT':
      // The server did not answer in time: connecting, the greeting (a silent server hits the socket timeout, which the
      // same `timeoutMs` makes fire together with it) or a quiet socket. Only a stalled TLS upgrade is a TLS failure.
      return e.timeoutType === 'UPGRADE_TIMEOUT' ? 'tls' : 'connect';
    case 'ECONNECTION':
    case 'ESOCKET':
    case 'EDNS':
    case 'EPROXY':
      return TLS_ERROR_CODE.test(original) ? 'tls' : 'connect';
    case 'EPROTOCOL':
      // Not an SMTP greeting or EHLO answer: the port is not an SMTP server. Later, the server broke the dialogue.
      return e.command === 'CONN' || e.command === 'EHLO' || e.command === 'HELO' || e.command === 'LHLO' ? 'connect' : 'send';
    default:
      // EENVELOPE, EMESSAGE, ESTREAM, ...: the server (or the message) refused what was sent.
      return TLS_ERROR_CODE.test(code) ? 'tls' : 'send';
  }
}

/** The DomainError for a failed send: the stage and a fixed detail; the nodemailer error rides along as `cause`. */
function smtpFailure(error: unknown): DomainError {
  const reason = reasonOf(error);
  const e = (typeof error === 'object' && error !== null ? error : {}) as NodemailerErrorLike;
  const meta: Record<string, unknown> = { reason };
  if (typeof e.code === 'string') meta['smtpCode'] = e.code;
  if (typeof e.responseCode === 'number') meta['responseCode'] = e.responseCode;
  return new DomainError('SMTP_FAILED', { detail: DETAIL[reason], meta, cause: error });
}

/** One plain address: no white space (so no line break), no list or display-name syntax. */
const PLAIN_ADDRESS = /^[^\s,;<>"]+@[^\s,;<>"@]+$/;

type SmtpConnectionClass = (typeof import('nodemailer/lib/smtp-connection'))['default'];

interface Nodemailer {
  createTransport: (typeof import('nodemailer'))['createTransport'];
  SMTPConnection: SmtpConnectionClass;
}

// nodemailer is loaded at the first mail, not at start-up: it is a few dozen files that most requests never need, and
// the cold start of a shared-hosting process is a budget.
let nodemailer: Promise<Nodemailer> | undefined;

function loadNodemailer(): Promise<Nodemailer> {
  nodemailer ??= Promise.all([import('nodemailer'), import('nodemailer/lib/smtp-connection')])
    .then(([main, connection]) => ({ createTransport: main.createTransport, SMTPConnection: connection.default }))
    .catch((error: unknown) => {
      nodemailer = undefined; // a failed load is tried again at the next mail
      throw error;
    });
  return nodemailer;
}

/**
 * A nodemailer transport (its `Transport` plugin interface: nodemailer still composes the message) that runs one SMTP
 * session the way nodemailer's SMTP transport does: connect (with STARTTLS as `options` say), log in when a username is
 * set and the server offers AUTH, send, close. It knows the stage the session is at, so that when `deadlineMs` runs out
 * it closes the connection and fails with a {@link SessionDeadline} of that stage. A STARTTLS upgrade under way is the
 * `tls` stage; the rest of setting the session up is `connect`.
 */
function sessionTransport(
  SMTPConnection: SmtpConnectionClass,
  options: SmtpTransportOptions,
  deadlineMs: number | undefined,
): Transport<SentMessageInfo> {
  const { auth, ...connectionOptions } = options;
  return {
    name: 'SMTP',
    version: 'altis',
    send(mail: MailMessage<SentMessageInfo>, callback): void {
      const connection = new SMTPConnection(connectionOptions);
      let stage: Reason = 'connect';
      let returned = false;
      let deadline: ReturnType<typeof setTimeout> | undefined;
      const finish = (error: Error | null, info?: SentMessageInfo): void => {
        if (returned) return;
        returned = true;
        clearTimeout(deadline);
        connection.close();
        callback(error, info);
      };
      if (deadlineMs !== undefined) {
        deadline = setTimeout(() => {
          finish(new SessionDeadline(stage === 'connect' && connection.upgrading === true ? 'tls' : stage, deadlineMs));
        }, deadlineMs);
      }
      connection.once('error', (error: Error) => finish(error));

      const deliver = (): void => {
        stage = 'send';
        const message = mail.message;
        const envelope = message.getEnvelope();
        connection.send(envelope as Parameters<typeof connection.send>[0], message.createReadStream(), (error, info) => {
          if (error) return finish(error);
          finish(null, { ...info, envelope: { from: envelope.from, to: envelope.to }, messageId: message.messageId() });
        });
      };
      connection.connect((error) => {
        if (returned) return;
        if (error) return finish(error);
        // As nodemailer's transport: a server that offers no AUTH gets the mail without a login.
        if (auth === undefined || !connection.allowsAuth) return deliver();
        stage = 'auth';
        connection.login({ type: 'LOGIN', user: auth.user, credentials: { user: auth.user, pass: auth.pass }, method: false }, (failed) => {
          if (returned) return;
          if (failed) return finish(failed);
          deliver();
        });
      });
    },
  };
}

/**
 * A mailer over SMTP. `load` gives the configuration at every send (see {@link loadSmtpConfig}); null means the
 * library has not set SMTP up. `o.timeoutMs` (default {@link DEFAULT_SMTP_TIMEOUT_MS}) is the longest each phase of the
 * session may take: connecting, the greeting, then silence on the socket. A whole send can therefore take a few times
 * that, or longer against a server that holds every reply back just inside it; a caller with a request budget passes
 * `o.deadlineMs` too, the longest the whole session may take. When that runs out, the connection is closed and the send
 * fails as SMTP_FAILED with the stage it had reached.
 *
 * @throws TypeError when `o.timeoutMs` or `o.deadlineMs` is not a positive integer
 */
export function createSmtpMailer(load: () => Promise<SmtpConfig | null>, o: SmtpMailerOptions = {}): Mailer {
  const timeoutMs = o.timeoutMs ?? DEFAULT_SMTP_TIMEOUT_MS;
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs <= 0) throw new TypeError('createSmtpMailer: timeoutMs must be a positive integer');
  const { deadlineMs } = o;
  if (deadlineMs !== undefined && (!Number.isSafeInteger(deadlineMs) || deadlineMs <= 0)) {
    throw new TypeError('createSmtpMailer: deadlineMs must be a positive integer');
  }

  return {
    async send(m): Promise<void> {
      if (!PLAIN_ADDRESS.test(m.to)) throw new TypeError('Mailer.send: `to` must be one plain address');
      const config = await load();
      if (config === null) {
        throw new DomainError('SMTP_NOT_CONFIGURED', {
          detail: 'Pengaturan SMTP belum lengkap / The SMTP settings are not complete',
        });
      }
      const { createTransport, SMTPConnection } = await loadNodemailer();
      const transport = createTransport(sessionTransport(SMTPConnection, smtpTransportOptions(config, timeoutMs), deadlineMs));
      try {
        await transport.sendMail({
          from: { name: oneLine(config.senderName), address: config.from },
          to: m.to,
          subject: oneLine(m.subject),
          text: m.text,
        });
      } catch (error) {
        throw smtpFailure(error);
      }
    },
  };
}
