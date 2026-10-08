import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  // Bundle the workspace packages and their deps so the published CLI is a single file.
  noExternal: [/^@wfc\//, /^@actions\//, 'yaml', 'zod', 'string-width'],
  banner: {
    // Some bundled dependencies are CommonJS and call require(); give the ESM bundle one.
    js: "#!/usr/bin/env node\nimport { createRequire as __wfcCreateRequire } from 'node:module';\nconst require = __wfcCreateRequire(import.meta.url);",
  },
  esbuildOptions(options) {
    options.conditions = ['source'];
  },
});
