# Installation and first workbook

Vaulter Sheets adds a native spreadsheet document type (`vaulter/spreadsheet`) to a Vaulter
application. The PHP package owns the workbook: it stores snapshots through Vaulter Documents,
validates every command, and asks a Node runtime (Univer OSS, Apache-2.0) to calculate the result.
The Vue package renders and edits the workbook in the browser.

## Requirements

- A Laravel application with Vaulter core, Drive, Documents and Media installed and migrated.
- PHP `>=8.4 <8.6`, Node.js `>=26.13.1` wherever the runtime runs.
- PostgreSQL 18 or newer (the schema uses `uuidv7()`), or SQLite for development and tests.
  Other drivers are refused when the migrations run ("Sheets requires PostgreSQL or SQLite").
- A queue worker and the Laravel scheduler.

## 1. Install the packages

```bash
composer require axiomasoft/vaulter-sheets
npm install @vaulter/sheets-vue          # browser editor
npm install @vaulter/sheets-runtime      # only when the runtime runs as a CLI next to PHP
```

The packages are distributed through the private channel listed in `release/packages.json`.

The service provider and the `sheets` module register themselves (`Activation::Auto`); they
require the `documents` and `media` modules. Run the migrations as usual:

```bash
php artisan migrate
```

## 2. Choose how PHP reaches the runtime

The PHP owner never evaluates formulas itself. It sends a canonical JSON request to the runtime
and verifies the digest of the answer. Pick one transport:

| Transport | When | Configure |
| --- | --- | --- |
| HTTP service | Production, containers | `SHEETS_RUNTIME_URL` and `SHEETS_RUNTIME_TOKEN_FILE` in PHP; the same token file and `PORT` (default 3100) in the runtime container |
| CLI | Single host, development | Leave `SHEETS_RUNTIME_URL` empty; `vaulter-sheets.runtime_command` (default `vaulter-sheets-runtime`) must be on the PHP worker's `PATH` |

The HTTP transport is selected whenever `runtime_url` is a non-empty string. Build the runtime
image from the repository root:

```bash
docker build -f packages/runtime/Dockerfile -t vaulter-sheets-runtime .
```

See [Configuration](../reference/configuration.md) for the runtime's own environment variables
(worker pool size, queue length, timeouts).

## 3. Run the queue and the scheduler

A command is calculated and committed inside the HTTP request that submits it. When that worker
dies or its lease expires, `vaulter-sheets:recover` re-runs the command as a `RunWorkbookCommand`
job on the queue **connection** named by `vaulter-sheets.queue_connection` (default
`sheets-commands`) and the queue `sheets-commands`. XLSX/CSV exchanges always run as
`RunWorkbookExchange` jobs on the connection `vaulter-sheets.exchange.queue_connection` (default
`sheets-exchange`). Define those connections in `config/queue.php` (or set the options to
an existing connection) and run a worker for them:

```bash
php artisan queue:work sheets-commands --queue=sheets-commands
php artisan queue:work sheets-exchange   # only when XLSX/CSV exchange is enabled
```

The module schedules `vaulter-sheets:recover` every minute while commands or an exchange format are
enabled. It reclaims commands and exchange jobs whose worker lease expired and expires old
outcomes, so the scheduler must run (`php artisan schedule:work` or cron).

A host with its own tenant resolver binds `Vaulter\Sheets\Contracts\WorkbookRecoveryContext` to
restore the queue actor's tenant before a recovered job runs.

## 4. Register the viewer in the Vue host

```ts
import { createApp } from 'vue'
import VaulterPlugin from '@vaulter/vue'
import { SPREADSHEET_VIEWER_KEY } from '@vaulter/sheets-vue'
import '@vaulter/sheets-vue/style.css'

createApp(App).use(VaulterPlugin, {
  viewers: {
    // Loaded on first use: the Univer editor is large.
    [SPREADSHEET_VIEWER_KEY]: () => import('@vaulter/sheets-vue').then(m => m.VaulterSpreadsheet),
  },
})
```

The editor talks to `/api/vaulter-sheets/v1` on the same origin. When the host mounts the routes
under another prefix (`vaulter-sheets.prefix`) or needs extra request headers, pass a client created
with `createWorkbooksClient`.

## 5. Create and edit a workbook

Create a document of type `vaulter/spreadsheet` through Vaulter Documents (or the Drive UI) and open
it. Each edit becomes a command posted to `POST /workbooks/{node}/commands` with the workbook ETag;
the response carries a receipt and the new ETag. The full request and response shapes are in
[`contracts/http-v1.yaml`](../../contracts/http-v1.yaml).

## Optional features

- **XLSX/CSV import and export.** Set `SHEETS_EXCHANGE_FORMATS=xlsx,csv` (or a subset) for both PHP
  and the runtime, and run the `sheets-exchange` worker.
- **Realtime co-editing.** Install `axiomasoft/vaulter-collaboration`, enable
  `vaulter.modules.collaboration` and `vaulter.modules.sheets-realtime` before migrating, and run the
  room process (`packages/realtime`). The README section "Collaborative workbooks" lists the
  environment of both sides.
- **Tiptap references.** `@vaulter/sheets-tiptap` embeds a live range of a workbook in a rich-text
  document; the server checks access to the source workbook on every preview.
