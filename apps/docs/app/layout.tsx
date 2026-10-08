import type { Metadata } from 'next';
import { Provider } from '@/components/provider';
import './global.css';

export const metadata: Metadata = {
  // Absolute URLs for the Open Graph image (app/opengraph-image.png); Next.js adds the base path.
  metadataBase: new URL('https://rumankazi.github.io'),
  title: { template: '%s · flowpact', default: 'flowpact — workflow contracts for GitHub Actions' },
  description: 'Lint, trace and lock the data flow between your GitHub Actions workflows.',
};

export default function Layout({ children }: LayoutProps<'/'>) {
  return (
    <html lang="en" suppressHydrationWarning>
      <body className="flex flex-col min-h-screen">
        <Provider>{children}</Provider>
      </body>
    </html>
  );
}
