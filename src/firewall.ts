import { execFileSync } from 'child_process';
import { log } from './util';

/**
 * Adds Windows Firewall inbound allow rules for the given TCP ports.
 * Requires an Administrator terminal; idempotent (safe to run repeatedly).
 * No-ops with a message on non-Windows platforms.
 */
export function setupWindowsFirewall(ports: number[]): void {
  if (process.platform !== 'win32') {
    log('--setup-firewall is only implemented for Windows; configure your firewall manually on this platform');
    return;
  }

  for (const port of ports) {
    const ruleName = `tunnelme TCP ${port}`;
    const script =
      `if (-not (Get-NetFirewallRule -DisplayName '${ruleName}' -ErrorAction SilentlyContinue)) { ` +
      `New-NetFirewallRule -DisplayName '${ruleName}' -Direction Inbound -Protocol TCP -LocalPort ${port} -Action Allow -ErrorAction Stop | Out-Null; ` +
      `Write-Output 'created' } else { Write-Output 'exists' }`;

    try {
      const output = execFileSync('powershell', ['-NoProfile', '-Command', script], { stdio: 'pipe' })
        .toString()
        .trim();
      if (output === 'created') {
        log(`firewall: added inbound rule for TCP ${port} ("${ruleName}")`);
      } else {
        log(`firewall: inbound rule for TCP ${port} already exists ("${ruleName}")`);
      }
    } catch (err) {
      const e = err as { stderr?: Buffer; message: string };
      const msg = e.stderr ? e.stderr.toString().trim() : e.message;
      log(`firewall: failed to add rule for TCP ${port}: ${msg}`);
      if (/access is denied|requested operation requires elevation/i.test(msg)) {
        log('firewall: this requires an Administrator terminal -- re-run as Administrator');
      }
    }
  }
}
