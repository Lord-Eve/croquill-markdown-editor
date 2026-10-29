import { createServer } from 'vite';
import { fileURLToPath } from 'node:url';

export const testIgnoredPaths = ['**/.tools/**', '**/src-tauri/**', '**/examples/private/**'];

/** Every browser test uses the same bounded watcher and dependency scan. */
export function createTestServer() {
  return createServer({
    configFile: false,
    root: fileURLToPath(new URL('../', import.meta.url)),
    cacheDir: 'node_modules/.vite-tests',
    logLevel: 'error',
    optimizeDeps: { entries: ['tests/harness.html'] },
    server: { host: '127.0.0.1', port: 0, watch: { ignored: testIgnoredPaths } },
  });
}
