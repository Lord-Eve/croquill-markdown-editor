import { configDefaults, defineConfig } from 'vitest/config';
import { testIgnoredPaths } from './tests/server';

export default defineConfig({
  server: { watch: { ignored: testIgnoredPaths } },
  test: {
    include: ['tests/**/*.test.ts'],
    fileParallelism: false,
    maxWorkers: 1,
    exclude: [...configDefaults.exclude, ...testIgnoredPaths],
  },
});
