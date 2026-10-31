import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { readFileSync } from 'node:fs';
const version = JSON.parse(readFileSync(new URL('./package.json', import.meta.url), 'utf8')).version;
const build = new Date().toISOString();

export default defineConfig({
  define: { __DILI_VERSION__: JSON.stringify(version), __DILI_BUILD__: JSON.stringify(build) },
  plugins: [react(), { name: 'dili-build-info', generateBundle() { this.emitFile({ type: 'asset', fileName: 'build-info.json', source: JSON.stringify({ version, build }) }); } }],
  experimental: {
    // The same build runs at / and /connect/d/<device>. HTML URLs are
    // prefixed by remoteHtml; JS preloads and imported assets must resolve
    // beside their importing module, not against the public website root.
    // Keep HTML root-relative so device links also work without a final slash.
    renderBuiltUrl(_filename, { hostType }) {
      return { relative: hostType !== 'html' };
    },
  },
  build: {
    // Browser tests build into an isolated throwaway directory so they never
    // replace assets served by an already-running local SessionDeck instance.
    target: ['chrome111', 'edge111', 'firefox111', 'safari16.2'],
    outDir: process.env.SESSIONDECK_CLIENT_DIR || 'dist/client',
    emptyOutDir: true,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (id.includes('/node_modules/@xterm/')) return 'terminal';
          if (id.includes('/node_modules/react/') || id.includes('/node_modules/react-dom/')) return 'react';
        },
      },
    },
  },
  server: { host: '127.0.0.1' },
});
