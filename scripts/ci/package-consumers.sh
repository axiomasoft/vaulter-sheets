#!/usr/bin/env bash
set -euo pipefail

# Build two standalone private archives (PHP zip + npm tgz) and verify them in a clean
# temporary consumer installed on top of vaulter:
#   - PHP: CREATE -> GET and 409 document_command_required for generic PUT
#   - Vue: import VaulterSpreadsheet from packed @vaulter/sheets-vue tarball

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)"
VAULTER_DIR="$(cd "${VAULTER_DIR:-${ROOT_DIR}/../vaulter}" && pwd)"
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
if [[ ! -d "${VAULTER_DIR}/node_modules" ]]; then
    (cd "${VAULTER_DIR}" && npm ci --no-audit --no-fund)
fi
(cd "${VAULTER_DIR}/packages/vue" && npm run build)

# Recreate the lockfile's sibling layout with the Vaulter checkout built above.
SHEETS_BUILD="${WORK_DIR}/sheets"
mkdir -p "${SHEETS_BUILD}"
ln -s "${VAULTER_DIR}" "${WORK_DIR}/vaulter"
tar -C "${ROOT_DIR}" --exclude=packages/vue/node_modules --exclude=packages/vue/dist \
    -cf - package.json package-lock.json patches scripts/patch-univer.mjs packages/vue packages/runtime/package.json | tar -C "${SHEETS_BUILD}" -xf -
(cd "${SHEETS_BUILD}" && npm ci --no-audit --no-fund)
if [[ ! "${SHEETS_BUILD}/node_modules/@vaulter/vue" -ef "${VAULTER_DIR}/packages/vue" ]]; then
    printf 'Expected @vaulter/vue to link to %s\n' "${VAULTER_DIR}/packages/vue" >&2
    exit 1
fi
(cd "${SHEETS_BUILD}/packages/vue" && npm run build)
NPM_TGZ_NAME="$(cd "${SHEETS_BUILD}/packages/vue" && npm pack --pack-destination "${ARCHIVE_DIR}" | tail -n 1)"
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
  },
  "devDependencies": {
    "@vue/test-utils": "^2.4.6",
    "happy-dom": "^20.10.6"
  }
}
JSON

(cd "${VUE_CONSUMER}" && npm install --no-audit --no-fund)
cat > "${VUE_CONSUMER}/verify.mjs" <<'MJS'
import { Window } from 'happy-dom';

const win = new Window();
globalThis.window = win;
globalThis.document = win.document;
globalThis.HTMLElement = win.HTMLElement;
globalThis.SVGElement = win.SVGElement;
globalThis.Element = win.Element;
globalThis.Node = win.Node;
globalThis.MutationObserver = win.MutationObserver;

const { defineComponent, h, ref } = await import('vue');
const { flushPromises, mount } = await import('@vue/test-utils');
const { VaulterPlugin, createVaulterClient, useViewerRegistry } = await import('@vaulter/vue');
const { VaulterSpreadsheet, SPREADSHEET_VIEWER_KEY } = await import('@vaulter/sheets-vue');

if (!VaulterSpreadsheet || SPREADSHEET_VIEWER_KEY !== 'vaulter/univer') {
  throw new Error('Failed to import VaulterSpreadsheet or SPREADSHEET_VIEWER_KEY from @vaulter/sheets-vue');
}

let loadCount = 0;
const client = createVaulterClient();
const workbookClient = {
  async open(id) {
    loadCount += 1;
    return {
      workbook: {format_version: 2, native: {id: 'wb1', name: `Budget v${loadCount}`}, profile: {}, tables: []},
      marker: {generation: 0, position: loadCount, sha256: 'a'.repeat(64)},
      etag: `"${id}.0.${loadCount}"`,
      commands: ['set_number'],
    };
  },
};

const sheetNode = {
  id: '20',
  drive_id: '1',
  parent_id: null,
  kind: 'document',
  name: 'Budget',
  mime: 'application/vnd.vaulter.document+json',
  extension: null,
  size_bytes: 0,
  version: 1,
  etag: '"20.0.1"',
  path: '/Budget',
  created_at: '2026-01-01T00:00:00Z',
  updated_at: '2026-01-01T00:00:00Z',
  trashed_at: null,
  abilities: {
    view: true, download: true, comment: true, edit: true,
    create: true, move: true, copy: true, trash: true,
    restore: true, share: true, manage: true, delete: true,
  },
  presentation: {
    handler: null,
    document_type: 'vaulter/spreadsheet',
    type_available: true,
    viewer: { key: SPREADSHEET_VIEWER_KEY, props: {} },
    capabilities: {
      editable: true, previewable: true, downloadable: false,
      thumbnailable: false, collaborative: false,
    },
  },
};

let resolvedViewer = null;
const viewerRef = ref(null);

const Host = defineComponent({
  setup() {
    const registry = useViewerRegistry();
    resolvedViewer = registry.resolve(SPREADSHEET_VIEWER_KEY);
    return () => {
      if (!resolvedViewer) return null;
      return h(
        resolvedViewer,
        { node: sheetNode, workbookClient, ref: viewerRef },
        {
          default: ({ workbook }) => h('pre', { class: 'wb' }, JSON.stringify(workbook)),
        },
      );
    };
  },
});

const wrapper = mount(Host, {
  global: {
    plugins: [
      [VaulterPlugin, { client, viewers: { [SPREADSHEET_VIEWER_KEY]: VaulterSpreadsheet } }],
    ],
  },
});

await flushPromises();

if (resolvedViewer !== VaulterSpreadsheet) {
  throw new Error('VaulterPlugin viewer registry did not resolve SPREADSHEET_VIEWER_KEY to VaulterSpreadsheet');
}
if (loadCount !== 1 || !wrapper.get('.wb').text().includes('Budget v1')) {
  throw new Error(`Initial workbook load failed: loadCount=${loadCount}, text=${wrapper.html()}`);
}

await viewerRef.value.load();
await flushPromises();

if (loadCount !== 2 || !wrapper.get('.wb').text().includes('Budget v2')) {
  throw new Error(`Workbook reload failed: loadCount=${loadCount}, text=${wrapper.html()}`);
}

console.log('OK: @vaulter/sheets-vue tarball imported, resolved via VaulterPlugin, mounted default slot, and reloaded workbook');
MJS
(cd "${VUE_CONSUMER}" && node verify.mjs)

echo "==> All consumer archive checks PASSED."
