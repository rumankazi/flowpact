import Link from 'next/link';
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
    body: '`wfc trace pipeline.yml:config` shows where a value goes — or, with --up, where it comes from.',
  },
];

export default function HomePage() {
  return (
    <main className="mx-auto flex w-full max-w-5xl flex-1 flex-col gap-12 px-4 py-16">
      <section className="flex flex-col items-center gap-6 text-center">
        <span className="rounded-full border border-fd-border px-3 py-1 font-mono text-xs text-fd-muted-foreground">
          wfc · workflow contracts for GitHub Actions
        </span>
        <h1 className="max-w-3xl text-4xl font-bold tracking-tight sm:text-5xl">
          Know exactly what flows between your workflows.
        </h1>
        <p className="max-w-2xl text-lg text-fd-muted-foreground">
          A linter and tracer for deeply nested reusable workflows: missing inputs, dead outputs, inherited
          secrets and matrix legs that quietly run with empty values.
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
        <code className="rounded-lg bg-fd-muted px-4 py-2 font-mono text-sm">
          npx workflow-contracts lint
        </code>
      </section>
      <Screenshot
        name="lint-incident"
        alt="wfc lint output showing WFC401 for a matrix combination without a config value"
      />
      <section className="grid gap-4 sm:grid-cols-2">
        {features.map((f) => (
          <div key={f.title} className="rounded-xl border border-fd-border p-5">
            <h2 className="mb-2 font-semibold">{f.title}</h2>
            <p className="text-sm text-fd-muted-foreground">{f.body}</p>
          </div>
        ))}
      </section>
    </main>
  );
}
