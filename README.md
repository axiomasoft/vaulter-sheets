# vaulter-sheets

Vaulter Sheets — zero-royalty Univer OSS (Apache-2.0) spreadsheet engine for Vaulter: PHP workbook owner, Vue editor, Node headless runtime, Zero-Pro XLSX/CSV, realtime and Tiptap WorkbookReference.

Private / proprietary channel for FlexCrm and Edufy.

## Layout

| Path | Artifact | Role |
| --- | --- | --- |
| `packages/sheets/` | `axiomasoft/vaulter-sheets` | PHP workbook owner |
| `packages/vue/` | `@vaulter/sheets-vue` | Closed Vue viewer |
| `packages/runtime/` | `@vaulter/sheets-runtime` | Node runtime and image, port 3100 |
| `packages/realtime/` | `@vaulter/sheets-realtime` | Realtime server and image, port 3101 |
| `packages/tiptap/` | `@vaulter/sheets-tiptap` | Tiptap WorkbookReference |
| `contracts/` | — | Canonical schemas |
| `release/packages.json` | — | Private PHP, npm and image manifest |

### Single-workbook setup

Install the Sheets PHP and Vue packages alongside Vaulter Documents, Drive and Media. Run the Vaulter migrations and register `VaulterSpreadsheet` for `vaulter/univer` in the Vue host. Import `@vaulter/sheets-vue/style.css` in the host. The viewer uses the same-origin `/api/vaulter-sheets/v1` API by default. Pass a client created with `createWorkbooksClient` when the host uses a custom route prefix or request headers.

Set `SHEETS_RUNTIME_URL` and `SHEETS_RUNTIME_TOKEN_FILE` for the private HTTP calculator. For CLI use, install the built runtime package and configure `vaulter-sheets.runtime_command`. The HTTP and CLI calculators use the same wire schema. Run the host scheduler and a worker on the `sheets-commands` queue to reclaim interrupted commands. A host with its own tenant resolver can bind `WorkbookRecoveryContext` to restore the queue actor in that tenant.

Use `scripts/ci/workbook-contract.sh` for the PostgreSQL and HTTP command tests and `scripts/ci/workbook-browser.sh` for the Chromium cold reopen and heap checks.

### Collaborative workbooks

Install `axiomasoft/vaulter-collaboration` and enable both `vaulter.modules.collaboration` and `vaulter.modules.sheets-realtime` before running the Vaulter migrations. Configure the collaboration package's Room JWT keys on the PHP owner. Set `SHEETS_REALTIME_URL` to the public WebSocket origin and mount the same private `SHEETS_REALTIME_OWNER_TOKEN_FILE` in PHP and the room process. Set `SHEETS_REALTIME_OWNER_URL` in the room process to the PHP endpoint ending in `/api/vaulter-sheets/v1/realtime/owner`. Keep that endpoint on the private network. The room process serves `/livez`, `/readyz` and the room WebSocket on port 3101. The WebSocket negotiates `univer-sheets.v1` for the `univer-sheets/1` journal protocol.

An editor enables a workbook with `PUT /workbooks/{node}/realtime/profile`, `If-Match` from the workbook catalog and `{"mode":"journal"}`. `POST /workbooks/{node}/realtime/session` issues the room credential for the host's current actor. Pass a function that fetches this session to `WorkbookRoomClient`. For a mounted Univer workbook, `connectNativeWorkbook` binds the command hook and reapplies pending intents after each confirmed state. The host supplies its in-place workbook replacement and cell reads. A room outage leaves the workbook in journal mode. To resume snapshot editing, explicitly switch the profile to `snapshot` with the current `If-Match` after the last accepted update has been checkpointed.

Build the room image with `docker build -f packages/realtime/Dockerfile .`. Run `scripts/ci/realtime.sh` for the PostgreSQL and two-process browser scenarios. Use `SHEETS_PG_VERSION=19.0` to select the second PostgreSQL lane.

## Toolchain

- PHP `>=8.4 <8.6`
- Node.js `>=26.13.1` (`package.json` `engines.node`)
- PostgreSQL CI matrix: 18.7 and 19.0

## CI

`.github/workflows/ci.yml` validates `composer.json`, asserts Node.js 26.13.1, runs PostgreSQL 18.7 and 19.0, applies the unindexed-foreign-key gate, and fails when a dependency or a source file hits a stop-crane. The workflow's negative fixture must fail on a forbidden package or a banned call.

## Node image

Build the single-workbook HTTP image from the repository root with `docker build -f packages/runtime/Dockerfile .`. Mount the bearer token file and set `SHEETS_RUNTIME_TOKEN_FILE` inside the container.
