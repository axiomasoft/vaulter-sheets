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

const base=new URL('./',import.meta.url);
const mode=process.argv[2]??'unknown-resource';
const snapshot=JSON.parse(readFileSync(new URL('snapshot-v3.json',base),'utf8'));
const summaryId=snapshot.sheetOrder.find(id=>snapshot.sheets[id].name==='Summary');
if(mode==='unknown-resource')snapshot.resources.push({name:'VAULTER_UNREGISTERED_SENTINEL',data:'{"kept":true}'});
if(mode==='cached-value')snapshot.sheets[summaryId].cellData[1][1].v=999;
const univer=new Univer({locale:LocaleType.EN_US,locales:{}});
for(const P of [UniverRenderEnginePlugin,UniverFormulaEnginePlugin,UniverDocsPlugin,UniverSheetsPlugin,UniverSheetsFormulaPlugin,UniverSheetsNumfmtPlugin])univer.registerPlugin(P);
const api=FUniver.newAPI(univer);const formula=api.getFormula();const wb=api.createWorkbook(snapshot);
const summary=wb.getSheetByName('Summary');const detail=wb.getSheetByName('Detail');
await formula.onCalculationResultApplied(10000);
if(mode==='unknown-resource'){
const after=wb.save();
console.log(JSON.stringify({mode,originalContainsSentinel:snapshot.resources.some(r=>r.name==='VAULTER_UNREGISTERED_SENTINEL'),savedContainsSentinel:after.resources.some(r=>r.name==='VAULTER_UNREGISTERED_SENTINEL')}));
assert.equal(after.resources.some(r=>r.name==='VAULTER_UNREGISTERED_SENTINEL'),false);
}else if(mode==='cached-value'){
console.log(JSON.stringify({mode,initialCache:999,afterDefaultInitialization:summary.getRange('B2').getRawValue()}));
const applied=formula.onCalculationResultApplied(10000);formula.executeCalculation();await applied;
console.log(JSON.stringify({mode,afterForcedRecalculation:summary.getRange('B2').getRawValue()}));
assert.equal(summary.getRange('B2').getRawValue(),41);
}else if(mode==='automatic-change'){
const applied=formula.onCalculationResultApplied(10000);detail.getRange('C4').setValue(8);await applied;
console.log(JSON.stringify({mode,afterAutomaticRecalculation:summary.getRange('B2').getRawValue()}));
assert.equal(summary.getRange('B2').getRawValue(),44);
}
univer.dispose();
