import { defineConfig } from 'tsup';

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node24',
  platform: 'node',
  clean: true,
  splitting: false,
  // The runner executes dist/index.js straight from the repository, so everything is bundled into that one file.
  noExternal: [/.*/],
  banner: {
    // Some bundled dependencies are CommonJS and call require(); give the ESM bundle one.
    js: "import { createRequire as __wfcCreateRequire } from 'node:module';\nconst require = __wfcCreateRequire(import.meta.url);",
  },
  esbuildOptions(options) {
    options.conditions = ['source'];
  },
});
