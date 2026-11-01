import { mkdirSync, readFileSync, writeFileSync, existsSync, chmodSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { homedir } from 'node:os';
import { DatabaseSync } from 'node:sqlite';
import { newSecret, relayUrl } from './invite.ts';
import { RelayStore } from './relay-store.ts';
import { createRelayApp } from './relay-service.ts';
import { RelayBandwidth } from './relay-bandwidth.ts';
import { acquireInstanceLock } from './instance-lock.ts';

const directory = resolve(process.env.SESSIONDECK_RELAY_DATA_DIR || join(homedir(), '.local/share/sessiondeck-relay'));
const port = Number(process.env.SESSIONDECK_RELAY_PORT || 18501);
if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new Error('中继服务端口无效');
const serverUrl = relayUrl(process.env.SESSIONDECK_RELAY_URL || 'https://discoverpaw.com/connect');
const domains = [...new Set([serverUrl, ...(process.env.SESSIONDECK_RELAY_DOMAINS || '').split(',').map(value => value.trim()).filter(Boolean)])];
const firstPort = Number(process.env.SESSIONDECK_RELAY_FIRST_PORT || 18700), lastPort = Number(process.env.SESSIONDECK_RELAY_LAST_PORT || 18799);
if (!Number.isInteger(firstPort) || !Number.isInteger(lastPort) || firstPort < 1024 || lastPort > 65535 || firstPort > lastPort) throw new Error('设备端口范围无效');
mkdirSync(directory, { recursive: true, mode: 0o700 });
const lock = await acquireInstanceLock(directory);
function token(name: string) {
  const path = join(directory, name);
  if (!existsSync(path)) writeFileSync(path, newSecret(), { mode: 0o600, flag: 'wx' });
  chmodSync(path, 0o600);
  return readFileSync(path, 'utf8').trim();
}
const pluginToken = token('plugin.token'), adminToken = token('admin.token');
const db = new DatabaseSync(join(directory, 'relay.sqlite'));
const store = new RelayStore(db, firstPort, lastPort);
const frpsPort = Number(process.env.SESSIONDECK_FRPS_PORT || 18502);
if (!Number.isInteger(frpsPort) || frpsPort < 1024 || frpsPort > 65535 || frpsPort === port) throw new Error('frps 端口无效');
// frps remains loopback-only. Public access goes through Caddy's verified WSS.
writeFileSync(join(directory, 'frps.json'), JSON.stringify({ bindAddr: '127.0.0.1', bindPort: frpsPort, proxyBindAddr: '127.0.0.1', maxPortsPerClient: 1, allowPorts: [{ start: firstPort, end: lastPort }], transport: { heartbeatTimeout: 20 }, httpPlugins: [{ name: 'sessiondeck-devices', addr: `127.0.0.1:${port}`, path: `/internal/frp/${pluginToken}`, ops: ['Login', 'NewProxy', 'Ping', 'NewWorkConn'] }] }), { mode: 0o600 });
const adminHtml = process.env.SESSIONDECK_RELAY_HTML || resolve('relay/index.html');
const interfaces = (process.env.SESSIONDECK_RELAY_NETWORK_INTERFACES || '').split(',').map(value => value.trim()).filter(Boolean);
const capacityValue = process.env.SESSIONDECK_RELAY_BANDWIDTH_MBPS;
const capacity = capacityValue ? Number(capacityValue) : null;
if (capacity !== null && (!Number.isFinite(capacity) || capacity <= 0)) throw new Error('带宽上限必须为正数 Mbps');
const bandwidth = new RelayBandwidth(interfaces, capacity);
bandwidth.sample();
const bandwidthTimer = setInterval(() => bandwidth.sample(), 5000);
bandwidthTimer.unref();
const app = createRelayApp(store, { serverUrl, domains, adminToken, pluginToken, adminHtml, bandwidth, clientsDir: resolve(process.env.SESSIONDECK_RELAY_CLIENTS_DIR || join(dirname(adminHtml), 'clients')) });
const server = app.listen(port, '127.0.0.1', () => console.log(`Dili 配对服务 → ${serverUrl}/\n管理密钥文件：${join(directory, 'admin.token')}`));
let closing = false;
function close() { if (closing) return; closing = true; clearInterval(bandwidthTimer); server.close(() => { db.close(); void lock.release().then(() => process.exit(0)); }); server.closeAllConnections(); }
process.on('SIGTERM', close); process.on('SIGINT', close);
