import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import { copyFile, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { promisify } from 'node:util';
import test from 'node:test';

const execute = promisify(execFile);

for (const fail of [false, true]) {
  test(`restart reports ${fail ? 'failure' : 'readiness'} using isolated service commands`, async t => {
    const root = await mkdtemp(join(tmpdir(), 'dili-restart-test-'));
    t.after(() => rm(root, { recursive: true, force: true }));
    const scripts = join(root, 'scripts'), bin = join(root, 'bin');
    await mkdir(scripts); await mkdir(bin);
    await copyFile(new URL('./restart-service.sh', import.meta.url), join(scripts, 'restart-service.sh'));
    const log = join(root, 'commands'), ready = join(root, 'ready');
    // No real systemd, listener, process signal, dependency install or build.
    await writeFile(join(bin, 'systemctl'), `#!/bin/sh
printf '%s\\n' "$*" >> "$RESTART_LOG"
case "$*" in
 *LoadState*) echo loaded ;;
 *FragmentPath*) echo /nonexistent/dili-test-unit ;;
 *'enable --now'*) ${fail ? 'exit 23' : 'touch "$RESTART_READY"'} ;;
esac
`, { mode: 0o755 });
    await writeFile(join(bin, 'npx'), '#!/bin/sh\necho no\n', { mode: 0o755 });
    await writeFile(join(bin, 'lsof'), '#!/bin/sh\nif [ -f "$RESTART_READY" ]; then echo 999999; else exit 1; fi\n', { mode: 0o755 });
    const run = execute('bash', [join(scripts, 'restart-service.sh'), '--detached'], {
      env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_CONFIG_HOME: join(root, 'config'), RESTART_LOG: log, RESTART_READY: ready }, timeout: 5000,
    });
    if (fail) {
      await assert.rejects(run, (error: { code?: number; stderr?: string; stdout?: string }) => error.code === 1 && /启动失败/.test(error.stderr ?? '') && !/已启动：http/.test(error.stdout ?? ''));
    } else {
      const result = await run;
      assert.match(result.stdout, /Dili 已启动/);
    }
    const commands = await readFile(log, 'utf8');
    assert.match(commands, /daemon-reload/);
    assert.match(commands, /enable --now dili/);
    assert.doesNotMatch(commands, /(?:stop|restart) dili/);
  });
}
