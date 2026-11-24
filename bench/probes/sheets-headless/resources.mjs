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

import {UniverDataValidationPlugin} from '@univerjs/data-validation';
import {UniverSheetsDataValidationPlugin} from '@univerjs/sheets-data-validation';
import {UniverSheetsConditionalFormattingPlugin} from '@univerjs/sheets-conditional-formatting';
import {UniverDrawingPlugin} from '@univerjs/drawing';
import {UniverSheetsDrawingPlugin} from '@univerjs/sheets-drawing';
import '@univerjs/sheets-data-validation/facade';
import '@univerjs/sheets-conditional-formatting/facade';
import '@univerjs/sheets-drawing/facade';
const base=new URL('./',import.meta.url);const phase=process.argv[2]??'create';
const univer=new Univer({locale:LocaleType.EN_US,locales:{}});
for(const P of [UniverRenderEnginePlugin,UniverFormulaEnginePlugin,UniverDocsPlugin,UniverSheetsPlugin,UniverSheetsFormulaPlugin,UniverSheetsNumfmtPlugin])univer.registerPlugin(P);
if(phase!=='missing-plugins')for(const P of [UniverDataValidationPlugin,UniverSheetsDataValidationPlugin,UniverSheetsConditionalFormattingPlugin,UniverDrawingPlugin,UniverSheetsDrawingPlugin])univer.registerPlugin(P);
const api=FUniver.newAPI(univer);const formula=api.getFormula();
const source=new URL(phase==='create'?'snapshot-v1.json':'snapshot-with-resources.json',base);
const wb=api.createWorkbook(JSON.parse(readFileSync(source,'utf8')));const detail=wb.getSheetByName('Detail');const summary=wb.getSheetByName('Summary');
async function recalc(){const p=formula.onCalculationResultApplied(10000);formula.executeCalculation();await p;}
await recalc();
if(phase==='missing-plugins'){
console.log(JSON.stringify({phase,resourcesBefore:JSON.parse(readFileSync(source,'utf8')).resources.map(r=>r.name),resourcesAfter:wb.save().resources.map(r=>r.name)}));
}else{
if(phase==='create'){
wb.insertDefinedNameBuilder(wb.newDefinedNameBuilder().setName('Totals').setRef('Detail!$D$2:$D$3').build());
summary.getRange('B3').setFormula('=SUM(Totals)');
await detail.getRange('B2:B3').setDataValidation(api.newDataValidation().requireNumberBetween(1,100).build());
detail.addConditionalFormattingRule(detail.newConditionalFormattingRule().whenNumberGreaterThan(18).setRanges([detail.getRange('D2:D3').getRange()]).setBackground('#ff0000').build());
// Explicit dimensions make this a content/geometry operation; the image is not fetched or rendered.
const im=await detail.newOverGridImage().setSource('https://example.invalid/fixture.png',api.Enum.ImageSourceType.URL).setColumn(6).setRow(1).setWidth(60).setHeight(40).buildAsync();
detail.insertImages([im]);
}else if(phase==='insert')detail.insertRowsBefore(1,1);
await recalc();
const result={phase,dom:{document:typeof document,window:typeof window},names:wb.getDefinedNames().map(n=>({name:n.getName(),ref:n.getFormulaOrRefString()})),validation:detail.getDataValidations().map(d=>d.rule),conditional:detail.getConditionalFormattingRules(),images:detail.getImages().map(i=>({id:i.getId(),placement:i.getPlacement(),source:i.toBuilder().getSource()})),sumNamed:summary.getRange('B3').getRawValue(),resources:wb.save().resources.map(r=>r.name)};
console.log(JSON.stringify(result));assert.equal(result.sumNamed,35);assert.equal(result.images.length,1);assert.equal(result.validation.length,1);assert.equal(result.conditional.length,1);
if(phase==='insert'){
assert.equal(result.names[0].ref,'Detail!$D$3:$D$4');assert.equal(result.validation[0].ranges[0].startRow,2);assert.equal(result.conditional[0].ranges[0].startRow,2);assert.equal(result.images[0].placement.from.row,2);
}
if(phase==='create')writeFileSync(new URL('snapshot-with-resources.json',base),JSON.stringify(wb.save(),null,2));
if(phase==='insert')writeFileSync(new URL('snapshot-with-resources-inserted.json',base),JSON.stringify(wb.save(),null,2));
}
univer.dispose();
