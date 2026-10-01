#!/usr/bin/env bash
# Stages this app definition into a checkout of truenas/apps so their own CI
# script can validate it, and so the result is ready to commit as a PR.
#
#   ./stage-for-catalog.sh /path/to/truenas-apps-checkout
#
# Then, from that checkout:
#   ./.github/scripts/ci.py --app freelisten --train community \
#       --test-file basic-values.yaml
#
# That needs Docker - it renders the template and actually deploys the
# containers, which is the part that can't be checked without it.
set -euo pipefail

HERE="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
APPS_REPO="${1:-}"
APP_NAME="freelisten"

if [ -z "$APPS_REPO" ]; then
  echo "usage: $0 /path/to/truenas-apps-checkout" >&2
  exit 1
fi
if [ ! -d "$APPS_REPO/ix-dev/community" ]; then
  echo "error: $APPS_REPO doesn't look like a truenas/apps checkout" >&2
  echo "       (expected it to contain ix-dev/community)" >&2
  exit 1
fi

DEST="$APPS_REPO/ix-dev/community/$APP_NAME"
mkdir -p "$DEST/templates/test_values"

cp "$HERE/app.yaml" "$HERE/item.yaml" "$HERE/ix_values.yaml" \
   "$HERE/questions.yaml" "$HERE/README.md" "$DEST/"
cp "$HERE/templates/docker-compose.yaml" "$DEST/templates/"
cp "$HERE/templates/test_values/basic-values.yaml" "$DEST/templates/test_values/"

# The shared library is vendored into every app rather than written by hand,
# straight from the repo's own library/<version>/ into base_v<version>.
#
# It has to be a version their library/hashes.yaml knows about. Most existing
# apps sit on much older versions because they're frozen at whatever was
# current when each was last touched - copying from a neighbouring app is how
# you end up pinned to something their tooling then refuses to update.
LIB_VERSION="$(grep '^lib_version:' "$HERE/app.yaml" | awk '{print $2}')"
LIB_DIR="base_v$(echo "$LIB_VERSION" | tr '.' '_')"
LIB_SRC="$APPS_REPO/library/$LIB_VERSION"

if [ ! -d "$LIB_SRC" ]; then
  echo "error: library version $LIB_VERSION not present in $APPS_REPO/library" >&2
  echo "       available: $(ls "$APPS_REPO/library" | grep -v hashes.yaml | tr '\n' ' ')" >&2
  echo "       set lib_version in app.yaml to one of those, with its" >&2
  echo "       matching hash from library/hashes.yaml" >&2
  exit 1
fi

if ! grep -q "^$LIB_VERSION:" "$APPS_REPO/library/hashes.yaml"; then
  echo "error: $LIB_VERSION is not in library/hashes.yaml" >&2
  exit 1
fi

EXPECTED_HASH="$(grep "^$LIB_VERSION:" "$APPS_REPO/library/hashes.yaml" | awk '{print $2}')"
DECLARED_HASH="$(grep '^lib_version_hash:' "$HERE/app.yaml" | awk '{print $2}')"
if [ "$EXPECTED_HASH" != "$DECLARED_HASH" ]; then
  echo "error: lib_version_hash in app.yaml does not match library/hashes.yaml" >&2
  echo "       expected: $EXPECTED_HASH" >&2
  echo "       declared: $DECLARED_HASH" >&2
  exit 1
fi

rm -rf "$DEST/templates/library"
mkdir -p "$DEST/templates/library"
cp -r "$LIB_SRC" "$DEST/templates/library/$LIB_DIR"

echo "staged $APP_NAME into $DEST"
echo "  library $LIB_VERSION vendored as $LIB_DIR (hash verified)"
echo
echo "next, from $APPS_REPO:"
echo "  ./.github/scripts/ci.py --app $APP_NAME --train community --test-file basic-values.yaml"
