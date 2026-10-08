import { startLanguageServer } from '@flowpact/language-server';
import { defineCommand } from 'citty';

export const lspCommand = defineCommand({
  meta: {
    name: 'lsp',
    description:
      'Start the language server for editors (LSP over stdin/stdout unless another transport is given)',
  },
  args: {
    stdio: { type: 'boolean', description: 'Communicate over stdin/stdout (the default)' },
    'node-ipc': {
      type: 'boolean',
      description: 'Communicate over Node IPC (when the editor forks the server)',
    },
    socket: { type: 'string', description: 'Communicate over a TCP socket on this port', valueHint: 'port' },
  },
  run: () => {
    startLanguageServer();
  },
});
