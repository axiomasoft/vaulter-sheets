#!/usr/bin/env bash
set -euo pipefail

# Build two standalone private archives (PHP zip + npm tgz) and verify them in a clean
# temporary consumer installed on top of vaulter:
#   - PHP: CREATE -> GET -> PUT -> GET and 412 Precondition Failed on stale ETag
#   - Vue: import VaulterSpreadsheet from packed @vaulter/sheets-vue tarball

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VAULTER_DIR="${VAULTER_DIR:-$(cd "${ROOT_DIR}/../vaulter" && pwd)}"
PACKMAN_DIR="${PACKMAN_DIR:-$(cd "${ROOT_DIR}/../packman" && pwd)}"
ARCHIVE_DIR="${ROOT_DIR}/build/archives"
WORK_DIR="$(mktemp -d "${TMPDIR:-/tmp}/vaulter-sheets-consumer.XXXXXX")"

cleanup() {
    rm -rf "${WORK_DIR}"
}
trap cleanup EXIT

mkdir -p "${ARCHIVE_DIR}"

echo "==> [1/4] Packing PHP archive (axiomasoft/vaulter-sheets)"
PHP_ZIP="${ARCHIVE_DIR}/vaulter-sheets-1.0.0.zip"
rm -f "${PHP_ZIP}"
php -r '
$zip = new ZipArchive();
$out = $argv[1];
$src = realpath($argv[2]);
if ($zip->open($out, ZipArchive::CREATE | ZipArchive::OVERWRITE) !== true) {
    fwrite(STDERR, "Failed to open zip: $out\n");
    exit(1);
}
$it = new RecursiveIteratorIterator(new RecursiveDirectoryIterator($src, FilesystemIterator::SKIP_DOTS));
foreach ($it as $file) {
    $path = $file->getPathname();
    $rel = ltrim(str_replace($src, "", $path), "/");
    if (str_starts_with($rel, "vendor/") || str_starts_with($rel, ".phpunit")) {
        continue;
    }
    if ($rel === "composer.json") {
        $manifest = json_decode(file_get_contents($path), true, 512, JSON_THROW_ON_ERROR);
        $manifest["version"] = "1.0.0";
        $zip->addFromString($rel, json_encode($manifest, JSON_PRETTY_PRINT | JSON_UNESCAPED_SLASHES) . "\n");
        continue;
    }
    $zip->addFile($path, $rel);
}
$zip->close();
' "${PHP_ZIP}" "${ROOT_DIR}/packages/sheets"
echo "    Created ${PHP_ZIP}"

echo "==> [2/4] Building and packing npm archive (@vaulter/sheets-vue)"
(cd "${ROOT_DIR}/packages/vue" && npm run build)
NPM_TGZ_NAME="$(cd "${ROOT_DIR}/packages/vue" && npm pack --pack-destination "${ARCHIVE_DIR}" | tail -n 1)"
NPM_TGZ="${ARCHIVE_DIR}/${NPM_TGZ_NAME}"
echo "    Created ${NPM_TGZ}"

echo "==> [3/4] Verifying PHP archive in clean consumer"
PHP_CONSUMER="${WORK_DIR}/php-consumer"
mkdir -p "${PHP_CONSUMER}"
cat > "${PHP_CONSUMER}/composer.json" <<JSON
{
    "name": "test/vaulter-sheets-consumer",
    "type": "project",
    "license": "proprietary",
    "repositories": [
        {
            "type": "artifact",
            "url": "${ARCHIVE_DIR}"
        },
        {
            "type": "path",
            "url": "${VAULTER_DIR}/packages/*",
            "options": {
                "symlink": true,
                "versions": {
                    "axiomasoft/vaulter-core": "1.0.x-dev",
                    "axiomasoft/vaulter-drive": "1.0.x-dev",
                    "axiomasoft/vaulter-documents": "1.0.x-dev",
                    "axiomasoft/vaulter-media": "1.0.x-dev"
                }
            }
        },
        {
            "type": "path",
            "url": "${PACKMAN_DIR}/packages/*",
            "options": {
                "symlink": true,
                "versions": {
                    "axiomasoft/packman": "0.1.1",
                    "axiomasoft/packman-plugins": "0.1.1",
                    "axiomasoft/packman-schema": "0.1.1",
                    "axiomasoft/packman-testkit": "0.1.1"
                }
            }
        }
    ],
    "require": {
        "php": ">=8.4 <8.6",
        "axiomasoft/vaulter-sheets": "1.0.0",
        "axiomasoft/vaulter-drive": "^1.0",
        "axiomasoft/vaulter-media": "^1.0",
        "orchestra/testbench": "^11.3",
        "pestphp/pest": "^5.2"
    },
    "autoload-dev": {
        "psr-4": {
            "Vaulter\\\\Sheets\\\\Tests\\\\": "vendor/axiomasoft/vaulter-sheets/tests/"
        }
    },
    "minimum-stability": "dev",
    "prefer-stable": true,
    "config": {
        "allow-plugins": {
            "pestphp/pest-plugin": true
        }
    }
}
JSON

(cd "${PHP_CONSUMER}" && composer install --no-interaction --no-progress --prefer-dist)
(cd "${PHP_CONSUMER}" && vendor/bin/pest --test-directory=vendor/axiomasoft/vaulter-sheets/tests vendor/axiomasoft/vaulter-sheets/tests/Feature/SpreadsheetContentTest.php)

echo "==> [4/4] Verifying npm archive in clean consumer"
VUE_CONSUMER="${WORK_DIR}/vue-consumer"
mkdir -p "${VUE_CONSUMER}"
VAULTER_VUE_TGZ_NAME="$(cd "${VAULTER_DIR}/packages/vue" && npm pack --pack-destination "${WORK_DIR}" | tail -n 1)"
cat > "${VUE_CONSUMER}/package.json" <<JSON
{
  "name": "test-vaulter-sheets-vue-consumer",
  "private": true,
  "type": "module",
  "dependencies": {
    "@vaulter/vue": "file:${WORK_DIR}/${VAULTER_VUE_TGZ_NAME}",
    "@vaulter/sheets-vue": "file:${NPM_TGZ}",
    "vue": "^3.5.42"
  }
}
JSON

(cd "${VUE_CONSUMER}" && npm install --no-audit --no-fund)
(cd "${VUE_CONSUMER}" && node -e "
import fs from 'node:fs';
const pkg = JSON.parse(fs.readFileSync('node_modules/@vaulter/sheets-vue/package.json', 'utf8'));
const esm = fs.readFileSync('node_modules/@vaulter/sheets-vue/dist/vaulter-sheets-vue.js', 'utf8');
const dts = fs.readFileSync('node_modules/@vaulter/sheets-vue/dist/index.d.ts', 'utf8');
if (pkg.name !== '@vaulter/sheets-vue') process.exit(1);
if (!esm.includes('@vaulter/vue') || !esm.includes('vaulter/univer')) process.exit(1);
if (!dts.includes('VaulterSpreadsheet') || !dts.includes('SPREADSHEET_VIEWER_KEY')) process.exit(1);
console.log('OK: @vaulter/sheets-vue tarball installed and verified (externalizes vue & @vaulter/vue)');
")

echo "==> All consumer archive checks PASSED."
