import * as net from 'net';
import WebSocket, { createWebSocketStream } from 'ws';
import { log, pipeBidirectional, describeError } from './util';
import type { Tunnel } from './types';

const RECONNECT_DELAYS_MS = [1000, 2000, 5000, 10000, 15000];

export interface StartClientOptions {
  /** e.g. "ws://localhost:7000" */
  serverUrl: string;
  token?: string | null;
  tunnels: Tunnel[];
}

export interface ClientHandle {
  stop(): void;
}

export function startClient(opts: StartClientOptions): ClientHandle {
  const { serverUrl, token = null, tunnels } = opts;
  const portByDomain = new Map(tunnels.map((t) => [t.domain, t.port]));

  let attempt = 0;
  let stopped = false;
  let currentWs: WebSocket | null = null;

  function connect(): void {
    if (stopped) return;
    const ws = new WebSocket(`${serverUrl}/_tunnelme/control`);
    currentWs = ws;

    ws.on('open', () => {
      attempt = 0;
      log('connected to tunnel server, registering...');
      ws.send(
        JSON.stringify({
          type: 'register',
          token,
          tunnels: tunnels.map((t) => ({ domain: t.domain, port: t.port })),
        })
      );
    });

    ws.on('message', (raw: Buffer) => {
      let msg: { type?: string; domains?: unknown; message?: string; id?: string; domain?: string };
      try {
        msg = JSON.parse(raw.toString());
      } catch {
        return;
      }

      if (msg.type === 'registered') {
        if (!Array.isArray(msg.domains)) return;
        for (const domain of msg.domains) {
          const port = portByDomain.get(domain);
          log(`tunnel active: https://${domain} -> localhost:${port}`);
        }
      } else if (msg.type === 'error') {
        log('server error:', msg.message);
      } else if (msg.type === 'conn' && msg.id && msg.domain) {
        handleConnRequest(msg.id, msg.domain);
      }
    });

    ws.on('close', () => {
      if (stopped) return;
      log('disconnected from tunnel server, reconnecting...');
      scheduleReconnect();
    });

    ws.on('error', (err: Error) => {
      log('control connection error:', describeError(err));
    });
  }

  function scheduleReconnect(): void {
    if (stopped) return;
    const delay = RECONNECT_DELAYS_MS[Math.min(attempt, RECONNECT_DELAYS_MS.length - 1)];
    attempt += 1;
    setTimeout(connect, delay);
  }

  function handleConnRequest(id: string, domain: string): void {
    const port = portByDomain.get(domain);
    if (!port) return;

    const dataWs = new WebSocket(`${serverUrl}/_tunnelme/data?id=${encodeURIComponent(id)}`);

    dataWs.on('open', () => {
      const dataStream = createWebSocketStream(dataWs, { decodeStrings: false });
      const localSocket = net.connect(port, 'localhost');
      pipeBidirectional(localSocket, dataStream);
    });

    dataWs.on('error', (err: Error) => {
      log(`data connection error for ${domain}:`, describeError(err));
    });
  }

  connect();

  return {
    stop() {
      stopped = true;
      if (currentWs) currentWs.close();
    },
  };
}
