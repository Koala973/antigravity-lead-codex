#!/usr/bin/env bash
set -euo pipefail

# Automated privacy, hardcoded-path & secret/token leak scan before commit / release.
# Optional argument: target directory to scan (defaults to repository root).

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET_DIR="${1:-$ROOT_DIR}"

HIT_FILE="$(mktemp)"
cleanup() {
  rm -f "$HIT_FILE"
}
trap cleanup EXIT

PRIVACY_PATTERNS=(
  "/Users/peidyang"
  "peidyang"
  "Delonix"
  "德胧"
  "百达屋"
  "feishu-change-bot"
  "delonix_ai_steward"
  "\.hermes/node"
)

# Portable ERE secret/token patterns (compatible with both GNU grep and macOS BSD grep).
SECRET_LABELS=(
  "OpenAI API key (sk-...)"
  "Anthropic API key (sk-ant-...)"
  "GitHub personal/OAuth token (gh[pousr]_...)"
  "GitHub fine-grained PAT (github_pat_...)"
  "Google API key (AIza...)"
  "AWS access key ID (AKIA...)"
  "Slack token (xox[baprs]-...)"
  "Private key PEM header"
)
SECRET_PATTERNS=(
  "(^|[^A-Za-z0-9_-])sk-(proj-|svcacct-|admin-)?[A-Za-z0-9_-]{20,}"
  "(^|[^A-Za-z0-9_-])sk-ant-[A-Za-z0-9_-]{20,}"
  "(^|[^A-Za-z0-9_])(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{30,}"
  "(^|[^A-Za-z0-9_])github_pat_[A-Za-z0-9_]{22,}"
  "(^|[^A-Za-z0-9_-])AIza[0-9A-Za-z_-]{35}"
  "(^|[^A-Za-z0-9])AKIA[0-9A-Z]{16}([^A-Za-z0-9]|$)"
  "(^|[^A-Za-z0-9-])xox[baprs]-[0-9A-Za-z-]{10,}"
  "-----BEGIN (RSA |EC |DSA |OPENSSH |PGP )?PRIVATE KEY-----"
)

COMMON_GREP_OPTS=(
  -rnIE
  --exclude-dir=.git
  --exclude-dir=node_modules
  --exclude-dir=release-artifacts
  --exclude-dir=__pycache__
  --exclude=privacy-check.sh
)

FOUND=0
for pat in "${PRIVACY_PATTERNS[@]}"; do
  if grep "${COMMON_GREP_OPTS[@]}" -e "$pat" -- "$TARGET_DIR" >"$HIT_FILE" 2>/dev/null; then
    echo "[PRIVACY FAIL] Matched forbidden pattern: $pat"
    cat "$HIT_FILE"
    FOUND=1
  fi
done

for idx in "${!SECRET_PATTERNS[@]}"; do
  pat="${SECRET_PATTERNS[$idx]}"
  label="${SECRET_LABELS[$idx]}"
  if grep "${COMMON_GREP_OPTS[@]}" -e "$pat" -- "$TARGET_DIR" >"$HIT_FILE" 2>/dev/null; then
    echo "[SECRET FAIL] Matched potential secret (${label}) at:"
    # Print only file:line so leaked secret values are never echoed into CI logs.
    cut -d: -f1,2 "$HIT_FILE"
    FOUND=1
  fi
done

if [[ "$FOUND" -ne 0 ]]; then
  echo "Privacy & secret scan FAILED. Clean matched references before committing or publishing." >&2
  exit 1
fi

echo "[PASS] Privacy, hardcoded-path & secret scan passed with 0 hits."
