#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

node -e 'const [major, minor, patch] = process.versions.node.split(".").map(Number); if (major < 26 || (major === 26 && (minor < 13 || (minor === 13 && patch < 1)))) process.exit(1)'
work=$(mktemp -d /tmp/sheets-realtime.XXXXXXXX)
db= owner= browser=
cleanup() {
    local status=$?
    if [[ -n $browser ]]; then kill "$browser" 2>/dev/null || true; fi
    if [[ -n $owner ]]; then kill "$owner" 2>/dev/null || true; fi
    if [[ -n $db ]]; then docker rm -f "$db" >/dev/null 2>&1 || true; fi
    if (( status == 0 )); then rm -rf "$work"; else printf 'Realtime logs: %s\n' "$work" >&2; fi
}
trap cleanup EXIT

export DB_CONNECTION=pgsql DB_HOST=127.0.0.1 DB_DATABASE=sheets_realtime_test DB_USERNAME=vaulter DB_PASSWORD=sheets-test-only
db=$(docker run -d --rm -e POSTGRES_DB="$DB_DATABASE" -e POSTGRES_USER="$DB_USERNAME" -e POSTGRES_PASSWORD="$DB_PASSWORD" \
    -p 127.0.0.1::5432 "postgres:${SHEETS_PG_VERSION:-18.7}")
DB_PORT=$(docker port "$db" 5432/tcp | awk -F: '{print $NF}')
export DB_PORT
for elapsed in {1..40}; do
    docker exec "$db" pg_isready -h 127.0.0.1 -U "$DB_USERNAME" -d "$DB_DATABASE" >/dev/null && break
    sleep 1
done
docker exec "$db" pg_isready -h 127.0.0.1 -U "$DB_USERNAME" -d "$DB_DATABASE"

export APP_ENV=testing SHEETS_REALTIME_TEST=1 SHEETS_REALTIME_URL=ws://127.0.0.1:3101
export SHEETS_OWNER_URL="http://127.0.0.1:${SHEETS_OWNER_PORT:-18086}"
export SHEETS_BROWSER_URL="http://127.0.0.1:${SHEETS_BROWSER_PORT:-15176}"
export SHEETS_REALTIME_OWNER_URL="$SHEETS_OWNER_URL/api/vaulter-sheets/v1/realtime/owner"
export SHEETS_REALTIME_OWNER_TOKEN_FILE="$work/owner.key"
(umask 077 && node -e 'process.stdout.write(require("node:crypto").randomBytes(32).toString("hex"))' > "$SHEETS_REALTIME_OWNER_TOKEN_FILE")

npm run build --workspace @vaulter/sheets-runtime
npm run build --workspace @vaulter/sheets-realtime
node --test packages/realtime/tests/restart.test.ts
php vendor/bin/pest -c packages/sheets/phpunit.xml --test-directory=packages/sheets/tests packages/sheets/tests/Feature/WorkbookRealtimeTest.php
php tests/e2e/owner.php > "$work/migrate.log" 2>&1
php -S "127.0.0.1:${SHEETS_OWNER_PORT:-18086}" tests/e2e/owner.php > "$work/owner.log" 2>&1 &
owner=$!
node node_modules/vite/bin/vite.js --config tests/e2e/vite.config.mjs --host 127.0.0.1 --port "${SHEETS_BROWSER_PORT:-15176}" --strictPort > "$work/vite.log" 2>&1 &
browser=$!
for elapsed in {1..40}; do
    curl -fsS "$SHEETS_BROWSER_URL/api/test/ready" >/dev/null 2>&1 && break
    sleep 1
done
curl -fsS "$SHEETS_BROWSER_URL/api/test/ready" >/dev/null
TMPDIR="$work" node node_modules/@playwright/test/cli.js test --config tests/e2e/realtime.playwright.config.mjs
