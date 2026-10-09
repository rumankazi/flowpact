import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('what the committed action bundle contains', () => {
  const sbom = JSON.parse(read('packages/action/dist/sbom.cdx.json')) as {
    metadata: { component: { name: string; version: string } };
    components: { name: string; version: string; licenses: unknown[] }[];
  };
  const notices = read('packages/action/dist/THIRD_PARTY_LICENSES.txt');

  it('lists the same packages in the SBOM and the notices, each with a license', () => {
    const { version } = JSON.parse(read('packages/action/package.json')) as { version: string };
    expect(sbom.metadata.component).toMatchObject({ name: 'flowpact-action', version });
    expect(notices).toContain(
      `bundles the code of the following ${sbom.components.length} third-party packages`,
    );
    for (const c of sbom.components) {
      expect(notices).toContain(`\n${c.name} ${c.version} (`);
      expect({ package: c.name, licenses: c.licenses.length }).toEqual({ package: c.name, licenses: 1 });
    }
    expect(notices).not.toContain('no license declared');
  });

  it('leaves out unzip-stream, which @actions/artifact needs only to download artifacts', () => {
    expect(sbom.components.map((c) => c.name)).not.toContain('unzip-stream');
  });
});
