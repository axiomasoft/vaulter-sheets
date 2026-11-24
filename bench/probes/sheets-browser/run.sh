#!/usr/bin/env bash
set -euo pipefail

probe_dir=$(cd "$(dirname "$0")" && pwd)
work_dir=$(mktemp -d)
trap 'rm -rf -- "$work_dir"' EXIT
cp "$probe_dir"/{package.json,npm-shrinkwrap.json,check.mjs,index.html,snapshot-v1.json} "$work_dir"
cd "$work_dir"

npm ci --ignore-scripts --prefer-offline --no-audit --no-fund
if [[ -z "${CHROME_BIN:-}" ]]; then
  ./node_modules/.bin/playwright install chromium --no-shell
fi
node check.mjs
