# Configuration reference

## PHP owner (`config/vaulter-sheets.php`)

The package ships `packages/sheets/config/vaulter-sheets.php` and merges it under the
`vaulter-sheets` key. Publish or override keys in the host's `config/vaulter-sheets.php`.

> **The merge is shallow.** Laravel's `mergeConfigFrom` merges only the top level. If the host
> defines `exchange` or `realtime`, it replaces the whole nested array, and every nested key it
> leaves out falls back to the default written in the code that reads it, not to the shipped
> config file. Copy the complete nested array when overriding one key in it.

Every integer option below is read as "positive `int`, otherwise the code default": `0`, a
negative number, a numeric string or `null` silently select the default listed in the
**Code fallback** column. Environment values are cast with `(int)`, so a non-numeric
environment value becomes `0` and therefore selects that fallback too.

### Core

| Key | Env | Shipped default | Code fallback | Meaning |
| --- | --- | --- | --- | --- |
| `prefix` | — | `api/vaulter-sheets/v1` | same | Route prefix of the workbook, exchange and realtime endpoints |
| `commands` | — | `true` | `true` | Enables the command endpoint, the realtime append path and the command list in the workbook catalog. Must be a real boolean; any other value raises an error when a command is handled |
| `inline_snapshot_bytes` | — | 512 KiB | 512 KiB | Snapshots up to this size are stored inline in the document payload; larger ones go to a Media blob |
| `max_snapshot_bytes` | `SHEETS_MAX_SNAPSHOT_BYTES` | 32 MiB | **7 MiB** ⚠ | Largest accepted workbook snapshot |
| `max_message_bytes` | `SHEETS_MAX_MESSAGE_BYTES` | 64 MiB | **8 MiB** (runtime wire) ⚠ / 64 MiB (exchange wire) | Largest PHP ↔ Node message |
| `locale` | — | *(not in the shipped file)* ⚠ | `enUS` | Locale of a blank workbook; one of the 19 Univer locales (`enUS`, `ruRU`, `deDE`, …) |
| `lease_seconds` | — | 60 | 60 | Worker lease on a running command; an expired lease is reclaimed by `vaulter-sheets:recover` |
| `replay_seconds` | — | 86 400 | 86 400 | How long a command ID can be replayed for its original receipt |
| `evidence_seconds` | — | 86 400 | 86 400 | How long the evidence of a committed command is kept |
| `queue_connection` | — | *(not in the shipped file)* ⚠ | `sheets-commands` | Queue **connection** of `RunWorkbookCommand` (the queue name is always `sheets-commands`) |

### Runtime transport

| Key | Env | Shipped default | Code fallback | Meaning |
| --- | --- | --- | --- | --- |
| `runtime_url` | `SHEETS_RUNTIME_URL` | `null` | — | When non-empty, PHP calls the HTTP runtime; otherwise it spawns `runtime_command` |
| `runtime_token_file` | `SHEETS_RUNTIME_TOKEN_FILE` | `null` | — | File with the bearer token shared with the HTTP runtime |
| `runtime_command` | — | `['vaulter-sheets-runtime']` | same | argv of the CLI runtime |
| `runtime_timeout_seconds` | — | 25 | 25 | Timeout of one calculation or exchange call, both transports |

### Exchange (`exchange.*`)

| Key | Env | Shipped default | Code fallback | Meaning |
| --- | --- | --- | --- | --- |
| `exchange.formats` | `SHEETS_EXCHANGE_FORMATS` | `[]` (comma list; only `csv`, `xlsx` are kept) | `[]` | Enabled import/export formats; empty disables exchange |
| `exchange.max_import_bytes` | `SHEETS_EXCHANGE_MAX_IMPORT_BYTES` | 32 MiB | 32 MiB | Largest uploaded file |
| `exchange.max_export_bytes` | `SHEETS_EXCHANGE_MAX_EXPORT_BYTES` | 32 MiB | 32 MiB | Largest produced file |
| `exchange.keep_seconds` | — | 604 800 (7 days) | 604 800 | How long a finished job and its file are kept |
| `exchange.lease_seconds` | — | 60 | 60 | Worker lease on a running exchange job |
| `exchange.queue_connection` | `SHEETS_EXCHANGE_QUEUE_CONNECTION` | `sheets-exchange` | `sheets-exchange` | Queue connection of `RunWorkbookExchange` |
| `exchange.command` | — | `['vaulter-sheets-exchange']` | same | argv of the CLI exchange worker |

### Realtime (`realtime.*`, only with the `sheets-realtime` module)

| Key | Env | Shipped default | Code fallback | Meaning |
| --- | --- | --- | --- | --- |
| `realtime.url` | `SHEETS_REALTIME_URL` | `null` | — | Public WebSocket origin handed to browsers in the room session |
| `realtime.owner_token_file` | `SHEETS_REALTIME_OWNER_TOKEN_FILE` | `null` | — | Token file shared with the room process for the private owner endpoint |
| `realtime.checkpoint_interval` | — | *(not in the shipped file)* ⚠ | 20 | Every Nth accepted update stores a full snapshot checkpoint; the others store a hash reference |

The module itself is switched on with `vaulter.modules.sheets-realtime = true` (and
`vaulter.modules.collaboration = true`) before the migrations run.

### Known mismatches ⚠

These are the places where the shipped file and the code disagree today. They matter whenever
the code fallback is used: a key missing from an overridden nested array, a host config written
without the key, or an invalid value.

1. **`max_snapshot_bytes`**: the file says 32 MiB, `WorkbookCodec` falls back to **7 MiB**. A host
   that sets `SHEETS_MAX_SNAPSHOT_BYTES=0` or a non-numeric value gets 7 MiB, not 32 MiB.
2. **`max_message_bytes`**: the file says 64 MiB. The exchange wire falls back to 64 MiB but the
   calculation wire (`RuntimeWire`) falls back to **8 MiB**, so with an invalid value the two
   wires enforce different limits.
3. **Keys read but not shipped**: `locale`, `queue_connection` and `realtime.checkpoint_interval`
   work only through their code fallbacks and are not discoverable from the config file.
4. **Two variables for one exchange limit**: PHP reads `SHEETS_EXCHANGE_MAX_IMPORT_BYTES` /
   `SHEETS_EXCHANGE_MAX_EXPORT_BYTES`, the Node exchange worker reads `SHEETS_EXCHANGE_MAX_BYTES`
   (default 32 MiB; a value below 1 MiB or not a number falls back to 32 MiB, one above 128 MiB is
   capped there). Raise both together.
5. **`SHEETS_EXCHANGE_FORMATS`** is read independently by PHP and by the runtime; a format
   enabled on one side only fails at run time (`format_disabled`).

The intended fix is one typed options object that owns every default, validates on boot and
replaces the raw `config()` reads; until then, set the values explicitly in production.

## Node runtime (`@vaulter/sheets-runtime`)

| Env | Default | Meaning |
| --- | --- | --- |
| `SHEETS_RUNTIME_TOKEN_FILE` | *(required)* | Bearer token file; the server refuses to start without a non-empty token |
| `PORT` | 3100 | HTTP port (`/livez`, `/readyz`, calculation and exchange endpoints) |
| `SHEETS_RUNTIME_MAX_WORKERS` | 2 | Calculation worker processes |
| `SHEETS_RUNTIME_MAX_QUEUE` | 8 | Requests waiting for a worker; beyond that the server answers 503 `runtime_unavailable` and PHP reports `runtime_failed` |
| `SHEETS_RUNTIME_RECYCLE_EVERY` | 50 | A worker is replaced after this many calculations |
| `SHEETS_RUNTIME_TIMEOUT_MS` | 20 000 | Per-calculation timeout; keep it below the PHP `runtime_timeout_seconds` |
| `SHEETS_RUNTIME_GZIP_MIN_BYTES` | 16 384 | Responses from this size are gzip-compressed (`0` compresses all) |
| `SHEETS_EXCHANGE_FORMATS` | empty | Enabled exchange formats, must match PHP |
| `SHEETS_EXCHANGE_MAX_BYTES` | 32 MiB | Largest exchange file; capped at 128 MiB, below 1 MiB falls back to 32 MiB |
| `SHEETS_ENGINE_IRONCALC_VERIFY` | unset | `1` recalculates every operation's result with IronCalc as well and returns the comparison with the response; a diagnostic that doubles the calculation cost (a request can also ask for it with `ironcalc_verify: true`) |

Invalid integers fall back to the default.

## Realtime room (`@vaulter/sheets-realtime`)

| Env | Default | Meaning |
| --- | --- | --- |
| `SHEETS_REALTIME_OWNER_URL` | *(required)* | PHP owner endpoint ending in `/api/vaulter-sheets/v1/realtime/owner`; keep it on the private network |
| `SHEETS_REALTIME_OWNER_TOKEN_FILE` | *(required)* | Same token file as the PHP `realtime.owner_token_file` |
| `PORT` | 3101 | `/livez`, `/readyz` and the room WebSocket (subprotocol `univer-sheets.v1`) |
| `SHEETS_REALTIME_PENDING_PER_ADDRESS` | 32 | Sockets one client address may hold before the owner accepted their credential; the next upgrade is answered 429. Admitted peers do not count |
| `SHEETS_REALTIME_TRUSTED_PROXIES` | *(empty)* | Comma-separated addresses or CIDR subnets of the reverse proxies in front of the process; for a connection from one, the right-most `X-Forwarded-For` entry that is not a trusted proxy is the client. Set it behind a proxy, or every client shares the proxy's address and its limit |
