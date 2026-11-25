# Changelog

All notable changes to **Vaulter Sheets** (`axiomasoft/vaulter-sheets` and the
`@vaulter/sheets-*` npm packages) are documented in this file.

The format is based on [Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the
packages adhere to [Semantic Versioning](https://semver.org/spec/v2.0.0.html). Each package is
released on its own line (`release/packages.json`); an entry names the package it affects.

## [Unreleased]

### Fixed

- `axiomasoft/vaulter-sheets`: an XLSX upload whose relationships part is empty is rejected as
  `unsafe_archive` (HTTP 422, reason `malformed_rels`) instead of failing with HTTP 500.
- `axiomasoft/vaulter-sheets`: `vaulter-sheets.commands` is read as a boolean with the
  documented default `true` everywhere. A missing key no longer hides the command list from the
  workbook catalog while commits are still accepted, and a non-boolean value (for example the
  string `"false"` from the environment, which used to count as enabled) now fails loudly
  instead of silently enabling commands.

### Changed

- Development: the family toolchain (Pint, Rector, PHPStan with the strict rule set, Pest type
  coverage) is declared in `composer.json`; `composer test` installs the npm workspace it needs.
