import test from 'node:test';import assert from 'node:assert/strict';import {mkdtempSync} from 'node:fs';import {tmpdir} from 'node:os';import {join} from 'node:path';import {OperationJournal,importArgsHash,operationArgsHash} from '../src/operation-journal.mjs';
const input={fileKey:'file',variables:[{key:'a'.repeat(40),resolvedType:'FLOAT'}]};
test('durable first import ID survives timeout and client restart; duplicate/foreign events rejected',()=>{const dir=mkdtempSync(join(tmpdir(),'journal-')),j=new OperationJournal(dir),r=j.begin(input,'conn');j.mark(r.operationId,{state:'unknown'});const e={operationId:r.operationId,fileKey:'file',argsHash:r.argsHash,sequence:1,stage:'variable-read',key:input.variables[0].key,id:'VariableID:real'};assert.equal(j.event('wrong',e),false);assert.equal(j.event('conn',{...e,argsHash:'wrong'}),false);assert.equal(j.event('conn',e),true);assert.equal(j.event('conn',e),false);const fresh=new OperationJournal(dir);assert.equal(fresh.get('file',r.operationId).variables[0].id,'VariableID:real');assert.throws(()=>fresh.begin(input,'new'),{code:'OPERATION_IN_PROGRESS'});assert.throws(()=>fresh.get('foreign',r.operationId),{code:'OPERATION_TARGET_MISMATCH'});fresh.event('conn',{...e,sequence:2,stage:'settled',success:false});assert.equal(fresh.get('file',r.operationId).settled,true);});
test('hash ignores attempt and operation id, preserves variable order and fields',()=>{assert.equal(importArgsHash(input),importArgsHash({...input,attempt:2,operationId:'x'}));assert.notEqual(importArgsHash(input),importArgsHash({...input,fileKey:'other'}));});
test('authenticated operation capability rebinds after socket loss, hides secret, rejects foreign plugin and acknowledges replay',()=>{
 const dir=mkdtempSync(join(tmpdir(),'journal-reconnect-')),j=new OperationJournal(dir),token='c'.repeat(64),r=j.begin(input,'old-socket',token);
 const e={operationId:r.operationId,fileKey:'file',argsHash:r.argsHash,sequence:1,stage:'variable-read',key:input.variables[0].key,id:'late-real-id'};
 assert.equal(j.event('new-plugin',e),false);assert.equal(j.event('new-plugin',{...e,resumeToken:'wrong'}),false);
 assert.equal(j.event('new-socket',{...e,resumeToken:token}),true);
 assert.equal(j.get('file',r.operationId).connectionId,'old-socket');
 assert.equal(JSON.stringify(j.get('file',r.operationId)).includes('resumeToken'),false);
 const reloaded=new OperationJournal(dir);
 assert.equal(reloaded.acknowledged('new-socket',e),true);
 assert.equal(reloaded.event('new-socket',{...e,sequence:2,stage:'settled',success:false}),true);
 assert.equal(reloaded.get('file',r.operationId).settled,true);
 assert.equal(reloaded.event('old-socket',{...e,sequence:3,stage:'verified'}),false);
});
test('successful completion without intermediate import evidence stays unverified',()=>{
 const j=new OperationJournal(mkdtempSync(join(tmpdir(),'journal-missing-progress-'))),r=j.begin(input,'conn');
 j.event('conn',{operationId:r.operationId,fileKey:'file',argsHash:r.argsHash,sequence:1,stage:'settled',success:true});
 const saved=j.get('file',r.operationId);assert.equal(saved.settled,true);assert.equal(saved.state,'unknown');assert.equal(saved.code,'OPERATION_JOURNAL_INCOMPLETE');assert.equal(saved.variables[0].id,undefined);
});
test('complete generated import records real native ID and verifies only after metadata reads',async()=>{
 const {buildImportVariablesCode}=await import('../src/import-variables.mjs');
 const {createFigmaMock}=await import('./helpers/figma-mock.mjs');
 const {figma}=createFigmaMock();figma.fileKey=input.fileKey;let imports=0;
 const variable={id:'real-native-variable',key:input.variables[0].key,resolvedType:'FLOAT',name:'Token',remote:true,variableCollectionId:'real-collection'};
 figma.variables.importVariableByKeyAsync=async()=>{imports++;return variable;};
 figma.variables.getVariableByIdAsync=async()=>variable;
 figma.variables.getVariableCollectionByIdAsync=async()=>({id:'real-collection',key:'b'.repeat(40),name:'Library',remote:true,modes:[{modeId:'default',name:'Default'}],defaultModeId:'default'});
 const j=new OperationJournal(mkdtempSync(join(tmpdir(),'journal-full-import-'))),r=j.begin(input,'conn');let sequence=0;
 const control={cancelled:false,report:event=>j.event('conn',{...event,operationId:r.operationId,fileKey:input.fileKey,argsHash:r.argsHash,sequence:++sequence})};
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 const result=await new AsyncFunction('figma','executionControl',buildImportVariablesCode(input))(figma,control);
 assert.equal(result.complete,true);assert.equal(j.get(input.fileKey,r.operationId).settled,false);
 control.report({stage:'settled',success:true});
 const saved=j.get(input.fileKey,r.operationId);assert.equal(saved.settled,true);assert.equal(saved.state,'verified');assert.equal(saved.stage,'verified');assert.equal(saved.sequence,5);assert.equal(saved.variables[0].id,variable.id);assert.equal(imports,1);
});

test('component journal persists a terminal not_applied outcome after a late native import',()=>{
 const dir=mkdtempSync(join(tmpdir(),'journal-component-'));
 const operation={fileKey:'file',name:'use_component',args:{fileKey:'file',libraryKey:'button',parentKey:'demo',key:'guide/button'}};
 const j=new OperationJournal(dir),r=j.begin(operation,'conn');
 assert.equal(r.argsHash,operationArgsHash(operation));
 assert.equal(r.name,'use_component');
 assert.equal(j.event('conn',{operationId:r.operationId,fileKey:'file',argsHash:r.argsHash,sequence:1,stage:'component-import',libraryKey:'button',id:'component-id'}),true);
 assert.equal(j.event('conn',{operationId:r.operationId,fileKey:'file',argsHash:r.argsHash,sequence:2,stage:'settled',success:false,operationStatus:'not_applied',code:'OPERATION_CANCELLED_BEFORE_MUTATION'}),true);
 const saved=new OperationJournal(dir).get('file',r.operationId);
 assert.equal(saved.settled,true);
 assert.equal(saved.state,'failed');
 assert.equal(saved.operationStatus,'not_applied');
 assert.equal(saved.code,'OPERATION_CANCELLED_BEFORE_MUTATION');
 assert.equal(saved.resourceId,'component-id');
});
