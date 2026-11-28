#!/usr/bin/env bash
set -euo pipefail

# Build reproducible prebuilt-UI release tarball and SHA256SUMS.txt.
# Note: Release tarballs bundle the prebuilt dist/app.html UI so users can skip
# Vite & devDependencies with `install.sh --no-build`. Production runtime Node
# dependencies (@modelcontextprotocol/sdk, zod) are NOT vendored in the tarball
# and are still installed via `npm ci --omit=dev` during installation.

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

DEFAULT_VERSION="v$(cd "$ROOT_DIR" && node -p "require('./plugins/codex-console/package.json').version")"
VERSION=""
OUT_DIR=""
SKIP_CHECKSUMS=0

while [[ $# -gt 0 ]]; do
  case "$1" in
    --skip-checksums) SKIP_CHECKSUMS=1; shift ;;
    -h|--help)
      cat <<'EOF'
Usage: package-release.sh [VERSION] [OUT_DIR] [--skip-checksums]

Builds a prebuilt-UI release tarball (antigravity-lead-codex-<VERSION>.tar.gz)
after verifying repository-wide version consistency.
EOF
      exit 0
      ;;
    *)
      if [[ -z "$VERSION" ]]; then
        VERSION="$1"
      elif [[ -z "$OUT_DIR" ]]; then
        OUT_DIR="$1"
      else
        echo "Unknown argument: $1" >&2
        exit 1
      fi
      shift
      ;;
  esac
done

VERSION="${VERSION:-$DEFAULT_VERSION}"
OUT_DIR="${OUT_DIR:-$ROOT_DIR/release-artifacts}"
PKG_NAME="antigravity-lead-codex-${VERSION}"

# Verify version consistency across the entire repository and requested tag
(cd "$ROOT_DIR" && node scripts/check-version.mjs --tag "$VERSION")

mkdir -p "$OUT_DIR"
TMP_STAGE="$(mktemp -d)"
trap 'rm -rf "$TMP_STAGE"' EXIT

# Ensure fresh UI bundle
(
  cd "$ROOT_DIR/plugins/codex-console"
  npm ci --no-audit --no-fund
  npm run build:ui
)

STAGE="$TMP_STAGE/$PKG_NAME"
mkdir -p "$STAGE"

for f in LICENSE README.md README_EN.md CHANGELOG.md CONTRIBUTING.md SECURITY.md; do
  [[ -f "$ROOT_DIR/$f" ]] && cp "$ROOT_DIR/$f" "$STAGE/"
done
cp -R "$ROOT_DIR/docs" "$ROOT_DIR/img" "$ROOT_DIR/scripts" "$STAGE/"
cp -R "$ROOT_DIR/plugins" "$ROOT_DIR/skills" "$STAGE/"

# Strip dev/transient directories from the prebuilt-UI release archive
rm -rf "$STAGE/plugins/codex-console/node_modules"
find "$STAGE" -name "__pycache__" -type d -exec rm -rf {} +
find "$STAGE" -name ".DS_Store" -delete

TARBALL="$OUT_DIR/${PKG_NAME}.tar.gz"
tar -czf "$TARBALL" -C "$TMP_STAGE" "$PKG_NAME"

if [[ "$SKIP_CHECKSUMS" -eq 0 ]]; then
  (
    cd "$OUT_DIR"
    if command -v sha256sum >/dev/null 2>&1; then
      sha256sum "${PKG_NAME}.tar.gz" > SHA256SUMS.txt
    else
      shasum -a 256 "${PKG_NAME}.tar.gz" > SHA256SUMS.txt
    fi
  )
fi

echo "Built prebuilt-UI release archive (requires npm for prod deps on install):"
if [[ "$SKIP_CHECKSUMS" -eq 0 ]]; then
  ls -lh "$TARBALL" "$OUT_DIR/SHA256SUMS.txt"
  cat "$OUT_DIR/SHA256SUMS.txt"
else
  ls -lh "$TARBALL"
fi
