import { spawn } from 'node:child_process';
import { join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { describe, expect, it } from 'vitest';

const ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const BIN = join(ROOT, 'packages/cli/dist/index.js');

interface Message {
  id?: number;
  method?: string;
  params?: { uri?: string; diagnostics?: { code: string }[] };
  result?: { serverInfo?: { name: string } };
}

/** Talks to `flowpact lsp` over stdio with hand-written framing, as an editor would. */
function session(args: string[]) {
  const child = spawn('node', [BIN, 'lsp', ...args], { cwd: ROOT, stdio: ['pipe', 'pipe', 'pipe'] });
  const messages: Message[] = [];
  const waiters: { test: (m: Message) => boolean; resolve: (m: Message) => void }[] = [];
  let buf = Buffer.alloc(0);
  child.stdout.on('data', (chunk: Buffer) => {
    buf = Buffer.concat([buf, chunk]);
    for (;;) {
      const sep = buf.indexOf('\r\n\r\n');
      if (sep < 0) return;
      const length = Number(/Content-Length: (\d+)/i.exec(buf.subarray(0, sep).toString())?.[1]);
      if (buf.length < sep + 4 + length) return;
      const message = JSON.parse(buf.subarray(sep + 4, sep + 4 + length).toString()) as Message;
      buf = buf.subarray(sep + 4 + length);
      messages.push(message);
      for (const w of waiters.splice(0)) {
        if (w.test(message)) w.resolve(message);
        else waiters.push(w);
      }
    }
  });
  const send = (message: object) => {
    const body = JSON.stringify({ jsonrpc: '2.0', ...message });
    child.stdin.write(`Content-Length: ${Buffer.byteLength(body)}\r\n\r\n${body}`);
  };
  const next = (test: (m: Message) => boolean) =>
    new Promise<Message>((resolve) => {
      const seen = messages.find(test);
      if (seen) resolve(seen);
      else waiters.push({ test, resolve });
    });
  const exited = new Promise<number | null>((resolve) => child.on('exit', resolve));
  return { send, next, exited };
}

describe('flowpact lsp', () => {
  it.each([[[]], [['--stdio']]])('serves diagnostics over stdio (%j) and exits cleanly', async (args) => {
    const folder = join(ROOT, 'fixtures/deep-nesting');
    const s = session(args);
    s.send({
      id: 1,
      method: 'initialize',
      params: {
        processId: null,
        rootUri: null,
        capabilities: {},
        workspaceFolders: [{ uri: pathToFileURL(folder).href, name: 'fixture' }],
      },
    });
    expect((await s.next((m) => m.id === 1)).result?.serverInfo?.name).toBe('flowpact');
    s.send({ method: 'initialized', params: {} });
    const published = await s.next(
      (m) =>
        m.method === 'textDocument/publishDiagnostics' && m.params?.uri?.endsWith('/pipeline.yml') === true,
    );
    expect(published.params?.diagnostics?.map((d) => d.code)).toContain('FP301');
    s.send({ id: 2, method: 'shutdown', params: null });
    await s.next((m) => m.id === 2);
    s.send({ method: 'exit', params: null });
    expect(await s.exited).toBe(0);
  });
});
