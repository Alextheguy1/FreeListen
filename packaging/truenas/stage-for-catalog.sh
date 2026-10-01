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

# The shared library is vendored into every app by their tooling rather than
# written by hand. Copy it from an app already on the same lib_version so the
# version and its hash in app.yaml stay consistent.
LIB_VERSION="$(grep '^lib_version:' "$HERE/app.yaml" | awk '{print $2}')"
LIB_DIR="base_v$(echo "$LIB_VERSION" | tr '.' '_')"
SOURCE_APP=""
for candidate in navidrome "$APPS_REPO"/ix-dev/community/*; do
  name="$(basename "$candidate")"
  if [ -d "$APPS_REPO/ix-dev/community/$name/templates/library/$LIB_DIR" ]; then
    SOURCE_APP="$name"
    break
  fi
done

if [ -z "$SOURCE_APP" ]; then
  echo "error: no app in the checkout vendors library $LIB_DIR" >&2
  echo "       bump lib_version in app.yaml to one that exists there" >&2
  exit 1
fi

rm -rf "$DEST/templates/library"
cp -r "$APPS_REPO/ix-dev/community/$SOURCE_APP/templates/library" "$DEST/templates/library"

echo "staged $APP_NAME into $DEST"
echo "  library $LIB_DIR copied from $SOURCE_APP"
echo
echo "next, from $APPS_REPO:"
echo "  ./.github/scripts/ci.py --app $APP_NAME --train community --test-file basic-values.yaml"
