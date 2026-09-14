#!/bin/sh
# Pack the kuna-server engine archive from the pinned kuna submodule.
#
# kuna is vendored as the git submodule `modules/decx-kuna/kuna`; this script
# never clones or downloads anything. Initialize the submodule first:
#
#     git submodule update --init modules/decx-kuna/kuna
#
# Build steps:
#   1. build the DECX server crate into server/target
#   2. build kuna's slacomp into .build/target and compile .slaspec -> .sla
#      on a COPY of kuna/specs (the submodule tree itself stays untouched)
#   3. stage dist/ and pack dist/kuna-server-<VERSION>-<os>-<arch>.zip
#
# The archive name uses VERSION, which must match server/Cargo.toml's version
# (enforced below) so release-kuna-server.yml can verify tag == VERSION.
#
# Archive layout:
#   bin/kuna-server    POSIX sh launcher (sets KUNA_SPECS to the bundled tree)
#   kuna_server        compiled Rust server binary
#   specs/             slacomp-compiled specs (platform-independent)
#   LICENSE, NOTICE    from the pinned kuna submodule root
#   UPSTREAM.md        submodule URL/revision + build provenance
#   decx.json          engine manifest
#   VERSION            server crate version (same value as the archive name)
#
# Environment:
#   SKIP_SPECS=1   reuse an existing .build/specs tree (skip slacomp + compile)
#   OUT_OS/OUT_ARCH  override the Go-style archive tags (default: uname -s/-m)
#   OUT_DIR        output directory (default: <script dir>/dist)

set -eu

HERE=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
KUNA_DIR=$HERE/kuna
SERVER_MANIFEST=$HERE/server/Cargo.toml
SLACOMP_TARGET_DIR=$HERE/.build/target
SPECS_DIR=$HERE/.build/specs
BUILD_DIR=$HERE/.build/pack

OUT_DIR=${OUT_DIR:-$HERE/dist}
KUNA_REPO=https://github.com/Noelo-Lab/kuna

fail() {
    printf 'build.sh: error: %s\n' "$1" >&2
    exit 1
}

VERSION=$(tr -d '[:space:]' < "$HERE/VERSION")
[ -n "$VERSION" ] || fail "VERSION file is empty: $HERE/VERSION"

# Go-style platform tags: the DECX installer substitutes {os}/{arch} with
# runtime.GOOS/runtime.GOARCH, so the names must match Go's, not uname's.
detect_os() {
    case $(uname -s) in
        Darwin) printf 'darwin' ;;
        Linux) printf 'linux' ;;
        MINGW*|MSYS*|CYGWIN*) printf 'windows' ;;
        *) fail "unsupported OS '$(uname -s)'; set OUT_OS=darwin|linux|windows" ;;
    esac
}

detect_arch() {
    case $(uname -m) in
        arm64|aarch64) printf 'arm64' ;;
        x86_64|amd64) printf 'amd64' ;;
        *) fail "unsupported architecture '$(uname -m)'; set OUT_ARCH=arm64|amd64" ;;
    esac
}

OUT_OS=${OUT_OS:-$(detect_os)}
OUT_ARCH=${OUT_ARCH:-$(detect_arch)}
case $OUT_OS in darwin|linux|windows) ;; *) fail "OUT_OS must be darwin, linux or windows (got '$OUT_OS')" ;; esac
case $OUT_ARCH in amd64|arm64) ;; *) fail "OUT_ARCH must be amd64 or arm64 (got '$OUT_ARCH')" ;; esac

[ -f "$SERVER_MANIFEST" ] || fail "server crate not found: $SERVER_MANIFEST"
[ -f "$KUNA_DIR/decompiler/Cargo.toml" ] || fail "kuna sources not found under $KUNA_DIR.
Initialize the pinned submodule first:
  git submodule update --init modules/decx-kuna/kuna"

SERVER_VERSION=$(sed -n 's/^version = "\(.*\)"/\1/p' "$SERVER_MANIFEST" | head -1)
[ "$VERSION" = "$SERVER_VERSION" ] \
    || fail "VERSION ($VERSION) does not match server/Cargo.toml version ($SERVER_VERSION)"

# The submodule gitlink pins the revision; record what was actually packed.
KUNA_REV=unknown
DIRTY=no
if command -v git >/dev/null 2>&1 && [ -e "$KUNA_DIR/.git" ]; then
    KUNA_REV=$(git -C "$KUNA_DIR" rev-parse HEAD 2>/dev/null) || KUNA_REV=unknown
    if [ -n "$(git -C "$KUNA_DIR" status --porcelain 2>/dev/null)" ]; then
        DIRTY=yes
        printf 'build.sh: warning: %s has local modifications; the archive will not match the pinned revision\n' "$KUNA_DIR" >&2
    fi
fi

printf 'build.sh: building kuna-server %s for %s-%s\n' "$VERSION" "$OUT_OS" "$OUT_ARCH" >&2

# --- 1. DECX server crate (target dir: server/target) -------------------------
cargo build --release --manifest-path "$SERVER_MANIFEST"
SERVER_BIN=$HERE/server/target/release/kuna-server
[ -x "$SERVER_BIN" ] || fail "server build produced no binary at $SERVER_BIN"

# --- 2. slacomp + specs -------------------------------------------------------
# The specs tree is copied before compiling: slacomp writes .sla files next to
# their .slaspec sources, and the pinned submodule must stay clean.
if [ "${SKIP_SPECS:-0}" = "1" ]; then
    [ -d "$SPECS_DIR" ] || fail "SKIP_SPECS=1 but $SPECS_DIR does not exist; run ./build.sh once without it"
    printf 'build.sh: SKIP_SPECS=1, reusing %s\n' "$SPECS_DIR" >&2
else
    cargo build --release --locked --manifest-path "$KUNA_DIR/decompiler/Cargo.toml" \
        -p kuna-slacomp --target-dir "$SLACOMP_TARGET_DIR"
    SLACOMP=$SLACOMP_TARGET_DIR/release/slacomp
    [ -x "$SLACOMP" ] || fail "slacomp build produced no binary at $SLACOMP"

    rm -rf "$SPECS_DIR"
    mkdir -p "$SPECS_DIR"
    cp -R "$KUNA_DIR/specs/." "$SPECS_DIR/"

    SLAS_SPEC_COUNT=$(find "$KUNA_DIR/specs" -name '*.slaspec' | wc -l | tr -d ' ')
    printf 'build.sh: compiling %s .slaspec files with slacomp (this can take a while)\n' "$SLAS_SPEC_COUNT" >&2
    SPECS_START=$(date +%s)
    "$SLACOMP" -a "$SPECS_DIR"
    SPECS_END=$(date +%s)
    SPECS_ELAPSED=$((SPECS_END - SPECS_START))
    printf 'build.sh: compiled specs in %ss\n' "$SPECS_ELAPSED" >&2
fi

SLA_COUNT=$(find "$SPECS_DIR" -name '*.sla' | wc -l | tr -d ' ')
if [ "$SLA_COUNT" -le 0 ]; then
    fail "no .sla files under $SPECS_DIR. The tree only contains uncompiled .slaspec sources;
the build's spec step (slacomp -a) must run first. Re-run ./build.sh without SKIP_SPECS."
fi
printf 'build.sh: %s .sla files ready under %s\n' "$SLA_COUNT" "$SPECS_DIR" >&2

# --- 3. stage dist ------------------------------------------------------------
[ -f "$KUNA_DIR/LICENSE" ] || fail "missing $KUNA_DIR/LICENSE"
[ -f "$KUNA_DIR/NOTICE" ] || fail "missing $KUNA_DIR/NOTICE"

rm -rf "$BUILD_DIR"
mkdir -p "$BUILD_DIR/bin"
cp "$SERVER_BIN" "$BUILD_DIR/kuna_server"
cp "$HERE/bin/kuna-server" "$BUILD_DIR/bin/kuna-server"
chmod 755 "$BUILD_DIR/bin/kuna-server" "$BUILD_DIR/kuna_server"
cp -R "$SPECS_DIR" "$BUILD_DIR/specs"
cp "$KUNA_DIR/LICENSE" "$BUILD_DIR/LICENSE"
cp "$KUNA_DIR/NOTICE" "$BUILD_DIR/NOTICE"
cp "$HERE/decx.json" "$BUILD_DIR/decx.json"
cp "$HERE/VERSION" "$BUILD_DIR/VERSION"

cat > "$BUILD_DIR/UPSTREAM.md" <<EOF
# kuna-server upstream provenance

- Server: \`kuna_server\` (DECX, new code; not part of upstream kuna), version $SERVER_VERSION
- Upstream project: kuna
- Repository: $KUNA_REPO
- Source: git submodule \`modules/decx-kuna/kuna\` ($KUNA_DIR)
- Revision: $KUNA_REV
- Submodule dirty at pack time: $DIRTY
- License: Apache-2.0 (see \`LICENSE\` and \`NOTICE\`)
- Packed: $(date -u '+%Y-%m-%dT%H:%M:%SZ')

The files under \`specs/\` are compiled from the pinned upstream \`.slaspec\` tree
(\`kuna/specs\`) by \`kuna-slacomp -a\`. SLEIGH-compiled \`.sla\` artifacts are
platform-independent and are not stored in the submodule.

DECX build commands (run from \`modules/decx-kuna\`):

\`\`\`sh
git submodule update --init modules/decx-kuna/kuna
./build.sh
\`\`\`

which expands to:

\`\`\`sh
cargo build --release --manifest-path server/Cargo.toml
cargo build --release --locked --manifest-path kuna/decompiler/Cargo.toml \\
    -p kuna-slacomp --target-dir .build/target
rm -rf .build/specs && mkdir -p .build/specs && cp -R kuna/specs/. .build/specs/
.build/target/release/slacomp -a .build/specs
\`\`\`
EOF

# --- 4. pack ------------------------------------------------------------------
mkdir -p "$OUT_DIR"
OUT_ZIP=$OUT_DIR/kuna-server-$VERSION-$OUT_OS-$OUT_ARCH.zip
rm -f "$OUT_ZIP"

if command -v zip >/dev/null 2>&1; then
    (cd "$BUILD_DIR" && zip -q -r -X "$OUT_ZIP" bin kuna_server specs LICENSE NOTICE UPSTREAM.md decx.json VERSION)
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

[ -f "$OUT_ZIP" ] || fail "packing failed, no archive at $OUT_ZIP"

# The pinned submodule must be byte-for-byte untouched by the build.
if command -v git >/dev/null 2>&1 && [ -e "$KUNA_DIR/.git" ]; then
    DIRTY_AFTER=$(git -C "$KUNA_DIR" status --porcelain 2>/dev/null || true)
    if [ -n "$DIRTY_AFTER" ]; then
        printf 'build.sh: warning: submodule %s has local changes after the build:\n%s\n' "$KUNA_DIR" "$DIRTY_AFTER" >&2
    fi
fi

printf 'build.sh: wrote %s (server %s, kuna rev %s, %s specs)\n' "$OUT_ZIP" "$SERVER_VERSION" "$KUNA_REV" "$SLA_COUNT"
