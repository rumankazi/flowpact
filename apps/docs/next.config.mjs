import { createMDX } from 'fumadocs-mdx/next';

const withMDX = createMDX();

// GitHub Pages serves the site from /<repo>; local `next dev` serves from /.
const basePath = process.env.DOCS_BASE_PATH ?? (process.env.NODE_ENV === 'production' ? '/flowpact' : '');

/** @type {import('next').NextConfig} */
const config = {
  output: 'export',
  basePath,
  trailingSlash: true,
  images: { unoptimized: true },
  env: { NEXT_PUBLIC_BASE_PATH: basePath },
  reactStrictMode: true,
};

export default withMDX(config);
