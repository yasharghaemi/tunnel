import * as crypto from 'crypto';
import type { Duplex } from 'stream';
import type { Socket } from 'net';

export function log(...args: unknown[]): void {
  console.log(new Date().toISOString(), ...args);
}

/** Formats an Error for logging, unwrapping AggregateError (whose own .message is often empty). */
export function describeError(err: unknown): string {
  if (!err) return String(err);
  const e = err as { errors?: unknown[]; message?: string; code?: string };
  if (Array.isArray(e.errors) && e.errors.length > 0) {
    return e.errors.map((sub) => (sub as { message?: string }).message || String(sub)).join('; ');
  }
  return e.message || e.code || String(err);
}

/** Constant-time string comparison, safe for comparing against a network-supplied secret. */
export function secureCompare(a: string, b: string): boolean {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Bidirectionally pipes two duplex streams and destroys both if either errors or closes. */
export function pipeBidirectional(a: Duplex, b: Duplex): void {
  a.pipe(b);
  b.pipe(a);

  let cleaned = false;
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    a.destroy();
    b.destroy();
  };

  a.on('error', cleanup);
  b.on('error', cleanup);
  a.on('close', cleanup);
  b.on('close', cleanup);
}

const REQUEST_LINE_RE = /^([A-Z]+) (\S+) HTTP\/\d\.\d$/;
const MAX_LEFTOVER_BYTES = 8192;

/**
 * Passively taps a socket carrying raw HTTP bytes and logs each request line
 * it spots (method + path), without consuming or altering the stream --
 * safe to use alongside a .pipe() of the same socket. Best-effort: after a
 * protocol upgrade (e.g. WebSocket) traffic is no longer HTTP and simply
 * won't match, so logging naturally goes quiet for that connection.
 */
export function logRequestLines(socket: Socket, label: string): void {
  let leftover = '';
  socket.on('data', (chunk: Buffer) => {
    leftover += chunk.toString('latin1');
    let idx: number;
    while ((idx = leftover.indexOf('\r\n')) !== -1) {
      const line = leftover.slice(0, idx);
      leftover = leftover.slice(idx + 2);
      const match = REQUEST_LINE_RE.exec(line);
      if (match) log(`${label} ${match[1]} ${match[2]}`);
    }
    if (leftover.length > MAX_LEFTOVER_BYTES) {
      leftover = leftover.slice(-1024);
    }
  });
}
