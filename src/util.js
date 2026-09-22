'use strict';

const crypto = require('crypto');

function log(...args) {
  console.log(new Date().toISOString(), ...args);
}

/** Formats an Error for logging, unwrapping AggregateError (whose own .message is often empty). */
function describeError(err) {
  if (!err) return String(err);
  if (Array.isArray(err.errors) && err.errors.length > 0) {
    return err.errors.map((e) => e.message || String(e)).join('; ');
  }
  return err.message || err.code || String(err);
}

/** Constant-time string comparison, safe for comparing against a network-supplied secret. */
function secureCompare(a, b) {
  const ha = crypto.createHash('sha256').update(String(a)).digest();
  const hb = crypto.createHash('sha256').update(String(b)).digest();
  return crypto.timingSafeEqual(ha, hb);
}

/** Bidirectionally pipes two duplex streams and destroys both if either errors or closes. */
function pipeBidirectional(a, b) {
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
function logRequestLines(socket, label) {
  let leftover = '';
  socket.on('data', (chunk) => {
    leftover += chunk.toString('latin1');
    let idx;
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

module.exports = { log, secureCompare, pipeBidirectional, describeError, logRequestLines };
