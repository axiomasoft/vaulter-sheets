import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {Readable} from 'node:stream';
import {test} from 'node:test';
import {deflateRawSync} from 'node:zlib';
import type {IncomingMessage, ServerResponse} from 'node:http';
import {unzipSync, zipSync} from 'fflate';
import {runOperation} from '../src/operation.ts';
import {WIRE_PROFILE} from '../src/profile.ts';
import {canonicalize, sha256Canonical, type JsonObject, type WorkbookV2} from '../src/protocol.ts';
import {importCsv, exportCsv} from '../src/exchange/csv.ts';
import {importXlsx, exportXlsx} from '../src/exchange/xlsx.ts';
import {
    createExchangeHttpHandler,
    parseEnabledExchangeFormats,
    processExchangeFrame,
} from '../src/exchange/worker.ts';

const sha256Hex = (data: Buffer | string): string => createHash('sha256').update(data).digest('hex');
const enc = new TextEncoder();

function makeMinimalXlsx(extraFiles: Record<string, string | Uint8Array> = {}, sheetXml?: string, workbookPr = '<workbookPr/>'): Buffer {
    const defaultSheet = sheetXml ??
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<sheetData><row r="1"><c r="A1"><v>42</v></c></row></sheetData>' +
        '</worksheet>';

    const files: Record<string, Uint8Array> = {
        '[Content_Types].xml': enc.encode(
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types">' +
            '<Default Extension="rels" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.relationships+xml"/>' +
            '<Default Extension="xml" ContentType="application/xml"/>' +
            '<Override PartName="/xl/workbook.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.sheet.main+xml"/>' +
            '<Override PartName="/xl/worksheets/sheet1.xml" ContentType="application/vnd.openxmlformats-officedocument.spreadsheetml.worksheet+xml"/>' +
            '</Types>',
        ),
        '_rels/.rels': enc.encode(
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/officeDocument" Target="xl/workbook.xml"/>' +
            '</Relationships>',
        ),
        'xl/workbook.xml': enc.encode(
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
            workbookPr +
            '<sheets><sheet name="Sheet1" sheetId="1" r:id="rId1"/></sheets>' +
            '</workbook>',
        ),
        'xl/_rels/workbook.xml.rels': enc.encode(
            '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
            '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
            '</Relationships>',
        ),
        'xl/worksheets/sheet1.xml': enc.encode(defaultSheet),
    };

    for (const [k, v] of Object.entries(extraFiles)) {
        files[k] = typeof v === 'string' ? enc.encode(v) : v;
    }

    const raw = zipSync(files, {level: 6});
    return Buffer.from(raw.buffer, raw.byteOffset, raw.byteLength);
}

interface RawZipSpec {
    name: string;
    data: Uint8Array;
    externalAttrs?: number;
    versionMadeBy?: number;
    overrideOffset?: number;
    overrideCompressedSize?: number;
    overrideUncompressedSize?: number;
    rawDeflate?: boolean;
}

function buildCustomRawZip(specs: RawZipSpec[]): Buffer {
    const parts: Buffer[] = [];
    const centralRecords: Buffer[] = [];
    let offset = 0;

    for (const spec of specs) {
        const nameBuf = Buffer.from(spec.name, 'utf8');
        const payload = spec.rawDeflate ? Buffer.from(deflateRawSync(spec.data)) : Buffer.from(spec.data);
        const method = spec.rawDeflate ? 8 : 0;
        const crc = 0;
        const compSize = spec.overrideCompressedSize ?? payload.length;
        const uncompSize = spec.overrideUncompressedSize ?? spec.data.length;

        const lfh = Buffer.alloc(30 + nameBuf.length);
        lfh.writeUInt32LE(0x04034b50, 0);
        lfh.writeUInt16LE(20, 4);
        lfh.writeUInt16LE(0, 6);
        lfh.writeUInt16LE(method, 8);
        lfh.writeUInt16LE(0, 10);
        lfh.writeUInt16LE(0, 12);
        lfh.writeUInt32LE(crc, 14);
        lfh.writeUInt32LE(compSize >>> 0, 18);
        lfh.writeUInt32LE(uncompSize >>> 0, 22);
        lfh.writeUInt16LE(nameBuf.length, 26);
        lfh.writeUInt16LE(0, 28);
        nameBuf.copy(lfh, 30);

        const actualOffset = spec.overrideOffset ?? offset;
        parts.push(lfh, payload);

        const cd = Buffer.alloc(46 + nameBuf.length);
        cd.writeUInt32LE(0x02014b50, 0);
        cd.writeUInt16LE(spec.versionMadeBy ?? (3 << 8) | 20, 4);
        cd.writeUInt16LE(20, 6);
        cd.writeUInt16LE(0, 8);
        cd.writeUInt16LE(method, 10);
        cd.writeUInt16LE(0, 12);
        cd.writeUInt16LE(0, 14);
        cd.writeUInt32LE(crc, 16);
        cd.writeUInt32LE(compSize >>> 0, 20);
        cd.writeUInt32LE(uncompSize >>> 0, 24);
        cd.writeUInt16LE(nameBuf.length, 28);
        cd.writeUInt16LE(0, 30);
        cd.writeUInt16LE(0, 32);
        cd.writeUInt16LE(0, 34);
        cd.writeUInt16LE(0, 36);
        cd.writeUInt32LE((spec.externalAttrs ?? (0o100644 << 16)) >>> 0, 38);
        cd.writeUInt32LE(actualOffset >>> 0, 42);
        nameBuf.copy(cd, 46);
        centralRecords.push(cd);

        offset += lfh.length + payload.length;
    }

    const cdOffset = offset;
    const cdBuf = Buffer.concat(centralRecords);
    const eocd = Buffer.alloc(22);
    eocd.writeUInt32LE(0x06054b50, 0);
    eocd.writeUInt16LE(0, 4);
    eocd.writeUInt16LE(0, 6);
    eocd.writeUInt16LE(specs.length, 8);
    eocd.writeUInt16LE(specs.length, 10);
    eocd.writeUInt32LE(cdBuf.length, 12);
    eocd.writeUInt32LE(cdOffset, 16);
    eocd.writeUInt16LE(0, 20);

    return Buffer.concat([...parts, cdBuf, eocd]);
}

async function invokeHandler(
    handler: (req: IncomingMessage, res: ServerResponse) => Promise<void>,
    body: JsonObject,
): Promise<{status: number; headers: Record<string, string | string[]>; json: JsonObject}> {
    const req = Readable.from([Buffer.from(JSON.stringify(body) + '\n', 'utf8')]) as unknown as IncomingMessage;
    let status = 200;
    const headers: Record<string, string | string[]> = {};
    let payload = '';
    const res = {
        writeHead(code: number, hdrs?: Record<string, string | string[]>) {
            status = code;
            if (hdrs) Object.assign(headers, hdrs);
        },
        setHeader(k: string, v: string | string[]) {
            headers[k.toLowerCase()] = v;
        },
        end(chunk?: string | Buffer) {
            if (chunk !== undefined) payload += Buffer.isBuffer(chunk) ? chunk.toString('utf8') : chunk;
        },
    } as unknown as ServerResponse;

    await handler(req, res);
    return {status, headers, json: JSON.parse(payload) as JsonObject};
}

test('imports and exports CSV with dialect options, leading zeros, multiline strings, safe "=" literal import and formula injection escape', async () => {
    const csvInput =
        '\uFEFF"id";"note";"code";"big_id";"flag";"amount";"formula_text"\r\n' +
        '"00123";"hello;world\nline2";"quote ""here""";"9007199254740993";TRUE;-42;"=cmd|\'/C calc\'!A0"\r\n' +
        '"002";"=1+1";"+441234";"@mention";FALSE;3.5;"normal"\r\n';

    const imported = await importCsv(Buffer.from(csvInput, 'utf8'), {
        delimiter: ';',
        quote: '"',
        line_ending: '\r\n',
        sheet_id: 'orders',
        sheet_name: 'Orders',
    });

    assert.equal(imported.report.format, 'csv');
    assert.equal(imported.report.operation, 'import');
    assert.equal(imported.report.editable_published, true);
    assert.equal(imported.report.dialect?.delimiter, ';');
    assert.equal(imported.report.dialect?.line_ending, '\r\n');
    assert.ok(imported.report.diagnostics.some(d => d.code === 'utf8_bom_stripped'));
    assert.ok(imported.report.diagnostics.some(d => d.code === 'csv_formula_literal_preserved'));

    const sheet = (imported.workbook.native.sheets as Record<string, JsonObject>).orders;
    const cellData = sheet.cellData as Record<string, Record<string, JsonObject>>;
    // Leading zeros, large ints, and "=... " remain strict string literals without .f
    assert.deepEqual(cellData['1']['0'], {t: 1, v: '00123'});
    assert.equal(cellData['1']['1'].v, 'hello;world\nline2');
    assert.equal(cellData['1']['2'].v, 'quote "here"');
    assert.deepEqual(cellData['1']['3'], {t: 1, v: '9007199254740993'});
    assert.deepEqual(cellData['1']['4'], {t: 3, v: 1});
    assert.deepEqual(cellData['1']['5'], {t: 2, v: -42});
    assert.equal(cellData['1']['6'].f, undefined);
    assert.equal(cellData['1']['6'].t, 1);
    assert.equal(cellData['1']['6'].v, "=cmd|'/C calc'!A0");
    assert.equal(cellData['2']['1'].f, undefined);
    assert.equal(cellData['2']['1'].v, '=1+1');

    // Add a second sheet with a real formula + stale cached value, then verify single-sheet export recalculates & escapes
    const multiWorkbook: WorkbookV2 = structuredClone(imported.workbook);
    (multiWorkbook.native.sheetOrder as string[]).push('calc');
    (multiWorkbook.native.sheets as Record<string, JsonObject>).calc = {
        id: 'calc',
        name: 'Calc',
        rowCount: 20,
        columnCount: 10,
        cellData: {
            '0': {
                '0': {t: 2, v: 6},
                '1': {t: 2, v: 7},
                '2': {f: '=A1*B1', t: 2, v: 999},
                '3': {t: 2, v: -15},
                '4': {t: 1, v: '=HYPERLINK("http://evil")'},
                '5': {t: 1, v: ' +cmd'},
            },
        },
    };

    const exportedCalc = await exportCsv(multiWorkbook, {sheet_id: 'calc', delimiter: ',', line_ending: '\n'});
    const calcCsv = exportedCalc.bytes.toString('utf8');
    // Stale 999 was recalculated to 42; negative numeric -15 stays numeric; literal = (with quotes) and leading-space + are prefixed with '
    assert.equal(calcCsv, '6,7,42,-15,"\'=HYPERLINK(""http://evil"")",\' +cmd\n');
    assert.ok(exportedCalc.report.losses.some(l => l.target === 'Orders' && l.reason === 'csv_exports_single_sheet_only'));
    assert.ok(exportedCalc.report.losses.some(l => l.property === 'formulas' && l.status === 'transformed'));
    assert.ok(exportedCalc.report.diagnostics.filter(d => d.code === 'formula_injection_escaped').length === 2);

    // Export Orders back with original dialect and reopen it cleanly
    const exportedOrders = await exportCsv(imported.workbook, {delimiter: ';', quote: '"', line_ending: '\r\n'});
    const reopened = await importCsv(exportedOrders.bytes, {delimiter: ';', quote: '"', line_ending: '\r\n'});
    const reopenedCells = ((reopened.workbook.native.sheets as Record<string, JsonObject>).sheet_1.cellData as Record<string, Record<string, JsonObject>>);
    assert.deepEqual(reopenedCells['1']['0'], {t: 1, v: '00123'});
    assert.deepEqual(reopenedCells['1']['3'], {t: 1, v: '9007199254740993'});
    assert.deepEqual(reopenedCells['1']['5'], {t: 2, v: -42});

    // Formula injection defense cannot be turned off
    await assert.rejects(
        () => exportCsv(imported.workbook, {formula_injection_defense: false}),
        /formula_injection_defense_required|cannot be disabled/,
    );
    // Invalid UTF-8 rejected
    await assert.rejects(
        () => importCsv(Buffer.from([0xff, 0xfe, 0x00]), {}),
        /valid UTF-8/,
    );
});

test('preserves quoted CSV text that would otherwise be coerced', async () => {
    const dialect = {delimiter: ';', quote: '|'};
    const imported = await importCsv(Buffer.from('|TRUE|;TRUE;|FALSE|;FALSE;|42|;42\n'), dialect);
    const exported = await exportCsv(imported.workbook, dialect);
    assert.equal(exported.bytes.toString().trimEnd(), '|TRUE|;TRUE;|FALSE|;FALSE;|42|;42');
    const reopened = await importCsv(exported.bytes, dialect);
    const cells = (reopened.workbook.native.sheets as Record<string, JsonObject>).sheet_1.cellData as Record<string, Record<string, JsonObject>>;
    assert.deepEqual(Object.values(cells['0']), [
        {t: 1, v: 'TRUE'}, {t: 3, v: 1}, {t: 1, v: 'FALSE'}, {t: 3, v: 0}, {t: 1, v: '42'}, {t: 2, v: 42},
    ]);
});

test('round-trips XLSX list formulas separately from inline options', async () => {
    const input = makeMinimalXlsx({},
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
        '<row r="1"><c r="A1"><v>1</v></c></row><row r="2"><c r="A2"><v>2</v></c></row><row r="3"><c r="A3"><v>3</v></c></row>' +
        '</sheetData><dataValidations count="3">' +
        '<dataValidation type="list" sqref="B1"><formula1>A1:A3</formula1></dataValidation>' +
        '<dataValidation type="list" sqref="B2"><formula1>"open,closed"</formula1></dataValidation>' +
        '<dataValidation type="list" sqref="B3"><formula1>Sheet1!$A$1:$A$3</formula1></dataValidation>' +
        '</dataValidations></worksheet>');
    const {workbook} = await importXlsx(input, {});
    const readFormulas = (value: WorkbookV2): string[] => {
        const validation = (value.native.resources as JsonObject[]).find(resource => resource.name === 'SHEET_DATA_VALIDATION_PLUGIN');
        const rules = JSON.parse(String(validation?.data)).sheet_1 as {formula1: string}[];
        return rules.map(rule => rule.formula1);
    };
    assert.deepEqual(readFormulas(workbook), ['=A1:A3', '["open","closed"]', '=Sheet1!$A$1:$A$3']);
    const exported = await exportXlsx(workbook, {});
    assert.deepEqual(readFormulas((await importXlsx(exported.bytes, {})).workbook), readFormulas(workbook));
});

test('reports worksheet hyperlinks and refuses strict publication with the loss report', async () => {
    const rels = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const input = makeMinimalXlsx({
        'xl/worksheets/_rels/sheet1.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            `<Relationship Id="rId1" Type="${rels}/hyperlink" Target="https://example.com/" TargetMode="External"/></Relationships>`,
    }, '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"' +
        ` xmlns:r="${rels}"><sheetData/><hyperlinks><hyperlink ref="A1" r:id="rId1"/></hyperlinks></worksheet>`);
    const {report} = await importXlsx(input, {});
    assert.ok(report.losses.some(loss => loss.target === 'Sheet1!A1' && loss.property === 'hyperlink' && loss.status === 'lost'));
    await assert.rejects(() => importXlsx(input, {strict_profile: true}), {
        code: 'unsupported_content',
        detail: {
            reason: 'strict_profile_loss', loss_count: 1,
            report: {
                format: 'xlsx', operation: 'import', source_sha256: report.source_sha256, date_system: '1900',
                sheets: report.sheets, defined_names: report.defined_names, losses: report.losses,
                diagnostics: report.diagnostics, unknown_parts: [], editable_published: false,
            },
        },
    });
});

test('keeps elapsed and time-only values separate from calendar dates in the 1904 system', async () => {
    const input = makeMinimalXlsx({
        'xl/styles.xml': '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
            '<numFmts count="2"><numFmt numFmtId="164" formatCode="[mm]:ss"/><numFmt numFmtId="165" formatCode="mm:ss"/></numFmts>' +
            '<cellXfs count="5"><xf numFmtId="46"/><xf numFmtId="164"/><xf numFmtId="165"/><xf numFmtId="22"/><xf numFmtId="20"/></cellXfs></styleSheet>',
    }, '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData><row r="1">' +
        ['A', 'B', 'C', 'D', 'E'].map((column, index) => `<c r="${column}1" s="${index}"><v>0.5</v></c>`).join('') +
        '</row></sheetData></worksheet>', '<workbookPr date1904="1"/>');
    const {workbook} = await importXlsx(input, {});
    const readValues = (value: WorkbookV2): unknown[] => {
        const cells = (value.native.sheets as Record<string, JsonObject>).sheet_1.cellData as Record<string, Record<string, JsonObject>>;
        return Object.values(cells['0']).map(cell => cell.v);
    };
    assert.deepEqual(readValues(workbook), [0.5, 0.5, 0.5, 1462.5, 0.5]);
    const cells = (workbook.native.sheets as Record<string, JsonObject>).sheet_1.cellData as Record<string, Record<string, JsonObject>>;
    const styles = workbook.native.styles as Record<string, JsonObject>;
    assert.deepEqual(styles[String(cells['0']['0'].s)].n, {pattern: '[h]:mm:ss'});
    for (const date_system of ['1900', '1904']) {
        const exported = await exportXlsx(workbook, {date_system});
        const sheet = Buffer.from(unzipSync(exported.bytes)['xl/worksheets/sheet1.xml']).toString();
        assert.match(sheet, /<c r="A1" s="\d+"><v>0\.5<\/v><\/c>/);
        assert.match(sheet, date_system === '1904'
            ? /<c r="D1" s="\d+"><v>0\.5<\/v><\/c>/
            : /<c r="D1" s="\d+"><v>1462\.5<\/v><\/c>/);
        assert.deepEqual(readValues((await importXlsx(exported.bytes, {})).workbook), readValues(workbook));
    }
});

test('shifts shared formula cell references without changing their sheet names', async () => {
    const ns = 'http://schemas.openxmlformats.org/spreadsheetml/2006/main';
    const rels = 'http://schemas.openxmlformats.org/officeDocument/2006/relationships';
    const sheet = (data: string): string => `<worksheet xmlns="${ns}"><sheetData>${data}</sheetData></worksheet>`;
    const input = makeMinimalXlsx({
        'xl/workbook.xml': `<workbook xmlns="${ns}" xmlns:r="${rels}"><sheets>` +
            ['Summary', 'Q1', 'Q2'].map((name, i) => `<sheet name="${name}" sheetId="${i + 1}" r:id="rId${i + 1}"/>`).join('') +
            '</sheets></workbook>',
        'xl/_rels/workbook.xml.rels': '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
            [1, 2, 3].map(i => `<Relationship Id="rId${i}" Type="${rels}/worksheet" Target="worksheets/sheet${i}.xml"/>`).join('') +
            '</Relationships>',
        'xl/worksheets/sheet2.xml': sheet('<row r="1"><c r="A1"><v>4</v></c></row><row r="2"><c r="A2"><v>5</v></c></row>'),
        'xl/worksheets/sheet3.xml': sheet('<row r="2"><c r="A2"><v>999</v></c></row>'),
    }, sheet('<row r="1"><c r="A1"><f t="shared" ref="A1:A2" si="0">\'Q1\'!A1+Q1!A1</f><v>0</v></c></row>' +
        '<row r="2"><c r="A2"><f t="shared" si="0"/><v>0</v></c></row>'));
    const {workbook} = await importXlsx(input, {});
    const cells = (workbook.native.sheets as Record<string, JsonObject>).sheet_1.cellData as Record<string, Record<string, JsonObject>>;
    assert.equal(cells['1']['0'].f, "='Q1'!A2+Q1!A2");
    assert.equal(cells['1']['0'].v, 10);
});

test('round-trips XLSX border styles and reports unsupported borders', async () => {
    const input = makeMinimalXlsx({
        'xl/styles.xml': '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
            '<borders count="1"><border><left style="double"/><right style="dashed"/><top style="dotted"/><bottom style="thin"/>' +
            '<diagonal style="thin"/></border></borders><cellXfs count="1"><xf borderId="0"/></cellXfs></styleSheet>',
    });
    const {workbook, report} = await importXlsx(input, {});
    const readBorder = (value: WorkbookV2): JsonObject => {
        const cells = (value.native.sheets as Record<string, JsonObject>).sheet_1.cellData as Record<string, Record<string, JsonObject>>;
        return (value.native.styles as Record<string, JsonObject>)[String(cells['0']['0'].s)].bd as JsonObject;
    };
    const border = readBorder(workbook);
    assert.equal((border.l as JsonObject).s, 7);
    assert.equal((border.r as JsonObject).s, 4);
    assert.equal((border.t as JsonObject).s, 3);
    assert.ok(report.losses.some(loss => loss.property === 'border' && loss.status === 'lost'));
    const {bytes} = await exportXlsx(workbook, {});
    assert.deepEqual(readBorder((await importXlsx(bytes, {})).workbook), border);
    (border.l as JsonObject).s = 99;
    assert.ok((await exportXlsx(workbook, {})).report.losses.some(loss => loss.property === 'border' && loss.status === 'lost'));
});

test('round-trips XLSX features, handles 1900/1904 dates, reports losses/unknown parts and supports post-import insert_row_before', async () => {
    const stylesXml =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<numFmts count="1"><numFmt numFmtId="164" formatCode="yyyy-mm-dd"/></numFmts>' +
        '<fonts count="2"><font><sz val="11"/><name val="Calibri"/></font><font><b/><sz val="12"/><color rgb="FF112233"/><name val="Arial"/></font></fonts>' +
        '<fills count="2"><fill><patternFill patternType="none"/></fill><fill><patternFill patternType="gray125"/></fill></fills>' +
        '<borders count="1"><border><left/><right/><top/><bottom/><diagonal/></border></borders>' +
        '<cellXfs count="2">' +
        '<xf numFmtId="0" fontId="0" fillId="0" borderId="0"/>' +
        '<xf numFmtId="164" fontId="1" fillId="0" borderId="0" applyFont="1" applyNumberFormat="1"/>' +
        '</cellXfs>' +
        '<dxfs count="1"><dxf><font><b/><color rgb="FFFF0000"/></font><fill><patternFill><bgColor rgb="FFFFFF00"/></patternFill></fill></dxf></dxfs>' +
        '</styleSheet>';

    const sstXml =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<sst xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" count="1" uniqueCount="1"><si><t>Revenue</t></si></sst>';

    // 1904 epoch: serial 44197 == 2025-01-01? Wait: 44197 + 1462 = 45659 (2025-01-01 in 1900 epoch). Also test serial 60 on 1900 book separately.
    const workbookXml1904 =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<workbook xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships">' +
        '<workbookPr date1904="1"/>' +
        '<sheets><sheet name="Summary" sheetId="1" r:id="rId1"/></sheets>' +
        '<definedNames><definedName name="Multiplier">Summary!$B$1</definedName></definedNames>' +
        '</workbook>';

    const sheetXml =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main">' +
        '<sheetViews><sheetView workbookViewId="0"><pane xSplit="0" ySplit="1" topLeftCell="A2" state="frozen"/></sheetView></sheetViews>' +
        '<sheetData>' +
        '<row r="1"><c r="A1" t="s" s="1"><v>0</v></c><c r="B1"><v>5</v></c><c r="C1"><f>_xlfn.IFS(B1&gt;3,B1*10)</f><v>999</v></c><c r="D1"><f>[External.xlsx]Sheet1!A1</f><v>77</v></c><c r="E1" s="1"><v>44197</v></c></row>' +
        '<row r="2"><c r="A2"><v>2</v></c><c r="B2"><f t="shared" ref="B2:B3" si="0">A2*Multiplier</f><v>0</v></c></row>' +
        '<row r="3"><c r="A3"><v>4</v></c><c r="B3"><f t="shared" si="0"/><v>0</v></c></row>' +
        '</sheetData>' +
        '<autoFilter ref="A1:E3"/>' +
        '<mergeCells count="1"><mergeCell ref="A4:B4"/></mergeCells>' +
        '<conditionalFormatting sqref="C1:C3"><cfRule type="cellIs" dxfId="0" priority="1" operator="greaterThan"><formula>10</formula></cfRule></conditionalFormatting>' +
        '<dataValidations count="1"><dataValidation type="list" sqref="E2:E3"><formula1>"open,closed"</formula1></dataValidation></dataValidations>' +
        '</worksheet>';

    const wbRelsWithSafeHyperlink =
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
        '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
        '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
        '<Relationship Id="rId3" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/sharedStrings" Target="sharedStrings.xml"/>' +
        '<Relationship Id="rId4" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="https://example.com/docs" TargetMode="External"/>' +
        '</Relationships>';

    const inputZip = makeMinimalXlsx(
        {
            'xl/workbook.xml': workbookXml1904,
            'xl/_rels/workbook.xml.rels': wbRelsWithSafeHyperlink,
            'xl/styles.xml': stylesXml,
            'xl/sharedStrings.xml': sstXml,
            'xl/drawings/drawing1.xml': '<wsDr/>',
        },
        sheetXml,
    );

    // strict_profile refuses unknown_parts / external ref loss
    await assert.rejects(
        () => importXlsx(inputZip, {strict_profile: true}),
        /Strict profile refuses/,
    );

    const imported = await importXlsx(inputZip, {});
    assert.equal(imported.report.date_system, '1904');
    assert.deepEqual(imported.report.unknown_parts, ['xl/drawings/drawing1.xml']);
    assert.ok(imported.report.losses.some(l => l.target === 'Summary!D1' && l.reason === 'external_ref_stripped'));
    assert.ok(imported.report.losses.some(l => l.target === 'xl/drawings/drawing1.xml' && l.reason === 'unsupported_ooxml_part'));
    assert.ok(imported.report.diagnostics.some(d => d.code === 'xlfn_stripped'));
    assert.ok(imported.report.diagnostics.some(d => d.code === 'date1904_shifted'));

    const sheet = (imported.workbook.native.sheets as Record<string, JsonObject>).sheet_1;
    const cells = sheet.cellData as Record<string, Record<string, JsonObject>>;
    assert.equal(cells['0']['2'].f, '=IFS(B1>3,B1*10)');
    assert.equal(cells['0']['2'].v, 50);
    assert.equal(cells['0']['2'].s, undefined); // unstyled cells should NOT carry style key
    assert.equal(cells['0']['3'].v, '#REF!');
    assert.equal(cells['0']['4'].v, 45659); // 44197 + 1462 days
    assert.equal(cells['1']['1'].v, 10); // shared formula B2: A2*Multiplier = 2*5 = 10
    assert.equal(cells['2']['1'].v, 20); // shifted shared formula B3: A3*Multiplier = 4*5 = 20

    // Re-export back as 1904 XLSX and check serial restored to 44197, plus CF, DV, DefinedNames, AutoFilter preserved
    const exported = await exportXlsx(imported.workbook, {date_system: '1904'});
    const reimported = await importXlsx(exported.bytes, {});
    assert.equal(reimported.report.date_system, '1904');
    assert.equal(reimported.report.defined_names.preserved, 1);
    assert.equal(reimported.report.sheets[0].validations, 1);
    assert.equal(reimported.report.sheets[0].conditional_formatting, 1);
    assert.equal(reimported.report.sheets[0].merges, 1);
    const reCells = ((reimported.workbook.native.sheets as Record<string, JsonObject>).sheet_1.cellData as Record<string, Record<string, JsonObject>>);
    assert.equal(reCells['0']['4'].v, 45659);
    assert.equal(reCells['2']['1'].v, 20);

    // Also verify 1900 serial 60 diagnostic AND post-import insert_row_before on a workbook without CF
    const plainXlsx = makeMinimalXlsx(
        {
            'xl/styles.xml': stylesXml,
            'xl/_rels/workbook.xml.rels':
                '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
                '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
                '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/worksheet" Target="worksheets/sheet1.xml"/>' +
                '<Relationship Id="rId2" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/styles" Target="styles.xml"/>' +
                '</Relationships>',
        },
        '<?xml version="1.0" encoding="UTF-8" standalone="yes"?>' +
        '<worksheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main"><sheetData>' +
        '<row r="1"><c r="A1" s="1"><v>60</v></c></row>' +
        '<row r="2"><c r="A2"><v>10</v></c><c r="B2"><f>=A2*3</f><v>0</v></c></row>' +
        '</sheetData></worksheet>',
    );
    const imp1900 = await importXlsx(plainXlsx, {});
    assert.ok(imp1900.report.diagnostics.some(d => d.code === 'serial_60_leap_bug'));
    const baseSha = sha256Canonical(imp1900.workbook);
    const opRes = await runOperation({
        version: 1,
        request_id: 'op-after-import',
        operation: 'apply',
        base: {generation: 0, position: 1, sha256: baseSha},
        profile_id: WIRE_PROFILE.id,
        workbook: imp1900.workbook as unknown as JsonObject,
        commands: [{kind: 'insert_row_before', sheet_id: 'sheet_1', row: 2, count: 1}],
    });
    assert.equal(opRes.ok, true);
    if (opRes.ok && 'workbook' in opRes) {
        const expAfterRowInsert = await exportXlsx(opRes.workbook, {});
        const reimpAfterInsert = await importXlsx(expAfterRowInsert.bytes, {});
        const afterCells = ((reimpAfterInsert.workbook.native.sheets as Record<string, JsonObject>).sheet_1.cellData as Record<string, Record<string, JsonObject>>);
        // Row 2 shifted down to row 3 (index "2")
        assert.equal(afterCells['2']['0'].v, 10);
        assert.equal(afterCells['2']['1'].v, 30);
    }
});

test('zip-guard blocks path traversal, backslash, NUL, drive letter, symlinks, overlaps, zip-bombs, XXE and external rels', async () => {
    const validContentTypes = enc.encode('<Types xmlns="http://schemas.openxmlformats.org/package/2006/content-types"/>');

    const badArchives: [string, Buffer, RegExp][] = [
        ['dot-dot traversal', buildCustomRawZip([{name: 'xl/../evil.xml', data: validContentTypes}]), /unsafe|invalid_zip|invalid/i],
        ['leading slash', buildCustomRawZip([{name: '/xl/workbook.xml', data: validContentTypes}]), /unsafe|invalid_zip|invalid/i],
        ['backslash', buildCustomRawZip([{name: 'xl\\workbook.xml', data: validContentTypes}]), /unsafe|invalid_zip|invalid/i],
        ['windows drive letter', buildCustomRawZip([{name: 'C:xl/workbook.xml', data: validContentTypes}]), /unsafe|invalid_zip|invalid/i],
        ['NUL byte in name', buildCustomRawZip([{name: 'xl/work\0book.xml', data: validContentTypes}]), /NUL|zip_error|unsafe/i],
        [
            'case-insensitive duplicate',
            buildCustomRawZip([
                {name: 'xl/workbook.xml', data: validContentTypes},
                {name: 'xl/WORKBOOK.XML', data: validContentTypes},
            ]),
            /Duplicate/,
        ],
        [
            'UNIX symlink S_IFLNK',
            buildCustomRawZip([
                {name: 'xl/workbook.xml', data: enc.encode('/etc/passwd'), externalAttrs: 0o120777 << 16},
            ]),
            /symbolic link/,
        ],
        [
            'overlapping ZIP byte ranges',
            buildCustomRawZip([
                {name: 'a.xml', data: enc.encode('<a/>')},
                {name: 'b.xml', data: enc.encode('<b/>'), overrideOffset: 0},
            ]),
            /overlap/i,
        ],
        [
            'zip-bomb ratio > 100x',
            buildCustomRawZip([
                {name: 'xl/workbook.xml', data: Buffer.alloc(1024 * 1024, 0x41), rawDeflate: true},
            ]),
            /compression ratio/,
        ],
        [
            'XXE DOCTYPE',
            makeMinimalXlsx({'xl/workbook.xml': '<!DOCTYPE foo [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><workbook/>'}),
            /DOCTYPE|DTD/,
        ],
        [
            'XInclude',
            makeMinimalXlsx({
                'xl/styles.xml': '<styleSheet xmlns="http://schemas.openxmlformats.org/spreadsheetml/2006/main" xmlns:xi="http://www.w3.org/2001/XInclude"><xi:include href="file:///etc/passwd"/></styleSheet>',
            }),
            /XInclude|DTD/,
        ],
        [
            'disallowed TargetMode=External non-hyperlink',
            makeMinimalXlsx({
                'xl/_rels/workbook.xml.rels':
                    '<?xml version="1.0" encoding="UTF-8"?>' +
                    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
                    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/attachedTemplate" Target="https://evil.invalid/t.dotm" TargetMode="External"/>' +
                    '</Relationships>',
            }),
            /Disallowed external relationship/,
        ],
        [
            'disallowed TargetMode=External file:// hyperlink',
            makeMinimalXlsx({
                'xl/_rels/workbook.xml.rels':
                    '<?xml version="1.0" encoding="UTF-8"?>' +
                    '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">' +
                    '<Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/hyperlink" Target="file:///etc/passwd" TargetMode="External"/>' +
                    '</Relationships>',
            }),
            /Disallowed external relationship/,
        ],
    ];

    for (const [label, archive, pattern] of badArchives) {
        await assert.rejects(
            () => importXlsx(archive, {}),
            pattern,
            `Expected failure for ${label}`,
        );
    }
});

test('exchange worker and HTTP handler enforce format gates and SHA-256 verification', async () => {
    const csvBuf = Buffer.from('a,b\n1,2\n', 'utf8');
    const xlsxBuf = makeMinimalXlsx();

    const frameOf = (payload: JsonObject): Buffer => Buffer.from(JSON.stringify(payload) + '\n', 'utf8');

    const csvDisabled = await processExchangeFrame(
        frameOf({
            version: 1,
            request_id: 'req-1',
            operation: 'import',
            format: 'csv',
            profile_id: WIRE_PROFILE.id,
            input_b64: csvBuf.toString('base64'),
            input_sha256: sha256Hex(csvBuf),
            options: {},
        }),
        parseEnabledExchangeFormats('xlsx'),
    );
    assert.equal(csvDisabled.ok, false);
    if (!csvDisabled.ok) assert.equal(csvDisabled.error.code, 'format_disabled');

    const badSha = await processExchangeFrame(
        frameOf({
            version: 1,
            request_id: 'req-2',
            operation: 'import',
            format: 'xlsx',
            profile_id: WIRE_PROFILE.id,
            input_b64: xlsxBuf.toString('base64'),
            input_sha256: '0'.repeat(64),
            options: {},
        }),
        parseEnabledExchangeFormats('csv,xlsx'),
    );
    assert.equal(badSha.ok, false);
    if (!badSha.ok) assert.equal(badSha.error.code, 'base_mismatch');

    // Empty enabled set -> HTTP handler returns 404 exchange_disabled
    const disabledHandler = createExchangeHttpHandler([]);
    const disabledRes = await invokeHandler(disabledHandler, {version: 1, request_id: 'h1'});
    assert.equal(disabledRes.status, 404);
    assert.equal(disabledRes.json.error, 'exchange_disabled');

    // Enabled CSV + XLSX HTTP handler round-trip
    const enabledHandler = createExchangeHttpHandler(parseEnabledExchangeFormats('csv,xlsx'));
    try {
        const okRes = await invokeHandler(enabledHandler, {
            version: 1,
            request_id: 'h2',
            operation: 'import',
            format: 'csv',
            profile_id: WIRE_PROFILE.id,
            input_b64: csvBuf.toString('base64'),
            input_sha256: sha256Hex(csvBuf),
            options: {},
        });
        assert.equal(okRes.status, 200);
        assert.equal(okRes.json.ok, true);
        const outWb = JSON.parse(Buffer.from(String(okRes.json.output_b64), 'base64').toString('utf8')) as WorkbookV2;
        assert.equal(canonicalize(outWb.profile), canonicalize(WIRE_PROFILE));
    } finally {
        enabledHandler.close();
    }
});
