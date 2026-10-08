# workflow-contracts (`wfc`)

**Lint, trace and lock the data flow between your GitHub Actions workflows.**

wfc follows every input, secret, env var, matrix key and output across nested reusable workflows and composite
actions, and reports what gets lost in between — missing or unknown inputs, values forwarded from optional into
required inputs, dead outputs, what `secrets: inherit` really needs, contexts GitHub does not allow in a field, and
matrix legs that silently run with an empty value.

```sh
npx workflow-contracts lint                         # lint .github/workflows and local actions
npx workflow-contracts trace pipeline.yml:config    # where does this input go? (--up: where does it come from?)
npx workflow-contracts explain WFC401               # why it matters, how to fix it
npx workflow-contracts generate                     # lock the interfaces in .github/workflow-contracts/
npx workflow-contracts check                        # lint + compare with the locked contracts
```

## Install

```sh
npm install --global workflow-contracts   # then: wfc lint
npm install --save-dev workflow-contracts # per project: npx --no wfc lint
```

Use the package name with npx (`npx workflow-contracts …`): an unrelated npm package is called `wfc`.

Requires Node.js 22 or newer. Exit codes: `0` clean, `1` findings at or above `--fail-on`, `2` usage or
configuration error, `3` internal error.

In GitHub Actions, use the action instead: `uses: rumankazi/wfc@v0` (job summary, annotations, SARIF and a
downloadable patch when contracts drift).

📖 **Docs:** https://rumankazi.github.io/wfc — every rule has its own page.

MIT licensed.
