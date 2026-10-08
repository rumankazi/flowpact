import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

/**
 * Builds the CLI once before any test file runs. The e2e suites run the bundle in parallel, so building it from each
 * suite's beforeAll could replace the file while another suite executes it.
 */
export default function setup(): void {
  execFileSync('pnpm', ['--filter', 'flowpact', 'build'], {
    cwd: fileURLToPath(new URL('../../', import.meta.url)),
    stdio: 'ignore',
  });
}
