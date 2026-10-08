<img src="https://raw.githubusercontent.com/rumankazi/flowpact/main/assets/brand/app-icon-128.png" alt="" width="64" height="64">

# flowpact (`flowpact`)

**Lint, trace and lock the data flow between your GitHub Actions workflows.**

flowpact follows every input, secret, env var, matrix key and output across nested reusable workflows and composite
actions, and reports what gets lost in between — missing or unknown inputs, values forwarded from optional into
required inputs, dead outputs, what `secrets: inherit` really needs, contexts GitHub does not allow in a field, and
matrix legs that silently run with an empty value.

```sh
npx flowpact lint                         # lint .github/workflows and local actions
npx flowpact trace pipeline.yml:config    # where does this input go? (--up: where does it come from?)
npx flowpact explain FP401               # why it matters, how to fix it
npx flowpact generate                     # lock the interfaces in .github/flowpact/
npx flowpact check                        # lint + compare with the locked contracts
```

## Install

```sh
npm install --global flowpact     # then: flowpact lint
npm install --save-dev flowpact   # per project: npx flowpact lint
```

Requires Node.js 22 or newer. Exit codes: `0` clean, `1` findings at or above `--fail-on`, `2` usage or
configuration error, `3` internal error.

In GitHub Actions, use the action instead: `uses: rumankazi/flowpact@v0.7` (job summary, annotations, SARIF and a
downloadable patch when contracts drift).

📖 **Docs:** https://rumankazi.github.io/flowpact — every rule has its own page.

MIT licensed.
