import Link from 'next/link';
import { Logo } from '@/components/logo';
import { Screenshot } from '@/components/screenshot';

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
  {
    title: 'Contracts',
    body: 'A generated lockfile of each workflow’s and action’s interface and wiring. `flowpact check` fails on drift and marks breaking changes.',
  },
  {
    title: 'Impact mode',
    body: 'For publishers: grades what each pull request changes for consumers as major, minor, patch or none, and fails when a pull request declares less, such as a `fix:` title on a change that needs a minor or major release.',
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
          <Link href="/docs/rules" className="rounded-lg border border-fd-border px-5 py-2.5 font-medium">
            Browse rules
          </Link>
        </div>
        <code className="rounded-lg bg-fd-muted px-4 py-2 font-mono text-sm">npx flowpact lint</code>
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
        <Link href="/docs/editors" className="self-center font-medium underline underline-offset-4">
          Install the extension
        </Link>
      </section>
    </main>
  );
}
