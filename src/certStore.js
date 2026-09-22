'use strict';

const fs = require('fs');
const path = require('path');
const tls = require('tls');
const acme = require('acme-client');
const selfsigned = require('selfsigned');

const LETS_ENCRYPT_PROD = 'https://acme-v02.api.letsencrypt.org/directory';
const LETS_ENCRYPT_STAGING = 'https://acme-v02.api.letsencrypt.org/directory'.replace('acme-v02', 'acme-staging-v02');

const RENEW_WITHIN_MS = 30 * 24 * 60 * 60 * 1000; // renew if <30 days left

class CertStore {
  /**
   * @param {object} opts
   * @param {string} opts.certsDir directory to persist certs/account key
   * @param {'acme'|'self-signed'} opts.mode
   * @param {string} [opts.acmeEmail] contact email for Let's Encrypt account
   * @param {boolean} [opts.staging] use LE staging directory (for testing, no rate limits)
   */
  constructor(opts) {
    this.certsDir = opts.certsDir;
    this.mode = opts.mode;
    this.acmeEmail = opts.acmeEmail;
    this.staging = !!opts.staging;

    this.cache = new Map(); // domain -> { ctx, expiresAt }
    this.pending = new Map(); // domain -> Promise<ctx>
    this.challenges = new Map(); // token -> keyAuthorization
    this._acmeClient = null;

    fs.mkdirSync(this.certsDir, { recursive: true });
  }

  domainDir(domain) {
    return path.join(this.certsDir, domain);
  }

  loadFromDisk(domain) {
    const dir = this.domainDir(domain);
    const certPath = path.join(dir, 'cert.pem');
    const keyPath = path.join(dir, 'key.pem');
    if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) return null;

    const cert = fs.readFileSync(certPath, 'utf8');
    const key = fs.readFileSync(keyPath, 'utf8');
    const expiresAt = this._certExpiry(cert);
    return { cert, key, expiresAt };
  }

  saveToDisk(domain, { cert, key }) {
    const dir = this.domainDir(domain);
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'cert.pem'), cert, { mode: 0o644 });
    fs.writeFileSync(path.join(dir, 'key.pem'), key, { mode: 0o600 });
  }

  _certExpiry(certPem) {
    try {
      const cert = new (require('crypto').X509Certificate)(certPem);
      return new Date(cert.validTo).getTime();
    } catch {
      return 0;
    }
  }

  /** Returns a tls.SecureContext for the given domain, provisioning/renewing as needed. */
  async getSecureContext(domain) {
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

    if (this.pending.has(domain)) return this.pending.get(domain);

    const provisioning = this._provision(domain)
      .then(({ cert, key }) => {
        this.saveToDisk(domain, { cert, key });
        const ctx = tls.createSecureContext({ cert, key });
        this.cache.set(domain, { ctx, expiresAt: this._certExpiry(cert) });
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

  async _provision(domain) {
    if (this.mode === 'self-signed') return this._provisionSelfSigned(domain);
    return this._provisionAcme(domain);
  }

  _provisionSelfSigned(domain) {
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

  async _getAcmeClient() {
    if (this._acmeClient) return this._acmeClient;

    const accountKeyPath = path.join(this.certsDir, 'account-key.pem');
    let accountKey;
    if (fs.existsSync(accountKeyPath)) {
      accountKey = fs.readFileSync(accountKeyPath);
    } else {
      accountKey = await acme.forge.createPrivateKey();
      fs.writeFileSync(accountKeyPath, accountKey, { mode: 0o600 });
    }

    this._acmeClient = new acme.Client({
      directoryUrl: this.staging ? LETS_ENCRYPT_STAGING : LETS_ENCRYPT_PROD,
      accountKey,
    });
    return this._acmeClient;
  }

  async _provisionAcme(domain) {
    const client = await this._getAcmeClient();
    const [key, csr] = await acme.forge.createCsr({ commonName: domain });

    let cert;
    try {
      cert = await client.auto({
        csr,
        email: this.acmeEmail,
        termsOfServiceAgreed: true,
        challengePriority: ['http-01'],
        challengeCreateFn: async (authz, challenge, keyAuthorization) => {
          if (challenge.type !== 'http-01') return;
          this.challenges.set(challenge.token, keyAuthorization);
        },
        challengeRemoveFn: async (authz, challenge) => {
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
            '(Let\'s Encrypt must be able to fetch http://' +
            domain +
            '/.well-known/acme-challenge/... from outside your network). Then try again.'
        );
      }
      throw err;
    }

    return { cert: cert.toString(), key: key.toString() };
  }

  /** Used by the plain :80 server to answer ACME http-01 challenge requests. */
  getChallengeResponse(token) {
    return this.challenges.get(token) || null;
  }
}

module.exports = { CertStore };
