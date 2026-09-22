#!/usr/bin/env node
'use strict';

const path = require('path');
const os = require('os');
const { Command } = require('commander');
const { loadConfig } = require('../src/config');
const { startClient } = require('../src/client');
const { startServer } = require('../src/server');

const program = new Command();

program
  .name('tunnelme')
  .description('Reverse-proxy a public domain to a localhost port, for dev/testing.')
  .version(require('../package.json').version);

program
  .command('run', { isDefault: true })
  .description('Start the client: expose a local port under a public domain')
  .option('-p, --port <port>', 'local port to expose', (v) => parseInt(v, 10))
  .option('-u, --url <domain>', 'public domain to route to the local port')
  .option('-c, --config <path>', 'config file with multiple tunnels (.yaml/.json)')
  .option('-s, --server <url>', 'tunnelme server control address')
  .option('-t, --token <token>', 'shared secret expected by the server')
  .action((opts) => {
    const DEFAULT_SERVER = 'ws://localhost:7000';
    let serverUrl;
    let token = opts.token || null;
    let tunnels;

    if (opts.config) {
      const cfg = loadConfig(opts.config);
      serverUrl = opts.server || cfg.server || DEFAULT_SERVER;
      token = opts.token || cfg.token || null;
      tunnels = cfg.tunnels.map((t) => ({ port: t.port, domain: t.url }));
    } else {
      serverUrl = opts.server || DEFAULT_SERVER;
      if (opts.port === undefined || Number.isNaN(opts.port) || !opts.url) {
        console.error('Error: --port and --url are required (or pass --config)');
        process.exit(1);
      }
      tunnels = [{ port: opts.port, domain: opts.url }];
    }

    startClient({ serverUrl, token, tunnels });
  });

program
  .command('serve')
  .description('Start the tunnel server (run this on the internet-facing machine)')
  .option('--http-port <port>', 'plain HTTP port (ACME challenges + redirect)', (v) => parseInt(v, 10), 80)
  .option('--https-port <port>', 'public HTTPS entrypoint', (v) => parseInt(v, 10), 443)
  .option('--control-port <port>', 'control channel port for clients to connect to', (v) => parseInt(v, 10), 7000)
  .option('--certs-dir <path>', 'where to store certificates', path.join(os.homedir(), '.tunnelme', 'certs'))
  .option('--tls <mode>', 'acme (Let\'s Encrypt) or self-signed', 'acme')
  .option('--email <email>', 'contact email for Let\'s Encrypt')
  .option('--staging', 'use Let\'s Encrypt staging directory (for testing)', false)
  .option('-t, --token <token>', 'require clients to present this shared secret')
  .option('-p, --port <port>', 'also run a local tunnel: local port to expose', (v) => parseInt(v, 10))
  .option('-u, --url <domain>', 'also run a local tunnel: public domain for --port')
  .option('-c, --config <path>', 'also run local tunnel(s) from a config file (.yaml/.json)')
  .action((opts) => {
    if (opts.tls === 'acme' && !opts.email) {
      console.error('Error: --email is required when --tls=acme (Let\'s Encrypt requires a contact email)');
      process.exit(1);
    }
    if ((opts.port !== undefined) !== Boolean(opts.url)) {
      console.error('Error: --port and --url must be used together');
      process.exit(1);
    }

    const { controlHttp } = startServer({
      httpPort: opts.httpPort,
      httpsPort: opts.httpsPort,
      controlPort: opts.controlPort,
      certsDir: opts.certsDir,
      tlsMode: opts.tls,
      acmeEmail: opts.email,
      staging: opts.staging,
      token: opts.token || null,
    });

    // Optionally also run the client in this same process, against the
    // server's own control port, so `serve` + a tunnel can run from one
    // terminal instead of two. Wait for the control channel to actually be
    // listening first, so the client's first connection attempt doesn't race it.
    if (opts.config || opts.port !== undefined) {
      controlHttp.once('listening', () => {
        if (opts.config) {
          const cfg = loadConfig(opts.config);
          startClient({
            serverUrl: `ws://localhost:${opts.controlPort}`,
            token: opts.token || cfg.token || null,
            tunnels: cfg.tunnels.map((t) => ({ port: t.port, domain: t.url })),
          });
        } else {
          startClient({
            serverUrl: `ws://localhost:${opts.controlPort}`,
            token: opts.token || null,
            tunnels: [{ port: opts.port, domain: opts.url }],
          });
        }
      });
    }
  });

program.parse();
