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

Package trees arrive in later waves. This scaffold is the root workspace: Composer path repository `packages/*`, npm workspaces, PHPStan, PHPUnit, the release manifest and CI.

## Toolchain

- PHP `>=8.4 <8.6`
- Node.js `>=26.13.1` (`package.json` `engines.node`)
- PostgreSQL CI matrix: 18.7 and 19.0

## CI

`.github/workflows/ci.yml` validates `composer.json`, asserts Node.js 26.13.1, runs PostgreSQL 18.7 and 19.0, applies the unindexed-foreign-key gate, and fails when a dependency or a source file hits a stop-crane. The workflow's negative fixture must fail on a forbidden package or a banned call.

## Node image

The root `Dockerfile` is the shared template for sheets-runtime (port 3100) and sheets-realtime (port 3101). Build the realtime image with `--build-arg SERVICE_PORT=3101`. Base `node:26.13.1-bookworm-slim`, Debian package `libatomic1` (the `libatomic` library), smoke `RUN node -e "process.exit(0)"`.
