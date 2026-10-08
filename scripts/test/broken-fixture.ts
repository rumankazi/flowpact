import { copyFileSync, mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

/**
 * Puts the deliberately invalid workflow in place for the tests (fixtures/broken). It is committed under a name no YAML
 * tool picks up, because GitHub's code scanning parses every .yml file and reports this one as a syntax error.
 */
export default function setup(): void {
  const root = fileURLToPath(new URL('../../fixtures/broken/', import.meta.url));
  mkdirSync(`${root}.github/workflows`, { recursive: true });
  copyFileSync(`${root}yaml-error.yml.txt`, `${root}.github/workflows/yaml-error.yml`);
}
