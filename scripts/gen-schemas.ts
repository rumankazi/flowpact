/** Publishes the JSON Schemas wfc reads and writes to the docs site (/schemas/<name>/v<n>.json). */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { configJsonSchema, contractJsonSchema, reportJsonSchema, SCHEMA_VERSIONS } from '@wfc/core';

const OUT = join(import.meta.dirname, '../apps/docs/public/schemas');
const schemas = {
  config: configJsonSchema(),
  contract: contractJsonSchema(),
  report: reportJsonSchema(),
} as const;

for (const [name, schema] of Object.entries(schemas)) {
  const dir = join(OUT, name);
  mkdirSync(dir, { recursive: true });
  const file = join(dir, `v${SCHEMA_VERSIONS[name as keyof typeof schemas]}.json`);
  writeFileSync(file, `${JSON.stringify(schema, null, 2)}\n`);
  console.log(`wrote ${file}`);
}
