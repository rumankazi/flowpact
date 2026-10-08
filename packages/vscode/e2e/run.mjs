// Starts VS Code (downloaded into .vscode-test/) with fixtures/deep-nesting open and runs smoke.cjs inside it.
// VSCODE_VERSION picks the version (default: stable); FLOWPACT_EXTENSION_PATH tests another copy of the extension,
// such as an unpacked .vsix.
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runTests } from '@vscode/test-electron';

const here = fileURLToPath(new URL('.', import.meta.url));
try {
  await runTests({
    version: process.env.VSCODE_VERSION || 'stable',
    extensionDevelopmentPath: process.env.FLOWPACT_EXTENSION_PATH || join(here, '..'),
    extensionTestsPath: join(here, 'smoke.cjs'),
    launchArgs: [join(here, '../../../fixtures/deep-nesting'), '--disable-extensions'],
  });
} catch (err) {
  console.error(err);
  process.exit(1);
}
