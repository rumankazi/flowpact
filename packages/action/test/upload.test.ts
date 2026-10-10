import { createHash, randomBytes } from 'node:crypto';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, utimesSync, writeFileSync } from 'node:fs';
import { createServer, type IncomingHttpHeaders, type Server } from 'node:http';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, inflateRawSync } from 'node:zlib';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

const log = vi.hoisted(() => ({ secrets: [] as string[], lines: [] as string[], warnings: [] as string[] }));

vi.mock('@actions/core', () => ({
  setSecret: (s: string) => void log.secrets.push(s),
  info: (m: string) => void log.lines.push(m),
  debug: (m: string) => void log.lines.push(m),
  warning: (m: string) => void log.warnings.push(m),
}));

const { retryWait, uploadArtifact, zip } = await import('../src/upload');

type Endpoint = 'CreateArtifact' | 'FinalizeArtifact' | 'block' | 'blocklist';
interface Reply {
  status: number;
  body?: string;
  headers?: Record<string, string>;
  /** Close the connection without answering. */
  hangUp?: boolean;
  /** Keep the connection open and never answer. */
  stall?: boolean;
}
interface Seen {
  endpoint: Endpoint;
  path: string;
  query: string;
  headers: IncomingHttpHeaders;
  body: Buffer;
  /** How many secrets were registered when the request arrived. */
  secrets: number;
}

const payload = Buffer.from(JSON.stringify({ scp: 'Actions.Foo Actions.Results:run-1:job-1' })).toString(
  'base64url',
);
const TOKEN = `eyJhbGciOiJIUzI1NiJ9.${payload}.TOKEN-SIGNATURE`;
// A signature with characters that are encoded in the URL: the service hands out base64.
const SIG = 'SIG+secret/=';
const SAS = `sv=2025-01-05&se=2026-06-05T00%3A00%3A00Z&sr=b&sp=cw&sig=${encodeURIComponent(SIG)}`;
const ENV = [
  'ACTIONS_RUNTIME_TOKEN',
  'ACTIONS_RESULTS_URL',
  'GITHUB_SERVER_URL',
  'GITHUB_RETENTION_DAYS',
  'ACTIONS_ARTIFACT_UPLOAD_TIMEOUT_MS',
];

let server: Server;
let base: string;
let seen: Seen[];
let replies: Partial<Record<Endpoint, Reply[]>>;
let saved: Record<string, string | undefined>;
let dir: string;
let files: string[];
let waits: number[];

const success: Record<Endpoint, () => Reply> = {
  CreateArtifact: () => ({
    status: 200,
    body: JSON.stringify({ ok: true, signed_upload_url: `${base}/blob/runs/flowpact-contracts.zip?${SAS}` }),
  }),
  block: () => ({ status: 201 }),
  blocklist: () => ({ status: 201 }),
  FinalizeArtifact: () => ({ status: 200, body: JSON.stringify({ ok: true, artifact_id: '42' }) }),
};

function endpointOf(path: string, query: URLSearchParams): Endpoint {
  if (path.startsWith('/twirp/github.actions.results.api.v1.ArtifactService/'))
    return path.split('/').at(-1) as Endpoint;
  return query.get('comp') === 'blocklist' ? 'blocklist' : 'block';
}

beforeEach(async () => {
  saved = Object.fromEntries(ENV.map((k) => [k, process.env[k]]));
  for (const k of ENV) delete process.env[k];
  seen = [];
  replies = {};
  Object.assign(log, { secrets: [], lines: [], warnings: [] });
  waits = [];
  vi.spyOn(retryWait, 'sleep').mockImplementation(async (ms) => void waits.push(ms));

  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (c: Buffer) => chunks.push(c));
    req.on('end', () => {
      const [path = '', query = ''] = req.url!.split('?');
      const endpoint = endpointOf(path, new URLSearchParams(query));
      seen.push({
        endpoint,
        path,
        query,
        headers: req.headers,
        body: Buffer.concat(chunks),
        secrets: log.secrets.length,
      });
      // Only the service's own endpoints answer; anything else is a 404, as on the real service.
      const fallback = Object.hasOwn(success, endpoint) ? success[endpoint] : undefined;
      if (typeof fallback !== 'function') return void res.writeHead(404).end();
      const reply = replies[endpoint]?.shift() ?? fallback();
      if (reply.hangUp) return void req.socket.destroy();
      if (reply.stall) return;
      res.writeHead(reply.status, reply.headers);
      res.end(reply.body ?? '');
    });
  });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  base = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  process.env.ACTIONS_RUNTIME_TOKEN = TOKEN;
  process.env.ACTIONS_RESULTS_URL = `${base}/`;

  dir = mkdtempSync(join(tmpdir(), 'flowpact-upload-'));
  mkdirSync(join(dir, 'flowpact-contracts/.github/flowpact/contracts/workflows'), { recursive: true });
  files = [
    join(dir, 'flowpact-contracts.patch'),
    join(dir, 'flowpact-contracts/README.md'),
    join(dir, 'flowpact-contracts/.github/flowpact/contracts/workflows/ci.contract.yml'),
  ];
  writeFileSync(files[0]!, 'diff --git a/x b/x\n'.repeat(40));
  writeFileSync(files[1]!, '# Regenerated workflow contracts\n');
  writeFileSync(files[2]!, 'inputs:\n  name: { type: string, required: true }\n');
  for (const f of files) utimesSync(f, new Date('2026-06-04T05:06:08Z'), new Date('2026-06-04T05:06:08Z'));
});

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(dir, { recursive: true, force: true });
  for (const [k, v] of Object.entries(saved)) {
    if (v === undefined) delete process.env[k];
    else process.env[k] = v;
  }
});

const of = (endpoint: Endpoint) => seen.filter((s) => s.endpoint === endpoint);
const json = (s: Seen) => JSON.parse(s.body.toString()) as Record<string, unknown>;

/** The blob as the service would assemble it: the blocks named in the last block list, in its order. */
function uploadedBlob(): Buffer {
  const blocks = new Map(of('block').map((s) => [new URLSearchParams(s.query).get('blockid'), s.body]));
  const list = of('blocklist').at(-1)!.body.toString();
  return Buffer.concat([...list.matchAll(/<Latest>([^<]*)<\/Latest>/g)].map((m) => blocks.get(m[1]!)!));
}

interface ZipFile {
  name: string;
  data: Buffer;
  flags: number;
  madeBy: number;
  mode: number;
  dosTime: number;
}

/** Reads a zip back: the central directory, each entry's local header, data and data descriptor. */
function unzip(buf: Buffer): ZipFile[] {
  const end = buf.length - 22;
  expect(buf.readUInt32LE(end)).toBe(0x06054b50);
  const count = buf.readUInt16LE(end + 10);
  let at = buf.readUInt32LE(end + 16);
  const out: ZipFile[] = [];
  for (let i = 0; i < count; i++) {
    expect(buf.readUInt32LE(at)).toBe(0x02014b50);
    const flags = buf.readUInt16LE(at + 8);
    const crc = buf.readUInt32LE(at + 16);
    const packed = buf.readUInt32LE(at + 20);
    const size = buf.readUInt32LE(at + 24);
    const nameLength = buf.readUInt16LE(at + 28);
    const local = buf.readUInt32LE(at + 42);
    const name = buf.subarray(at + 46, at + 46 + nameLength).toString(flags & 0x800 ? 'utf8' : 'latin1');
    expect(buf.readUInt16LE(at + 10)).toBe(8); // deflate
    expect(buf.readUInt32LE(local)).toBe(0x04034b50);
    expect(buf.readUInt16LE(local + 6)).toBe(flags);
    expect(
      buf.subarray(local + 30, local + 30 + nameLength).toString(flags & 0x800 ? 'utf8' : 'latin1'),
    ).toBe(name);
    const start = local + 30 + nameLength + buf.readUInt16LE(local + 28);
    const data = inflateRawSync(buf.subarray(start, start + packed));
    expect({ size: data.length, crc: crc32(data) }).toEqual({ size, crc });
    const descriptor = start + packed;
    expect([0, 4, 8, 12].map((o) => buf.readUInt32LE(descriptor + o))).toEqual([
      0x08074b50,
      crc,
      packed,
      size,
    ]);
    out.push({
      name,
      data,
      flags,
      madeBy: buf.readUInt16LE(at + 4),
      mode: buf.readUInt32LE(at + 38) >>> 16,
      dosTime: buf.readUInt32LE(at + 12),
    });
    at += 46 + nameLength + buf.readUInt16LE(at + 30) + buf.readUInt16LE(at + 32);
  }
  return out;
}

describe('uploadArtifact', () => {
  it('sends the requests @actions/artifact sends and returns the artifact id', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-04T05:06:07.890Z'));
    const res = await uploadArtifact('flowpact-contracts', files, dir, { retentionDays: 7 });

    expect(seen.map((s) => s.endpoint)).toEqual(['CreateArtifact', 'block', 'blocklist', 'FinalizeArtifact']);
    const [create, block, list, finalize] = seen as [Seen, Seen, Seen, Seen];
    for (const twirp of [create, finalize]) {
      expect(twirp.headers['content-type']).toBe('application/json');
      expect(twirp.headers.authorization).toBe(`Bearer ${TOKEN}`);
      expect(twirp.headers['user-agent']).toMatch(/^flowpact-action/);
    }
    expect(create.body.toString()).toBe(
      '{"workflow_run_backend_id":"run-1","workflow_job_run_backend_id":"job-1","name":"flowpact-contracts",' +
        '"expires_at":"2026-06-11T05:06:07.890Z","version":7,"mime_type":"application/zip"}',
    );

    // The signed URL as given, with the block parameters after it; never the runtime token.
    expect(block.path).toBe('/blob/runs/flowpact-contracts.zip');
    expect(block.query).toMatch(
      new RegExp(`^${SAS.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}&comp=block&blockid=[^&]+$`),
    );
    const id = new URLSearchParams(block.query).get('blockid')!;
    expect(Buffer.from(id, 'base64').toString()).toMatch(/^[0-9a-f-]{36}0{12}$/);
    expect(block.headers).toMatchObject({
      'content-type': 'application/octet-stream',
      'content-length': String(block.body.length),
      'x-ms-version': '2026-10-06',
      accept: 'application/xml',
    });
    expect(list.query).toBe(`${SAS}&comp=blocklist`);
    expect(list.body.toString()).toBe(
      `<?xml version="1.0" encoding="UTF-8" standalone="yes"?><BlockList><Latest>${id}</Latest></BlockList>`,
    );
    expect(list.headers).toMatchObject({
      'content-type': 'application/xml',
      'x-ms-blob-content-type': 'application/zip',
      'x-ms-version': '2026-10-06',
    });
    for (const s of [block, list]) {
      expect(s.headers.authorization).toBeUndefined();
      expect(s.headers['x-ms-client-request-id']).toMatch(/^[0-9a-f-]{36}$/);
    }

    const blob = uploadedBlob();
    expect(finalize.body.toString()).toBe(
      '{"workflow_run_backend_id":"run-1","workflow_job_run_backend_id":"job-1","name":"flowpact-contracts",' +
        `"size":"${blob.length}","hash":"sha256:${createHash('sha256').update(blob).digest('hex')}"}`,
    );
    expect(res).toEqual({ id: 42, size: blob.length });
  });

  it('zips the files under their paths relative to the root, as the library does', async () => {
    await uploadArtifact('flowpact-contracts', files, dir);
    const entries = unzip(uploadedBlob());
    expect(entries.map((e) => e.name)).toEqual([
      'flowpact-contracts.patch',
      'flowpact-contracts/README.md',
      'flowpact-contracts/.github/flowpact/contracts/workflows/ci.contract.yml',
    ]);
    entries.forEach((e, i) => {
      expect(e.data.equals(readFileSync(files[i]!))).toBe(true);
      expect(e).toMatchObject({ flags: 0x0008, madeBy: 0x032d });
      // 2026-06-04 05:06:08 UTC as an MS-DOS date and time.
      expect(e.dosTime).toBe(((2026 - 1980) << 25) | (6 << 21) | (4 << 16) | (5 << 11) | (6 << 5) | 4);
      if (process.platform !== 'win32') expect(e.mode).toBe(0o100644);
    });
  });

  it('masks the signature before the blob upload and never logs it or the token', async () => {
    replies.blocklist = [
      { status: 403, body: '<?xml version="1.0"?><Error><Code>AuthenticationFailed</Code></Error>' },
    ];
    await expect(uploadArtifact('flowpact-contracts', files, dir)).rejects.toThrow(
      'Put Block List failed: (403) AuthenticationFailed',
    );
    expect(log.secrets).toEqual([SIG, encodeURIComponent(SIG)]);
    expect(of('block')[0]!.secrets).toBe(2);
    expect(of('FinalizeArtifact')).toEqual([]);
    for (const line of [...log.lines, ...log.warnings]) {
      expect(line).not.toContain('TOKEN-SIGNATURE');
      expect(line).not.toContain(payload);
      expect(line).not.toContain(SIG);
      expect(line).not.toContain(encodeURIComponent(SIG));
    }
  });

  it('stops a stalled blob upload after the stall timeout, without retrying it or showing the signature', async () => {
    process.env.ACTIONS_ARTIFACT_UPLOAD_TIMEOUT_MS = '200';
    replies.block = [{ status: 0, stall: true }];
    const failure = await uploadArtifact('flowpact-contracts', files, dir).then(
      () => '',
      (err: Error) => err.message,
    );
    expect(failure).toMatch(/^Put Block failed: upload stalled: no progress in 200 ms \(Request timeout: /);
    expect(failure).toContain('sig=***');
    expect(of('block')).toHaveLength(1);
    for (const line of [failure, ...log.lines, ...log.warnings]) {
      expect(line).not.toContain(SIG);
      expect(line).not.toContain(encodeURIComponent(SIG));
    }
  });

  it('retries the artifact service as the library does', async () => {
    replies.CreateArtifact = [
      { status: 503, body: '{"msg":"busy"}' },
      { status: 429, body: '{}', headers: { 'retry-after': '2' } },
      { status: 500, body: '<html>not json</html>' },
    ];
    await uploadArtifact('flowpact-contracts', files, dir);
    expect(of('CreateArtifact')).toHaveLength(4);
    expect(waits.slice(0, 2)).toEqual([8000, 2000]);
    expect(waits[2]).toBeGreaterThanOrEqual(18000);
    expect(waits[2]).toBeLessThan(27000);
    expect(log.lines).toContain(
      'CreateArtifact attempt 1 of 5 failed: (503) Service Unavailable: busy. Retrying in 8000 ms',
    );
  });

  it('stops at a status that is not retried, at the storage quota, after five attempts or two minutes', async () => {
    const msg = 'an artifact with this name already exists on the workflow run';
    replies.CreateArtifact = [{ status: 409, body: JSON.stringify({ msg }) }];
    await expect(uploadArtifact('flowpact-contracts', files, dir)).rejects.toThrow(
      `Failed to CreateArtifact: (409) Conflict: ${msg}`,
    );
    expect(of('CreateArtifact')).toHaveLength(1);

    seen = [];
    replies.CreateArtifact = [{ status: 403, body: '{"msg":"insufficient usage to create artifact"}' }];
    await expect(uploadArtifact('flowpact-contracts', files, dir)).rejects.toThrow(
      'storage quota has been hit',
    );
    expect(seen).toHaveLength(1);

    seen = [];
    replies.FinalizeArtifact = Array.from({ length: 5 }, () => ({ status: 502, body: '{}' }));
    await expect(uploadArtifact('flowpact-contracts', files, dir)).rejects.toThrow(
      'Failed to FinalizeArtifact after 5 attempts: (502) Bad Gateway',
    );
    expect(of('FinalizeArtifact')).toHaveLength(5);

    seen = [];
    waits = [];
    replies.CreateArtifact = [0, 1].map(() => ({
      status: 429,
      body: '{}',
      headers: { 'retry-after': '100' },
    }));
    await expect(uploadArtifact('flowpact-contracts', files, dir)).rejects.toThrow(
      'Failed to CreateArtifact',
    );
    expect(of('CreateArtifact')).toHaveLength(2);
    expect(waits).toEqual([100_000]);
  });

  it('gives up at once when the artifact service is out of reach, as the library does', async () => {
    const closed = createServer();
    await new Promise<void>((r) => closed.listen(0, '127.0.0.1', r));
    const { port } = closed.address() as { port: number };
    await new Promise((r) => closed.close(r));
    process.env.ACTIONS_RESULTS_URL = `http://127.0.0.1:${port}/`;
    await expect(uploadArtifact('flowpact-contracts', files, dir)).rejects.toThrow(
      'Failed to CreateArtifact: unable to make request: ECONNREFUSED',
    );
    expect(waits).toEqual([]);
  });

  it('retries blob storage on 500, 503 and dropped connections, as the Azure client does', async () => {
    replies.block = [{ status: 500 }, { status: 503 }, { hangUp: true, status: 0 }];
    await uploadArtifact('flowpact-contracts', files, dir);
    const blocks = of('block');
    expect(blocks).toHaveLength(4);
    expect(new Set(blocks.map((b) => b.query)).size).toBe(1);
    expect(waits).toEqual([0, 4000, 12000]);

    seen = [];
    replies.block = Array.from({ length: 4 }, () => ({ hangUp: true, status: 0 }));
    await expect(uploadArtifact('flowpact-contracts', files, dir)).rejects.toThrow('Put Block failed');
    expect(of('block')).toHaveLength(4);
    expect(of('blocklist')).toEqual([]);
  });

  it('uploads more than 8 MiB in blocks of 8 MiB, listed in order', async () => {
    writeFileSync(files[1]!, randomBytes(9 * 1024 * 1024));
    await uploadArtifact('flowpact-contracts', files, dir);
    const blocks = of('block');
    expect(blocks).toHaveLength(2);
    expect(blocks[0]!.body.length).toBe(8 * 1024 * 1024);
    const ids = blocks.map((b) =>
      Buffer.from(new URLSearchParams(b.query).get('blockid')!, 'base64').toString(),
    );
    expect(ids[0]!.slice(0, 36)).toBe(ids[1]!.slice(0, 36));
    expect(ids.map((id) => id.slice(36))).toEqual(['000000000000', '000000000001']);
    expect(unzip(uploadedBlob())[1]!.data.equals(readFileSync(files[1]!))).toBe(true);
  });

  it('caps retention at the repository maximum and sends no expiry without retentionDays', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    vi.setSystemTime(new Date('2026-06-04T05:06:07.000Z'));
    process.env.GITHUB_RETENTION_DAYS = '3';
    await uploadArtifact('flowpact-contracts', files, dir, { retentionDays: 7 });
    expect(json(of('CreateArtifact')[0]!).expires_at).toBe('2026-06-07T05:06:07Z');
    expect(log.warnings).toEqual([
      'Retention days cannot be greater than the maximum allowed retention set within the repository. Using 3 instead.',
    ]);

    seen = [];
    await uploadArtifact('flowpact-contracts', files, dir);
    expect(json(of('CreateArtifact')[0]!)).not.toHaveProperty('expires_at');
  });

  it('does not upload on GitHub Enterprise Server, as the library does not', async () => {
    process.env.GITHUB_SERVER_URL = 'https://github.acme.example';
    await expect(uploadArtifact('flowpact-contracts', files, dir)).rejects.toThrow(
      'not available on GitHub Enterprise Server',
    );
    expect(seen).toEqual([]);
    process.env.GITHUB_SERVER_URL = 'https://acme.ghe.com';
    await expect(uploadArtifact('flowpact-contracts', files, dir)).resolves.toMatchObject({ id: 42 });
  });

  it('refuses names, paths and files the service would not take, and runs without runner variables', async () => {
    const fails = (message: string, ...args: Parameters<typeof uploadArtifact>) =>
      expect(uploadArtifact(...args)).rejects.toThrow(message);
    await fails('The artifact name "a/b"', 'a/b', files, dir);
    await fails('No files were found', 'x', [], dir);
    await fails('is not inside the artifact', 'x', [join(tmpdir(), 'elsewhere.txt')], dir);
    if (process.platform !== 'win32') {
      writeFileSync(join(dir, 'a:b.yml'), '');
      await fails('The path a:b.yml contains', 'x', [join(dir, 'a:b.yml')], dir);
    }
    process.env.ACTIONS_RUNTIME_TOKEN = `x.${Buffer.from('{"scp":"Actions.Other"}').toString('base64url')}.y`;
    await fails('has no Actions.Results scope', 'x', files, dir);
    process.env.ACTIONS_RUNTIME_TOKEN = 'not a token';
    await fails('has no Actions.Results scope', 'x', files, dir);
    delete process.env.ACTIONS_RUNTIME_TOKEN;
    await fails('Unable to get the ACTIONS_RUNTIME_TOKEN env variable', 'x', files, dir);
    expect(seen).toEqual([]);

    // What the library takes, this takes too.
    process.env.ACTIONS_RUNTIME_TOKEN = TOKEN;
    writeFileSync(join(dir, "it's (1) & more.yml"), '');
    await uploadArtifact("flowpact's contracts", [join(dir, "it's (1) & more.yml")], dir);
    expect(unzip(uploadedBlob()).map((e) => e.name)).toEqual(["it's (1) & more.yml"]);
  });
});

describe('zip', () => {
  it('flags UTF-8 names, keeps the permissions and clamps dates to what MS-DOS times hold', () => {
    const entries = unzip(
      zip([
        {
          name: 'dir/é名.md',
          data: Buffer.from('é\n'),
          mode: 0o100755,
          mtime: new Date('1975-01-01T00:00:00Z'),
        },
        { name: 'empty', data: Buffer.alloc(0), mode: 0o644, mtime: new Date('2050-01-01T00:00:00Z') },
      ]),
    );
    expect(entries.map(({ name, flags, mode, dosTime }) => ({ name, flags, mode, dosTime }))).toEqual([
      { name: 'dir/é名.md', flags: 0x0808, mode: 0o100755, dosTime: 0x00210000 },
      { name: 'empty', flags: 0x0008, mode: 0o100644, dosTime: 0x7f9fbf7d },
    ]);
    expect(entries[1]!.data.length).toBe(0);
  });
});
