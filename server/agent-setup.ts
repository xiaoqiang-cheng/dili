import { spawn } from 'node:child_process';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { chmod, copyFile, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { constants } from 'node:fs';
import { randomUUID } from 'node:crypto';
import { parse as parseToml, stringify as stringifyToml, type TomlTable } from 'smol-toml';
import { parse as parseYaml, stringify as stringifyYaml } from 'yaml';
import { findExecutable } from './adapters.ts';
import type { Backend } from '../shared/types.ts';
import type { AgentConfigInput, AgentSetupInfo, SetupAction } from '../shared/setup.ts';

const DSH_PROVIDER_ID = 'dili';
const DSH_API_KEY_REF = 'DILI_API_KEY';
const PI_PROVIDER_ID = 'dili';
const CUSTOM_PROVIDER_NOTE = 'Dili 托管的 OpenAI 兼容提供商；地址和模型需同时填写，留空二者会移除托管配置。';

const guides = {
  claude: { installCommand: 'npm install -g @anthropic-ai/claude-code', loginCommand: 'claude auth login', nativeCommand: 'claude', docsUrl: 'https://code.claude.com/docs/en/setup', note: '使用原生账号登录，或保存 API 配置到 Claude 用户设置。其他终端运行 claude 也会读取。' },
  codex: { installCommand: 'npm install -g @openai/codex', loginCommand: 'codex login --device-auth', nativeCommand: 'codex', docsUrl: 'https://developers.openai.com/codex/cli/', note: '使用原生账号登录，或通过 codex login --with-api-key 保存 API Key。自定义服务需兼容 Responses API。' },
  dsh: { installCommand: 'npm install -g @deepseek-ai/dsh @deepseek-harness-tui/dsh-tui', loginCommand: 'dsh web', nativeCommand: 'dsh web', docsUrl: 'https://github.com/deepseek-ai/deepseek-harness', note: `可在原生 Web 设置中配置提供商和账号；也可在这里保存 ${CUSTOM_PROVIDER_NOTE}` },
  pi: { installCommand: 'npm install -g @earendil-works/pi-coding-agent', loginCommand: 'pi', nativeCommand: 'pi', docsUrl: 'https://github.com/earendil-works/pi', note: `可运行 pi 使用 /login 维护原生提供商；也可在这里保存 ${CUSTOM_PROVIDER_NOTE}` },
} as const;

function invalid(message: string): never { throw Object.assign(new Error(message), { status: 400 }); }
function validate(input: AgentConfigInput): AgentConfigInput {
  if (!input || typeof input !== 'object' || Array.isArray(input)) invalid('无效的配置');
  if (Object.keys(input).some(key => !['apiKey', 'baseUrl', 'model'].includes(key))) invalid('未知的配置项');
  const result: AgentConfigInput = {};
  for (const key of ['apiKey', 'baseUrl', 'model'] as const) {
    const value = input[key];
    if (value === undefined) continue;
    if (typeof value !== 'string' || value.length > (key === 'apiKey' ? 4096 : 500) || /[\x00-\x1f\x7f]/.test(value)) invalid('配置值格式无效');
    result[key] = value.trim();
  }
  if (result.baseUrl) {
    let url: URL;
    try { url = new URL(result.baseUrl); } catch { invalid('API 地址格式无效'); }
    if (!['https:', 'http:'].includes(url.protocol) || url.username || url.password || url.search || url.hash) invalid('API 地址仅支持 HTTP(S)，不能包含账号、查询参数或片段');
    if (url.protocol === 'http:' && !['localhost', '127.0.0.1', '[::1]'].includes(url.hostname)) invalid('远程 API 地址必须使用 HTTPS');
  }
  return result;
}

async function readNative(path: string): Promise<string | null> {
  try {
    // Avoid overwriting files redirected outside the native config directory.
    const info = await lstat(path);
    if (!info.isFile() || info.isSymbolicLink() || info.size > 2_000_000) throw new Error('原生配置必须是普通文件且不超过 2 MB');
    return await readFile(path, 'utf8');
  } catch (error) { if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null; throw error; }
}
function jsonObject(raw: string | null): Record<string, unknown> {
  const value: unknown = raw === null ? {} : JSON.parse(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('原生 JSON 配置格式无效');
  return value as Record<string, unknown>;
}
function objectValue(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
}
function parseYamlObject(raw: string | null, label: string): Record<string, unknown> {
  const value: unknown = raw === null ? {} : parseYaml(raw);
  if (!value || typeof value !== 'object' || Array.isArray(value)) invalid(`${label}格式无效`);
  return value as Record<string, unknown>;
}
function dshEntries(raw: string | null): Array<Record<string, unknown>> {
  const value: unknown = raw === null ? [] : parseYaml(raw);
  if (value === null) return [];
  if (!Array.isArray(value)) invalid('dsh 原生配置不是 patch 列表，未覆盖');
  return value.map((entry, index) => {
    const object = objectValue(entry);
    if (!object) invalid(`dsh 原生配置第 ${index + 1} 项不是映射，未覆盖`);
    return object;
  });
}
function findDshEntry(entries: Array<Record<string, unknown>>, id: string) {
  return entries.find(entry => entry.id === id);
}
function dshConfig(entry: Record<string, unknown>): Record<string, unknown> {
  if (entry.config !== undefined && !objectValue(entry.config)) invalid('dsh 原生配置的 config 不是映射，未覆盖');
  const config = objectValue(entry.config) ?? {};
  entry.config = config;
  return config;
}
function dshContents(raw: string | null, mode: 'set' | 'remove', input: AgentConfigInput): string {
  const entries = dshEntries(raw);
  const llm = findDshEntry(entries, 'llm-pi-ai');
  if (mode === 'set') {
    const entry = llm ?? { id: 'llm-pi-ai', name: '@deepseek-ai/dsh-llm-pi-ai' };
    if (!llm) entries.push(entry);
    const config = dshConfig(entry);
    if (config.providers !== undefined && !objectValue(config.providers)) invalid('dsh 原生配置的 providers 不是映射，未覆盖');
    const providers = objectValue(config.providers) ?? {};
    providers[DSH_PROVIDER_ID] = {
      displayName: 'Dili custom API',
      apiKeyEnv: DSH_API_KEY_REF,
      api: 'openai-completions',
      baseURL: input.baseUrl,
      models: [{ id: input.model, name: input.model }],
    };
    config.providers = providers;
    // Keep new sessions on the provider we just configured. The user layer is
    // backed up before writing, and clearing the managed URL removes this override.
    const defaultModel = findDshEntry(entries, 'agent-default-model') ?? { id: 'agent-default-model', name: '@deepseek-ai/dsh-agent-default-model' };
    if (!findDshEntry(entries, 'agent-default-model')) entries.push(defaultModel);
    const defaultConfig = dshConfig(defaultModel);
    defaultConfig.provider = DSH_PROVIDER_ID;
    defaultConfig.model = input.model;
  } else {
    if (llm) {
      const config = objectValue(llm.config);
      const providers = objectValue(config?.providers);
      if (providers) {
        delete providers[DSH_PROVIDER_ID];
        if (Object.keys(providers).length === 0) delete config!.providers;
      }
    }
    const defaultModel = findDshEntry(entries, 'agent-default-model');
    const defaultConfig = objectValue(defaultModel?.config);
    if (defaultModel && defaultConfig?.provider === DSH_PROVIDER_ID) {
      const index = entries.indexOf(defaultModel);
      if (index >= 0) entries.splice(index, 1);
    }
  }
  return stringifyYaml(entries, { lineWidth: 0 });
}
function dshCredentialContents(raw: string | null, apiKey: string): string {
  const root = parseYamlObject(raw, 'DSH 凭据文件');
  if (root.version !== undefined && root.version !== 1) invalid('DSH 凭据文件版本不受支持，未覆盖');
  if (root.refs !== undefined && !objectValue(root.refs)) invalid('DSH 凭据文件 refs 不是映射，未覆盖');
  if (root.records !== undefined && !objectValue(root.records)) invalid('DSH 凭据文件 records 不是映射，未覆盖');
  const refs = objectValue(root.refs) ?? {};
  refs[DSH_API_KEY_REF] = apiKey;
  root.version = 1;
  root.refs = refs;
  if (root.records === undefined) root.records = {};
  return stringifyYaml(root, { lineWidth: 0 });
}
function piProvider(config: Record<string, unknown>): Record<string, unknown> | null {
  return objectValue(objectValue(config.providers)?.[PI_PROVIDER_ID]);
}
function piCredential(config: Record<string, unknown>): Record<string, unknown> | null {
  return objectValue(config[PI_PROVIDER_ID]);
}
async function writeNative(path: string, contents: string, original: string | null) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const lock = `${path}.dili-lock`, tmp = `${path}.dili-${randomUUID()}.tmp`;
  try { await writeFile(lock, '', { flag: 'wx', mode: 0o600 }); }
  catch { throw Object.assign(new Error('原生配置正在修改，请稍后重试'), { status: 409 }); }
  try {
    if (await readNative(path) !== original) throw Object.assign(new Error('原生配置已被其他程序更新，请刷新后重试'), { status: 409 });
    if (original !== null) {
      const backup = `${path}.dili-backup-${Date.now()}-${randomUUID()}`;
      await copyFile(path, backup, constants.COPYFILE_EXCL);
      await chmod(backup, 0o600);
    }
    await writeFile(tmp, contents, { mode: 0o600, flag: 'wx' });
    await rename(tmp, path);
  } finally { await rm(tmp, { force: true }); await rm(lock, { force: true }); }
}

/** The API key travels on stdin, never shell command text, argv or returned output. */
export async function codexApiLogin(file: string, key: string): Promise<void> {
  await new Promise<void>((resolveLogin, reject) => {
    const child = spawn(file, ['login', '--with-api-key'], { stdio: ['pipe', 'ignore', 'ignore'] });
    const timer = setTimeout(() => { child.kill('SIGTERM'); reject(new Error('Codex 原生登录超时，请检查本机版本和配置')); }, 15_000);
    child.once('error', () => { clearTimeout(timer); reject(new Error('无法启动 Codex 原生登录')); });
    child.once('exit', code => { clearTimeout(timer); if (code === 0) resolveLogin(); else reject(new Error('Codex 未能保存 API Key，请在原生终端检查登录状态')); });
    child.stdin.on('error', () => {});
    child.stdin.end(key + '\n');
  });
}

export class AgentSetup {
  private busy = new Set<Backend>();
  private readonly homes: Record<Backend, string>;
  constructor(options: { home?: string; homes?: Partial<Record<Backend, string>>; find?: typeof findExecutable; login?: typeof codexApiLogin } = {}) {
    const home = options.home ?? homedir();
    this.homes = {
      claude: resolve(options.homes?.claude ?? (options.home ? join(home, '.claude') : process.env.CLAUDE_CONFIG_DIR ?? join(home, '.claude'))),
      codex: resolve(options.homes?.codex ?? (options.home ? join(home, '.codex') : process.env.CODEX_HOME ?? join(home, '.codex'))),
      dsh: resolve(options.homes?.dsh ?? (options.home ? join(home, '.dsh') : process.env.DSH_HOME ?? join(home, '.dsh'))),
      pi: resolve(options.homes?.pi ?? (options.home ? join(home, '.pi', 'agent') : process.env.PI_CODING_AGENT_DIR ?? join(home, '.pi', 'agent'))),
    };
    this.find = options.find ?? findExecutable;
    this.login = options.login ?? codexApiLogin;
  }
  private readonly find: typeof findExecutable;
  private readonly login: typeof codexApiLogin;
  private dshProfilePath(profile: 'web' | 'dsh-tui') { return join(this.homes.dsh, 'profiles', profile, 'cordis.patch.yml'); }
  private dshCredentialPath() { return join(this.homes.dsh, '.credentials.yaml'); }
  private piAuthPath() { return join(this.homes.pi, 'auth.json'); }
  private configPath(id: Backend) {
    if (id === 'claude') return join(this.homes.claude, 'settings.json');
    if (id === 'codex') return join(this.homes.codex, 'config.toml');
    if (id === 'pi') return join(this.homes.pi, 'models.json');
    return this.dshProfilePath('web');
  }
  async info(id: Backend): Promise<AgentSetupInfo> {
    const info: AgentSetupInfo = { id, executable: await this.find(id), configPath: this.configPath(id), credentialPresent: false, baseUrl: '', model: '', ...guides[id] };
    try {
      if (id === 'claude') {
        const config = jsonObject(await readNative(info.configPath));
        const env = jsonObject(config.env === undefined ? null : JSON.stringify(config.env));
        info.credentialPresent = Boolean(env.ANTHROPIC_API_KEY || env.ANTHROPIC_AUTH_TOKEN || process.env.ANTHROPIC_API_KEY || process.env.ANTHROPIC_AUTH_TOKEN);
        info.baseUrl = typeof env.ANTHROPIC_BASE_URL === 'string' ? env.ANTHROPIC_BASE_URL : '';
        info.model = typeof config.model === 'string' ? config.model : '';
      } else if (id === 'dsh') {
        info.credentialPath = this.dshCredentialPath();
        const entry = dshEntries(await readNative(info.configPath)).find(value => value.id === 'llm-pi-ai');
        const provider = objectValue(objectValue(entry?.config)?.providers)?.[DSH_PROVIDER_ID];
        const configured = objectValue(provider);
        if (configured) {
          info.baseUrl = typeof configured.baseURL === 'string' ? configured.baseURL : '';
          const first = Array.isArray(configured.models) ? objectValue(configured.models[0]) : null;
          info.model = typeof first?.id === 'string' ? first.id : '';
        }
        const credentials = parseYamlObject(await readNative(info.credentialPath), 'DSH 凭据文件');
        const refs = objectValue(credentials.refs);
        info.credentialPresent = Boolean((typeof refs?.[DSH_API_KEY_REF] === 'string' && refs[DSH_API_KEY_REF]) || process.env[DSH_API_KEY_REF]);
      } else if (id === 'pi') {
        info.credentialPath = this.piAuthPath();
        const config = jsonObject(await readNative(info.configPath));
        const provider = piProvider(config);
        info.baseUrl = typeof provider?.baseUrl === 'string' ? provider.baseUrl : '';
        const first = Array.isArray(provider?.models) ? objectValue(provider.models[0]) : null;
        info.model = typeof first?.id === 'string' ? first.id : '';
        const auth = jsonObject(await readNative(info.credentialPath));
        const credential = piCredential(auth);
        info.credentialPresent = Boolean(credential && ['api_key', 'oauth'].includes(String(credential.type)));
      } else {
        const config = parseToml(await readNative(info.configPath) ?? '');
        info.model = typeof config.model === 'string' ? config.model : '';
        const provider = (config.model_providers as TomlTable | undefined)?.[String(config.model_provider)] as TomlTable | undefined;
        info.baseUrl = typeof provider?.base_url === 'string' ? provider.base_url : '';
        // Only report existence, never return native OAuth tokens or keys.
        info.credentialPresent = await lstat(join(this.homes.codex, 'auth.json')).then(() => true, () => false) || Boolean(process.env.OPENAI_API_KEY);
      }
    } catch { info.error = '原生配置无法读取或格式不正确，请在本机检查后再保存。'; }
    // Even a configured URL can contain a token in older configs; do not expose it.
    try { const url = new URL(info.baseUrl); if (url.username || url.password || url.search || url.hash) info.baseUrl = ''; } catch { info.baseUrl = ''; }
    return info;
  }
  async list() { return Promise.all((['claude', 'codex', 'dsh', 'pi'] as const).map(id => this.info(id))); }
  /** The OpenAI-compatible API the user configured here for dsh, else for Pi:
   * Dili's own coordinator reuses it. Null when neither has a managed provider
   * with a key. The key is returned to the server only, never to a browser. */
  async managedApi(): Promise<{ baseUrl: string; model: string; apiKey: string; source: 'dsh' | 'pi' } | null> {
    for (const id of ['dsh', 'pi'] as const) {
      try {
        const info = await this.info(id);
        if (!info.baseUrl || info.error) continue;
        let apiKey = '';
        if (id === 'dsh') {
          const refs = objectValue(parseYamlObject(await readNative(this.dshCredentialPath()), 'DSH 凭据文件').refs);
          apiKey = typeof refs?.[DSH_API_KEY_REF] === 'string' ? refs[DSH_API_KEY_REF] as string : process.env[DSH_API_KEY_REF] ?? '';
        } else {
          const credential = piCredential(jsonObject(await readNative(this.piAuthPath())));
          apiKey = credential?.type === 'api_key' && typeof credential.key === 'string' ? credential.key : '';
        }
        if (apiKey) return { baseUrl: info.baseUrl, model: info.model, apiKey, source: id };
      } catch { /* An unreadable native file means this source is unavailable. */ }
    }
    return null;
  }
  async command(id: Backend, action: SetupAction): Promise<string> {
    if (!['install', 'login', 'native'].includes(action)) invalid('未知的安装引导操作');
    if (action === 'install') return guides[id].installCommand;
    const file = await this.find(id);
    if (!file) invalid('请先安装后端，再刷新检测');
    // Use the detected binary, including explicit per-backend overrides.
    const quote = `'${file.replace(/'/g, `'"'"'`)}'`;
    if (id === 'codex' && action === 'login') return `${quote} login --device-auth`;
    if (id === 'claude' && action === 'login') return `${quote} auth login`;
    return quote + (id === 'dsh' ? ' web' : '');
  }
  async save(id: Backend, body: AgentConfigInput) {
    const input = validate(body);
    if (this.busy.has(id)) throw Object.assign(new Error('此后端的配置正在保存，请稍候'), { status: 409 });
    this.busy.add(id);
    try {
      if (id === 'dsh') return await this.saveDsh(input);
      if (id === 'pi') return await this.savePi(input);
      const path = this.configPath(id), original = await readNative(path);
      let contents: string;
      if (id === 'claude') {
        const config = jsonObject(original);
        const env = jsonObject(config.env === undefined ? null : JSON.stringify(config.env));
        if (input.apiKey) env.ANTHROPIC_API_KEY = input.apiKey;
        if (input.baseUrl !== undefined) { if (input.baseUrl) env.ANTHROPIC_BASE_URL = input.baseUrl; else delete env.ANTHROPIC_BASE_URL; }
        if (input.model !== undefined) { if (input.model) config.model = input.model; else delete config.model; }
        config.env = env;
        contents = JSON.stringify(config, null, 2) + '\n';
      } else {
        const config = parseToml(original ?? '');
        if (input.model !== undefined) { if (input.model) config.model = input.model; else delete config.model; }
        if (input.baseUrl) {
          const providers = config.model_providers ?? {};
          if (typeof providers !== 'object' || Array.isArray(providers) || providers instanceof Date) invalid('Codex model_providers 配置格式无效');
          // Keep all original provider definitions; select an explicit Dili-managed one.
          (providers as TomlTable).dili = { name: 'Dili custom API', base_url: input.baseUrl, wire_api: 'responses', requires_openai_auth: true };
          config.model_providers = providers;
          config.model_provider = 'dili';
        } else if (input.baseUrl === '') delete config.model_provider;
        contents = stringifyToml(config);
        if (input.apiKey) {
          const file = await this.find(id);
          if (!file) invalid('请先安装 Codex，再保存 API Key');
          // Validate config before the native authentication action.
          await this.login(file, input.apiKey);
        }
      }
      try { await writeNative(path, contents, original); }
      catch (error) { if (id === 'codex' && input.apiKey) throw new Error('API Key 已交给 Codex，但配置文件保存失败。请刷新后检查原生设置，再重试配置。'); throw error; }
      return { agent: await this.info(id), note: '已保存原生配置并备份原文件；新启动的会话会读取。未调用模型验证凭据。' };
    } catch (error) {
      // Parser errors may embed a source line containing credentials.
      if (error instanceof SyntaxError || error?.constructor?.name === 'TomlError' || error?.constructor?.name === 'YAMLParseError') throw Object.assign(new Error('原生配置格式不正确，未覆盖，请修复后重试'), { status: 400 });
      throw error;
    } finally { this.busy.delete(id); }
  }
  private managedApiMode(id: 'dsh' | 'pi', input: AgentConfigInput): 'set' | 'remove' | 'keep' {
    const hasBaseUrl = input.baseUrl !== undefined;
    const hasModel = input.model !== undefined;
    if (hasBaseUrl !== hasModel) invalid(id === 'dsh' ? 'dsh 自定义 API 需要同时填写 API 地址和模型' : 'Pi 自定义 API 需要同时填写 API 地址和模型');
    if (!hasBaseUrl) return 'keep';
    if ((input.baseUrl === '') !== (input.model === '')) invalid(id === 'dsh' ? 'dsh 自定义 API 需要同时填写 API 地址和模型' : 'Pi 自定义 API 需要同时填写 API 地址和模型');
    return input.baseUrl ? 'set' : 'remove';
  }
  private async saveDsh(input: AgentConfigInput) {
    const mode = this.managedApiMode('dsh', input);
    if (mode === 'keep' && input.apiKey && !(await this.info('dsh')).baseUrl) invalid('dsh 自定义 API 需要同时填写 API 地址和模型');
    // Validate and build both profile layers before writing the key, so a YAML
    // parser error cannot leave a secret behind without the matching provider.
    let web: { path: string; original: string | null; contents: string } | null = null;
    let tui: { path: string; original: string | null; contents: string } | null = null;
    if (mode !== 'keep') {
      const path = this.dshProfilePath('web'), original = await readNative(path);
      web = { path, original, contents: dshContents(original, mode, input) };
      // The TUI profile is a separate patch layer. Update it only when the user
      // already has one, so configuring Dili never creates a second native UI.
      const tuiPath = this.dshProfilePath('dsh-tui'), tuiOriginal = await readNative(tuiPath);
      if (tuiOriginal !== null) tui = { path: tuiPath, original: tuiOriginal, contents: dshContents(tuiOriginal, mode, input) };
    }
    const credentialPath = this.dshCredentialPath();
    let keySaved = false;
    if (input.apiKey) {
      const original = await readNative(credentialPath);
      await writeNative(credentialPath, dshCredentialContents(original, input.apiKey), original);
      keySaved = true;
    }
    try {
      if (web) await writeNative(web.path, web.contents, web.original);
      if (tui) await writeNative(tui.path, tui.contents, tui.original);
    } catch (error) {
      if (keySaved) throw new Error('DSH API Key 已保存，但 profile 配置保存失败。请刷新后检查原生配置，再重试。');
      throw error;
    }
    return { agent: await this.info('dsh'), note: mode === 'keep' ? '已保存 DSH 凭据并备份原文件；未改变 DSH provider 配置。新启动的会话会读取。未调用模型验证凭据。' : '已写入 DSH profile 配置和凭据文件并备份原文件；新启动的会话会读取。dsh-tui 配置仅在已存在时同步更新。未调用模型验证凭据。' };
  }
  private async savePi(input: AgentConfigInput) {
    const mode = this.managedApiMode('pi', input);
    if (mode === 'keep' && input.apiKey && !(await this.info('pi')).baseUrl) invalid('Pi 自定义 API 需要同时填写 API 地址和模型');
    // Build models.json before writing auth.json for the same reason as DSH:
    // a malformed native file must not strand a newly saved key.
    let models: { path: string; original: string | null; contents: string } | null = null;
    if (mode !== 'keep') {
      const path = this.configPath('pi'), original = await readNative(path);
      const config = jsonObject(original);
      if (config.providers !== undefined && !objectValue(config.providers)) invalid('Pi providers 配置不是映射，未覆盖');
      const providers = objectValue(config.providers) ?? {};
      if (mode === 'set') {
        providers[PI_PROVIDER_ID] = {
          name: 'Dili custom API',
          baseUrl: input.baseUrl,
          api: 'openai-completions',
          models: [{ id: input.model, name: input.model }],
        };
        config.providers = providers;
      } else {
        delete providers[PI_PROVIDER_ID];
        if (Object.keys(providers).length === 0) delete config.providers;
      }
      models = { path, original, contents: JSON.stringify(config, null, 2) + '\n' };
    }
    let keySaved = false;
    if (input.apiKey) {
      const authPath = this.piAuthPath(), authOriginal = await readNative(authPath);
      const auth = jsonObject(authOriginal);
      auth[PI_PROVIDER_ID] = { type: 'api_key', key: input.apiKey };
      await writeNative(authPath, JSON.stringify(auth, null, 2) + '\n', authOriginal);
      keySaved = true;
    }
    try { if (models) await writeNative(models.path, models.contents, models.original); }
    catch (error) {
      if (keySaved) throw new Error('Pi API Key 已保存，但 models.json 保存失败。请刷新后检查原生配置，再重试。');
      throw error;
    }
    return { agent: await this.info('pi'), note: mode === 'keep' ? '已保存 Pi auth.json 并备份原文件；未改变 models.json 的 provider 配置。新启动的会话会读取。未调用模型验证凭据。' : '已写入 Pi models.json 和 auth.json 并备份原文件；新启动的会话会读取。未调用模型验证凭据。' };
  }
}
