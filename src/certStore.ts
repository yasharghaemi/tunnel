import * as fs from 'fs';
import * as path from 'path';
import * as tls from 'tls';
import * as crypto from 'crypto';
import * as acme from 'acme-client';
import * as selfsigned from 'selfsigned';

const LETS_ENCRYPT_PROD = 'https://acme-v02.api.letsencrypt.org/directory';
const LETS_ENCRYPT_STAGING = 'https://acme-v02.api.letsencrypt.org/directory'.replace('acme-v02', 'acme-staging-v02');

const RENEW_WITHIN_MS = 30 * 24 * 60 * 60 * 1000; // renew if <30 days left

export type TlsMode = 'acme' | 'self-signed';

export interface CertStoreOptions {
  certsDir: string;
  mode: TlsMode;
  /** contact email for Let's Encrypt account */
  acmeEmail?: string;
  /** use LE staging directory (for testing, no rate limits) */
  staging?: boolean;
}

interface CertKeyPair {
  cert: string;
  key: string;
}

interface CachedCert {
  ctx: tls.SecureContext;
  expiresAt: number;
}

interface DiskCert extends CertKeyPair {
  expiresAt: number;
}

export class CertStore {
  private certsDir: string;
  private mode: TlsMode;
  private acmeEmail?: string;
  private staging: boolean;

  private cache = new Map<string, CachedCert>();
  private pending = new Map<string, Promise<tls.SecureContext>>();
  private challenges = new Map<string, string>();
  private acmeClient: acme.Client | null = null;

  constructor(opts: CertStoreOptions) {
    this.certsDir = opts.certsDir;
    this.mode = opts.mode;
    this.acmeEmail = opts.acmeEmail;
    this.staging = !!opts.staging;

    fs.mkdirSync(this.certsDir, { recursive: true });
  }

  private domainDir(domain: string): string {
    return path.join(this.certsDir, domain);
  }

  private loadFromDisk(domain: string): DiskCert | null {
    const dir = this.domainDir(domain);
    const certPath = path.join(dir, 'cert.pem');
    const keyPath = path.join(dir, 'key.pem');
    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) return null;

    const cert = fs.readFileSync(certPath, 'utf8');
    const key = fs.readFileSync(keyPath, 'utf8');
    const expiresAt = this.certExpiry(cert);
    return { cert, key, expiresAt };
  }

  private saveToDisk(domain: string, { cert, key }: CertKeyPair): void {
    const dir = this.domainDir(domain);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cert.pem'), cert, { mode: 0o644 });
    fs.writeFileSync(path.join(dir, 'key.pem'), key, { mode: 0o600 });
  }

  private certExpiry(certPem: string): number {
    try {
      const cert = new crypto.X509Certificate(certPem);
      return new Date(cert.validTo).getTime();
    } catch {
      return 0;
    }
  }

  /** Returns a tls.SecureContext for the given domain, provisioning/renewing as needed. */
  async getSecureContext(domain: string): Promise<tls.SecureContext> {
    const cached = this.cache.get(domain);
    if (cached && cached.expiresAt - Date.now() > RENEW_WITHIN_MS) {
      return cached.ctx;
    }

    const fromDisk = this.loadFromDisk(domain);
    if (fromDisk && fromDisk.expiresAt - Date.now() > RENEW_WITHIN_MS) {
      const ctx = tls.createSecureContext({ cert: fromDisk.cert, key: fromDisk.key });
      this.cache.set(domain, { ctx, expiresAt: fromDisk.expiresAt });
      return ctx;
    }

    const existingPending = this.pending.get(domain);
    if (existingPending) return existingPending;

    const provisioning = this.provision(domain)
      .then(({ cert, key }) => {
        this.saveToDisk(domain, { cert, key });
        const ctx = tls.createSecureContext({ cert, key });
        this.cache.set(domain, { ctx, expiresAt: this.certExpiry(cert) });
        this.pending.delete(domain);
        return ctx;
      })
      .catch((err) => {
        this.pending.delete(domain);
        throw err;
      });

    this.pending.set(domain, provisioning);
    return provisioning;
  }

  private async provision(domain: string): Promise<CertKeyPair> {
    if (this.mode === 'self-signed') return this.provisionSelfSigned(domain);
    return this.provisionAcme(domain);
  }

  private provisionSelfSigned(domain: string): CertKeyPair {
    const attrs = [{ name: 'commonName', value: domain }];
    const pems = selfsigned.generate(attrs, {
      days: 365,
      keySize: 2048,
      extensions: [
        { name: 'basicConstraints', cA: false },
        { name: 'subjectAltName', altNames: [{ type: 2, value: domain }] },
      ],
    });
    return { cert: pems.cert, key: pems.private };
  }

  private async getAcmeClient(): Promise<acme.Client> {
    if (this.acmeClient) return this.acmeClient;

    const accountKeyPath = path.join(this.certsDir, 'account-key.pem');
    let accountKey: Buffer;
    if (fs.existsSync(accountKeyPath)) {
      accountKey = fs.readFileSync(accountKeyPath);
    } else {
      accountKey = await acme.forge.createPrivateKey();
      fs.writeFileSync(accountKeyPath, accountKey, { mode: 0o600 });
    }

    this.acmeClient = new acme.Client({
      directoryUrl: this.staging ? LETS_ENCRYPT_STAGING : LETS_ENCRYPT_PROD,
      accountKey,
    });
    return this.acmeClient;
  }

  private async provisionAcme(domain: string): Promise<CertKeyPair> {
    const client = await this.getAcmeClient();
    const [key, csr] = await acme.forge.createCsr({ commonName: domain });

    let cert: string;
    try {
      cert = await client.auto({
        csr,
        email: this.acmeEmail,
        termsOfServiceAgreed: true,
        challengePriority: ['http-01'],
        challengeCreateFn: async (_authz, challenge, keyAuthorization) => {
          if (challenge.type !== 'http-01') return;
          this.challenges.set(challenge.token, keyAuthorization);
        },
        challengeRemoveFn: async (_authz, challenge) => {
          this.challenges.delete(challenge.token);
        },
      });
    } catch (err) {
      // acme-client's retry logic has a known bug: a pure network failure
      // (no HTTP response at all) talking to Let's Encrypt, after retries
      // are exhausted, throws this exact confusing TypeError instead of the
      // real network error. Surface a clearer, actionable message instead.
      if (err instanceof TypeError && /reading 'config'/.test(err.message)) {
        throw new Error(
          `Failed to reach Let's Encrypt while requesting a certificate for ${domain} ` +
            "(a network-level failure was hidden by a bug in the acme-client library). " +
            'Check outbound internet access from this machine to acme-v02.api.letsencrypt.org, ' +
            'and that inbound port 80 is reachable from the internet for the HTTP-01 challenge ' +
            "(Let's Encrypt must be able to fetch http://" +
            domain +
            '/.well-known/acme-challenge/... from outside your network). Then try again.'
        );
      }
      throw err;
    }

    return { cert: cert.toString(), key: key.toString() };
  }

  /** Used by the plain :80 server to answer ACME http-01 challenge requests. */
  getChallengeResponse(token: string): string | null {
    return this.challenges.get(token) || null;
  }
}
