import Link from 'next/link';
import { Logo } from '@/components/logo';
import { Screenshot } from '@/components/screenshot';
import { installLinks } from '@/lib/shared';

const features = [
  {
    title: 'Data flow, not just syntax',
    body: 'Follows every input, secret, env var and output across nested reusable workflows and composite actions.',
  },
  {
    title: 'Matrix-aware',
    body: 'Expands include/exclude exactly like GitHub and evaluates each binding per combination — catching the leg that silently gets an empty value.',
  },
  {
    title: 'Explains itself',
    body: 'Every finding has a code, the exact location, the call chain, why it matters, how to fix it and a docs link.',
  },
  {
    title: 'Trace anything',
    body: '`flowpact trace pipeline.yml:config` shows where a value goes — or, with --up, where it comes from.',
  },
];

export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-12 px-4 py-16">
      <section className="flex flex-col items-center gap-6 text-center">
        <Logo className="size-16" />
        <span className="rounded-full border border-fd-border px-3 py-1 font-mono text-xs text-fd-muted-foreground">
          flowpact · data-flow linter for GitHub Actions
        </span>
        <h1 className="max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">
          Know exactly what flows between your workflows.
        </h1>
        <p className="max-w-2xl text-lg text-fd-muted-foreground">
          GitHub Actions turns a missing matrix value, an undeclared secret or an optional input without a
          default into an empty value and keeps the run green. flowpact finds them across reusable workflows,
          local actions and every combination of the matrices written in your workflows.
        </p>
        <div className="flex flex-wrap justify-center gap-3">
          <Link
            href="/docs"
            className="rounded-lg bg-fd-primary px-5 py-2.5 font-medium text-fd-primary-foreground"
          >
            Get started
          </Link>
          <a
            href={installLinks.vscode}
            className="rounded-lg border border-fd-border px-5 py-2.5 font-medium"
          >
            Install for VS Code
          </a>
          <Link href="/docs/rules" className="rounded-lg border border-fd-border px-5 py-2.5 font-medium">
            Browse rules
          </Link>
        </div>
        <code className="rounded-lg bg-fd-muted px-4 py-2 font-mono text-sm">npx flowpact lint</code>
        <p className="text-sm text-fd-muted-foreground">
          In CI, use the{' '}
          <a href={installLinks.action} className="underline underline-offset-4">
            GitHub Action
          </a>
          . In VSCodium, Cursor or Windsurf, install the extension from{' '}
          <a href={installLinks.openVsx} className="underline underline-offset-4">
            Open VSX
          </a>
          .
        </p>
      </section>
      <Screenshot
        name="lint-incident"
        alt="flowpact lint output showing FP401 for a matrix combination without a config value"
      />
      <section className="grid gap-4 sm:grid-cols-2">
        {features.map((f) => (
          <div key={f.title} className="rounded-xl border border-fd-border p-5">
            <h2 className="mb-2 font-semibold">{f.title}</h2>
            <p className="text-sm text-fd-muted-foreground">{f.body}</p>
          </div>
        ))}
      </section>
      <section className="flex flex-col gap-3">
        <div className="flex flex-col items-center gap-3 text-center">
          <h2 className="text-2xl font-semibold tracking-tight">
            For publishers of reusable workflows and actions
          </h2>
          <p className="max-w-2xl text-fd-muted-foreground">
            Other repositories pin what you publish to a tag such as <code>@v1</code>, and a renamed job or a
            removed output breaks them without any error in your repository. Contracts put every change to
            inputs, secrets and outputs into the pull request as a YAML diff and mark the breaking ones.
            Impact mode grades each pull request as major, minor, patch or none, and fails it when a change
            needs a minor or major release and its title declares less, such as <code>fix:</code> on a renamed
            job. Turn both on in the GitHub Action with <code>mode: check</code> and <code>impact: auto</code>
            .
          </p>
        </div>
        <Screenshot
          name="impact"
          alt="flowpact impact failing with FP810: declared patch (the title “fix: tidy the test job”), but a removed output and a renamed job require major"
        />
        <div className="flex flex-wrap justify-center gap-x-6 gap-y-2">
          <Link href="/docs/contracts" className="font-medium underline underline-offset-4">
            Contracts
          </Link>
          <Link href="/docs/impact-mode" className="font-medium underline underline-offset-4">
            Impact mode
          </Link>
        </div>
      </section>
      <section className="flex flex-col gap-3">
        <div className="flex flex-col items-center gap-3 text-center">
          <h2 className="text-2xl font-semibold tracking-tight">And in your editor, as you type</h2>
          <p className="max-w-2xl text-fd-muted-foreground">
            The VS Code extension reports the same findings before you push, and traces any input or output
            across files.
          </p>
        </div>
        <Screenshot
          name="editor-diagnostics"
          format="png"
          alt="VS Code showing FP401 on matrix.config: the windows matrix entry has no config, with the call chain and flowpact's hover card"
        />
        <div className="flex flex-wrap justify-center gap-3">
          <a
            href={installLinks.vscode}
            className="rounded-lg bg-fd-primary px-5 py-2.5 font-medium text-fd-primary-foreground"
          >
            Install from the VS Code Marketplace
          </a>
          <a
            href={installLinks.openVsx}
            className="rounded-lg border border-fd-border px-5 py-2.5 font-medium"
          >
            Open VSX
          </a>
        </div>
        <p className="text-center text-sm text-fd-muted-foreground">
          Open VSX serves VSCodium, Cursor, Windsurf and other editors built on VS Code. Other editors use{' '}
          <Link href="/docs/editors#other-editors" className="underline underline-offset-4">
            flowpact lsp
          </Link>
          .
        </p>
      </section>
    </main>
  );
}
