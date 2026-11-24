#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

docker compose -f tests/consumer/compose.yml config --quiet
node -e "JSON.parse(require('node:fs').readFileSync('packman.json', 'utf8'));"

container="vaulter-sheets-office-pg-$$"
work="$(mktemp -d /tmp/vaulter-sheets-office.XXXXXX)"
cleanup() {
    docker rm -f "${container}" >/dev/null 2>&1 || true
    rm -rf "${work}"
}
trap cleanup EXIT

export DB_CONNECTION=pgsql DB_HOST=127.0.0.1 DB_DATABASE=sheets_office_test DB_USERNAME=vaulter DB_PASSWORD=sheets-test-only
docker run -d --rm --name "${container}" -p 127.0.0.1::5432 \
    -e POSTGRES_DB="${DB_DATABASE}" -e POSTGRES_USER="${DB_USERNAME}" -e POSTGRES_PASSWORD="${DB_PASSWORD}" \
    "${SHEETS_POSTGRES_IMAGE:-postgres:18.7}" >/dev/null
export DB_PORT
DB_PORT="$(docker port "${container}" 5432/tcp | awk -F: '{print $NF}')"

for elapsed in {1..60}; do
    docker exec "${container}" pg_isready -h 127.0.0.1 -U "${DB_USERNAME}" -d "${DB_DATABASE}" >/dev/null 2>&1 && break
    sleep 1
done
docker exec "${container}" pg_isready -h 127.0.0.1 -U "${DB_USERNAME}" -d "${DB_DATABASE}"

npm run build --workspace @vaulter/sheets-runtime
npm run build --workspace @vaulter/sheets-realtime
npm run build --workspace @vaulter/sheets-vue

node --test packages/runtime/tests/table-bindings.test.ts

APP_ENV=testing php tests/e2e/owner.php > "${work}/schema.log" 2>&1 || { cat "${work}/schema.log"; exit 1; }
docker exec -i "${container}" psql -X -v ON_ERROR_STOP=1 -U "${DB_USERNAME}" -d "${DB_DATABASE}" < scripts/ci/unindexed-fks.sql

vendor/bin/pest -c packages/sheets/phpunit.xml --test-directory=packages/sheets/tests --filter="WorkbookCommandTest|WorkbookRealtimeTest|WorkbookExchangeTest"

VAULTER_AI_DIR="${VAULTER_AI_DIR:-../vaulter-ai}"
if [[ -d "${VAULTER_AI_DIR}/packages/sheets/tests" ]]; then
    (
        cd "${VAULTER_AI_DIR}"
        vendor/bin/pest packages/sheets/tests/CurrentRowsTest.php packages/sheets/tests/CalculationTest.php packages/sheets/tests/SheetAclTest.php
        vendor/bin/pest packages/sheets/tests/FixedMembersTest.php --filter="PHP and HTTP replay|missing row_id|22x3"
    )
fi
