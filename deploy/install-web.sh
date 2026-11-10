#!/usr/bin/env bash
# Install the browser build of the app into the bridge, which serves it at
# https://<bridge>/app/ (Safari on iPhone: Share -> Add to Home Screen).
# No bridge restart is needed: files are read on every request.
#
#   deploy/install-web.sh                          # newest release
#   deploy/install-web.sh release/v1.145.4+295     # a given release
set -euo pipefail

REPO=${CCPOCKET_REPO:-dmitry575/ccpocket}
DEST=${BRIDGE_WEB_APP_DIR:-$HOME/.ccpocket/web-app}
TAG=${1:-}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT

if command -v gh >/dev/null 2>&1; then
  [ -n "$TAG" ] || TAG=$(gh release view -R "$REPO" --json tagName -q .tagName)
  gh release download "$TAG" -R "$REPO" -p 'CC-Pocket-web-v*.tar.gz' -D "$tmp"
else
  [ -n "$TAG" ] || { echo "without gh, pass the release tag (e.g. release/v1.145.4+295)" >&2; exit 64; }
  version=${TAG#release/v}
  curl -fsSL -o "$tmp/web.tar.gz" \
    "https://github.com/$REPO/releases/download/${TAG//+/%2B}/CC-Pocket-web-v${version%%+*}.tar.gz"
fi

tar -xzf "$tmp"/*.tar.gz -C "$tmp"
[ -f "$tmp/web/index.html" ] || { echo "archive has no web/index.html" >&2; exit 1; }

# Swap the whole folder so the bridge never serves a half-copied build.
mkdir -p "$(dirname "$DEST")"
rm -rf "$DEST.new" "$DEST.old"
mv "$tmp/web" "$DEST.new"
[ ! -d "$DEST" ] || mv "$DEST" "$DEST.old"
mv "$DEST.new" "$DEST"
rm -rf "$DEST.old"
echo "installed $(cat "$DEST/fork-build.txt" 2>/dev/null || echo "$TAG") into $DEST"
