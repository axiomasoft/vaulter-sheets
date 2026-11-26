# Changelog

All notable changes to **Vaulter Sheets** (`axiomasoft/vaulter-sheets` and the
`@vaulter/sheets-*` npm packages) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
packages adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Release targets are listed in `release/packages.json`. Until the public PHP APIs stabilize, publish Sheets and its required Vaulter PHP packages at the same version. npm packages have separate release targets.

## [Unreleased]

### Fixed

- `@vaulter/sheets-runtime` and `axiomasoft/vaulter-sheets` accept the optional IronCalc diagnostic on the calculation wire. PHP responses can include `checks.ironcalc_verification` on apply and recalculate.
- `@vaulter/sheets-runtime` filters dynamic data exchange links and program calls on XLSX import and export.
- `axiomasoft/vaulter-sheets` returns HTTP 422 `invalid_command` for an empty or oversized range sheet ID.
- `axiomasoft/vaulter-sheets`: a malformed cell range (`A0`, `ZZZZ1`, `B2:A1`, plain text) is
  answered `422 invalid_command` before the workbook is loaded. It used to reach the runtime and
  come back as `503 runtime_failed`, which told clients to retry a request that cannot succeed;
  clients that retried every 503 now get the 422 at once.
- `axiomasoft/vaulter-sheets` and `@vaulter/sheets-runtime` parse all XLSX XML parts, including
  worksheets, shared strings and relationships. Invalid XML and prohibited namespace declarations
  return HTTP 422 `unsafe_archive`. Literal namespace URLs in cell text are accepted.
- `axiomasoft/vaulter-sheets`: an XLSX upload whose relationships part is empty is rejected as
  `unsafe_archive` (HTTP 422, reason `malformed_rels`) instead of failing with HTTP 500.
- `axiomasoft/vaulter-sheets`: `vaulter-sheets.commands` is read as a boolean with the
  documented default `true` everywhere. A missing key no longer hides the command list from the
  workbook catalog while commits are still accepted, and a non-boolean value (for example the
  string `"false"` from the environment, which used to count as enabled) now fails loudly
  instead of silently enabling commands.

### Changed

- `@vaulter/sheets-realtime` derives presence identity from admitted room credentials, closes expired peers with 4001, and periodically rechecks every peer. New generations receive the full state even when the sequence number is unchanged. Presence updates are coalesced over 50 ms.
- `@vaulter/sheets-realtime` bounds pending connections per client address and limits queued intents per peer. Configure `SHEETS_REALTIME_PENDING_PER_ADDRESS` and `SHEETS_REALTIME_TRUSTED_PROXIES` when deploying behind a reverse proxy.
- `axiomasoft/vaulter-sheets` migration 000610 adds an actor admission row and a partial index of active jobs. Concurrent admissions now enforce the configured quota before committing a source blob. Existing imports and exports remain addressable with their original request keys. PostgreSQL serialization conflicts or deadlocks that exhaust the retry budget return HTTP 503 `contention`. Custom factories for `WorkbookExchange` must provide the Media `ContentStore` that stages source bytes before admission.
- `axiomasoft/vaulter-sheets`: an actor may have at most `exchange.max_active_per_actor` (default
  8, `SHEETS_EXCHANGE_MAX_ACTIVE_PER_ACTOR`) unfinished imports and exports in a project scope; a
  new registration beyond that is answered `429 too_many_exchanges`. Replaying an existing
  `request_key` remains available at capacity. Concurrent PostgreSQL admissions now serialize by actor and project.
- The published Sheets package requires matching versions of Vaulter Core, Drive, Documents and Media.
- Development: the family toolchain (Pint, Rector, PHPStan with the strict rule set, Pest type
  coverage) is declared in `composer.json`; `composer test` installs the npm workspace it needs.
