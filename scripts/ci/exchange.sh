#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

export SHEETS_EXCHANGE_FORMATS="csv,xlsx"

runtime_supervisor=
owner_pid=
vite_pid=

start_workbook_runtime() {
    node packages/runtime/dist/server.js > "${work}/runtime.log" 2>&1 &
    runtime_supervisor=$!
}

after_workbook_cleanup() {
    for pid in "${owner_pid}" "${vite_pid}" "${runtime_supervisor}"; do
        if [[ -n "${pid}" ]]; then kill "${pid}" 2>/dev/null || true; fi
    done
    if [[ ${result:-1} != 0 ]]; then
        echo "======= owner.log =======" >&2
        cat "${work}/owner.log" >&2 2>/dev/null || true
        echo "======= vite.log =======" >&2
        cat "${work}/vite.log" >&2 2>/dev/null || true
    fi
}

run_workbook_checks() {
    # 1. Verify runtime exchange endpoints enforce disabled state & token auth cleanly
    local disabled_port="${SHEETS_RUNTIME_DISABLED_PORT:-13101}"
    PORT="${disabled_port}" SHEETS_EXCHANGE_FORMATS="" node packages/runtime/dist/server.js > "${work}/runtime-disabled.log" 2>&1 &
    local disabled_pid=$!
    for elapsed in {1..40}; do
        curl -fsS "http://127.0.0.1:${disabled_port}/readyz" >/dev/null 2>&1 && break
        sleep 1
    done
    local disabled_code
    disabled_code=$(curl -s -o "${work}/disabled-resp.json" -w '%{http_code}' \
        -H "Authorization: Bearer $(cat "${SHEETS_RUNTIME_TOKEN_FILE}")" \
        -H 'Content-Type: application/json' \
        -d '{"version":1,"request_id":"disabled-probe"}' \
        "http://127.0.0.1:${disabled_port}/v1/exchange")
    kill "${disabled_pid}" 2>/dev/null || true
    wait "${disabled_pid}" 2>/dev/null || true
    if [[ "${disabled_code}" != "404" ]] || ! grep -q '"exchange_disabled"' "${work}/disabled-resp.json"; then
        echo "Expected 404 exchange_disabled when SHEETS_EXCHANGE_FORMATS is unset, got ${disabled_code}: $(cat "${work}/disabled-resp.json")" >&2
        return 1
    fi

    # 2. Verify runtime unit & integration tests (Node >=26.13.1)
    npm run test --workspace @vaulter/sheets-runtime

    # 3. Migrate owner schema against PostgreSQL 18.7 and verify v_sheets_* foreign-key indexes
    APP_ENV=testing php tests/e2e/owner.php > "${work}/schema.log" 2>&1 || { cat "${work}/schema.log"; return 1; }
    docker exec -i "${container}" psql -X -v ON_ERROR_STOP=1 -U "${DB_USERNAME}" -d "${DB_DATABASE}" <<'SQL'
DO $$
BEGIN
    IF to_regclass('v_sheets_exchange_jobs') IS NULL THEN
        RAISE EXCEPTION 'v_sheets_exchange_jobs table is missing';
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE conrelid = 'v_sheets_exchange_jobs'::regclass AND contype = 'f') THEN
        RAISE EXCEPTION 'Sheets exchange foreign keys are missing';
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

    # 4. Run full Pest exchange feature suite against PostgreSQL 18.7 + HTTP runtime (/v1/exchange)
    php vendor/bin/pest -c packages/sheets/phpunit.xml --test-directory=packages/sheets/tests packages/sheets/tests/Feature/WorkbookExchangeTest.php

    # 5. Browser E2E for exchange lifecycle against PostgreSQL 18.7 + Vite + Chromium
    export APP_ENV=testing SHEETS_OWNER_URL="http://127.0.0.1:${SHEETS_OWNER_PORT:-18083}"
    export SHEETS_BROWSER_URL="http://127.0.0.1:${SHEETS_BROWSER_PORT:-15173}"
    php -S "127.0.0.1:${SHEETS_OWNER_PORT:-18083}" tests/e2e/owner.php > "${work}/owner.log" 2>&1 &
    owner_pid=$!
    npm run build --workspace @vaulter/sheets-vue
    node node_modules/vite/bin/vite.js --config tests/e2e/vite.config.mjs --host 127.0.0.1 --port "${SHEETS_BROWSER_PORT:-15173}" --strictPort > "${work}/vite.log" 2>&1 &
    vite_pid=$!
    for elapsed in {1..60}; do
        curl -fsS "${SHEETS_BROWSER_URL}/api/test/ready" >/dev/null 2>&1 && break
        sleep 1
    done
    curl -fsS "${SHEETS_BROWSER_URL}/api/test/ready"
    TMPDIR="${work}" node node_modules/@playwright/test/cli.js test --config tests/e2e/exchange.playwright.config.mjs

    # 6. Verify contract schema checksums match root contracts/
    cmp contracts/exchange-v1.schema.json packages/runtime/contracts/exchange-v1.schema.json
    cmp contracts/runtime-v1.schema.json packages/runtime/contracts/runtime-v1.schema.json
    cmp contracts/workbook-v2.schema.json packages/runtime/contracts/workbook-v2.schema.json
}

source "$(dirname "${BASH_SOURCE[0]}")/workbook-contract.sh"
