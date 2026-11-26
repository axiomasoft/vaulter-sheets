# Workbook calculation wire v1

This protocol connects the PHP workbook owner to the Node calculation runtime. The PHP owner controls access and publication. The runtime computes a candidate or reads ranges. The schema defines message shapes. The rules below define framing, lossless decoding, digests and concurrency. [JSON Schema](../contracts/runtime-v1.schema.json) · [Transport configuration](reference/configuration.md) · [Public HTTP API](../contracts/http-v1.yaml)

## Frames and decoding

A message is one UTF-8 JSON object followed by LF. The response occupies exactly one line. Reject malformed UTF-8, missing LF and trailing data. Enforce the configured byte budget on both ends. Oversized input gives `limit_exceeded`. The original reference profile used 8 MiB. The operator reference records shipped transport limits and fallbacks.

Both decoders reject duplicate object keys, a nesting depth greater than 256 and non-finite numbers, including exponent overflow. An integer token without a decimal point or exponent outside ±(2⁵³−1) must exactly match the ECMAScript string representation of the parsed double. For example, `9007199254740993` loses a digit and must be rejected. Both `10000000000000000` and `123456789012345680000` round-trip and are accepted as workbook values. Coordinates, counts, generation and position must also be safe integers. Represent objects and arrays distinctly throughout decoding and encoding.

## Requests

Every request carries `version: 1`, `request_id`, `operation`, `base: {generation, position, sha256}`, `profile_id` and `workbook`. The workbook is a v2 envelope containing `format_version`, `profile`, `native` and `tables`. A table binding includes stable table, sheet, row and column IDs alongside one-based row and column coordinates. The adapter converts these to zero-based engine indexes.

An `apply` request contains 1–64 commands. A `read` or `recalculate` request carries a selector with `ranges: [{sheet_id, range}]`. Optional `limits` lower the profile's command count, cells per command or calculation timeout. Before opening the engine, verify the workbook digest against `base.sha256`, match the profile and verify its supported resources. Unknown resources give `unsupported_content` with reason `unknown_resource`.

### Cell content and addressing

`CellContent` is null for an empty cell or an object containing exactly one of `number`, `text`, `boolean` or `formula`. Preconditions compare typed content. For formulas, compare the formula source. Text `"5"`, number `5` and a formula returning five therefore have distinct preconditions. A literal in `set_values` is null or a tagged number, text or boolean. Use a formula command to write formula source.

| Operation | Addressing and checks |
| --- | --- |
| Scalar setters | Supply sheet, row, column, expected content and the new value or formula. Check every addressed cell before changing it. |
| `set_values` | Supply the top-left cell and equally sized, rectangular expected-content and literal-value matrices. Validate the entire rectangle and its cell budget before writing. |
| `insert_row_before` | Supply sheet, row and count. Inside a logical table the owner supplies exactly `count` unused IDs in `new_row_ids[table_id]`. An insertion outside all tables requires no IDs. Reuse owner-assigned IDs on replay. |
| `fill_formula` | Resolve sheet, table, destination column and row IDs against the supplied workbook. Validate the expression, expected destinations and declared input preconditions. `fixed_members` operates only on the listed row IDs. `current_rows` requires exact current membership in table order and reports expected and actual IDs on `scope_changed`. |

The schema lists the remaining structural and formatting commands, formula expressions and their fields. Unknown operations outside the selected profile give `unsupported_command`. Validate all targets and preconditions for a command before its first write.

## Responses

A successful `apply` or `recalculate` returns the version, request ID, operation, base digest, candidate workbook and digest, changed ranges, calculation and checks. The checks report resource preservation and readback cells with sheet ID, address, coordinates, formula and value. A successful `read` returns the base digest, calculation and ranges of cells.

Wait for the engine to finish calculation and apply the results. A successful calculation reports `state: "ready"` and the digest of its source. Readback must reflect the completed calculation, including when a snapshot initially contains stale cached values. On timeout, return `calculation_timeout`. Verify that the exported workbook retains the input resources required by its profile. Report a lost resource as `unsupported_content` with reason `resource_lost`.

A failure returns `{version, request_id, ok:false, error:{code, message, detail?}}`. The request ID may be null if it could not be decoded. Discard the candidate on failure.

| Runtime error | Public outcome from PHP |
| --- | --- |
| `precondition_failed` | HTTP 409 `version_conflict` |
| `scope_changed` | HTTP 409 `scope_changed` |
| `unknown_target` | HTTP 422 `unknown_target` |
| `identity_required` | HTTP 422 `invalid_command` |
| `profile_mismatch`, `unsupported_command`, `unsupported_content` | HTTP 422 `unsupported_content` |
| `limit_exceeded` | HTTP 413 `limit_exceeded` |
| `calculation_timeout` | HTTP 503 `calculation_pending` |
| `invalid_message`, `unsupported_version`, `base_mismatch`, invalid output, process failure or mismatched request ID | HTTP 503 `runtime_failed` |

## Canonicalization and publication

Compute SHA-256 over the RFC 8785 canonical encoding of the **entire workbook envelope**, including profile and table bindings. Use lowercase hex. Sort object keys by UTF-16 code units, print numbers using ECMAScript rules and preserve the difference between an empty object and an empty array. PHP represents objects as `stdClass`. The workbook supports fractional and large double values in cell content. Its digest uses that numeric profile independently of Office proposal digests.

The owner independently verifies that the echoed base digest matches the supplied workbook, the candidate digest matches its own encoding of the returned workbook, and the calculation source digest matches the candidate. It also checks the profile and the document size limit before publishing. Some Univer operations generate new style IDs. Equivalent workbooks produced in separate runs can therefore have different candidate digests. Bind idempotency to the command fingerprint, policy, preconditions and saved receipt. Return the recorded outcome on replay and use the stored journal material to recover the acknowledged version.

### Changes to the head during calculation

Calculate outside the transaction. Lock the document before publication and compare generation, position and digest with the base that was calculated.

| Policy | Owner behavior |
| --- | --- |
| `exact_base` | Require `If-Match` for edits using exact addresses. Discard the candidate and return `version_conflict` if the head moves. Structural edits use this policy. |
| `rebase_cells` | Require `If-Match`. Reapply eligible cell edits on the new head and check each expected value again. Return `version_conflict` if a cell changed, an intervening structural receipt affects its sheet, or the receipt history has a gap. Return `generation_changed` after a generation change. |
| `revalidate_by_id` | Supply the expected generation and omit `If-Match`. Resolve stable IDs again on the new head. Validate fixed or current membership. After the retry budget is exhausted, return HTTP 503 `contention`. A generation change gives `generation_changed`. |

The command contract script exercises real calculations against the PHP owner. ACID publication, HTTP transport, ACL enforcement, browser edits, restore and collaboration also have package-level tests. [Testing guide](guides/testing-and-ci.md)
