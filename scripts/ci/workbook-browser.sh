#!/usr/bin/env bash
set -euo pipefail
cd "$(dirname "$0")/../.."

runtime_supervisor=
owner_pid=
vite_pid=
start_workbook_runtime() {
    export SHEETS_RUNTIME_RESTART_SIGNAL="${work}/supervisor.pid"
    export SHEETS_RUNTIME_CHILD_PID="${work}/runtime.pid"
    (
        child=
        restart() {
            kill "${child}" 2>/dev/null || true
            wait "${child}" 2>/dev/null || true
            node packages/runtime/dist/server.js >> "${work}/runtime.log" 2>&1 &
            child=$!
            printf '%s\n' "${child}" > "${SHEETS_RUNTIME_CHILD_PID}"
        }
        trap 'restart' USR2
        trap 'kill "${child}" 2>/dev/null || true; exit 0' TERM
        restart
        while kill -0 "${child}" 2>/dev/null; do wait "${child}" || true; done
    ) &
    runtime_supervisor=$!
    printf '%s\n' "${runtime_supervisor}" > "${SHEETS_RUNTIME_RESTART_SIGNAL}"
}
after_workbook_cleanup() {
    for pid in "${owner_pid}" "${vite_pid}" "${runtime_supervisor}"; do
        if [[ -n "${pid}" ]]; then kill "${pid}" 2>/dev/null || true; fi
    done
    if [[ ${result:-1} != 0 ]]; then
        cat "${work}/owner.log" "${work}/vite.log" 2>/dev/null || true
    fi
}
run_workbook_checks() {
    export APP_ENV=testing SHEETS_OWNER_URL="http://127.0.0.1:${SHEETS_OWNER_PORT:-18083}"
    export SHEETS_BROWSER_URL="http://127.0.0.1:${SHEETS_BROWSER_PORT:-15173}"
    php tests/e2e/owner.php > "${work}/owner-migrate.log" 2>&1 || { cat "${work}/owner-migrate.log"; return 1; }
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
    TMPDIR="${work}" node node_modules/@playwright/test/cli.js test --config tests/e2e/playwright.config.mjs
}
source "$(dirname "${BASH_SOURCE[0]}")/workbook-contract.sh"
