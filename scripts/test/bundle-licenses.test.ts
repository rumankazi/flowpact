import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';

const root = join(import.meta.dirname, '../..');
const read = (path: string) => readFileSync(join(root, path), 'utf8');

describe('what the committed action bundle contains', () => {
  const sbom = JSON.parse(read('packages/action/dist/sbom.cdx.json')) as {
    bomFormat: string;
    specVersion: string;
    serialNumber: string;
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

  it('is a CycloneDX document that actions/attest accepts, with a serial number derived from its contents', () => {
    // actions/attest takes a file as CycloneDX only with bomFormat, serialNumber and specVersion.
    expect(sbom).toMatchObject({ bomFormat: 'CycloneDX', specVersion: '1.5' });
    expect(sbom.serialNumber).toMatch(
      /^urn:uuid:[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
    );
  });

  it('leaves out @actions/artifact and its packages: the action uploads the drift artifact itself', () => {
    const names = sbom.components.map((c) => c.name);
    for (const name of ['@actions/artifact', '@azure/storage-blob', 'archiver', 'unzip-stream'])
      expect(names).not.toContain(name);
  });
});
