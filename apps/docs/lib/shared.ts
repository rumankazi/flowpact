import { createGetUrl } from 'fumadocs-core/source';

export const appName = 'wfc';
export const docsRoute = '/docs';
export const docsContentRoute = '/llms.mdx/docs';
export const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? '';

export const gitConfig = {
  user: 'rumankazi',
  repo: 'wfc',
  branch: 'main',
  /** Where the MDX sources live inside the repository. */
  contentDir: 'apps/docs/content/docs',
};

const getContentUrl = createGetUrl(docsContentRoute);

export function getPageMarkdownUrl(page: { slugs: string[]; locale?: string }) {
  const segments = [...page.slugs, 'content.md'];
  return { segments, url: getContentUrl(segments, page.locale) };
}

/** Prefixes a public asset path with the deployment base path. */
export const asset = (path: string) => `${basePath}${path}`;
