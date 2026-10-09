import { defineConfig } from 'tsup';
import { bundleLicenses } from '../../scripts/bundle-licenses';
import pkg from './package.json' with { type: 'json' };

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
    js: "import { createRequire as __flowpactCreateRequire } from 'node:module';\nconst require = __flowpactCreateRequire(import.meta.url);",
  },
  esbuildOptions(options) {
    options.conditions = ['source'];
    // @actions/artifact imports unzip-stream only to download artifacts, which the action never does.
    options.alias = { 'unzip-stream': './src/stubs/unzip-stream.ts' };
  },
  // dist/THIRD_PARTY_LICENSES.txt and dist/sbom.cdx.json: what the committed bundle contains.
  esbuildPlugins: [
    bundleLicenses({
      name: 'flowpact-action',
      version: pkg.version,
      description: 'The flowpact GitHub Action',
    }),
  ],
});
