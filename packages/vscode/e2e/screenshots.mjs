// Renders the editor screenshots in the docs (apps/docs/public/screenshots/editor-*.png) from a real VS Code with the
// packaged extension installed, like scripts/gen-screenshots.ts does for the CLI. Run `pnpm build` first, then
// `pnpm --filter vscode-flowpact screenshots`. Windows open on screen while it runs. FLOWPACT_VSIX reuses a packaged
// extension; VSCODE_VERSION picks the version (default: stable).
import { spawnSync } from 'node:child_process';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { downloadAndUnzipVSCode, resolveCliArgsFromVSCodeExecutablePath } from '@vscode/test-electron';
import { _electron as electron } from 'playwright-core';

const here = fileURLToPath(new URL('.', import.meta.url));
const pkg = join(here, '..');
const repo = join(pkg, '../..');
const out = join(repo, 'apps/docs/public/screenshots');
const mod = process.platform === 'darwin' ? 'Meta' : 'Control';

// The fixtures are copied into a fresh home directory, so paths in the editor read ~/<fixture>/…
const home = mkdtempSync(join(tmpdir(), 'flowpact-screenshots-'));
const env = { ...process.env, HOME: home };
// Set when this runs from a terminal inside VS Code; it would start VS Code as plain Node.
delete env.ELECTRON_RUN_AS_NODE;
for (const fixture of ['deep-nesting', 'incident-matrix'])
  cpSync(join(repo, 'fixtures', fixture), join(home, fixture), { recursive: true });

const settings = {
  'workbench.colorTheme': 'Default Dark Modern',
  'workbench.startupEditor': 'none',
  'workbench.tips.enabled': false,
  'workbench.enableExperiments': false,
  'workbench.layoutControl.enabled': false,
  'workbench.secondarySideBar.defaultVisibility': 'hidden',
  'window.commandCenter': false,
  'window.restoreWindows': 'none',
  'window.title': '${activeEditorShort}${separator}${rootName}',
  'chat.disableAIFeatures': true,
  'editor.minimap.enabled': false,
  'editor.fontSize': 14,
  'editor.lineHeight': 21,
  'editor.stickyScroll.enabled': false,
  'editor.hover.delay': 100,
  'editor.occurrencesHighlight': 'off',
  'editor.selectionHighlight': false,
  'editor.guides.indentation': false,
  'breadcrumbs.enabled': false,
  'security.workspace.trust.enabled': false,
  'telemetry.telemetryLevel': 'off',
  'update.mode': 'none',
  'extensions.ignoreRecommendations': true,
  'extensions.autoCheckUpdates': false,
  'git.enabled': false,
};

let profiles = 0;
/** A fresh user data directory, so no window inherits another one's layout. */
function profile(extra = {}) {
  const dir = join(home, `.profile-${profiles++}`);
  mkdirSync(join(dir, 'User'), { recursive: true });
  writeFileSync(join(dir, 'User/settings.json'), JSON.stringify({ ...settings, ...extra }));
  return dir;
}

const run = (cmd, args, opts = {}) => {
  const res = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (res.status !== 0) throw new Error(`${cmd} ${args.join(' ')} failed:\n${res.stdout}${res.stderr}`);
};

const vsix = process.env.FLOWPACT_VSIX || join(home, 'flowpact.vsix');
if (!process.env.FLOWPACT_VSIX)
  run(join(pkg, 'node_modules/.bin/vsce'), ['package', '--no-dependencies', '-o', vsix], { cwd: pkg });
const exe = await downloadAndUnzipVSCode({ version: process.env.VSCODE_VERSION || 'stable' });
const extensions = join(home, '.extensions');
const [cli, ...cliArgs] = resolveCliArgsFromVSCodeExecutablePath(exe);
const install = [
  '--install-extension',
  vsix,
  `--user-data-dir=${profile()}`,
  `--extensions-dir=${extensions}`,
];
run(cli, [...cliArgs, ...install], { env });

const quickInput = '.quick-input-widget:not([style*="display: none"]) input';

async function launch(fixture, size, extra) {
  const app = await electron.launch({
    executablePath: exe,
    env,
    args: [
      join(home, fixture),
      `--user-data-dir=${profile(extra)}`,
      `--extensions-dir=${extensions}`,
      '--skip-welcome',
      '--skip-release-notes',
      '--disable-workspace-trust',
      '--new-window',
    ],
  });
  const win = await app.firstWindow();
  await app.evaluate(
    ({ BrowserWindow }, s) => BrowserWindow.getAllWindows()[0].setBounds({ x: 40, y: 40, ...s }),
    size,
  );
  await win.waitForSelector('.monaco-workbench', { timeout: 60_000 });
  return { app, win };
}

async function command(win, name) {
  await win.keyboard.press(`${mod}+Shift+P`);
  await win.waitForSelector(quickInput);
  await win.keyboard.type(name);
  await win.waitForTimeout(500);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(400);
}

async function open(win, file) {
  await win.keyboard.press(`${mod}+P`);
  await win.waitForSelector(quickInput);
  await win.keyboard.type(file);
  await win.waitForTimeout(700);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(800);
}

/** Puts the cursor `offset` characters into the first occurrence of `needle` in the fixture file. */
async function cursorAt(win, fixture, file, needle, offset) {
  const text = readFileSync(join(home, fixture, file), 'utf8');
  const i = text.indexOf(needle);
  if (i < 0) throw new Error(`${needle} not found in ${file}`);
  const before = text.slice(0, i + offset).split('\n');
  await win.keyboard.press('Control+G');
  await win.waitForSelector(quickInput);
  await win.keyboard.type(`${before.length}:${before.at(-1).length + 1}`);
  await win.keyboard.press('Enter');
  await win.waitForTimeout(300);
}

/** Opens a file with findings and waits until the server has published them, then tidies the window. */
async function ready(win, file) {
  await open(win, file);
  await win.waitForSelector('.squiggly-error, .squiggly-warning, .squiggly-info', { timeout: 60_000 });
  await win.waitForTimeout(800);
  await command(win, 'Notifications: Clear All Notifications');
  await command(win, 'View: Close Primary Side Bar');
}

async function hover(win) {
  await command(win, 'Show or Focus Hover');
  await win.waitForSelector('.monaco-hover-content', { timeout: 15_000 });
  await win.waitForTimeout(600);
}

const shots = [
  {
    name: 'editor-hover',
    fixture: 'deep-nesting',
    size: { width: 820, height: 480 },
    async take(win) {
      const file = '.github/workflows/build.yml';
      await ready(win, file);
      await cursorAt(win, this.fixture, file, 'inputs.environment', 6);
      await hover(win);
    },
  },
  {
    name: 'editor-diagnostics',
    fixture: 'incident-matrix',
    size: { width: 820, height: 640 },
    // Below the line, so the matrix the finding is about stays visible.
    settings: { 'editor.hover.above': false },
    async take(win) {
      const file = '.github/workflows/tests.yml';
      await ready(win, file);
      await cursorAt(win, this.fixture, file, 'matrix.config', 5);
      await hover(win);
    },
  },
  {
    name: 'editor-references',
    fixture: 'incident-matrix',
    size: { width: 820, height: 600 },
    async take(win) {
      await ready(win, '.github/workflows/tests.yml');
      const file = '.github/workflows/run-suite.yml';
      await open(win, file);
      await cursorAt(win, this.fixture, file, '      config:', 7);
      await command(win, 'Peek References');
      await win.waitForSelector('.peekview-widget', { timeout: 15_000 });
      await win.waitForTimeout(1000);
    },
  },
];

try {
  for (const shot of shots) {
    const { app, win } = await launch(shot.fixture, shot.size, shot.settings);
    try {
      await shot.take(win);
      await win.screenshot({ path: join(out, `${shot.name}.png`) });
      console.log(`wrote ${shot.name}.png`);
    } finally {
      await app.close();
    }
  }
} finally {
  rmSync(home, { recursive: true, force: true });
}
