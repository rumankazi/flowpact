import { join } from 'node:path';
import * as vscode from 'vscode';
import {
  DidChangeConfigurationNotification,
  LanguageClient,
  type LanguageClientOptions,
  RevealOutputChannelOn,
  type ServerOptions,
  State,
  TransportKind,
} from 'vscode-languageclient/node';
import { type ExtensionSettings, hidesOverlapInOpenFiles, serverSettings, withoutOverlap } from './settings';

const GITHUB_ACTIONS = 'GitHub.vscode-github-actions';

/**
 * Workflows, action metadata, and flowpact's config and contracts. Matched by path, not language: the GitHub Actions
 * extension gives workflows its own language id. `file` only, so the original side of a git diff is not analyzed.
 */
const SELECTOR = [
  { scheme: 'file', pattern: '**/.github/workflows/*.{yml,yaml}' },
  { scheme: 'file', pattern: '**/action.{yml,yaml}' },
  { scheme: 'file', pattern: '**/.github/flowpact/**/*.{yml,yaml}' },
];

let client: LanguageClient | undefined;

export async function activate(context: vscode.ExtensionContext): Promise<void> {
  const output = vscode.window.createOutputChannel('flowpact', { log: true });
  const status = vscode.languages.createLanguageStatusItem('flowpact.status', SELECTOR);
  status.name = 'flowpact';
  status.text = 'flowpact';
  context.subscriptions.push(output, status);

  const read = (): ExtensionSettings => {
    const c = vscode.workspace.getConfiguration('flowpact');
    return {
      plugins: c.get('plugins', true),
      contracts: c.get('contracts', 'auto'),
      overlappingRules: c.get('overlappingRules', 'auto'),
      hiddenRules: c.get('hiddenRules', []),
    };
  };
  const current = () =>
    serverSettings(read(), { trusted: vscode.workspace.isTrusted, logLevel: output.logLevel });
  const overlapHidden = () =>
    hidesOverlapInOpenFiles(read(), {
      trusted: vscode.workspace.isTrusted,
      githubActions: vscode.extensions.getExtension(GITHUB_ACTIONS) !== undefined,
    });

  // FP502–FP505 are dropped only from open documents, the ones GitHub's extension validates. The server's diagnostics
  // are kept as sent, so opening or closing a file (or installing that extension) can filter them again.
  const sentDiagnostics = new Map<string, vscode.Diagnostic[]>();
  let hiding = overlapHidden();
  const isOpen = (uri: vscode.Uri) =>
    vscode.workspace.textDocuments.some((d) => d.uri.toString() === uri.toString());
  const visible = (uri: vscode.Uri, diagnostics: vscode.Diagnostic[]) =>
    hiding && isOpen(uri) ? withoutOverlap(diagnostics) : diagnostics;
  const refilter = (only?: vscode.Uri) => {
    const collection = client?.diagnostics;
    if (!collection) return;
    for (const [key, diagnostics] of sentDiagnostics) {
      if (only && only.toString() !== key) continue;
      const uri = vscode.Uri.parse(key);
      collection.set(uri, visible(uri, diagnostics));
    }
  };

  /** The settings the server has, so unchanged settings are not sent again. */
  let sent: string | undefined;
  const push = () => {
    if (overlapHidden() !== hiding) {
      hiding = !hiding;
      refilter();
    }
    if (client?.state !== State.Running) return;
    const settings = current();
    const json = JSON.stringify(settings);
    if (json === sent) return;
    const unloadPlugins =
      sent !== undefined && (JSON.parse(sent) as { plugins: boolean }).plugins && !settings.plugins;
    sent = json;
    // An imported plugin module stays loaded in the server; only a restart unloads it.
    if (unloadPlugins) {
      void restart();
      return;
    }
    client
      .sendNotification(DidChangeConfigurationNotification.type, { settings: { flowpact: settings } })
      .catch((err: unknown) => output.error(`could not send the settings: ${String(err)}`));
  };

  const showState = (state: State) => {
    status.busy = state === State.Starting;
    const failed = state === State.Stopped || state === State.StartFailed;
    status.severity = failed
      ? vscode.LanguageStatusSeverity.Error
      : vscode.LanguageStatusSeverity.Information;
    if (failed) {
      status.detail = 'stopped';
      status.command = { title: 'Restart', command: 'flowpact.restartServer' };
    } else if (!vscode.workspace.isTrusted) {
      status.detail = 'plugins off: workspace not trusted';
      status.command = { title: 'Manage Trust', command: 'workbench.trust.manage' };
    } else {
      status.detail = state === State.Starting ? 'starting' : undefined;
      status.command = { title: 'Show Output', command: 'flowpact.showOutput' };
    }
  };

  const module = context.asAbsolutePath(join('dist', 'server.mjs'));
  const serverOptions: ServerOptions = {
    run: { module, transport: TransportKind.ipc },
    debug: { module, transport: TransportKind.ipc, options: { execArgv: ['--nolazy', '--inspect=6009'] } },
  };
  const clientOptions: LanguageClientOptions = {
    documentSelector: SELECTOR,
    outputChannel: output,
    revealOutputChannelOn: RevealOutputChannelOn.Never,
    progressOnInitialization: true,
    // Evaluated on every start, including restarts after a crash.
    initializationOptions: () => {
      const settings = current();
      sent = JSON.stringify(settings);
      return settings;
    },
    middleware: {
      handleDiagnostics: (uri, diagnostics, next) => {
        if (diagnostics.length) sentDiagnostics.set(uri.toString(), diagnostics);
        else sentDiagnostics.delete(uri.toString());
        next(uri, visible(uri, diagnostics));
      },
    },
  };
  const create = () => {
    const c = new LanguageClient('flowpact', 'flowpact', serverOptions, clientOptions);
    c.onDidChangeState(({ newState }) => {
      showState(newState);
      if (newState === State.Running) push();
    });
    return c;
  };
  const restart = async () => {
    if (client?.state === State.Running) {
      await client.restart();
      return;
    }
    // After a failed start the client cannot start again; replace it.
    await client?.dispose().catch(() => undefined);
    sentDiagnostics.clear();
    client = create();
    await client.start();
  };

  context.subscriptions.push(
    vscode.commands.registerCommand('flowpact.restartServer', restart),
    vscode.commands.registerCommand('flowpact.showOutput', () => output.show()),
    vscode.workspace.onDidChangeConfiguration((e) => {
      if (e.affectsConfiguration('flowpact')) push();
    }),
    vscode.workspace.onDidGrantWorkspaceTrust(() => {
      push();
      if (client) showState(client.state);
    }),
    vscode.extensions.onDidChange(push),
    output.onDidChangeLogLevel(push),
    vscode.workspace.onDidOpenTextDocument((d) => {
      if (hiding) refilter(d.uri);
    }),
    vscode.workspace.onDidCloseTextDocument((d) => {
      if (hiding) refilter(d.uri);
    }),
  );

  client = create();
  await client.start();
}

export function deactivate(): Promise<void> | undefined {
  return client?.dispose().catch(() => undefined);
}
