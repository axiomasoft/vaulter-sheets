#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

node -e 'const [major, minor, patch] = process.versions.node.split(".").map(Number); if (major < 26 || (major === 26 && (minor < 13 || (minor === 13 && patch < 1)))) process.exit(1)'

work=$(mktemp -d /tmp/sheets-reference.XXXXXXXX)
db= runtime= owner= browser=
cleanup() {
  local status=$?
  if [[ -n $browser ]]; then kill "$browser" 2>/dev/null || true; fi
  if [[ -n $owner ]]; then kill "$owner" 2>/dev/null || true; fi
  if [[ -n $runtime ]]; then kill "$runtime" 2>/dev/null || true; fi
  if [[ -n $db ]]; then docker rm -f "$db" >/dev/null 2>&1 || true; fi
  if (( status == 0 )); then rm -rf "$work"; else printf 'Reference logs: %s\n' "$work" >&2; fi
}
trap cleanup EXIT

npm run test --workspace @vaulter/sheets-tiptap
npm run build --workspace @vaulter/sheets-tiptap
npm run build --workspace @vaulter/sheets-runtime
npm run build --workspace @vaulter/sheets-vue

export DB_CONNECTION=pgsql DB_HOST=127.0.0.1 DB_DATABASE=sheets_reference_test DB_USERNAME=vaulter DB_PASSWORD=sheets-test-only
db=$(docker run -d --rm -e POSTGRES_DB="$DB_DATABASE" -e POSTGRES_USER="$DB_USERNAME" -e POSTGRES_PASSWORD="$DB_PASSWORD" \
  -p 127.0.0.1::5432 "postgres:${SHEETS_PG_VERSION:-18.7}")
DB_PORT=$(docker port "$db" 5432/tcp | awk -F: '{print $NF}')
export DB_PORT
for _elapsed in {1..40}; do
  docker exec "$db" pg_isready -h 127.0.0.1 -U "$DB_USERNAME" -d "$DB_DATABASE" >/dev/null && break
  sleep 1
done
docker exec "$db" pg_isready -h 127.0.0.1 -U "$DB_USERNAME" -d "$DB_DATABASE"

printf '%s\n' 'local-test-runtime-token' > "$work/token"
export SHEETS_RUNTIME_TOKEN_FILE="$work/token"
export PORT="${SHEETS_RUNTIME_TEST_PORT:-13102}" SHEETS_RUNTIME_URL="http://127.0.0.1:${SHEETS_RUNTIME_TEST_PORT:-13102}"
node packages/runtime/dist/server.js > "$work/runtime.log" 2>&1 &
runtime=$!
for _elapsed in {1..60}; do
  curl -fsS "$SHEETS_RUNTIME_URL/readyz" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "$SHEETS_RUNTIME_URL/readyz" >/dev/null

export APP_ENV=testing
export SHEETS_OWNER_URL="http://127.0.0.1:${SHEETS_OWNER_PORT:-18087}"
export SHEETS_BROWSER_URL="http://127.0.0.1:${SHEETS_BROWSER_PORT:-15177}"
php tests/consumer/laravel/owner.php > "$work/migrate.log" 2>&1 || { cat "$work/migrate.log" >&2; exit 1; }
php -S "127.0.0.1:${SHEETS_OWNER_PORT:-18087}" tests/consumer/laravel/owner.php > "$work/owner.log" 2>&1 &
owner=$!
node node_modules/vite/bin/vite.js --config tests/consumer/vue/vite.config.mjs --host 127.0.0.1 --port "${SHEETS_BROWSER_PORT:-15177}" --strictPort > "$work/vite.log" 2>&1 &
browser=$!
for _elapsed in {1..40}; do
  curl -fsS "$SHEETS_BROWSER_URL/api/test/ready" >/dev/null 2>&1 && break
  sleep 1
done
curl -fsS "$SHEETS_BROWSER_URL/api/test/ready" >/dev/null
TMPDIR="$work" node node_modules/@playwright/test/cli.js test --config tests/e2e/reference.playwright.config.mjs
