import * as os from 'os';
import * as https from 'https';
import { log } from './util';

const IP_ECHO_SERVICES = ['https://api.ipify.org', 'https://ifconfig.me/ip', 'https://icanhazip.com'];

// Minimal local shape of what we use from @achingbrain/nat-port-mapper --
// declared locally (instead of imported) to avoid Node16 module resolution's
// resolution-mode requirements for type-only imports of an ESM-only package.
interface PortMapping {
  externalHost: string;
  externalPort: number;
}
interface Gateway {
  externalIp(): Promise<string>;
  map(internalPort: number, internalHost: string, options?: Record<string, unknown>): Promise<PortMapping>;
  stop(): Promise<void>;
}
interface UpnpNatClient {
  findGateways(options?: { signal?: AbortSignal }): AsyncGenerator<Gateway, void, unknown>;
}
type UpnpNatFn = (options?: Record<string, unknown>) => UpnpNatClient;

// @achingbrain/nat-port-mapper is ESM-only; this project is CommonJS, so it
// must be loaded via dynamic import() rather than require() -- and the
// dynamic import() must reach the compiled output unchanged (see tsconfig's
// "module": "Node16", which -- unlike "CommonJS" -- doesn't downlevel it into
// a plain require() call, which would defeat the whole point).
function loadUpnpNat(): Promise<UpnpNatFn> {
  return import('@achingbrain/nat-port-mapper').then((mod) => mod.upnpNat as UpnpNatFn);
}

function fetchText(url: string, timeoutMs = 5000): Promise<string> {
  return new Promise((resolve, reject) => {
    const req = https.get(url, { timeout: timeoutMs }, (res) => {
      if (res.statusCode !== 200) {
        res.resume();
        reject(new Error(`${url} returned HTTP ${res.statusCode}`));
        return;
      }
      let body = '';
      res.on('data', (c) => (body += c));
      res.on('end', () => resolve(body.trim()));
    });
    req.on('timeout', () => req.destroy(new Error(`${url} timed out`)));
    req.on('error', reject);
  });
}

/** Picks this machine's primary LAN IPv4 address (non-internal). */
function localIp(): string {
  const ifaces = os.networkInterfaces();
  for (const name of Object.keys(ifaces)) {
    for (const iface of ifaces[name] || []) {
      if (iface.family === 'IPv4' && !iface.internal) return iface.address;
    }
  }
  throw new Error('Could not determine a local LAN IPv4 address');
}

/**
 * Best-effort public IP detection: tries asking the router directly via
 * UPnP/NAT-PMP first (no third party involved), falls back to a plain HTTP
 * echo service if the router doesn't support/allow that.
 */
export async function detectPublicIp(): Promise<string> {
  try {
    const upnpNat = await loadUpnpNat();
    const client = upnpNat();
    for await (const gateway of client.findGateways({ signal: AbortSignal.timeout(4000) })) {
      try {
        const ip = await gateway.externalIp();
        await gateway.stop();
        if (ip) return ip;
      } catch {
        await gateway.stop().catch(() => {});
      }
      break;
    }
  } catch {
    // no UPnP/NAT-PMP gateway reachable -- fall through to HTTP echo
  }

  for (const url of IP_ECHO_SERVICES) {
    try {
      const ip = await fetchText(url);
      if (/^\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3}$/.test(ip)) return ip;
    } catch {
      // try next service
    }
  }

  throw new Error('Could not determine public IP (tried UPnP/NAT-PMP and HTTP echo services)');
}

/** Builds a working public hostname for `port` using sslip.io's wildcard DNS -- no domain ownership needed, no traffic relay. */
export function quickDomain(port: number, ip: string): string {
  return `p${port}.${ip.split('.').join('-')}.sslip.io`;
}

/**
 * Best-effort automatic port forwarding via UPnP/NAT-PMP for the given TCP
 * ports. Returns a stop() function that removes the mappings, or null if no
 * compatible router was found. Mappings auto-renew for as long as the
 * process runs (handled by the underlying library).
 */
export async function autoPortForward(ports: number[]): Promise<(() => Promise<void>) | null> {
  const host = localIp();
  const upnpNat = await loadUpnpNat();
  const client = upnpNat({ description: 'tunnelme' });

  let gateway: Gateway | null = null;
  try {
    for await (const gw of client.findGateways({ signal: AbortSignal.timeout(4000) })) {
      gateway = gw;
      break;
    }
  } catch (err) {
    log(`UPnP: gateway discovery failed: ${(err as Error).message}`);
  }

  if (!gateway) {
    log('UPnP: no compatible router found (UPnP/NAT-PMP may be disabled) -- set up port forwarding manually');
    return null;
  }

  for (const port of ports) {
    try {
      const mapping = await gateway.map(port, host, { externalPort: port, protocol: 'tcp' });
      log(`UPnP: mapped external port ${mapping.externalPort} -> ${host}:${port}`);
    } catch (err) {
      log(`UPnP: failed to map port ${port}: ${(err as Error).message}`);
    }
  }

  const foundGateway = gateway;
  return async () => {
    await foundGateway.stop().catch(() => {});
  };
}
