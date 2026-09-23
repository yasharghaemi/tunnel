# tunnelme

Reverse-proxies a public domain to a localhost port, for dev/testing — a small
self-hosted alternative to ngrok, built for your own domain + your own box.

## How it works

Two pieces, both in this one CLI:

- **`tunnelme serve`** — runs on the internet-facing machine (in your case: the
  machine your router forwards ports 80/443 to). Terminates TLS using
  automatically-provisioned Let's Encrypt certificates, chosen by SNI per
  domain, and relays raw bytes to whichever client registered that domain.
- **`tunnelme`** (a.k.a. `tunnelme run`) — the client. Connects out to the
  server's control channel, registers a domain, and forwards traffic to
  `localhost:<port>`.

The server never parses HTTP itself — it just forwards decrypted TLS bytes
through to the client, which hands them to your local app. That means it
transparently supports HTTP/1.1 keep-alive, WebSocket upgrades (HMR, etc.),
anything TCP-based — not just plain request/response.

## Install (global, callable from anywhere)

Once published to npm (package name `tunnelmate`, command stays `tunnelme`):

```powershell
npm install -g tunnelmate
```

For local development against this source tree instead (the source is
TypeScript, compiled to `dist/` — the `tunnelme` bin points at the compiled
output, so build once before linking, and after any source change):

```powershell
cd C:\codes\tunnel
npm install
npm run build
npm link
```

Either way, `tunnelme` ends up on your PATH. Test with `tunnelme --version`
from any directory.

## One-time setup on your machine

Since your router already forwards TCP 80 and 443 to this machine, and your
DNS is already pointed at your static IP, you just need to run the server
component here:

```powershell
# Run as Administrator (binding ports 80/443 on Windows requires elevation)
tunnelme serve --tls acme --email you@example.com
```

Defaults: HTTP on :80, HTTPS on :443, control channel on :7000 (localhost
only — do **not** forward 7000 through your router; it's for your dev
machines to reach, not the public internet).

Make sure Windows Firewall allows inbound on 80/443 (and 7000 if your client
runs on a different LAN machine).

Certificates are cached under `~/.tunnelme/certs` and auto-renew (checked
whenever a domain is used, renewed once inside 30 days of expiry).

**First run for a new domain**: Let's Encrypt requires your domain's A record
to already resolve to your static IP, and port 80 to be reachable from the
internet (used for the HTTP-01 challenge) — both of which you already have.
If you want to test the flow without hitting Let's Encrypt's rate limits,
add `--staging` first, then drop it once it's working end-to-end.

## Skipping the manual setup

Everything above (port-forwarding, DNS, firewall, Administrator privileges)
is inherent to being reachable from the internet without relying on someone
else's infrastructure (unlike, say, Cloudflare Tunnel, which avoids all of
that specifically by routing your traffic through Cloudflare's network
instead of yours). A few flags automate what can be automated:

**`--quick`** — don't own a domain, or just want to test something right
now? Skip `--url` entirely:

```powershell
tunnelme serve --tls acme --email you@example.com --port 3000 --quick
```

This detects your public IP and builds a working URL via
[sslip.io](https://sslip.io)'s wildcard DNS (e.g.
`https://p3000.24-78-95-66.sslip.io`) — no domain registration, no DNS
records to configure, and no traffic relay (sslip.io only ever answers a DNS
query; your data goes straight from the visitor to your machine, same as
with a real domain).

**`--upnp`** — attempts to configure port forwarding on your router
automatically via UPnP/NAT-PMP, instead of doing it by hand in the router's
admin page:

```powershell
tunnelme serve --tls acme --email you@example.com --port 3000 --quick --upnp
```

Not all routers support or allow this (many ISP-provided routers disable it
by default) — if none is found, it logs that and falls back to needing
manual port-forwarding, same as before.

**`--setup-firewall`** — adds the Windows Firewall inbound rules for you
(needs an Administrator terminal; safe to run repeatedly):

```powershell
tunnelme serve --tls acme --email you@example.com --port 3000 --quick --setup-firewall
```

Put together, `--quick --upnp --setup-firewall` (run as Administrator) gets
about as close to "one command, zero manual network configuration" as a
fully self-hosted tunnel can get — the one thing that still can't be
automated is your static IP itself, since that's an ISP-level property, not
something software on your machine controls.

## Expose a local dev server

If your app and `serve` run on the **same machine**, skip the second
terminal entirely by passing `--port`/`--url` straight to `serve` — it starts
the server and the tunnel together in one process:

```powershell
tunnelme serve --tls acme --email you@example.com --port 3000 --url app.example.com
```

(`--config <path>` works here too, for multiple tunnels — see below.)

If your app runs on a **different machine**, run `serve` there once, then run
the client separately wherever the app lives:

```powershell
tunnelme --port 3000 --url app.example.com --server ws://192.168.1.50:7000
```

(`--server` points at whichever machine is running `serve`; use `localhost`
if they're the same box, or its LAN IP otherwise.)

Visit `https://app.example.com` — it now proxies to `localhost:3000`.

## Multiple routes via config file

`tunnels.yaml`:

```yaml
server: ws://localhost:7000
token: some-shared-secret   # optional, must match `serve --token`
tunnels:
  - port: 3000
    url: app.example.com
  - port: 8080
    url: api.example.com
  - port: 5173
    url: admin.example.com
```

```powershell
tunnelme --config .\tunnels.yaml
```

All tunnels share one control connection and reconnect automatically if it
drops.

## Securing the control channel

Anyone who can reach the control port (7000) can register a domain and start
receiving its traffic. If more than just you can reach it on your LAN, set a
shared secret:

```powershell
tunnelme serve --token "long-random-string" ...
tunnelme --port 3000 --url app.example.com --token "long-random-string"
```

## Diagnostics

**Request logging** — `tunnelme serve` logs every request it sees on both
:80 and :443 (method, path, remote address, domain), plus connection
open/close events. Useful for confirming traffic is actually reaching the
tunnel server at all before worrying about your local app.

**`GET /host/live`** — every registered domain answers this path directly
from the tunnel server itself, without forwarding to your local app:

```powershell
curl https://app.example.com/host/live
# {"live":true,"domain":"app.example.com","checkedAt":"..."}
```

This proves DNS + port-forwarding + TLS + an actively-connected client are
all working, independent of whether your local app is up — handy for
isolating "is the tunnel broken" from "is my app broken".

## Running `serve` continuously

For a long-running setup, run it under a process manager so it survives
reboots/crashes, e.g. [pm2](https://pm2.keymetrics.io/) or NSSM as a Windows
service:

```powershell
npm install -g pm2
pm2 start tunnelme --name tunnelme-server -- serve --tls acme --email you@example.com
```

## CLI reference

```
tunnelme --port <port> --url <domain> [--server <ws-url>] [--token <token>]
tunnelme --config <path> [--server <ws-url>] [--token <token>]
tunnelme serve [--http-port 80] [--https-port 443] [--control-port 7000]
               [--tls acme|self-signed] [--email <email>] [--staging]
               [--certs-dir <path>] [--token <token>]
               [--port <port> [--url <domain> | --quick]] [--config <path>]
               [--upnp] [--setup-firewall]
```

The last line of `serve`'s options is optional: pass `--port`/`--url` (or
`--config`) to also run a local tunnel in the same process, against the
server's own control port — one terminal instead of two, when both run on
the same machine.
