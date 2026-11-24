/** Reproducible test on Univer OSS 1.5.2; Node 24.22.3; no DOM/Canvas/browser. */
import {readFileSync,writeFileSync} from 'node:fs';
import {strict as assert} from 'node:assert';
import {LocaleType, Univer, CellValueType} from '@univerjs/core';
import {FUniver} from '@univerjs/core/facade';
import {UniverRenderEnginePlugin} from '@univerjs/engine-render';
import {UniverFormulaEnginePlugin} from '@univerjs/engine-formula';
import {UniverDocsPlugin} from '@univerjs/docs';
import {UniverSheetsPlugin} from '@univerjs/sheets';
import {UniverSheetsFormulaPlugin} from '@univerjs/sheets-formula';
import {UniverSheetsNumfmtPlugin} from '@univerjs/sheets-numfmt';
import '@univerjs/engine-formula/facade';
import '@univerjs/sheets/facade';
import '@univerjs/sheets-formula/facade';
import '@univerjs/sheets-numfmt/facade';
const phase=process.argv[2] ?? 'create';
const base=new URL('./', import.meta.url);
const univer=new Univer({locale:LocaleType.EN_US,locales:{}});
for(const P of [UniverRenderEnginePlugin,UniverFormulaEnginePlugin,UniverDocsPlugin,UniverSheetsPlugin,UniverSheetsFormulaPlugin,UniverSheetsNumfmtPlugin]) univer.registerPlugin(P);
const api=FUniver.newAPI(univer);
const formula=api.getFormula();
const pathFor = (n)=>new URL(`snapshot-v${n}.json`,base);
const from=phase==='update'?1:phase==='insert'?2:3;
let wb;
console.log(JSON.stringify({phase,node:process.version,dom:{document:typeof document,window:typeof window}}));
if(phase==='create'){
  wb=api.createWorkbook({id:'vaulter-smoke',name:'Fruit'});
  const detail=wb.getActiveSheet().setName('Detail');
  const summary=wb.insertSheet('Summary');
  detail.getRange('A1:D3').setValues([
    ['Товар','Количество','Цена','Сумма'],
    ['Яблоки',2,10,null],
    ['Груши',3,5,null],
  ]);
  detail.getRange('D2').setFormula('=B2*C2');
  detail.getRange('D3').setFormula('=B3*C3');
  summary.getRange('B2').setFormula('=SUM(Detail!D2:D3)');
  detail.getRange('B2:B3').setNumberFormat('0');
  detail.getRange('C2:D3').setNumberFormat('0.00');
  summary.getRange('B2').setNumberFormat('0.00');
}else wb=api.createWorkbook(JSON.parse(readFileSync(pathFor(from),'utf8')));
const detail=wb.getSheetByName('Detail');
const summary=wb.getSheetByName('Summary');
// Register wait before requesting calculation. An isolated job has a single writer.
async function recalc(){const applied=formula.onCalculationResultApplied(10000);formula.executeCalculation();await applied;}
await recalc();
function cell(s,a){const r=s.getRange(a);return {sheet:s.getSheetName(),address:a,value:r.getRawValue(),display:r.getDisplayValue(),getValue:r.getValue(),formula:r.getFormula(),type:r.getCellDataGrid()[0][0]?.t??null,format:r.getNumberFormat()};}
function report(stage,shifted=false){console.log(JSON.stringify({stage,cells:[cell(detail,shifted?'C3':'C2'),cell(detail,shifted?'C4':'C3'),cell(detail,shifted?'D3':'D2'),cell(detail,shifted?'D4':'D3'),cell(summary,'B2')]}));}
if(phase==='create'){
  assert.equal(detail.getRange('D2').getRawValue(),20);assert.equal(detail.getRange('D3').getRawValue(),15);assert.equal(summary.getRange('B2').getRawValue(),35);
  report('initial-calculated');
  writeFileSync(pathFor(1),JSON.stringify(wb.save(),null,2));
}else if(phase==='update'){
  assert.equal(summary.getRange('B2').getRawValue(),35);report('reopened-v1');
  detail.getRange('C3').setValue(7);
  await recalc();assert.equal(summary.getRange('B2').getRawValue(),41);report('agent-edited');
  writeFileSync(pathFor(2),JSON.stringify(wb.save(),null,2));
}else if(phase==='insert'){
  assert.equal(summary.getRange('B2').getRawValue(),41);
  detail.insertRowsBefore(1,1);await recalc();
  assert.equal(detail.getRange('C3').getRawValue(),10);assert.equal(detail.getRange('C4').getRawValue(),7);
  assert.equal(detail.getRange('D3').getFormula(),'=B3*C3');assert.equal(detail.getRange('D4').getFormula(),'=B4*C4');
  assert.equal(summary.getRange('B2').getFormula(),'=SUM(Detail!D3:D4)');assert.equal(summary.getRange('B2').getRawValue(),41);
  report('row-inserted',true);writeFileSync(pathFor(3),JSON.stringify(wb.save(),null,2));
}else if(phase==='reopen'){
  assert.equal(detail.getRange('C3').getRawValue(),10);assert.equal(summary.getRange('B2').getRawValue(),41);report('reopened-v3-new-process',true);
  console.log(JSON.stringify({resources:wb.save().resources?.map(r=>r.name),savedBytes:Buffer.byteLength(JSON.stringify(wb.save()))}));
}else if(phase==='stale-address'){
  detail.getRange('C3').setValue(8);await recalc();
  assert.equal(detail.getRange('A3').getValue(),'Яблоки');assert.equal(detail.getRange('C3').getRawValue(),8);
  report('unprotected-stale-address-overwrites-apple-not-saved',true);
}
univer.dispose();
