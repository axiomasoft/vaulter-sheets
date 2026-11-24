#!/usr/bin/env bash
set -euo pipefail
probe_dir=$(cd "$(dirname "$0")/sheets-headless" && pwd)
work=$(mktemp -d)
printf 'Каталог снимков и вывода: %s\n' "$work"
(cd "$probe_dir" && sha256sum --check --status SHA256SUMS)
cp "$probe_dir"/{package.json,npm-shrinkwrap.json,smoke.mjs,edge-cases.mjs,resources.mjs} "$work/"
cd "$work"
npm ci --ignore-scripts --no-audit --no-fund --prefer-offline
node -v
for phase in create update insert reopen stale-address; do
    node smoke.mjs "$phase" > "$work/$phase.log"
done
for phase in cached-value unknown-resource; do
    node edge-cases.mjs "$phase" > "$work/$phase.log"
done
node resources.mjs create > "$work/resources-create.log"
if node resources.mjs insert > "$work/resources-insert.log" 2>&1; then
    echo 'Диапазон conditional formatting теперь проходит проверку. Пересмотрите зафиксированное ограничение версии.'
    exit 1
fi
python3 - "$work" <<'PY'
import json
from pathlib import Path
import sys

root = Path(sys.argv[1])
def output(name):
    return [json.loads(line) for line in (root / f"{name}.log").read_text().splitlines() if line.startswith("{")]

assert [record["afterDefaultInitialization"] for record in output("cached-value") if "afterDefaultInitialization" in record] == [999]
assert output("cached-value")[-1]["afterForcedRecalculation"] == 41
assert output("unknown-resource")[-1]["savedContainsSentinel"] is False
cf_range = output("resources-insert")[0]["conditional"][0]["ranges"][0]
assert (cf_range["startRow"], cf_range["endRow"]) == (1, 2)
assert "ERR_ASSERTION" in (root / "resources-insert.log").read_text()
print("Начальный итог 35, после цены/вставки/открытия 41. Подложенный кэш 999 исправился после полного пересчёта.")
print("Повторены ограничения: пропадает неизвестный ресурс, headless CF остался D2:D3 вместо D3:D4.")
PY
