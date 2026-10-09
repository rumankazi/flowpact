import type { BaseLayoutProps } from 'fumadocs-ui/layouts/shared';
import { Logo } from '@/components/logo';
import { appName, gitConfig, installLinks } from './shared';

export function baseOptions(): BaseLayoutProps {
  return {
    nav: {
      title: (
        <span className="inline-flex items-center gap-2 font-semibold">
          <Logo className="size-6" />
          {appName}
        </span>
      ),
    },
    links: [
      { text: 'Docs', url: '/docs' },
      { text: 'Rules', url: '/docs/rules' },
      { text: 'VS Code', url: installLinks.vscode, external: true },
      { text: 'GitHub Action', url: installLinks.action, external: true },
    ],
    githubUrl: `https://github.com/${gitConfig.user}/${gitConfig.repo}`,
  };
}
