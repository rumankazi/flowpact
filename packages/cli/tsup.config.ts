import { defineConfig } from 'tsup';
import { bundleLicenses } from '../../scripts/bundle-licenses';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  entry: ['src/index.ts'],
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  // Bundle everything (workspace packages and every dependency): the published CLI is a single file with no runtime
  // dependencies, so installing it downloads nothing else.
  noExternal: [/.*/],
  banner: {
    // Some bundled dependencies are CommonJS and call require(); give the ESM bundle one.
    js: "#!/usr/bin/env node\nimport { createRequire as __flowpactCreateRequire } from 'node:module';\nconst require = __flowpactCreateRequire(import.meta.url);",
  },
  esbuildOptions(options) {
    options.conditions = ['source'];
  },
  // dist/THIRD_PARTY_LICENSES.txt and dist/sbom.cdx.json: what the bundle contains, shipped in the npm package.
  esbuildPlugins: [
    bundleLicenses({ name: 'flowpact', version: pkg.version, description: 'The flowpact command-line tool' }),
  ],
});
