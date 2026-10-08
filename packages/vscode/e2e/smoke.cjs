// Runs inside VS Code with fixtures/deep-nesting open: the extension must start its bundled server and serve
// diagnostics (for open and closed files), hover and go to definition.
const assert = require('node:assert/strict');
const vscode = require('vscode');

const codeOf = (d) => String(typeof d.code === 'object' ? d.code.value : d.code);

async function waitFor(what, read, timeoutMs = 60_000) {
  const end = Date.now() + timeoutMs;
  for (;;) {
    const value = await read();
    if (value) return value;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
}

function positionOf(doc, needle, offset = 0) {
  const i = doc.getText().indexOf(needle);
  assert.ok(i >= 0, `${needle} not found`);
  return doc.positionAt(i + offset);
}

exports.run = async () => {
  const id = process.env.FLOWPACT_EXTENSION_ID;
  const extension = id && vscode.extensions.getExtension(id);
  assert.ok(extension, `the extension ${id} is not installed`);
  await extension.activate();
  const folder = vscode.workspace.workspaceFolders?.[0];
  assert.ok(folder, 'no workspace folder is open');
  const pipeline = vscode.Uri.joinPath(folder.uri, '.github/workflows/pipeline.yml');
  const doc = await vscode.workspace.openTextDocument(pipeline);
  await vscode.window.showTextDocument(doc);

  const found = await waitFor('FP301 in pipeline.yml', () => {
    const list = vscode.languages.getDiagnostics(pipeline).filter((d) => d.source === 'flowpact');
    return list.some((d) => codeOf(d) === 'FP301') ? list : undefined;
  });
  const build = vscode.Uri.joinPath(folder.uri, '.github/workflows/build.yml');
  const closed = vscode.languages.getDiagnostics(build).filter((d) => d.source === 'flowpact');
  assert.ok(
    closed.some((d) => codeOf(d) === 'FP101'),
    `build.yml (not open) has ${closed.map(codeOf).join(', ') || 'no'} diagnostics`,
  );

  const hovers = await vscode.commands.executeCommand(
    'vscode.executeHoverProvider',
    pipeline,
    positionOf(doc, 'inputs.environment', 8),
  );
  const text = hovers
    .flatMap((h) => h.contents)
    .map((c) => (typeof c === 'string' ? c : c.value))
    .join('\n');
  assert.match(text, /^\*\*flowpact\*\* · input · \[docs\]/m);
  assert.match(text, /`inputs\.environment` in `pipeline\.yml`/);

  const definitions = await vscode.commands.executeCommand(
    'vscode.executeDefinitionProvider',
    pipeline,
    positionOf(doc, 'environment: ${{', 2),
  );
  const targets = definitions.map(
    (d) => `${(d.targetUri ?? d.uri).path}:${(d.targetRange ?? d.range).start.line + 1}`,
  );
  assert.ok(
    targets.some((t) => t.endsWith('/.github/workflows/build.yml:5')),
    `go to definition went to ${targets.join(', ') || 'nothing'}`,
  );
  console.log(
    `flowpact smoke test passed: ${found.length} diagnostics in pipeline.yml, hover and definition work`,
  );
};
