import { build } from 'esbuild';
import { copyFile, mkdir } from 'node:fs/promises';
await mkdir('dist/relay', { recursive: true });
await build({ entryPoints: ['server/relay-main.ts'], outfile: 'dist/relay/relay.mjs', bundle: true, platform: 'node', target: 'node24', format: 'esm', banner: { js: "import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" } });
await copyFile('relay/index.html', 'dist/relay/index.html');
await copyFile('relay/public.caddy', 'dist/relay/public.caddy');
await copyFile('relay/pwa.caddy', 'dist/relay/pwa.caddy');
console.log('配对服务构建就绪：dist/relay');
await copyFile('relay/retired-origin.caddy', 'dist/relay/retired-origin.caddy');
