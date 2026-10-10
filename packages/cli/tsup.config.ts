import { copyFileSync } from 'node:fs';
import { defineConfig } from 'tsup';
import { bundleLicenses } from '../../scripts/bundle-licenses';
import pkg from './package.json' with { type: 'json' };

export default defineConfig({
  // dist/index.js is the `flowpact` command, dist/api.js the API (`import { lint } from 'flowpact'`). With splitting,
  // the engine both use is one shared chunk (dist/chunk-<hash>.js) instead of two copies.
  entry: { index: 'src/index.ts', api: 'src/api.ts' },
  format: ['esm'],
  target: 'node22',
  platform: 'node',
  clean: true,
  splitting: true,
  // Bundle everything (workspace packages and every dependency): the published package has no runtime dependencies,
  // so installing it downloads nothing else.
  noExternal: [/.*/],
  banner: {
    // Some bundled dependencies are CommonJS and call require(); give every ESM file one. The command's hashbang comes
    // from src/index.ts, which esbuild keeps above this.
    js: "import { createRequire as __flowpactCreateRequire } from 'node:module';\nconst require = __flowpactCreateRequire(import.meta.url);",
  },
  esbuildOptions(options) {
    options.conditions = ['source'];
  },
  // dist/THIRD_PARTY_LICENSES.txt and dist/sbom.cdx.json: what the bundle contains, shipped in the npm package.
  esbuildPlugins: [
    bundleLicenses({
      name: 'flowpact',
      version: pkg.version,
      description: 'The flowpact command-line tool and API',
    }),
  ],
  // The API's types are written by hand (api.d.ts): self-contained, without the engine's internal types.
  onSuccess: async () => copyFileSync('api.d.ts', 'dist/api.d.ts'),
});
