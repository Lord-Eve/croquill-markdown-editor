import { createServer } from 'vite';
import { createServer as createSocket } from 'node:net';
import { fileURLToPath } from 'node:url';

export const testIgnoredPaths = ['**/.tools/**', '**/src-tauri/**', '**/examples/private/**'];

/** A port the system has just confirmed free on the loopback address. */
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const socket = createSocket();
    socket.once('error', reject);
    socket.listen(0, '127.0.0.1', () => {
      const address = socket.address();
      socket.close(() => typeof address === 'object' && address ? resolve(address.port) : reject(Error('No free port')));
    });
  });
}

/** Every browser test uses the same bounded watcher and dependency scan. */
export async function createTestServer() {
  return createServer({
    configFile: false,
    root: fileURLToPath(new URL('../', import.meta.url)),
    cacheDir: 'node_modules/.vite-tests',
    logLevel: 'error',
    optimizeDeps: { entries: ['tests/harness.html'] },
    // Vite reads port 0 as its default 5173 and stops if another program holds that
    // port in a way it cannot share (seen on 2026-11-13 with a local proxy). Ask the
    // system for a free port instead.
    server: { host: '127.0.0.1', port: await freePort(), strictPort: false, watch: { ignored: testIgnoredPaths } },
  });
}
