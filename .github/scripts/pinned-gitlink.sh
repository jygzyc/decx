#!/usr/bin/env bash
# Resolve the pinned upstream revision recorded by the superproject's gitlink
# for a submodule. Works whether the submodule is initialised or not and fails
# loudly instead of falling back to whatever happens to be checked out.
set -euo pipefail

if [ "$#" -ne 1 ]; then
  echo "usage: pinned-gitlink.sh <submodule-path>" >&2
  exit 2
fi

path="$1"
root="$(git rev-parse --show-toplevel)"
cd "$root"

sha="$(git ls-tree HEAD -- "$path" | awk '$1 == "160000" { print $3 }')"
if [ -z "$sha" ]; then
  # The gitlink can live only in the index before it is first committed; take
  # that staging entry rather than guessing from the worktree.
  sha="$(git ls-files -s -- "$path" | awk '$1 == "160000" { print $2 }')"
fi
if [ -z "$sha" ]; then
  echo "error: '$path' is not a recorded submodule gitlink" >&2
  exit 1
fi
printf '%s\n' "$sha"
