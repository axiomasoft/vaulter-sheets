# Architecture

## Components

```text
 Browser                       PHP application                          Node
┌──────────────────┐   HTTP   ┌──────────────────────────────┐  wire  ┌───────────────────────┐
│ @vaulter/        │ ───────► │ axiomasoft/vaulter-sheets    │ ─────► │ @vaulter/sheets-      │
│ sheets-vue       │          │  owner of every workbook     │        │ runtime (Univer OSS)  │
│ (Univer editor)  │          │  Documents · Drive · Media   │ ◄───── │ calculate, import,    │
└──────┬───────────┘          └──────────┬───────────────────┘        │ export                │
       │ WebSocket                       │ private owner API          └───────────────────────┘
       ▼                                 ▲
┌──────────────────┐                     │
│ @vaulter/        │ ────────────────────┘
│ sheets-realtime  │  room process (optional, journal mode)
└──────────────────┘
```

| Package | Role |
| --- | --- |
| `axiomasoft/vaulter-sheets` (`packages/sheets`) | Registers the `vaulter/spreadsheet` document type and the `sheets` module. Owns validation, idempotency, locking, commit and storage. The only component with database access |
| `@vaulter/sheets-runtime` (`packages/runtime`) | Stateless calculator over Univer OSS (Apache-2.0): applies commands to a snapshot, recalculates, imports and exports XLSX/CSV. Runs as an HTTP service (port 3100) or as a CLI spawned by PHP |
| `@vaulter/sheets-vue` (`packages/vue`) | `VaulterSpreadsheet` viewer/editor and the typed `createWorkbooksClient` |
| `@vaulter/sheets-realtime` (`packages/realtime`) | Room process for co-editing (port 3101) and the browser `WorkbookRoomClient` / `connectNativeWorkbook` binding |
| `@vaulter/sheets-tiptap` (`packages/tiptap`) | Tiptap node that embeds a workbook range in a rich-text document |
| `contracts/` | JSON Schemas and OpenAPI of the workbook format, the runtime wire, the exchange wire and the HTTP API |

The runtime never sees a database credential and the browser never talks to the runtime: PHP
checks access, sends exactly the snapshot and commands needed, and verifies the answer.

## A command, end to end

1. The editor posts `POST /workbooks/{node}/commands` with a command ID, `If-Match: <ETag>`, a
   policy and up to 64 commands (`set_number`, `set_formula`, `insert_row_before`, `merge_cells`,
   `fill_formula`, …).
2. PHP checks Drive access, validates the commands (`Data\WorkbookCommand`), and registers the
   command ID in `v_sheets_commands`. A retry with the same ID and fingerprint inside
   `replay_seconds` returns the original receipt; a different request under the same ID is an
   `idempotency_conflict`.
3. PHP takes a worker lease and sends the snapshot, its SHA-256 and the commands to the runtime
   as canonical JSON (RFC 8785; PHP and Node produce identical bytes, pinned by tests).
4. The runtime returns a candidate snapshot, the formula dependencies and a digest. PHP verifies
   the digest and the candidate (no lost resources, limits), then re-checks access, the lease and
   the document head under a lock and commits through Vaulter Documents.
5. The response carries the receipt, the new position and the new ETag. If the worker dies after
   step 3, the lease expires and `vaulter-sheets:recover` re-runs the command from the queue.

**Policies.** `exact_base` commits only on the ETag the client saw. `rebase_cells` lets edits to
different cells from two users commit in either order (no structural commands). `revalidate_by_id`
(only for `fill_formula`) addresses table rows by logical ID and fails with `scope_changed` or
`version_conflict` when those rows or their inputs changed.

## Storage

Workbook snapshots are ordinary Vaulter documents: small snapshots are inline in the document
payload, larger ones (`inline_snapshot_bytes`, default 512 KiB) are Media blobs pinned by the
revision. The package adds these tables (prefix `v_` by default):

| Table | Purpose |
| --- | --- |
| `sheets_commands` | One row per command ID: state (`running`, `committed`, `rejected`, `expired`), lease, receipt, replay and evidence windows |
| `sheets_exchange_jobs` | Import/export jobs, their lease, source and output blobs and keep window |
| `sheets_projection_builds`, `_heads`, `_sheets`, `_tables`, `_columns`, `_rows`, `_cells` | Relational projection of a published workbook version (cells by logical row ID) |
| `sheets_realtime_links` | Realtime module only: links each accepted room update in `collaboration_updates` to its command receipt |

The schema is plain SQL in `packages/sheets/database/sql/` (PostgreSQL 18+, with a SQLite
translation for tests); every foreign key has an index, which CI enforces with
`scripts/ci/unindexed-fks.sql`.

The projection tables and the publication guard (`Projections\PublishCellProjection`, which only
publishes a build for the exact generation, position and hash it was built from) are in place; no
projector that fills them ships in this repository yet.

## XLSX/CSV exchange

`POST /workbooks/{node}/exchanges` registers an import or export job and returns at once; a
`RunWorkbookExchange` job streams the file to the runtime (HTTP or the `vaulter-sheets-exchange`
CLI) and stores the result. PHP runs the archive guard on every XLSX before the runtime sees it
(entry quotas, compression ratio, path traversal, XXE, external relationships). When an import
would lose content the workbook profile cannot represent, the runtime reports it
(`unsupported_content` with `detail.reason = strict_profile_loss` and a loss report) instead of
dropping it silently.

Formulas another spreadsheet application would act on when the file is opened never cross the
exchange in either direction: a link into another workbook (`[Book.xlsx]Sheet!A1`), a DDE link
(`=cmd|' /C calc'!A0`) or a call of `DDE`, `CALL`, `REGISTER`, `REGISTER.ID` or `EXEC`. Import
and export leave such a cell formula, defined name, validation or conditional format out and
report it as a loss (`external_ref_stripped`, `dde_link_stripped`); an exported cell keeps its
last value.

## Realtime

With `vaulter-collaboration` and the `sheets-realtime` module enabled, an editor switches a
workbook to journal mode (`PUT /workbooks/{node}/realtime/profile`). Browsers then receive a room
credential (`POST /workbooks/{node}/realtime/session`) and connect to the room process, which
forwards every intent to the private PHP owner endpoint. PHP validates and commits it like a
command, appends it to the collaboration journal and links it in `sheets_realtime_links`; every
`realtime.checkpoint_interval` updates (default 20) a full snapshot checkpoint is stored. The room
process holds no authority: if it restarts, clients replay from the journal, and pending intents
are re-rendered against the confirmed state.

### Room credentials

The room process never verifies a token itself; the PHP owner does, on every call, and checks
expiry, revocation and access each time. The room process only decides when to ask:

- **Open.** A joining peer's token is sent to the owner in a read of its own, even when another
  peer's read is already in flight, and the peer gets no state until that read succeeds.
- **Expiry.** The token's `exp` claim (read unverified) arms a timer; when it passes, the peer is
  closed with `4001 Room credential expired`, the code the collaboration hub uses.
  `WorkbookRoomClient` reconnects on any close with a fresh session.
- **Revalidation.** Every peer's token goes to the owner again at least every 60 seconds
  (`revalidateMs` of `createRealtimeServer`). The room poll goes stalest peer first and then re-reads
  with each peer that is due, so a read another peer's token passed never counts for someone else.
  A refused token (401/403/404) closes only that peer: `4403 Room access ended` for 401/404, `1013`
  for 403. A revoked token or lost access therefore stops fan-out within about a minute.

### Room limits

- **Peers.** A room serves at most 32 peers and a process at most 1024 sockets. Only peers the
  owner admitted count against the room limit, so sockets that never present a credential cannot
  lock a room; they are closed after 5 seconds. A peer admitted into a full room is closed
  `1013 Room full`.
- **Clients.** One client address holds at most 32 sockets the owner has not admitted yet
  (`SHEETS_REALTIME_PENDING_PER_ADDRESS`); the next upgrade is refused 429, so one client cannot
  fill the process's 1024 sockets with connections that never authenticate. Behind a reverse
  proxy, list it in `SHEETS_REALTIME_TRUSTED_PROXIES` so the limit applies to the forwarded client.
- **Presence.** Awareness changes are sent on at most once every 50 ms per room, the latest
  presence of every peer included. Each broadcast is a list of every other peer's presence for
  every peer, so the interval, not the senders, sets the cost of presence.
  Identity in a presence is the room's: `client_id` is an id the room gives each socket, and
  `user.id` / `user.type` are the subject (`sub`, `sub_type`) of the room token the owner accepted.
  A client's own `client_id` and `user.id` are not passed on; its name and colour are, display only.
- **Commands.** A room queues at most 64 intents, and at most 4 of one peer; the next is answered `room_busy` (retryable).
