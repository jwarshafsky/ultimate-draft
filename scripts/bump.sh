#!/bin/sh
# Stamp EVERY ?v=NN cache buster in index.html to one number: the commit count.
# Run before committing (after staging your changes is fine — index.html gets
# re-staged by the commit). Replaces the error-prone hand-bump convention.
cd "$(dirname "$0")/.." || exit 1
V=$(( $(git rev-list --count HEAD) + 1 ))
sed -i '' -E "s/\?v=[0-9]+/?v=$V/g" index.html
echo "index.html: all ?v= stamped to $V"
