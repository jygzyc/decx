#!/bin/sh
# Pack the asc-server engine archive from the pinned ASC submodule.
#
# ASC is vendored as the git submodule `modules/decx-asc/asc` (see .gitmodules);
# this script never clones or downloads anything. Initialize the submodule first:
#
#     git submodule update --init modules/decx-asc/asc
#
# Output: $OUT_DIR/asc-server-<VERSION>.zip (default OUT_DIR=<script dir>/dist)
# Archive layout:
#   bin/asc-server     POSIX sh launcher (execs the venv python)
#   asc_server.py      DECX adapter (imports ASC's core API from asc/)
#   asc/               pinned ASC submodule tree (src/, main.py, requirements.txt, LICENSE)
#   UPSTREAM.md        submodule URL/revision + build provenance
#   decx.json          engine manifest
#   VERSION            adapter version (same value as the archive name)
#
# Environment:
#   ASC_ROOT  ASC checkout to pack (default: <script dir>/asc, the submodule)
#   OUT_DIR   output directory (default: <script dir>/dist)

set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
# VERSION is the adapter's own version (reported by /health) and the source of
# truth for the archive name: `decx self install --module asc` resolves the
# `asc-server-{version}.zip` asset published by release-asc-server.yml.
VERSION=$(cat "$HERE/VERSION")
ASC_DIR=${ASC_ROOT:-$HERE/asc}
OUT_DIR=${OUT_DIR:-$HERE/dist}

BUILD_DIR=$HERE/.build/pack
ASC_REPO=https://github.com/MG1937/ASC

fail() {
    printf 'build.sh: error: %s\n' "$1" >&2
    exit 1
}

[ -f "$ASC_DIR/src/asc_client/apk_handler.py" ] \
    || fail "ASC sources not found under $ASC_DIR.
Initialize the pinned submodule first:
  git submodule update --init modules/decx-asc/asc"

grep -q "ADAPTER_VERSION = \"$VERSION\"" "$HERE/asc_server.py" \
    || fail "VERSION ($VERSION) does not match ADAPTER_VERSION in asc_server.py"

# The submodule gitlink pins the revision; record what was actually packed.
ASC_REV=unknown
DIRTY=no
if command -v git >/dev/null 2>&1 && [ -e "$ASC_DIR/.git" ]; then
    ASC_REV=$(git -C "$ASC_DIR" rev-parse HEAD 2>/dev/null) || ASC_REV=unknown
    if [ -n "$(git -C "$ASC_DIR" status --porcelain 2>/dev/null)" ]; then
        DIRTY=yes
        printf 'build.sh: warning: %s has local modifications; the archive will not match the pinned revision\n' "$ASC_DIR" >&2
    fi
fi

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/bin"

copy_asc() {
    src=$1
    (
        cd "$src" || exit 1
        tar -cf - \
            --exclude .git \
            --exclude .gitmodules \
            --exclude __pycache__ \
            --exclude '*.pyc' \
            --exclude .venv \
            --exclude venv \
            --exclude tests \
            --exclude docs \
            --exclude scripts \
            --exclude .github \
            --exclude dist \
            --exclude '*.egg-info' \
            src main.py README.md LICENSE requirements.txt
    ) | (
        cd "$BUILD_DIR/asc" || exit 1
        tar -xf -
    )
}

mkdir -p "$BUILD_DIR/asc"
copy_asc "$ASC_DIR"

[ -f "$BUILD_DIR/asc/src/asc_client/apk_handler.py" ] || fail "packed ASC tree is incomplete"
cp "$HERE/asc_server.py" "$BUILD_DIR/asc_server.py"
cp "$HERE/bin/asc-server" "$BUILD_DIR/bin/asc-server"
chmod 755 "$BUILD_DIR/bin/asc-server"
cp "$HERE/decx.json" "$BUILD_DIR/decx.json"
cp "$HERE/VERSION" "$BUILD_DIR/VERSION"

cat > "$BUILD_DIR/UPSTREAM.md" <<EOF
# asc-server upstream provenance

- Adapter: \`asc_server.py\` (DECX, new code; not part of upstream ASC), adapter version $VERSION
- Upstream project: ASC -- R8 Compiler Optimization as a DeCompiler Primitive
- Repository: $ASC_REPO
- Source: git submodule \`modules/decx-asc/asc\` ($ASC_DIR)
- Revision: $ASC_REV
- Submodule dirty at pack time: $DIRTY
- License: Apache-2.0 (see \`asc/LICENSE\`)
- Packed: $(date -u '+%Y-%m-%dT%H:%M:%SZ')

DECX build command:

\`\`\`sh
git submodule update --init modules/decx-asc/asc
cd modules/decx-asc && ./build.sh
\`\`\`

The files under \`asc/\` are the pinned upstream tree, unmodified. The launcher
(\`bin/asc-server\`) creates \`venv/\` next to \`asc/\` on first run and installs
\`asc/requirements.txt\` (androguard==4.1.3 and transitive dependencies) from PyPI.
EOF

mkdir -p "$OUT_DIR"
OUT_ZIP=$OUT_DIR/asc-server-$VERSION.zip
rm -f "$OUT_ZIP"

if command -v zip >/dev/null 2>&1; then
    (cd "$BUILD_DIR" && zip -q -r -X "$OUT_ZIP" bin asc asc_server.py UPSTREAM.md decx.json VERSION)
else
    python3 - "$BUILD_DIR" "$OUT_ZIP" <<'PY'
import os
import sys
import zipfile

stage, out = sys.argv[1], sys.argv[2]
with zipfile.ZipFile(out, "w", zipfile.ZIP_DEFLATED) as zf:
    for root, dirs, files in os.walk(stage):
        dirs[:] = sorted(d for d in dirs if d != "__pycache__")
        for name in sorted(files):
            if name.endswith(".pyc"):
                continue
            full = os.path.join(root, name)
            rel = os.path.relpath(full, stage)
            info = zipfile.ZipInfo(rel)
            info.external_attr = (os.stat(full).st_mode & 0xFFFF) << 16
            info.compress_type = zipfile.ZIP_DEFLATED
            with open(full, "rb") as fh:
                zf.writestr(info, fh.read())
PY
fi

printf 'build.sh: wrote %s (adapter %s, asc rev %s)\n' "$OUT_ZIP" "$VERSION" "$ASC_REV"
