#!/usr/bin/env bash
# Build the standalone CLI tarball and stage it into a sibling monorepo
# checkout at apps/registry/public/cli/, where it is committed and served
# at registry.metahub.ai/cli/ for install.sh.
#
# Usage: pnpm tarball:monorepo [path-to-monorepo]
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
MONOREPO="${1:-$HERE/../metahub-monorepo}"
DST="$MONOREPO/apps/registry/public/cli"

if [ ! -d "$MONOREPO/apps/registry" ]; then
  echo "error: monorepo registry app not found under $MONOREPO" >&2
  echo "       pass the monorepo path: pnpm tarball:monorepo /path/to/metahub-monorepo" >&2
  exit 1
fi

(cd "$HERE" && pnpm --filter "@metahub-ai/mh..." build && pnpm --filter @metahub-ai/mh bundle)

mkdir -p "$DST"
rm -f "$DST"/*.tgz
cp "$HERE"/packages/cli/standalone/*.tgz "$DST/"

echo "copied $(ls "$DST" | tr '\n' ' ')→ $DST"
echo "remember to commit the refreshed tarball in the monorepo."
