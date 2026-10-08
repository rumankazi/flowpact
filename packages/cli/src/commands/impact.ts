import { defineCommand } from 'citty';
import { guard } from '../shared';
import { type ReportArgs, reportArgs, runReport } from './lint';

const { paths: _paths, impact: _impact, ...args } = reportArgs;

export const impactCommand = defineCommand({
  meta: {
    name: 'impact',
    description:
      'Check that the declared release impact (PR title, labels, --expect) covers the changes to published workflows and actions',
  },
  args,
  run: ({ args, rawArgs }) => guard(() => runReport(args as unknown as ReportArgs, rawArgs, 'impact')),
});
