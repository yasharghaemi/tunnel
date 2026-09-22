'use strict';

const http = require('http');
const tls = require('tls');
const crypto = require('crypto');
const { WebSocketServer, WebSocket, createWebSocketStream } = require('ws');
const { CertStore } = require('./certStore');
const { log, secureCompare, pipeBidirectional, logRequestLines } = require('./util');

const CONN_WAIT_TIMEOUT_MS = 15000;
const LIVE_CHECK_PATH = '/host/live';
const LIVE_CHECK_LINE_RE = /^(GET|HEAD) \/host\/live(\?\S*)? HTTP\/\d\.\d\r?$/;

function liveCheckBody(domain) {
  return JSON.stringify({ live: true, domain, checkedAt: new Date().toISOString() });
}

function startServer(opts) {
  const {
    httpPort = 80,
    httpsPort = 443,
    controlPort = 7000,
    certsDir,
    tlsMode = 'acme', // 'acme' | 'self-signed'
    acmeEmail,
    staging = false,
    token = null,
  } = opts;

  const certStore = new CertStore({ certsDir, mode: tlsMode, acmeEmail, staging });

  /** @type {Map<string, WebSocket>} domain -> control connection */
  const domainClients = new Map();
  /** @type {Map<string, {resolve: Function, reject: Function, timer: NodeJS.Timeout}>} */
  const pendingConns = new Map();

  // ---- Control + data WebSocket server (LAN/localhost only, not internet-exposed) ----
  const controlHttp = http.createServer((req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('tunnelme control channel\n');
  });
  const wss = new WebSocketServer({ noServer: true });

  controlHttp.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url, 'http://internal');
    if (url.pathname === '/_tunnelme/control') {
      wss.handleUpgrade(req, socket, head, (ws) => handleControlConnection(ws));
    } else if (url.pathname === '/_tunnelme/data') {
      const id = url.searchParams.get('id');
      wss.handleUpgrade(req, socket, head, (ws) => handleDataConnection(ws, id));
    } else {
      socket.destroy();
    }
  });

  function handleControlConnection(ws) {
    const ownedDomains = new Set();

    ws.on('message', (raw) => {
      let msg;
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === 'register') {
        if (token && !secureCompare(msg.token || '', token)) {
          ws.send(JSON.stringify({ type: 'error', message: 'invalid token' }));
          ws.close();
          return;
        }
        if (!Array.isArray(msg.tunnels)) {
          ws.send(JSON.stringify({ type: 'error', message: '"tunnels" must be an array' }));
          return;
        }
        const registered = [];
        for (const t of msg.tunnels) {
          if (!t || !t.domain || t.port === undefined || t.port === null) continue;
          domainClients.set(t.domain, ws);
          ownedDomains.add(t.domain);
          registered.push(t.domain);
          log(`registered ${t.domain} -> client's localhost:${t.port}`);
        }
        ws.send(JSON.stringify({ type: 'registered', domains: registered }));
      }
    });

    ws.on('close', () => {
      for (const domain of ownedDomains) {
        if (domainClients.get(domain) === ws) {
          domainClients.delete(domain);
          log(`unregistered ${domain}`);
        }
      }
    });

    ws.on('error', () => {});
  }

  function handleDataConnection(ws, id) {
    const pending = pendingConns.get(id);
    if (!pending) {
      ws.close();
      return;
    }
    pendingConns.delete(id);
    clearTimeout(pending.timer);
    pending.resolve(createWebSocketStream(ws, { decodeStrings: false }));
  }

  /** Ask the owning client to open a data connection for `domain`; resolves to a duplex stream. */
  function requestProxyConnection(domain) {
    const ws = domainClients.get(domain);
    if (!ws || ws.readyState !== WebSocket.OPEN) return Promise.reject(new Error('no client connected for domain'));

    const id = crypto.randomUUID();
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pendingConns.delete(id);
        reject(new Error('timed out waiting for client data connection'));
      }, CONN_WAIT_TIMEOUT_MS);

      pendingConns.set(id, { resolve, reject, timer });
      ws.send(JSON.stringify({ type: 'conn', id, domain }));
    });
  }

  // ---- Plain :80 server: ACME http-01 challenges + redirect to https ----
  const httpServer = http.createServer((req, res) => {
    const remote = `${req.socket.remoteAddress}:${req.socket.remotePort}`;
    log(`${remote} -> ${req.headers.host || '(no host)'} ${req.method} ${req.url}`);
    const url = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/.well-known/acme-challenge/')) {
      const token_ = url.pathname.split('/').pop();
      const keyAuth = certStore.getChallengeResponse(token_);
      if (keyAuth) {
        res.writeHead(200, { 'content-type': 'text/plain' });
        res.end(keyAuth);
        return;
      }
      res.writeHead(404);
      res.end('not found');
      return;
    }
    const host = (req.headers.host || '').split(':')[0];
    if (!domainClients.has(host)) {
      res.writeHead(404);
      res.end('not found');
      return;
    }
    if (url.pathname === LIVE_CHECK_PATH) {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(liveCheckBody(host));
      return;
    }
    const portSuffix = httpsPort === 443 ? '' : `:${httpsPort}`;
    res.writeHead(301, { location: `https://${host}${portSuffix}${req.url}` });
    res.end();
  });

  // ---- TLS :443 server: SNI-routed, only for registered domains. Raw byte
  // forwarding only -- no HTTP parsing here, so HTTP/1.1, keep-alive and
  // WebSocket upgrades all pass through transparently to the client's local app. ----
  const httpsServer = tls.createServer(
    {
      SNICallback: (servername, cb) => {
        if (!domainClients.has(servername)) {
          cb(new Error(`unknown domain: ${servername}`));
          return;
        }
        certStore
          .getSecureContext(servername)
          .then((ctx) => cb(null, ctx))
          .catch((err) => {
            log(`cert error for ${servername}:`, err.message);
            cb(err);
          });
      },
    },
    (tlsSocket) => {
      const domain = tlsSocket.servername;
      if (!domain || !domainClients.has(domain)) {
        tlsSocket.destroy();
        return;
      }
      proxyRawConnection(tlsSocket, domain);
    }
  );

  httpsServer.on('tlsClientError', () => {});

  function proxyRawConnection(socket, domain) {
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    log(`connection from ${remote} for ${domain}`);
    socket.on('close', () => log(`connection closed from ${remote} for ${domain}`));

    // Peek at the first chunk to catch the /host/live health check, which the
    // server answers directly (proves the tunnel is reachable without needing
    // the local app to be up). Anything else is pushed back with unshift()
    // and proxied exactly as before. pause()+unshift() happen synchronously
    // within this handler so no bytes are lost between the peek and the retry.
    socket.once('data', (chunk) => {
      const firstLine = chunk.toString('latin1').split('\r\n', 1)[0];
      if (LIVE_CHECK_LINE_RE.test(firstLine)) {
        log(`${remote} -> ${domain} GET ${LIVE_CHECK_PATH} (answered by tunnelme server)`);
        const body = liveCheckBody(domain);
        socket.end(
          `HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: ${Buffer.byteLength(body)}\r\nconnection: close\r\n\r\n${body}`
        );
        return;
      }
      socket.pause();
      socket.unshift(chunk);
      forwardToClient(socket, domain, remote);
    });
  }

  async function forwardToClient(socket, domain, remote) {
    try {
      // Wait for the client's data connection before attaching any 'data'
      // consumer -- attaching one earlier would switch the socket into
      // flowing mode and could drop bytes that arrive before pipe() is wired up.
      const dataStream = await requestProxyConnection(domain);
      logRequestLines(socket, `${remote} -> ${domain}`);
      pipeBidirectional(socket, dataStream);
    } catch (err) {
      log(`proxy failed for ${domain}:`, err.message);
      socket.destroy();
    }
  }

  controlHttp.listen(controlPort, () => log(`control channel listening on ws://0.0.0.0:${controlPort}`));
  httpServer.listen(httpPort, () => log(`http (acme + redirect) listening on :${httpPort}`));
  httpsServer.listen(httpsPort, () => log(`https tunnel entrypoint listening on :${httpsPort}`));

  return { controlHttp, httpServer, httpsServer };
}

module.exports = { startServer };
