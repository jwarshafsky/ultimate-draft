#!/bin/bash
# Ultimate Draft test runner. Plain node scripts (repo convention: no npm deps).
# Runs every test/*.test.js, prints a per-file summary, and exits nonzero if any
# test failed (each test file sets process.exitCode=1 on failure).
#
# CLAUDE.md convention: scripts/test.sh must pass before any push. Every bug gets
# a failing fixture/case BEFORE its fix.
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
cd "$ROOT"

fail=0
ran=0

for f in test/*.test.js; do
  [ -e "$f" ] || continue
  ran=$((ran + 1))
  echo ""
  echo "========================================================"
  echo "  $f"
  echo "========================================================"
  if ! node "$f"; then
    fail=1
  fi
done

echo ""
echo "========================================================"
if [ "$ran" -eq 0 ]; then
  echo "  No test files found (test/*.test.js)."
  exit 1
fi
if [ "$fail" -ne 0 ]; then
  echo "  RESULT: FAILURES — see above. ($ran file(s) run)"
  echo "========================================================"
  exit 1
fi
echo "  RESULT: ALL GREEN ($ran file(s) run)"
echo "========================================================"
