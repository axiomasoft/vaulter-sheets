# Following a workbook edit

In the sample workbook, changing `Detail!C3` from 5 to 7 increases `Detail!D3` from 15 to 21 and `Summary!B2` from 35 to 41. The browser probe checks the displayed values and the row-shift formulas. [Browser probe](../bench/probes/sheets-browser/README.md)

1. Open the workbook by Drive node ID. PHP checks access, document type, schema version and write mode. It reads the current inline snapshot or its pinned Media blob and returns the workbook, profile, head marker and ETag.
2. Send a `set_number` command with the observed content, command ID, expected generation, policy and ETag. The runtime receives the snapshot and base digest and evaluates formulas outside the owner's database transaction.
3. PHP verifies the candidate digest and calculation result. Under a lock, it rechecks permissions, lease and head and atomically commits the payload and receipt. A conflicting write using a stale ETag follows the chosen policy.
4. If the HTTP response is lost, query `GET /workbooks/{node}/commands/{command}` or retry the original request. With continued access and a live replay window, the recorded receipt gives the original generation and position even if later work has moved the head. A different request under the same ID conflicts.
5. Insert a row before the data row, save and reopen. The native workbook updates the addresses and formulas. Stable table row IDs continue to identify the intended members across supported structural edits. A restore advances generation, invalidating reads and pending work tied to the former generation.

Journal-mode clients submit edits through the room owner and recover from the confirmed journal head. The CLI and HTTP calculation runtimes require no database credentials. [Calculation wire](runtime-wire-v1.md) · [Storage](database.md) · [Package architecture](concepts/architecture.md)
