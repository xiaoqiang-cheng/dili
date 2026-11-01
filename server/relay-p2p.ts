import { isIP } from 'node:net';

/** `host:port` for a private/VPN interface; never a public hostname. */
export type P2PUpstreams = { default?: string; devices: Map<string, string> };

function target(value: string): string {
  const match = /^\[([0-9a-fA-F:]+)\]:(\d+)$/.exec(value) ?? /^([^:]+):(\d+)$/.exec(value);
  if (!match || !isIP(match[1]!) || Number(match[2]) < 1 || Number(match[2]) > 65535) {
    throw new Error(`P2P 上游必须是 IP:端口，收到 ${value}`);
  }
  const host = match[1]!, port = Number(match[2]);
  return `${isIP(host) === 6 ? `[${host}]` : host}:${port}`;
}

/**
 * Parse `SESSIONDECK_RELAY_P2P_UPSTREAM`.
 *
 * A bare `10.144.0.2:4318` applies to every device on this relay (the common
 * single-host setup); `deviceId=10.144.0.2:4318` overrides one device.
 */
export function parseP2PUpstreams(raw: string | undefined): P2PUpstreams {
  const result: P2PUpstreams = { devices: new Map() };
  for (const part of (raw ?? '').split(',').map(value => value.trim()).filter(Boolean)) {
    const index = part.indexOf('=');
    if (index < 0) { result.default = target(part); continue; }
    const key = part.slice(0, index).trim();
    const value = target(part.slice(index + 1).trim());
    if (!key) throw new Error('P2P 上游缺少设备 id');
    if (key === '*') result.default = value;
    else result.devices.set(key, value);
  }
  return result;
}

export function p2pTarget(config: P2PUpstreams, deviceId: string): string | undefined {
  return config.devices.get(deviceId) ?? config.default;
}

/**
 * A failed or unhealthy P2P path must fall back to the FRP upstream instead of
 * turning a VPN hiccup into a remote outage. Probes are cached per target so
 * Caddy's forward_auth path does not add a TCP/HTTP round trip to every request.
 */
export class P2PHealth {
  private readonly cache = new Map<string, { healthy: boolean; at: number }>();
  private readonly inflight = new Map<string, Promise<boolean>>();
  constructor(
    private readonly config: P2PUpstreams,
    private readonly probe: (target: string) => Promise<boolean>,
    private readonly now: () => number = Date.now,
    private readonly ttlMs = 5000,
  ) {}

  async upstream(deviceId: string): Promise<string | undefined> {
    const target = p2pTarget(this.config, deviceId);
    if (!target) return undefined;
    const cached = this.cache.get(target);
    if (cached && this.now() - cached.at < this.ttlMs) return cached.healthy ? target : undefined;
    let pending = this.inflight.get(target);
    if (!pending) {
      pending = this.probe(target).catch(() => false).finally(() => this.inflight.delete(target));
      this.inflight.set(target, pending);
    }
    const healthy = await pending;
    this.cache.set(target, { healthy, at: this.now() });
    return healthy ? target : undefined;
  }
}
