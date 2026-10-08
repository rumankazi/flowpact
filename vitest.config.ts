import { fileURLToPath } from 'node:url';
import { defineConfig } from 'vitest/config';

const src = (pkg: string) => fileURLToPath(new URL(`./packages/${pkg}/src/index.ts`, import.meta.url));

export default defineConfig({
  resolve: {
    alias: { '@wfc/core': src('core'), '@wfc/reporters': src('reporters') },
  },
  test: {
    include: ['packages/*/test/**/*.test.ts', 'scripts/test/**/*.test.ts'],
    // The CLI e2e tests spawn node processes, which take seconds each on shared CI runners.
    testTimeout: 60_000,
    // The CLI e2e suites run the bundle; build it once (scripts/test/build-cli.ts).
    globalSetup: ['scripts/test/build-cli.ts'],
    // @actions/workflow-parser imports JSON without import attributes; let Vite transform it like the bundler does.
    server: { deps: { inline: [/@actions\/workflow-parser/, /@actions\/expressions/] } },
    coverage: {
      provider: 'v8',
      include: ['packages/*/src/**'],
      exclude: ['packages/cli/src/index.ts'],
      reporter: ['text-summary', 'html', 'json-summary'],
      thresholds: {
        lines: 80,
        'packages/core/src/**': { lines: 90 },
      },
    },
  },
});
