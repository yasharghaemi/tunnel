import * as fs from 'fs';
import * as path from 'path';
import * as yaml from 'js-yaml';
import type { TunnelmeConfig } from './types';

/**
 * Loads a tunnelme config file (.yaml/.yml/.json).
 * Shape:
 * {
 *   server: "ws://localhost:7000",   // control-channel address of `tunnelme serve`
 *   token: "shared-secret",           // optional, must match server --token
 *   tunnels: [ { port: 3000, url: "app.example.com" }, ... ]
 * }
 */
export function loadConfig(configPath: string): TunnelmeConfig {
  const resolved = path.resolve(configPath);
  const raw = fs.readFileSync(resolved, 'utf8');
  const ext = path.extname(resolved).toLowerCase();

  const data = (ext === '.json' ? JSON.parse(raw) : yaml.load(raw)) as Partial<TunnelmeConfig> | null;

  if (!data || typeof data !== 'object') {
    throw new Error(`Config file ${resolved} did not parse to an object`);
  }
  if (!Array.isArray(data.tunnels) || data.tunnels.length === 0) {
    throw new Error(`Config file ${resolved} must define a non-empty "tunnels" array`);
  }
  for (const [i, t] of data.tunnels.entries()) {
    if (t.port === undefined || t.port === null || !t.url) {
      throw new Error(`tunnels[${i}] must have both "port" and "url"`);
    }
  }
  return data as TunnelmeConfig;
}
