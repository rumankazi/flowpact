import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { appName, gitConfig } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="inline-flex items-center gap-2 font-semibold">
          <span className="rounded bg-fd-primary px-1.5 py-0.5 font-mono text-xs text-fd-primary-foreground">
            {appName}
          </span>
          workflow contracts
        </span>
      ),
    },
    links: [
      { text: 'Docs', url: '/docs' },
      { text: 'Rules', url: '/docs/rules' },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
