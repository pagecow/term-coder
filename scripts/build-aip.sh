#!/bin/sh
# Build a ChatOSS .aip for Term Coder.
#
# v1.28.1 fix: the file list is DERIVED from index.html — every local href/src
# it references — instead of a hand-written copy list. v1.28.0 shipped WITHOUT
# style.css (the copy list said "app.json index.html icon.svg js libs" and
# style.css was never copied), so the installed app rendered with no CSS at
# all. This script fails hard if any referenced local asset is missing, and it
# verifies the archive contents before finishing.
#
# Usage: scripts/build-aip.sh [output.aip]   (defaults to term-coder-v<version>.aip)
set -eu

cd "$(dirname "$0")/.."
ROOT=$(pwd)

# --- version + icon + entry from app.json (single source of truth) -----------
VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' app.json | head -1)
[ -n "$VERSION" ] || { echo "ERROR: could not read version from app.json" >&2; exit 1; }
ICON=$(sed -n 's/.*"icon"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' app.json | head -1)
ENTRY=$(sed -n 's/.*"entry"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' app.json | head -1)
[ -n "$ENTRY" ] || ENTRY="index.html"
OUT="${1:-term-coder-v${VERSION}.aip}"

STAGE=$(mktemp -d)
trap 'rm -rf "$STAGE"' EXIT

cp app.json "$STAGE/"
# The ENTRY FILE is the one file the OS requires at the archive root — v1.28.1
# shipped without index.html (the script extracted refs FROM it but never
# copied it) and the update failed with "The entry file index.html is missing
# from the archive." Copy it explicitly, from app.json's "entry" field.
[ -f "$ENTRY" ] || { echo "ERROR: app.json entry '$ENTRY' not found" >&2; exit 1; }
cp "$ENTRY" "$STAGE/"
if [ -n "$ICON" ]; then
  [ -f "$ICON" ] || { echo "ERROR: app.json icon '$ICON' not found" >&2; exit 1; }
  cp "$ICON" "$STAGE/"
fi

# --- every LOCAL asset index.html references (stylesheets, scripts) ----------
grep -oE '(href|src)="[^"#?]+"[^>]*' index.html \
  | sed -E 's/^[^=]*="([^"#?]+)".*/\1/' \
  | grep -v '^https\?://' | grep -v '^mailto:' | grep -v '^data:' \
  | sort -u > "$STAGE/.refs"

MISSING=0
while IFS= read -r ref; do
  [ -n "$ref" ] || continue
  if [ ! -f "$ref" ]; then
    echo "ERROR: index.html references missing file: $ref" >&2
    MISSING=1
    continue
  fi
  mkdir -p "$STAGE/$(dirname "$ref")"
  cp "$ref" "$STAGE/$ref"
done < "$STAGE/.refs"
[ "$MISSING" -eq 0 ] || exit 1
rm "$STAGE/.refs"

# style.css (or any root stylesheet) is the file v1.28.0 forgot — belt and
# braces: refuse to build an .aip that doesn't stage a stylesheet.
ls "$STAGE"/*.css >/dev/null 2>&1 || { echo "ERROR: no .css staged — the app would render unstyled" >&2; exit 1; }

rm -f "$OUT"
case "$OUT" in
  /*) (cd "$STAGE" && zip -r -q "$OUT" .) ;;
  *)  (cd "$STAGE" && zip -r -q "$ROOT/$OUT" .) ;;
esac

# --- verify: entry file + app.json at the archive root, no tests/docs leaked --
if ! unzip -l "$OUT" | awk '{print $NF}' | grep -qx "app.json"; then
  echo "ERROR: built archive is missing app.json" >&2
  exit 1
fi
if ! unzip -l "$OUT" | awk '{print $NF}' | grep -qx "$ENTRY"; then
  echo "ERROR: built archive is missing the entry file $ENTRY (the OS refuses to install it)" >&2
  exit 1
fi
if unzip -l "$OUT" | grep -Ei "tests/|\.md$|\.git" >/dev/null; then
  echo "ERROR: built archive contains non-app files (tests/docs/.git)" >&2
  exit 1
fi

echo "Built $OUT (v$VERSION):"
unzip -l "$OUT"