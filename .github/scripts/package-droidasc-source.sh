#!/usr/bin/env bash
# Package the pinned DroidASC checkout as a relocatable source payload:
# main.py, the droidasc/ package, requirements.txt and LICENSE (plus VERSION
# when upstream ships one). The archive carries the interpreter payload the
# manager's python-venv installer assembles -- deliberately NOT a built venv,
# which would hard-code the build machine's Python paths.
#
# Usage: package-droidasc-source.sh <output.tar.gz> [version]
# Prints the packaged revision as `pinned=<sha>` on stdout for PROVENANCE.
set -euo pipefail

if [ "$#" -lt 1 ] || [ "$#" -gt 2 ]; then
  echo "usage: package-droidasc-source.sh <output.tar.gz> [version]" >&2
  exit 2
fi

output="$1"
version="${2:-}"
root="$(git rev-parse --show-toplevel)"
source_path="subprojects/decx-droidasc/source"
cd "$root"

pinned="$(bash .github/scripts/pinned-gitlink.sh "$source_path")"

staging="$(mktemp -d "${TMPDIR:-/tmp}/droidasc-src.XXXXXX")"
trap 'rm -rf "$staging"' EXIT
payload="$staging/payload"
mkdir -p "$payload"

# Export the pinned tree, never the worktree: uninitialised or dirty checkouts
# cannot leak into a release asset.
git -C "$source_path" archive --format=tar "$pinned" | tar -x -C "$payload"

for required in main.py requirements.txt droidasc; do
  if [ ! -e "$payload/$required" ]; then
    echo "error: pinned DroidASC tree is missing $required" >&2
    exit 1
  fi
done

# Keep only the install payload: the interpreter entry point, the package, its
# requirements and provenance-ish metadata. Tests, docs and CI stay upstream.
tmp="$staging/select"
mkdir -p "$tmp"
mv "$payload/main.py" "$payload/requirements.txt" "$payload/droidasc" "$tmp/"
for optional in LICENSE VERSION; do
  if [ -f "$payload/$optional" ]; then
    mv "$payload/$optional" "$tmp/"
  fi
done

# Byte-identical archives for a given pin make the SHA256SUMS asset stable.
# tar headers otherwise embed the export wall-clock time. bsdtar (macOS)
# lacks GNU tar's --sort=name/--mtime flags, so normalise with Python's tar
# module instead of forking on the host tar flavour.
epoch="$(git -C "$source_path" log -1 --format=%ct "$pinned" 2>/dev/null || printf '0')"
mkdir -p "$(dirname "$output")"
PKG_SRC="$tmp" PKG_OUT="$output" PKG_EPOCH="$epoch" python3 - <<'PY'
import gzip
import os
import tarfile

src = os.environ["PKG_SRC"]
out = os.environ["PKG_OUT"]
epoch = int(os.environ["PKG_EPOCH"])

entries = []
for base, dirs, files in os.walk(src):
    dirs.sort()
    files.sort()
    for name in dirs + files:
        full = os.path.join(base, name)
        entries.append(full)

# gzip stamps its header with the current time by default; pin it so a given
# gitlink always produces the same bytes.
with open(out, "wb") as raw, gzip.GzipFile("", "wb", 9, raw, mtime=epoch) as gz:
    with tarfile.open(fileobj=gz, mode="w", format=tarfile.PAX_FORMAT) as tar:
        for full in entries:
            arc = os.path.relpath(full, src)
            info = tar.gettarinfo(full, arc)
            info.mtime = epoch
            info.uid = info.gid = 0
            info.uname = info.gname = ""
            info.pax_headers = {}  # no per-file pax metadata either
            if info.isfile():
                with open(full, "rb") as fh:
                    tar.addfile(info, fh)
            else:
                tar.addfile(info)
PY
ls -l "$output"

# Smoke the archive on a clean Python: extract and ask the entry point for
# help. --help only parses arguments, so this runs without androguard while
# still proving the payload imports and the CLI wiring survived the export.
check="$(mktemp -d "${TMPDIR:-/tmp}/droidasc-check.XXXXXX")"
tar -xzf "$output" -C "$check"
python3 "$check/main.py" --help > /dev/null
echo "pinned=$pinned"
if [ -n "$version" ]; then
  echo "version=$version"
fi
