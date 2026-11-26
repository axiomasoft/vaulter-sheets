# Workbook data ownership

Drive authorizes the public node ID, and Documents resolves it through `documents.node_id`. A Sheets record refers to `documents.id`. Documents owns the generation, position, payload and revision history. Sheets owns the v2 format, engine profile, table bindings and command outcome. Media retains large snapshots and exchange files through blob pins. The table names below use the default prefix. Install migrations apply the configured connection, prefix and key strategy. [Schema definitions](../packages/sheets/database/sql)

| Table | Record and access path |
| --- | --- |
| `v_sheets_commands` | One command ID per tenant, project, subject and document. The row stores the fingerprint, intent, lease, terminal result and evidence window. The receipt identifies its document and generation. |
| `v_sheets_exchange_jobs` | One import or export for a request key in the same actor and document scope. The row records source generation and position, blob IDs, worker lease, report, outcome and retention deadline. An import receipt belongs to its own document and generation. |
| `v_sheets_projection_builds`, `v_sheets_projection_heads` | The build identifies a snapshot, digest and lifecycle state. A head points to a ready build of its document. Publication compares the active generation and position before advancing the head. |
| `v_sheets_projection_sheets`, `_tables`, `_columns`, `_rows`, `_cells` | Each item belongs to a build. Table, row and column IDs resolve to coordinates for that version. Sparse cells are addressed by build, sheet, row and column. A consistency-sensitive reader must join one build and check the current generation. |
| `v_sheets_realtime_links` | Links a position in the shared collaboration journal to a Sheets receipt of the same document and generation. The optional realtime module owns this table. |

The projection schema is available independently of the Office reader integration. See the architecture guide for the implemented population and read paths. [Architecture](concepts/architecture.md)

## Replay and recovery

Check the caller's access before looking up or exposing an outcome. A matching command ID and fingerprint refer to the original outcome. A different fingerprint gives HTTP 409 `idempotency_conflict`. Within the replay window, return the original receipt or recorded rejection, including its original generation and position. An expired outcome gives HTTP 410 `idempotency_window_expired`. Evidence has a separate retention window. A retry must never publish a second edit merely because evidence expired.

The owner assigns a worker token and deadline before execution. An expired lease can be reclaimed. The owner checks token, permissions, generation and base marker again under the document lock. The payload, position and receipt commit on the same connection. Only the committed version can reach consumers. Restoration advances the generation, and a worker from the previous generation cannot publish into the new head.

Register imports against an authorized existing workbook. Pin the source blob until job retention permits cleanup. An export captures a specific document version, which gives a retry a stable source after later edits. Check download access again before serving output. Garbage collection releases expired pins before Media collects unreferenced blobs.

In journal mode, a write must pass the active collaboration owner fence. Room recovery uses acknowledged journal positions and checkpoints. Switching a document between snapshot and journal mode is an authorized operation with an expected head. [Configuration](reference/configuration.md)
