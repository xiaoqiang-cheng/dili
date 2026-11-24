import { existsSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

/** System libraries Chromium needs, unpacked without root by
 * scripts/browser-libs.sh when the machine lacks them (e.g. a fresh WSL).
 * Absent directory: the browser uses the system libraries as usual. */
export const BROWSER_LIBS = process.env.DILI_BROWSER_LIBS || join(homedir(), '.local/share/dili-browser-libs/usr/lib/x86_64-linux-gnu');

export function browserLaunchEnv(): Record<string, string> | undefined {
  if (process.platform !== 'linux' || !existsSync(BROWSER_LIBS)) return undefined;
  const env = Object.fromEntries(Object.entries(process.env).filter((entry): entry is [string, string] => typeof entry[1] === 'string'));
  return { ...env, LD_LIBRARY_PATH: [BROWSER_LIBS, process.env.LD_LIBRARY_PATH].filter(Boolean).join(':') };
}
