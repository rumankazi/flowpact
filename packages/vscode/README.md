# flowpact for VS Code

[flowpact](https://rumankazi.github.io/flowpact) checks the data flow between your GitHub Actions workflows: the
inputs, secrets and outputs that cross reusable-workflow calls and local actions, per matrix combination. This
extension runs it while you edit.

![A finding as you type: the windows matrix entry passes an empty config to a reusable workflow, with the call chain and flowpact's hover card](https://raw.githubusercontent.com/rumankazi/flowpact/main/apps/docs/public/screenshots/editor-diagnostics.png)

## Features

- **Diagnostics as you type** for the whole repository, closed files included. Editing a reusable workflow updates its
  callers' findings at once, before you save. Each finding links to its rule's documentation and shows the call chain
  that leads to it.
- **Hover** an input, secret, output, env variable or matrix key to see how it is declared, where its value comes from
  and where it flows, through every level of nesting.
- **Go to definition** across workflow calls and local actions: from `with: config:` to the callee's input, from
  `needs.build.outputs.url` to the reusable workflow's output, from `steps.x.outputs.y` to the action's output.
- **Find references** and **highlights** across files.
- **Contract drift** (`FP801`–`FP805`) as you edit, when the repository [locks its contracts](https://rumankazi.github.io/flowpact/docs/contracts).

![Hover on an input: a required string that comes from pipeline.yml and goes on to package.yml](https://raw.githubusercontent.com/rumankazi/flowpact/main/apps/docs/public/screenshots/editor-hover.png)

![Peek References on an input: its declaration, two reads, and the caller that passes it](https://raw.githubusercontent.com/rumankazi/flowpact/main/apps/docs/public/screenshots/editor-references.png)

Your [flowpact config](https://rumankazi.github.io/flowpact/docs/configuration) applies as in the CLI and in CI:
severities, overrides, ignores and plugins.

## Requirements

VS Code 1.101 or later. The analysis is bundled; nothing else needs to be installed.

## Settings

| Setting | Default | Description |
| --- | --- | --- |
| `flowpact.plugins` | `true` | Load the plugins the config lists. They run JavaScript from the repository, so they never load in an untrusted workspace. |
| `flowpact.contracts` | `auto` | Report contract drift: `auto` when `.github/flowpact/contracts/` exists, `on` or `off`. |
| `flowpact.overlappingRules` | `auto` | `FP502`–`FP505` repeat checks the GitHub Actions extension makes. `auto` hides them in files you open in the editor while that extension runs; `show` or `hide` them everywhere. |
| `flowpact.hiddenRules` | `[]` | Rule codes not to show in the editor. |
| `flowpact.trace.server` | `messages` | How much of each protocol message to show when the output's log level is Trace (`messages` or `verbose`). |

Logs go to the **flowpact** output channel; its log level (**Developer: Set Log Level…**) also sets the server's.

## Workspace trust

In Restricted Mode everything works except plugins. Trusting the workspace loads them without a restart. Plugins load
only for repositories inside the workspace folders.

## More

- [Editor documentation](https://rumankazi.github.io/flowpact/docs/editors), including other editors (`flowpact lsp`)
- [Rules](https://rumankazi.github.io/flowpact/docs/rules)
- [Issues](https://github.com/rumankazi/flowpact/issues)
