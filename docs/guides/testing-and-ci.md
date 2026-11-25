# Testing and CI

Setup and the one-line commands are in [CONTRIBUTING.md](../../CONTRIBUTING.md). This page explains
what each layer covers and how CI is put together.

## PHP suite (`packages/sheets/tests`)

Run with `composer test` (which first installs the npm workspace through `composer node:deps`).
Pest is pointed at `packages/sheets/phpunit.xml` and `--test-directory=packages/sheets/tests`, so
`Pest.php` there decides which base test case each file uses.

| Suite | What it covers | Base case |
| --- | --- | --- |
| `Arch` | Package boundary: strict types, final classes, no debug helpers, production code never uses the tests, no import of a Vaulter or Packman class marked `#[Internal]` (one documented exception) | none (Pest arch) |
| `Unit` | Pure code: RFC 8785 canonical JSON (and byte parity with the Node implementation), the XLSX archive guard | none |
| `Contract` | The document type against the Vaulter Documents contract tests | `TestCase` |
| `Feature` | Commands, the commands switch, exchange, realtime, content round trips, the package disabled | `TestCase`, `RealtimeTestCase`, `WithoutSheetsTestCase` |

`TestCase` boots Orchestra Testbench with Vaulter core, Drive, Documents, Media and Sheets;
`RealtimeTestCase` adds Vaulter Collaboration; `WithoutSheetsTestCase` boots the base without
Sheets to prove the type disappears cleanly.

Several feature tests call the real Node runtime from `packages/runtime/src` (Node.js 26.13.1 runs
the TypeScript sources directly), so a broken runtime fails the PHP suite too.

**Databases.** The default is in-memory SQLite. CI runs the same suite on PostgreSQL 18.7 and 19.0;
locally, PostgreSQL 18 or newer is required because the schema uses `uuidv7()` (see the PostgreSQL
section of CONTRIBUTING for the exact commands). The suite also passes in random order
(`vendor/bin/pest … --order-by=random`).

**Type coverage.** `composer test:types` must stay at 100 %.

## npm workspaces

| Workspace | Tests |
| --- | --- |
| `@vaulter/sheets-runtime` | `node --test`: command application, the workbook profile, table bindings, exchange, an IronCalc cross-check |
| `@vaulter/sheets-realtime` | `node --test`: journal replay after restart, the native Univer binding |
| `@vaulter/sheets-vue` | Vitest: the spreadsheet component and the command translation |
| `@vaulter/sheets-tiptap` | Vitest: the WorkbookReference node |

Each workspace also has `typecheck` and `build`. Build in dependency order: runtime, realtime, vue,
tiptap.

## End-to-end lanes

`scripts/ci/*.sh` start their own PostgreSQL container, the runtime and, where needed, a Laravel
owner and a Vite page, then drive Chromium through Playwright. They need Docker and
`npx playwright install --with-deps chromium`. The table in CONTRIBUTING lists what each lane covers.

## Static checks

| Check | Command | Notes |
| --- | --- | --- |
| PHPStan | `composer analyse` | Level max with the Packman base config, Larastan, strict rules and disallowed calls (`DB::transaction`, `ZipArchive::extractTo`, `parse_url`, `env()` outside config, `CURLOPT_RESOLVE`). Analyses `src`, `database`, `routes` |
| Pint | `composer lint:check` | The family rule set from the base repository |
| Rector | `composer refactor:check` | The family set, dry run. Rector is held below 2.9 until Packman devtools drops `SetList::EARLY_RETURN` |
| Stop-cranes | `python3 scripts/ci/engineering-rails.py --root .` and `--self-test` | Text scan of manifests and sources for the zero-royalty denylist and banned calls; the self-test proves each rule still fires |

## CI (`.github/workflows/ci.yml`)

The workflow is a DAG. GitHub draws it from each job's `needs`:

```
changes ──► quality ──► php (8.4/8.5 × PostgreSQL 18.7/19.0; default SQLite is local)
                   ├──► node (workspaces, then the end-to-end lanes)
                   └──► images (runtime and realtime Docker builds)
                         └──► CI gate
```

1. **Changes** selects lanes. A push to `main`, a `workflow_dispatch`, or a change under
   `.github/` or `scripts/ci/` runs every lane. On other branches, `dorny/paths-filter` skips
   lanes whose files did not change.
2. **Quality** is the fast fail: the Node engines assertion, stop-cranes, `composer validate`,
   Pint, PHPStan, Rector, 100 % type coverage, actionlint and zizmor. Heavier lanes start only
   after it succeeds.
3. **PHP, Node and images** then run in parallel. The PHP 8.4 / PostgreSQL 18.7 cell uploads a
   Clover coverage artifact.
4. **CI gate** waits for every job (`if: always()`) and fails if any needed job failed or was
   cancelled. A skipped lane (path filter) is allowed. Branch protection should require only
   `CI gate`.

Triggers: pushes to `main`, `refactor/**`, `feat/**`, `fix/**`, `hotfix/**` and `chore/**`, pull
requests, and manual `workflow_dispatch`. Concurrent runs on the same ref cancel the earlier one.
Actions are pinned by commit SHA (with a version comment); PostgreSQL images by digest. PHP and
Node setup, Composer/npm caching, and workflow lint live in composite actions under
`.github/actions/`.

### Sibling repositories

Every job except `images` checks out the siblings with `scripts/ci/checkout-ecosystem.sh`
(`vaulter` and `vaulter-collaboration` at `main`, Packman at the tag pinned in `composer.json`,
currently `v0.1.1`). The secret `VAULTER_READ_TOKEN` is optional while those repositories are
public; when set, it is sent as an HTTP header, never in a URL. Runners need Docker (service
containers, end-to-end lanes, and the image job).
