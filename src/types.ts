export interface TunnelEntry {
  port: number;
  url: string;
}

/** Shape of a tunnelme config file (.yaml/.yml/.json). */
export interface TunnelmeConfig {
  /** control-channel address of `tunnelme serve`, e.g. "ws://localhost:7000" */
  server?: string;
  /** optional shared secret, must match server --token */
  token?: string;
  tunnels: TunnelEntry[];
}

/** A single {port, domain} pairing as used internally by the client/server. */
export interface Tunnel {
  port: number;
  domain: string;
}
