#!/bin/sh
# All 40+ script files share one global scope (no modules). A duplicated
# top-level name silently shadows (function) or kills a whole file at parse
# time (const/let). This prints any name declared at column 0 in two files.
cd "$(dirname "$0")/.." || exit 1
dupes=$(grep -hoE '^(function|const|let|var) [A-Za-z_$][A-Za-z0-9_$]*' \
  js/*.js js/*/*.js | awk '{print $2}' | sort | uniq -d)
if [ -n "$dupes" ]; then
  echo "DUPLICATE top-level globals:"
  for n in $dupes; do
    echo "  $n"
    grep -lE "^(function|const|let|var) $n\b" js/*.js js/*/*.js | sed 's/^/    /'
  done
  exit 1
fi
echo "globals ok (no duplicate top-level names)"
