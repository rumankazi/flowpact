import { asset } from '@/lib/shared';

/**
 * A terminal screenshot rendered from real `wfc` output (see scripts/gen-screenshots.ts).
 * SVGs keep the text crisp at any zoom and stay in sync with the CLI.
 */
export function Screenshot({ name, alt, caption }: { name: string; alt: string; caption?: string }) {
  return (
    <figure className="my-6">
      <img
        src={asset(`/screenshots/${name}.svg`)}
        alt={alt}
        className="w-full rounded-xl border border-fd-border shadow-sm"
        loading="lazy"
      />
      {caption ? (
        <figcaption className="mt-2 text-center text-sm text-fd-muted-foreground">{caption}</figcaption>
      ) : null}
    </figure>
  );
}
