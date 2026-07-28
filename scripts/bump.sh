#!/bin/sh
# Stamp EVERY ?v=NN cache buster in index.html to one number: the commit count.
# Run before committing (after staging your changes is fine — index.html gets
# re-staged by the commit). Replaces the error-prone hand-bump convention.
set -e
cd "$(dirname "$0")/.." || exit 1
V=$(( $(git rev-list --count HEAD) + 1 ))
# GNU sed (Linux/Beelink) takes -i with no argument; BSD sed (macOS) needs -i ''.
# Passing the BSD form to GNU sed makes it read '' as the SCRIPT and the real
# expression as a FILENAME -- it changed nothing while still printing success,
# which shipped stale cached code. Detect instead of assuming.
if sed --version >/dev/null 2>&1; then
  sed -i -E "s/\?v=[0-9]+/?v=$V/g" index.html      # GNU
else
  sed -i '' -E "s/\?v=[0-9]+/?v=$V/g" index.html   # BSD/macOS
fi
# Prove it actually happened -- never report success on a no-op again.
if grep -oE '\?v=[0-9]+' index.html | sort -u | grep -qv "?v=$V"; then
  echo "bump.sh FAILED: index.html still has ?v= values other than $V" >&2
  grep -oE '\?v=[0-9]+' index.html | sort -u >&2
  exit 1
fi
echo "index.html: all ?v= stamped to $V"
