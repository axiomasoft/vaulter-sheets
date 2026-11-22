# Engine comparison 4.1

Decision: `univer-oss-basic-1` on `@univerjs/core@1.5.2` (Apache-2.0).
IronCalc `@ironcalc/nodejs@0.9.1` (MIT OR Apache-2.0) is the calculation cross-check and is not the browser engine.
Handsontable and HyperFormula are an offline benchmark only and are not production dependencies.

| Candidate | Ran | Corpus | License | Production |
| --- | --- | --- | --- | --- |
| Univer OSS 1.5.2 | yes | yes | Apache-2.0 | yes |
| IronCalc 0.9.1 | yes | yes | MIT OR Apache-2.0 | no |
| HyperFormula 3.5.0 | yes | yes | GPL-3.0-only | no |
| Handsontable 18.1.2 | loaded, not mounted | n/a | commercial | no |

## Formula corpus

Vector: `examples/workbook.json`. Expected path: 35, then price 7 → 41, then insert → `=SUM(Detail!D3:D4)` = 41, cold cache 999 unverified until forced recalculation returns 41.

- Univer checks passed: yes
- Univer cold cache: {"phase":"cold","afterDefaultInitialization":999,"afterForcedRecalculation":41,"formula":"=SUM(Detail!D3:D4)","numberFormat":"0.00"}
- Univer unknown resource kept: false
- Univer conditional formatting: {"before":{"startRow":1,"endRow":2},"afterInsertRowBefore":{"startRow":1,"endRow":2},"shifted":false}
- Univer data validation: {"before":{"startRow":1,"endRow":2},"afterInsertRowBefore":{"startRow":2,"endRow":3},"shifted":true}
- IronCalc corpus: yes. Shared Univer snapshot: no.
- IronCalc cold cache: Before evaluate(), Summary!B2 is #ERROR!, not a stored number. Model has no slot for an injected cache of 999 beside a formula.
- IronCalc conditional formatting: {"before":["D2:D3"],"afterInsertRowBefore":["D3:D4"],"shifted":true}
- IronCalc undo: {"available":true,"canUndo":true,"before":"5","editedValue":"7","afterUndo":"5"}
- IronCalc clipboard: {"available":false,"step":"paste","copy":{"csv":"5","range":[3,3,3,3]},"error":"InvalidArg, invalid type: string \"3\", expected i32"}
- HyperFormula corpus: yes. Summary formula after insert: =SUM(Detail!D3:D4).
- Handsontable: loaded_not_mounted. The grid needs a browser document and a commercial key. This process did not mount it.

## Resources and commands

Approved resources: SHEET_AuthzIoMockService_PLUGIN, SHEET_CONDITIONAL_FORMATTING_PLUGIN, SHEET_DATA_VALIDATION_PLUGIN, SHEET_DEFINED_NAME_PLUGIN, SHEET_FILTER_PLUGIN, SHEET_RANGE_PROTECTION_PLUGIN, SHEET_RANGE_THEME_MODEL_PLUGIN, SHEET_WORKSHEET_PROTECTION_PLUGIN, SHEET_WORKSHEET_PROTECTION_POINT_PLUGIN.
Measured save() resources: SHEET_AuthzIoMockService_PLUGIN, SHEET_CONDITIONAL_FORMATTING_PLUGIN, SHEET_DATA_VALIDATION_PLUGIN, SHEET_DEFINED_NAME_PLUGIN, SHEET_FILTER_PLUGIN, SHEET_RANGE_PROTECTION_PLUGIN, SHEET_RANGE_THEME_MODEL_PLUGIN, SHEET_WORKSHEET_PROTECTION_PLUGIN, SHEET_WORKSHEET_PROTECTION_POINT_PLUGIN.
Only measured: (none). Only approved: (none).

A persisting command on an unknown resource returns `unsupported_content` before the write.
`insert_row_before` on `SHEET_CONDITIONAL_FORMATTING_PLUGIN` returns `unsupported_content` before the write.

## Timing and memory

- Univer open of 100k cells / 10k formulas (forced): p50 361.262 ms, p95 405.239 ms (n=3)
- Univer 100×100 paste: 22.014 ms
- Univer 20× open/dispose Node heap delta: 9338512 bytes (gc=true)
- Browser CDP heap delta: -9550776 bytes
- Browser long tasks: [221,198,59,117,127]
- IronCalc large book: p50 6.402 ms, p95 6.428 ms (n=3)

## Browser, clipboard, undo, accessibility

- Official sheets-browser exit: 0
- Official univer-headless exit: 0
- Bench browser input: {"price":7,"line":21,"total":41}
- Bench clipboard: {"source":7,"pastedByValue":7,"keyboard":true,"keyboardPaste":null}
- Bench undo: {"available":true,"before":7,"after":7}
- Bench accessibility snapshot: recorded in manifest.json

## Process rules

- Isolation: `child_process.fork`, worker_threads false, max old space 640 MB.
- Formula barrier: `onCalculationResultApplied` after `FORCED`. Stale cache is unverified_until_recalculation.
- Node recorded by this run: v26.13.1.

