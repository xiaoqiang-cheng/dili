import { execFile } from 'node:child_process';
import { realpathSync } from 'node:fs';
import { promisify } from 'node:util';
import { homedir, release } from 'node:os';
import { join, resolve } from 'node:path';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import type { StartupStatus } from '../shared/setup.ts';
import { defaultDataDir, legacyDataDir, resolveDataDir } from './data-dir.ts';

const exec = promisify(execFile);
type Result = { stdout: string; code: number };
type Runner = (file: string, args: string[]) => Promise<Result>;
const run: Runner = async (file, args) => {
  try { return { stdout: (await exec(file, args, { timeout: 3000, maxBuffer: 8192 })).stdout, code: 0 }; }
  catch (error) { return { stdout: '', code: Number((error as { code?: number }).code) || 1 }; }
};

// systemd uses its own quoting, percent specifiers and dollar expansion.
export function unitQuote(value: string, expandDollars = false): string {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('启动设置包含无效控制字符');
  return `"${value.replace(/\\/g, '\\\\').replace(/"/g, '\\"').replace(/%/g, '%%').replace(/\$/g, expandDollars ? '$$$$' : '$$')}"`;
}

// WorkingDirectory= takes a bare path: systemd does not unquote it.
export function unitPath(value: string): string {
  if (/[\x00-\x1f\x7f]/.test(value)) throw new Error('启动设置包含无效控制字符');
  return value.replace(/%/g, '%%');
}

/** Compares directory identity, so a renamed default and its symlink match. */
export function sameDirectory(a: string, b: string): boolean {
  if (a === b) return true;
  try { return realpathSync(a) === realpathSync(b); } catch { return false; }
}

/** Reads one `Environment=KEY=value` line, undoing systemd quoting for paths. */
function environmentValue(line: string, key: string): string {
  const raw = line.slice('Environment='.length);
  const unquoted = raw.startsWith('"') && raw.endsWith('"')
    ? raw.slice(1, -1).replace(/\\(["\\])/g, '$1').replace(/\$\$/g, '$').replace(/%%/g, '%')
    : raw;
  const prefix = `${key}=`;
  return unquoted.startsWith(prefix) ? unquoted.slice(prefix.length) : '';
}

export const SERVICE_UNIT = 'dili.service';
// Units installed before the rename. Migrated by enabling dili.service.
export const LEGACY_SERVICE_UNIT = 'sessiondeck.service';

/** Toggles future startup only. No stop, restart, start, --now or privileged commands. */
export class StartupService {
  private readonly unitPath: string;
  private readonly legacyPath: string;
  private readonly runner: Runner;
  private readonly platform: string;
  private readonly wsl: boolean;
  private readonly dataDir: string;
  private busy = false;
  constructor(private readonly options: {
    root: string; configDir?: string; dataDir?: string; cwd?: string; port?: number; host?: string;
    runner?: Runner; platform?: string; wsl?: boolean;
  }) {
    const unitDir = join(options.configDir ?? process.env.XDG_CONFIG_HOME ?? join(homedir(), '.config'), 'systemd/user');
    this.unitPath = join(unitDir, SERVICE_UNIT);
    this.legacyPath = join(unitDir, LEGACY_SERVICE_UNIT);
    this.runner = options.runner ?? run;
    this.platform = options.platform ?? process.platform;
    this.wsl = options.wsl ?? /microsoft/i.test(release());
    this.dataDir = resolve(options.dataDir ?? resolveDataDir());
  }
  private async unit(path = this.unitPath): Promise<string | null> {
    try { return await readFile(path, 'utf8'); }
    catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
  }
  private matches(unit: string): boolean {
    // Existing source-install units are retained, including all custom settings.
    const cli = unitQuote(join(this.options.root, 'bin/dili.mjs'), true);
    const source = join(this.options.root, 'start.sh');
    if (!unit.includes(cli) && !unit.split('\n').some(line => line === `ExecStart=${source}` || line === `ExecStart="${source}"`)) return false;
    const environment = unit.split('\n').filter(line => line.startsWith('Environment='));
    const wanted: Record<string, string> = {
      SESSIONDECK_DATA_DIR: this.dataDir,
      SESSIONDECK_PORT: String(this.options.port ?? Number(process.env.PORT || process.env.SESSIONDECK_PORT || 4317)),
      SESSIONDECK_HOST: this.options.host ?? process.env.HOST ?? process.env.SESSIONDECK_HOST ?? '127.0.0.1',
    };
    const demo = process.env.SESSIONDECK_DEMO === '1';
    const defaultData = defaultDataDir({ demo });
    const legacyData = legacyDataDir({ demo });
    for (const [key, value] of Object.entries(wanted)) {
      const lines = environment.filter(line => line.includes(`${key}=`));
      if (lines.length > 1) return false;
      if (!lines.length) {
        // The unit pins nothing, so the binary's default applies.
        if (key === 'SESSIONDECK_DATA_DIR') { if (!sameDirectory(value, defaultData)) return false; }
        else if (value !== (key === 'SESSIONDECK_PORT' ? '4317' : '127.0.0.1')) return false;
        continue;
      }
      if (lines[0] === `Environment=${key}=${value}` || lines[0] === `Environment=${unitQuote(`${key}=${value}`)}`) continue;
      if (key !== 'SESSIONDECK_DATA_DIR') return false;
      // Units written before the rename pin the old default; the migration
      // leaves that path as a symlink, so both name the same store.
      const pinned = environmentValue(lines[0], key);
      if (!sameDirectory(pinned, value) && !(sameDirectory(pinned, legacyData) && sameDirectory(value, defaultData))) return false;
    }
    return true;
  }
  async status(): Promise<StartupStatus> {
    const [unit, legacyUnit] = await Promise.all([this.unit(), this.unit(this.legacyPath)]);
    // A legacy unit of another installation still owns auto-start for this machine.
    const conflict = unit !== null ? !this.matches(unit) : legacyUnit !== null && !this.matches(legacyUnit);
    const ownsLegacy = legacyUnit !== null && this.matches(legacyUnit);
    const status: StartupStatus = { supported: false, enabled: false, active: false, wsl: this.wsl, linger: false, unitPath: this.unitPath, conflict, legacy: false, note: '' };
    if (this.platform !== 'linux') return { ...status, note: '目前支持 Linux / WSL2 的 systemd 用户服务；其他平台请手动运行 dili。' };
    const available = await this.runner('systemctl', ['--user', 'show-environment']);
    if (available.code !== 0) return { ...status, note: this.wsl ? '请在 WSL 启用 systemd 并重新启动发行版，再设置自动启动。' : '当前无法连接 systemd 用户服务，请在本机登录后的终端设置。' };
    const state = async (verb: string, name: string) => (await this.runner('systemctl', ['--user', verb, name])).stdout.trim();
    const [enabled, active, legacyEnabled, legacyActive, linger] = await Promise.all([
      unit === null ? '' : state('is-enabled', SERVICE_UNIT),
      unit === null ? '' : state('is-active', SERVICE_UNIT),
      ownsLegacy ? state('is-enabled', LEGACY_SERVICE_UNIT) : '',
      ownsLegacy ? state('is-active', LEGACY_SERVICE_UNIT) : '',
      this.runner('loginctl', ['show-user', String(process.getuid?.() ?? ''), '-p', 'Linger', '--value']),
    ]);
    const legacy = legacyEnabled === 'enabled';
    return { ...status, supported: true, legacy, enabled: enabled === 'enabled' || legacy, active: active === 'active' || legacyActive === 'active', linger: linger.stdout.trim() === 'yes',
      note: conflict ? '已有用户服务属于其他安装或数据目录，不能从此实例覆盖。请在原安装中设置。'
        : legacy ? `自动启动仍使用旧的 ${LEGACY_SERVICE_UNIT}。迁移会启用 ${SERVICE_UNIT} 并停用旧单元，不停止当前服务。`
        : this.wsl ? '在 WSL 发行版启动后自动运行；这不会让 Windows 自动启动 WSL。' : '启用后在用户登录时自动运行。关闭自动启动不会停止当前会话。' };
  }
  async change(enabled: boolean): Promise<StartupStatus> {
    if (this.busy) throw Object.assign(new Error('启动设置正在处理中'), { status: 409 });
    this.busy = true;
    try {
      const current = await this.status();
      if (!current.supported || current.conflict) throw Object.assign(new Error(current.note), { status: 409 });
      if (current.enabled === enabled && !(enabled && current.legacy)) return current;
      if (enabled && !(await this.unit())) {
        const cwd = resolve(this.options.cwd ?? process.cwd());
        const port = this.options.port ?? Number(process.env.PORT || process.env.SESSIONDECK_PORT || 4317);
        const host = this.options.host ?? process.env.HOST ?? process.env.SESSIONDECK_HOST ?? '127.0.0.1';
        const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/local/bin:/usr/bin:/bin', SESSIONDECK_PORT: String(port), SESSIONDECK_HOST: host };
        // Pin the data directory only when it is not the default: a unit that
        // pinned today's default would survive a future rename pointing at it.
        if (!sameDirectory(this.dataDir, defaultDataDir({ demo: process.env.SESSIONDECK_DEMO === '1' }))) env.SESSIONDECK_DATA_DIR = this.dataDir;
        // Native credentials stay in native files. Never copy arbitrary environment secrets.
        for (const key of ['CODEX_HOME', 'CLAUDE_CONFIG_DIR', 'DSH_HOME', 'SESSIONDECK_CLAUDE_BIN', 'SESSIONDECK_CODEX_BIN', 'SESSIONDECK_DSH_BIN', 'SESSIONDECK_DSH_TUI_BIN', 'SESSIONDECK_REMOTE_PORT']) if (process.env[key]) env[key] = process.env[key]!;
        const contents = ['# Managed by Dili.', '[Unit]', 'Description=Dili personal agent workbench', 'After=network.target', '', '[Service]', 'Type=simple', `WorkingDirectory=${unitPath(cwd)}`, ...Object.entries(env).map(([key, value]) => `Environment=${unitQuote(`${key}=${value}`)}`), `ExecStart=${unitQuote(process.execPath, true)} ${unitQuote(join(this.options.root, 'bin/dili.mjs'), true)}`, 'Restart=on-failure', 'RestartSec=5', 'TimeoutStopSec=30', 'KillMode=mixed', '', '[Install]', 'WantedBy=default.target', ''].join('\n');
        const dir = join(this.unitPath, '..');
        await mkdir(dir, { recursive: true });
        // Exclusive creation prevents two instances from replacing each other's unit.
        await writeFile(this.unitPath, contents, { mode: 0o600, flag: 'wx' });
      }
      if (enabled && (await this.runner('systemctl', ['--user', 'daemon-reload'])).code !== 0) throw new Error('用户服务刷新失败，请检查 systemd 后重试');
      if ((enabled || await this.unit()) && (await this.runner('systemctl', ['--user', enabled ? 'enable' : 'disable', SERVICE_UNIT])).code !== 0) throw new Error('无法更新自动启动，请在本机终端检查 systemctl --user status dili');
      // Disable only: a running legacy instance keeps serving its sessions.
      if (current.legacy && (await this.runner('systemctl', ['--user', 'disable', LEGACY_SERVICE_UNIT])).code !== 0) throw new Error(`无法停用旧的 ${LEGACY_SERVICE_UNIT}，请在本机终端执行 systemctl --user disable ${LEGACY_SERVICE_UNIT}，避免两个服务同时启动`);
      return await this.status();
    } finally { this.busy = false; }
  }
}
