#!/usr/bin/env bash
# The PHP suite runs the Node workbook runtime from packages/runtime/src, so it
# needs the npm workspace installed with the Node.js version from package.json.
# Installs it when node_modules is missing or older than package-lock.json.
set -euo pipefail

cd "$(dirname "$0")/.."

if ! command -v node >/dev/null 2>&1; then
    echo "node-deps: Node.js is not on PATH; install the version from package.json engines.node." >&2
    exit 1
fi

node -e '
const required = require("./package.json").engines.node.replace(/^>=/, "").split(".").map(Number);
const actual = process.versions.node.split(".").map(Number);
for (let i = 0; i < 3; i++) {
    if (actual[i] !== required[i]) {
        if (actual[i] > required[i]) process.exit(0);
        console.error(`node-deps: Node.js >=${required.join(".")} required, found ${process.versions.node}.`);
        process.exit(1);
    }
}
'

if [[ ! -f node_modules/.package-lock.json || package-lock.json -nt node_modules/.package-lock.json ]]; then
    npm ci --no-audit --no-fund
fi
