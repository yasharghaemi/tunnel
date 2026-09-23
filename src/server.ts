import * as http from 'http';
import * as tls from 'tls';
import * as crypto from 'crypto';
import type { Duplex } from 'stream';
import type { Socket } from 'net';
import { WebSocketServer, WebSocket, createWebSocketStream } from 'ws';
import { CertStore, type TlsMode } from './certStore';
import { log, secureCompare, pipeBidirectional, logRequestLines } from './util';

const CONN_WAIT_TIMEOUT_MS = 15000;
const LIVE_CHECK_PATH = '/host/live';
const LIVE_CHECK_LINE_RE = /^(GET|HEAD) \/host\/live(\?\S*)? HTTP\/\d\.\d\r?$/;

function liveCheckBody(domain: string): string {
  return JSON.stringify({ live: true, domain, checkedAt: new Date().toISOString() });
}

export interface StartServerOptions {
  httpPort?: number;
  httpsPort?: number;
  controlPort?: number;
  certsDir: string;
  /** 'acme' | 'self-signed' */
  tlsMode?: TlsMode;
  acmeEmail?: string;
  staging?: boolean;
  token?: string | null;
}

export interface ServerHandle {
  controlHttp: http.Server;
  httpServer: http.Server;
  httpsServer: tls.Server;
}

interface PendingConn {
  resolve: (stream: Duplex) => void;
  reject: (err: Error) => void;
  timer: NodeJS.Timeout;
}

export function startServer(opts: StartServerOptions): ServerHandle {
  const {
    httpPort = 80,
    httpsPort = 443,
    controlPort = 7000,
    certsDir,
    tlsMode = 'acme',
    acmeEmail,
    staging = false,
    token = null,
  } = opts;

  const certStore = new CertStore({ certsDir, mode: tlsMode, acmeEmail, staging });

  const domainClients = new Map<string, WebSocket>();
  const pendingConns = new Map<string, PendingConn>();

  // ---- Control + data WebSocket server (LAN/localhost only, not internet-exposed) ----
  const controlHttp = http.createServer((_req, res) => {
    res.writeHead(200, { 'content-type': 'text/plain' });
    res.end('tunnelme control channel\n');
  });
  const wss = new WebSocketServer({ noServer: true });

  controlHttp.on('upgrade', (req, socket, head) => {
    const url = new URL(req.url || '', 'http://internal');
    if (url.pathname === '/_tunnelme/control') {
      wss.handleUpgrade(req, socket, head, (ws) => handleControlConnection(ws));
    } else if (url.pathname === '/_tunnelme/data') {
      const id = url.searchParams.get('id') || '';
      wss.handleUpgrade(req, socket, head, (ws) => handleDataConnection(ws, id));
    } else {
      socket.destroy();
    }
  });

  function handleControlConnection(ws: WebSocket): void {
    const ownedDomains = new Set<string>();

    ws.on('message', (raw: Buffer) => {
      let msg: { type?: string; token?: string; tunnels?: Array<{ domain?: string; port?: number }> };
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
        const registered: string[] = [];
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

  function handleDataConnection(ws: WebSocket, id: string): void {
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
  function requestProxyConnection(domain: string): Promise<Duplex> {
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
    const url = new URL(req.url || '', `http://${req.headers.host || 'localhost'}`);
    if (url.pathname.startsWith('/.well-known/acme-challenge/')) {
      const challengeToken = url.pathname.split('/').pop() || '';
      const keyAuth = certStore.getChallengeResponse(challengeToken);
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

  function proxyRawConnection(socket: Socket, domain: string): void {
    const remote = `${socket.remoteAddress}:${socket.remotePort}`;
    log(`connection from ${remote} for ${domain}`);
    socket.on('close', () => log(`connection closed from ${remote} for ${domain}`));

    // Peek at the first chunk to catch the /host/live health check, which the
    // server answers directly (proves the tunnel is reachable without needing
    // the local app to be up). Anything else is pushed back with unshift()
    // and proxied exactly as before. pause()+unshift() happen synchronously
    // within this handler so no bytes are lost between the peek and the retry.
    socket.once('data', (chunk: Buffer) => {
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

  async function forwardToClient(socket: Socket, domain: string, remote: string): Promise<void> {
    try {
      // Wait for the client's data connection before attaching any 'data'
      // consumer -- attaching one earlier would switch the socket into
      // flowing mode and could drop bytes that arrive before pipe() is wired up.
      const dataStream = await requestProxyConnection(domain);
      logRequestLines(socket, `${remote} -> ${domain}`);
      pipeBidirectional(socket, dataStream);
    } catch (err) {
      log(`proxy failed for ${domain}:`, (err as Error).message);
      socket.destroy();
    }
  }

  function onListenError(label: string, port: number) {
    return (err: NodeJS.ErrnoException) => {
      if (err.code === 'EACCES') {
        log(
          `Failed to listen on :${port} (${label}): permission denied. ` +
            (process.platform === 'win32'
              ? 'Binding to ports below 1024 requires an Administrator terminal -- re-run as Administrator.'
              : 'Binding to ports below 1024 requires root -- re-run with sudo, or use a port above 1024.')
        );
      } else if (err.code === 'EADDRINUSE') {
        log(`Failed to listen on :${port} (${label}): another process is already using this port.`);
      } else {
        log(`Failed to listen on :${port} (${label}):`, err.message);
      }
      process.exit(1);
    };
  }

  controlHttp.on('error', onListenError('control channel', controlPort));
  httpServer.on('error', onListenError('http', httpPort));
  httpsServer.on('error', onListenError('https', httpsPort));

  controlHttp.listen(controlPort, () => log(`control channel listening on ws://0.0.0.0:${controlPort}`));
  httpServer.listen(httpPort, () => log(`http (acme + redirect) listening on :${httpPort}`));
  httpsServer.listen(httpsPort, () => log(`https tunnel entrypoint listening on :${httpsPort}`));

  return { controlHttp, httpServer, httpsServer };
}
