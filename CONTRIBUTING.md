# Contributing to Vaulter Sheets

This repository holds one Laravel package (`packages/sheets`, `axiomasoft/vaulter-sheets`) and
four npm workspaces (`packages/runtime`, `packages/realtime`, `packages/vue`,
`packages/tiptap`). See the [README](README.md) for what each one ships.

## Workspace layout

Composer path repositories, the `file:` dependency of `packages/vue` on `@vaulter/vue` and the
CI checkout expect the sibling repositories next to this one:

```text
workspace/
├── vaulter-sheets/          # this repository
├── vaulter/                 # axiomasoft/vaulter (core, media, drive, documents, @vaulter/vue)
├── vaulter-collaboration/   # axiomasoft/vaulter-collaboration
└── packman/                 # axiomasoft/packman at the tag pinned in composer.json
```

`scripts/ci/checkout-ecosystem.sh` creates any missing sibling at the ref CI uses (Packman at
the tag named in the root `composer.json`, the Vaulter repositories at `main`). For private
repositories export `VAULTER_READ_TOKEN`; the script sends it as an HTTP header and never
writes it to a URL or git config.

## Prerequisites

- PHP `>=8.4 <8.6` with Composer and the `mbstring`, `xml`, `xmlreader`, `zip` and
  `pdo_pgsql` extensions
- Node.js `>=26.13.1` with npm (`package.json` `engines.node`; older Node.js cannot run the
  TypeScript sources the PHP suite executes)
- Docker for the `scripts/ci/*.sh` lanes, which start their own PostgreSQL containers
- PostgreSQL 18 or newer only if you want to run the PHP suite on a server database (the schema
  uses `uuidv7()`; SQLite is the default)

## Setup

```bash
scripts/ci/checkout-ecosystem.sh
(cd ../vaulter && npm ci && npm run build --workspace @vaulter/vue)
composer install
npm ci
```

## Checks

| What | Command |
| --- | --- |
| Code style | `composer lint:check` (fix with `composer lint`) |
| Static analysis (level max, family strict rules) | `composer analyse` |
| Rector (dry run) | `composer refactor:check` (apply with `composer refactor`) |
| Engineering rails (stop-cranes) | `python3 scripts/ci/engineering-rails.py --root . && python3 scripts/ci/engineering-rails.py --self-test` |
| PHP tests | `composer test` |
| PHP type coverage (100 %) | `composer test:types` |
| npm workspaces | `npm run test`, `npm run typecheck`, `npm run build` with `--workspace <name>` |

`composer test` first runs `composer node:deps`: the PHP suite calls the Node workbook runtime
straight from `packages/runtime/src` (canonical JSON parity, calculator, exchange), so it needs
the npm workspace installed. The script checks the Node.js version against `engines.node` and
runs `npm ci` when `node_modules` is missing or older than `package-lock.json`; nothing has to
be built.

The npm workspaces depend on each other in this order: runtime, realtime, vue, tiptap.
`npm run build --workspaces` follows it; when running one workspace by hand, build realtime
before type-checking vue, which imports `@vaulter/sheets-realtime/native-adapter`.

### PostgreSQL

`packages/sheets/phpunit.xml` defaults to in-memory SQLite. To run against PostgreSQL, export
the usual Laravel variables, migrate with the test owner and check the foreign-key indexes the
same way CI does:

```bash
export APP_ENV=testing DB_CONNECTION=pgsql DB_HOST=127.0.0.1 DB_PORT=5432 \
       DB_DATABASE=vaulter_test DB_USERNAME=vaulter DB_PASSWORD=secret
php tests/e2e/owner.php
PGHOST=$DB_HOST PGPORT=$DB_PORT PGUSER=$DB_USERNAME PGPASSWORD=$DB_PASSWORD PGDATABASE=$DB_DATABASE \
    psql -v ON_ERROR_STOP=1 -f scripts/ci/unindexed-fks.sql
composer test
```

### End-to-end lanes

The scripts under `scripts/ci/` start a throwaway PostgreSQL container (`postgres:18.7` by
default; `SHEETS_POSTGRES_IMAGE` or `SHEETS_PG_VERSION` selects another, depending on the
script), build what they need and clean up on exit:

| Script | Covers |
| --- | --- |
| `workbook-contract.sh` | PostgreSQL commands against the HTTP runtime |
| `exchange.sh` | XLSX/CSV import and export jobs |
| `realtime.sh` | Room process, journal and two-process browser scenarios |
| `reference.sh` | Tiptap WorkbookReference in a consumer app, in a browser |
| `workbook-browser.sh` | Chromium cold reopen and heap checks |
| `office-sheets.sh` | Table bindings, the command, realtime and exchange suites on PostgreSQL and, when `../vaulter-ai` is checked out, its sheets tests |
| `package-consumers.sh` | The private PHP and npm archives in clean consumer projects |

The browser lanes need Playwright Chromium: `npx playwright install --with-deps chromium`.

## CI

The jobs, what each test layer covers and what a mirror needs to run the workflow are described in
[docs/guides/testing-and-ci.md](docs/guides/testing-and-ci.md). The `CI gate` job is the one check
a branch rule should require.

## Commits and branches

- Work on a branch; `main` is updated through reviewed merges only.
- Use [Conventional Commits](https://www.conventionalcommits.org/) with the package as the
  scope (`sheets`, `runtime`, `realtime`, `vue`, `tiptap`, `ci`, `deps`). The body says what
  changed and why.
- Every suppression (`@phpstan-ignore`, `@ts-expect-error`) carries its reason next to it.
  Skipped tests are not allowed; the rails reject `->skip()`.
- Do not commit AI agent or editor configuration; `.gitignore` excludes the known paths.
