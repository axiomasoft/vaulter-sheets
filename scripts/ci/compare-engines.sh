#!/usr/bin/env bash
# Runs the pinned Univer probes, the IronCalc cross-check and
# the offline Handsontable/HyperFormula benchmark, then writes bench/results/engine-comparison.
set -euo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
OUT="${ROOT}/bench/results/engine-comparison"
mkdir -p "${OUT}/headless"
export NPM_CONFIG_CACHE="${NPM_CONFIG_CACHE:-/tmp/npm-cache}"
# Chrome's singleton socket must fit in the 108-byte sockaddr limit. The
# conductor temp directory is longer than that, so the browser probe gets a
# short TMPDIR of its own.
export TMPDIR="${VAULTER_SHEETS_TMP:-/tmp/vaulter-sheets-bench}"
mkdir -p "${TMPDIR}"

cd "${ROOT}"
if [[ -z "${CHROME_BIN:-}" && -x /usr/bin/google-chrome ]]; then
    CHROME_BIN=/usr/bin/google-chrome
    export CHROME_BIN
fi
node -v | tee "${OUT}/node.txt"

set +e
bash "${ROOT}/bench/probes/univer-headless.sh" > "${OUT}/headless/univer-headless.log" 2>&1
headless_exit=$?
echo "${headless_exit}" > "${OUT}/headless/exit"
bash "${ROOT}/bench/probes/sheets-browser/run.sh" > "${OUT}/sheets-browser.log" 2>&1
browser_exit=$?
echo "${browser_exit}" > "${OUT}/sheets-browser.exit"
set -e

work="$(sed -n 's/^Каталог снимков и вывода: //p' "${OUT}/headless/univer-headless.log" | head -n 1)"
if [[ -n "${work}" && -d "${work}" ]]; then
    find "${work}" -maxdepth 1 -name '*.log' -exec cp {} "${OUT}/headless/" \;
fi

install_bench() {
    local dir="$1"
    # @ironcalc/nodejs optional platform packages are omitted from the lock that
    # `npm install` writes, and `npm ci` then rejects that lock. Install there.
    if [[ -f "${dir}/package-lock.json" && "${dir}" != *ironcalc* ]]; then
        (cd "${dir}" && npm ci --no-audit --no-fund)
    else
        (cd "${dir}" && npm install --no-audit --no-fund)
    fi
}

install_bench "${ROOT}/bench/engines/univer"
node --expose-gc "${ROOT}/bench/engines/univer/run.mjs" > "${OUT}/univer.json"

if [[ -z "${CHROME_BIN}" && -x /usr/bin/google-chrome ]]; then
    CHROME_BIN=/usr/bin/google-chrome
fi
if [[ -n "${CHROME_BIN}" ]]; then
    CHROME_BIN="${CHROME_BIN}" node "${ROOT}/bench/engines/univer/browser.mjs" > "${OUT}/univer-browser.json" || true
fi

install_bench "${ROOT}/bench/engines/ironcalc"
node "${ROOT}/bench/engines/ironcalc/run.mjs" > "${OUT}/ironcalc.json"

node "${ROOT}/bench/engines/handsontable-hyperformula/run.mjs" > "${OUT}/offline.json" || true

node --experimental-strip-types "${ROOT}/bench/engines/write-report.mjs"
echo "compare-engines: headless ${headless_exit}, browser ${browser_exit}, report written"
