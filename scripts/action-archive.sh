#!/usr/bin/env bash
# Writes the GitHub Action as released, action.yml and its committed bundle with its license notices and SBOM, to a
# reproducible .tar.gz:
#   scripts/action-archive.sh <out.tar.gz>
# Sorted names, the checked-out commit's time, no owner and no gzip timestamp, so building it again from the same commit
# gives the same bytes. Needs GNU tar (the release and CI run it on Ubuntu).
set -euo pipefail
out="${1:?usage: scripts/action-archive.sh <out.tar.gz>}"
tar --sort=name --mtime="@$(git log -1 --format=%ct HEAD)" --owner=0 --group=0 --numeric-owner --format=gnu \
  -cf - action.yml packages/action/dist/index.js packages/action/dist/THIRD_PARTY_LICENSES.txt \
  packages/action/dist/sbom.cdx.json LICENSE | gzip -n -9 > "$out"
