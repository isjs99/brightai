#!/usr/bin/env bash
# Sync every configured entity, then write this month's summary.
# Exit code 2 = an entity needs `revfin auth <entity>` again.
set -uo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
cd "$HERE"

if [ -x ".venv/bin/revfin" ]; then
  REVFIN=".venv/bin/revfin"
else
  REVFIN="$(command -v revfin || true)"
fi
if [ -z "$REVFIN" ]; then
  echo "revfin not found: run 'python3 -m venv .venv && .venv/bin/pip install -e .' in $HERE" >&2
  exit 1
fi

MONTH="${1:-$(date -u +%Y-%m)}"
echo "== $(date -u +%FT%TZ) revfin sync"
"$REVFIN" sync
status=$?
echo "== $(date -u +%FT%TZ) revfin summary --month $MONTH"
"$REVFIN" summary --month "$MONTH" || status=$?
exit $status
