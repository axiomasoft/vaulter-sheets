#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

container="vaulter-sheets-pg-$$"
work="$(mktemp -d /tmp/vaulter-sheets.XXXXXX)"
runtime_pid=
cleanup() {
    if [[ -n "${runtime_pid}" ]]; then kill "${runtime_pid}" 2>/dev/null || true; fi
    if declare -F after_workbook_cleanup >/dev/null; then after_workbook_cleanup; fi
    docker rm -f "${container}" >/dev/null 2>&1 || true
    if [[ ${result:-1} != 0 ]]; then cat "${work}/runtime.log" 2>/dev/null || true; fi
    rm -rf "${work}"
}
trap cleanup EXIT
export DB_CONNECTION=pgsql DB_HOST=127.0.0.1 DB_DATABASE=sheets_test DB_USERNAME=vaulter DB_PASSWORD=sheets-test-only
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
docker exec "${container}" psql -U "${DB_USERNAME}" -d "${DB_DATABASE}" -tAc 'SHOW server_version'
printf '%s\n' 'local-test-runtime-token' > "${work}/token"
export SHEETS_RUNTIME_TOKEN_FILE="${work}/token"
export PORT="${SHEETS_RUNTIME_TEST_PORT:-13100}" SHEETS_RUNTIME_URL="http://127.0.0.1:${SHEETS_RUNTIME_TEST_PORT:-13100}"
npm run build --workspace @vaulter/sheets-runtime
if declare -F start_workbook_runtime >/dev/null; then
    start_workbook_runtime
else
    node packages/runtime/dist/server.js > "${work}/runtime.log" 2>&1 &
    runtime_pid=$!
fi
for elapsed in {1..60}; do
    curl -fsS "${SHEETS_RUNTIME_URL}/readyz" >/dev/null 2>&1 && break
    sleep 1
done
curl -fsS "${SHEETS_RUNTIME_URL}/readyz"
[[ $(curl -s -o /dev/null -w '%{http_code}' -X POST "${SHEETS_RUNTIME_URL}/v1/operations") == 401 ]]
if declare -F run_workbook_checks >/dev/null; then
    run_workbook_checks
else
    APP_ENV=testing php tests/e2e/owner.php > "${work}/schema.log" 2>&1 || { cat "${work}/schema.log"; exit 1; }
    docker exec -i "${container}" psql -X -v ON_ERROR_STOP=1 -U "${DB_USERNAME}" -d "${DB_DATABASE}" <<'SQL'
DO $$
BEGIN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'v_sheets_commands'::regclass AND contype = 'f') THEN
        RAISE EXCEPTION 'Sheets command foreign keys are missing';
    END IF;
    IF EXISTS (
        SELECT 1 FROM pg_constraint AS fk
        WHERE fk.contype = 'f' AND left(fk.conrelid::regclass::text, 9) = 'v_sheets_'
            AND NOT EXISTS (
                SELECT 1 FROM pg_index AS idx
                JOIN pg_class AS ic ON ic.oid = idx.indexrelid
                JOIN pg_am AS am ON am.oid = ic.relam AND am.amname = 'btree'
                WHERE idx.indrelid = fk.conrelid AND idx.indisvalid AND idx.indisready AND idx.indpred IS NULL
                    AND (string_to_array(idx.indkey::text, ' ')::smallint[])[1:cardinality(fk.conkey)] = fk.conkey
            )
    ) THEN
        RAISE EXCEPTION 'A Sheets foreign key lacks a valid leading-column index';
    END IF;
END
$$;
SQL
    php vendor/bin/pest -c packages/sheets/phpunit.xml --test-directory=packages/sheets/tests packages/sheets/tests/Feature/WorkbookCommandTest.php
    node --max-old-space-size=640 packages/runtime/tests/cold-cycle.mjs
    cmp contracts/runtime-v1.schema.json packages/runtime/contracts/runtime-v1.schema.json
    cmp contracts/workbook-v2.schema.json packages/runtime/contracts/workbook-v2.schema.json
fi
result=0
