# Changelog

All notable changes to **Vaulter Sheets** (`axiomasoft/vaulter-sheets` and the
`@vaulter/sheets-*` npm packages) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
packages adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each package is
released on its own line (`release/packages.json`); an entry names the package it affects.

## [Unreleased]

### Fixed

- `axiomasoft/vaulter-sheets`: a malformed cell range (`A0`, `ZZZZ1`, `B2:A1`, plain text) is
  answered `422 invalid_command` before the workbook is loaded. It used to reach the runtime and
  come back as `503 runtime_failed`, which told clients to retry a request that cannot succeed;
  clients that retried every 503 now get the 422 at once.
- `axiomasoft/vaulter-sheets`: the archive guard also refuses an XLSX part that declares the
  XInclude namespace with character references (`http&#58;//www.w3.org/2001/XInclude`); the plain
  substring check let it through in every part except relationships.
- `axiomasoft/vaulter-sheets`: an XLSX upload whose relationships part is empty is rejected as
  `unsafe_archive` (HTTP 422, reason `malformed_rels`) instead of failing with HTTP 500.
- `axiomasoft/vaulter-sheets`: `vaulter-sheets.commands` is read as a boolean with the
  documented default `true` everywhere. A missing key no longer hides the command list from the
  workbook catalog while commits are still accepted, and a non-boolean value (for example the
  string `"false"` from the environment, which used to count as enabled) now fails loudly
  instead of silently enabling commands.

### Changed

- `axiomasoft/vaulter-sheets`: an actor may have at most `exchange.max_active_per_actor` (default
  8, `SHEETS_EXCHANGE_MAX_ACTIVE_PER_ACTOR`) unfinished imports and exports in a project scope; a
  new registration beyond that is answered `429 too_many_exchanges`. Replaying an existing
  `request_key` is never held back.
- Development: the family toolchain (Pint, Rector, PHPStan with the strict rule set, Pest type
  coverage) is declared in `composer.json`; `composer test` installs the npm workspace it needs.
