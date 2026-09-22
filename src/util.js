'use strict';

const crypto = require('crypto');

function log(...args) {
  console.log(new Date().toISOString(), ...args);
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

module.exports = { log, secureCompare, pipeBidirectional };
