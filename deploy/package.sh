#!/usr/bin/env bash
# Builds the files to upload to the server, in ./dist:
#   mumbaimaxing-deploy.tar.gz   the app code (no node_modules, data, secrets, certs or .env)
#   setup.sh                     the installer / updater
#   google-oauth-client.json     copy of the OAuth client (secret, so upload it and don't share it)
set -euo pipefail
ROOT=$(cd "$(dirname "$0")/.." && pwd)
NAME=$(basename "$ROOT")
OUT="$ROOT/dist"
rm -rf "$OUT" && mkdir -p "$OUT"

COPYFILE_DISABLE=1 tar --no-xattrs --no-mac-metadata -czf "$OUT/mumbaimaxing-deploy.tar.gz" -C "$(dirname "$ROOT")" \
  --exclude="$NAME/node_modules" --exclude="$NAME/data" --exclude="$NAME/secrets" --exclude="$NAME/certs" \
  --exclude="$NAME/dist" --exclude="$NAME/.env" --exclude='.DS_Store' --exclude='*.log' \
  "$NAME"
cp "$ROOT/deploy/setup.sh" "$OUT/setup.sh"
[ -f "$ROOT/secrets/google-oauth-client.json" ] && cp "$ROOT/secrets/google-oauth-client.json" "$OUT/google-oauth-client.json" && chmod 600 "$OUT/google-oauth-client.json"

echo "Built in $OUT:"
ls -lh "$OUT" | tail -n +2
echo
echo "Bundle contents check (should list no secrets, data or node_modules):"
tar -tzf "$OUT/mumbaimaxing-deploy.tar.gz" | grep -E '(/secrets/|/data/|node_modules|\.env$|/certs/)' || echo "  OK: clean"
