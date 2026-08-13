#!/usr/bin/env bash
# Pull the canonical @metahub/shared sources from a sibling monorepo checkout.
#
# The monorepo's packages/shared is the source of truth for the wire-format
# contract (portal, registry, and publisher SDKs build against it there).
# This repo carries a synced copy so the client toolchain is self-contained.
#
# Usage: pnpm sync:shared [path-to-monorepo]
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
MONOREPO="${1:-$HERE/../metahub-monorepo}"
SRC="$MONOREPO/packages/shared"
DST="$HERE/packages/shared"

if [ ! -f "$SRC/package.json" ]; then
  echo "error: monorepo shared package not found at $SRC" >&2
  echo "       pass the monorepo path: pnpm sync:shared /path/to/metahub-monorepo" >&2
  exit 1
fi

rsync -a --delete "$SRC/src/" "$DST/src/"
cp "$SRC/README.md" "$DST/README.md" 2>/dev/null || true

echo "synced packages/shared/src from $SRC"
if ! diff -q "$SRC/package.json" "$DST/package.json" >/dev/null 2>&1; then
  echo "note: package.json differs from the monorepo copy (expected — repo metadata)."
  echo "      If the monorepo added dependencies or exports, port them by hand:"
  echo "      diff $SRC/package.json $DST/package.json"
fi
