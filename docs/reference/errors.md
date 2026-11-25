# Error reference

## Response shape

Every failure of the `/api/vaulter-sheets/v1` endpoints is an RFC 9457 problem document with
`Content-Type: application/problem+json`:

```json
{
  "type": "about:blank",
  "title": "unsafe_archive",
  "code": "unsafe_archive",
  "status": 422,
  "detail": {"reason": "malformed_rels"}
}
```

`code` is the stable value to branch on; `title` repeats it. `detail` is an object whose keys depend
on the code (often a `reason`). A command that was accepted and later rejected by its worker is
reported by `GET /workbooks/{node}/commands/{command}` as `{"data": {"state": "rejected", "error":
{...}}}` with the same code and status.

In PHP every problem is a `Vaulter\Sheets\Data\WorkbookProblem` with public `problem`, `status`
and `detail` properties.

## Codes

**Retry** says what a client should do: *yes* (the same request may succeed later, back off),
*refresh* (re-read the workbook and its ETag, rebuild the command), *no* (fix the request or the
setup).

| Code | Status | Retry | When |
| --- | --- | --- | --- |
| `invalid_command` | 422 | no | The request or a command is malformed: unknown kind, extra field, wrong policy for the command, missing `If-Match`, bad range |
| `unknown_target` | 422 | refresh | A sheet, row, column or table referenced by the command does not exist (any more) |
| `unsupported_content` | 422 | no | The document is not a workbook of the supported profile, a command or file uses a feature outside the profile, commands are switched off (`vaulter-sheets.commands = false`), or a strict import would lose content (`detail.reason = strict_profile_loss` with a loss report) |
| `format_disabled` | 422 | no | The exchange format is not enabled in `SHEETS_EXCHANGE_FORMATS` (PHP or runtime) |
| `unsafe_archive` | 422 | no | An uploaded XLSX failed the archive guard; `detail.reason` is one of the reasons below |
| `limit_exceeded` | 413 | no | A size or count limit: request body, more than 64 commands, snapshot, wire message, cell budget, import/export size, archive quotas |
| `version_conflict` | 409 | refresh | `If-Match` does not match the current workbook ETag, or an `exact_base` precondition failed |
| `scope_changed` | 409 | refresh | A `fill_formula` was computed for a set of table rows that changed (`detail.expected`, `detail.actual`) |
| `generation_changed` | 409 | refresh | The document was replaced (new generation) while the command or exchange was in flight |
| `idempotency_conflict` | 409 | no | The same command or exchange ID was reused with a different request |
| `exchange_not_ready` | 409 | yes | Download requested while the exchange job is still queued or running |
| `room_not_active` | 409 | no | A realtime call for a workbook that is not in journal mode |
| `incompatible_binding` | 412 | refresh | The room credential was issued for another schema version, state format or protocol than the document now has |
| `idempotency_window_expired` | 410 | no | The command or exchange ID is older than `replay_seconds` / `exchange.keep_seconds`; its receipt is gone |
| `evidence_unavailable` | 410 | no | Evidence was requested for a command that is not committed or whose evidence expired (`evidence_seconds`) |
| `permission_denied` | 403 | no | The actor may read the workbook but not perform this exchange (for example import into a read-only node) |
| `room_read_only` | 403 | no | A write in a room for an actor who only has read access |
| `resource_unavailable` | 404 | no | The node does not exist, is not visible to the actor, or is not a workbook. Deliberately the same answer for "missing" and "forbidden" |
| `owner_credential_invalid` | 401 | no | Private owner endpoint called without the correct `X-Vaulter-Sheets-Owner` token |
| `room_credential_invalid` | 401 | refresh | The room credential is invalid, expired or superseded; request a new session |
| `invalid_message` | 400 | no | An exchange request carried an `input_b64` that is not valid base64 |
| `runtime_failed` | 503 | yes | The Node runtime is unreachable, overloaded (503 from its queue), crashed, or returned a response that failed validation or digest checks |
| `calculation_pending` | 503 | yes | The runtime timed out (`calculation_timeout`) |
| `contention` | 503 | yes | Another worker holds the workbook lock; the command was released for retry |
| `lease_lost` | 503 | yes | The worker's lease expired before it could commit; recovery will run the command again |
| `snapshot_unavailable` | 503 | yes | A stored snapshot or exchange file could not be read from Media |
| `room_unavailable` | 503 | yes | The room process or the database clock could not be reached |

### Other `detail.reason` values

| Code | Reason | Meaning |
| --- | --- | --- |
| `version_conflict` | `formula_dependencies_changed` | A cell a formula depends on changed between calculation and commit |
| `version_conflict` | `input_precondition_failed` (+ `row_id`) | A `revalidate_by_id` input row no longer has the expected content |
| `version_conflict` | `formula_rebase`, `split_range` | A realtime edit cannot be rebased over a concurrent row insertion (a formula, or a value range the insertion splits) |
| `unsupported_content` | `resource_lost` | The calculated candidate would drop a workbook resource the current version has |

### Runtime error mapping

The Node runtime answers with its own codes, which PHP maps before they reach a client:

| Runtime code | Calculation wire | Exchange wire |
| --- | --- | --- |
| `precondition_failed` | `version_conflict` 409 | — |
| `scope_changed` | `scope_changed` 409 | — |
| `unknown_target` | `unknown_target` 422 | `unknown_target` 422 |
| `identity_required` | `invalid_command` 422 | — |
| `invalid_message` | — | `invalid_command` 422 |
| `profile_mismatch`, `unsupported_command`, `unsupported_content`, `unsupported_version` | `unsupported_content` 422 | `unsupported_content` 422 |
| `format_disabled` | — | `format_disabled` 422 |
| `unsafe_archive` | — | `unsafe_archive` 422 |
| `limit_exceeded` | `limit_exceeded` 413 | `limit_exceeded` 413 |
| `calculation_timeout` | `calculation_pending` 503 | `calculation_pending` 503 |
| anything else | `runtime_failed` 503 | `runtime_failed` 503 |

### `unsafe_archive` reasons

The PHP archive guard (`Exchange\ZipArchiveGuard`) checks an XLSX before any XML is parsed:

| Reason | Meaning |
| --- | --- |
| `not_a_zip`, `invalid_zip`, `corrupt_stream`, `unreadable_entry`, `size_mismatch` | Not a readable ZIP, or an entry's data disagrees with its header |
| `invalid_entry_header`, `invalid_entry_name`, `duplicate_entry_name` | Malformed or ambiguous central directory |
| `unsafe_entry_path`, `symlink_entry`, `special_file_entry` | Path traversal, absolute paths, symlinks or device entries |
| `too_many_entries`, `entry_size_limit`, `total_size_limit`, `compression_ratio_limit`, `zip_bomb_overflow` | Quotas against ZIP bombs |
| `xxe_doctype`, `xxe_xinclude`, `xxe_or_xinclude`, `invalid_xml_encoding` | DOCTYPE, XInclude or a non-UTF-8 declaration in an XML part |
| `malformed_rels`, `oversized_rels`, `disallowed_external_relationship` | A relationships part is empty, unparsable, too large, or points outside the package |

The runtime may add its own `unsafe_archive` reasons for checks it performs on the decoded
workbook; they arrive unchanged in `detail`.
