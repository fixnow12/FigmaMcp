import test from 'node:test';
import assert from 'node:assert/strict';
import {createFigmaMock,executeGenerated} from './helpers/figma-mock.mjs';
const implementation=await import('../src/import-variables.mjs').catch(()=>({}));
const key='a'.repeat(40),second='b'.repeat(40),collectionKey='c'.repeat(40);
function fixture(){
 const m=createFigmaMock();m.figma.fileKey='working';let imports=0;
 const collection={id:'actual-collection',key:collectionKey,name:'Library',remote:true,modes:[{modeId:'default-id',name:'default'}],defaultModeId:'default-id'};
 const variable={id:'opaque-destination-id',key,name:'Token',resolvedType:'COLOR',remote:true,variableCollectionId:collection.id};
 m.figma.variables.importVariableByKeyAsync=async()=>{imports++;return variable;};
 m.figma.variables.getVariableByIdAsync=async()=>variable;
 m.figma.variables.getVariableCollectionByIdAsync=async()=>collection;
 return {...m,variable,collection,input:{fileKey:'working',variables:[{key,resolvedType:'COLOR',collectionKey}]},imports:()=>imports};
}
const run=m=>executeGenerated(m.figma,implementation.buildImportVariablesCode(m.input));
test('import_variables provides a typed implementation',()=>assert.equal(typeof implementation.buildImportVariablesCode,'function'));
test('returns verified opaque destination IDs and complete collection metadata without layer writes',async()=>{
 const m=fixture(),before=JSON.stringify(m.collection),result=await run(m);
 assert.equal(result.complete,true);assert.equal(result.fileKey,'working');assert.deepEqual(result.coverage,{requested:1,verified:1,complete:true});
 assert.deepEqual(result.variables[0],{id:m.variable.id,key,name:'Token',resolvedType:'COLOR',remote:true,variableCollectionId:m.collection.id,collectionKey,collection:{...m.collection}});
 assert.equal(JSON.stringify(m.collection),before);assert.equal(m.writes.length,0);
});
test('strict schema rejects malformed keys, type, duplicates and unknown fields before import',()=>{
 const {input}=fixture();assert.equal(implementation.importVariablesSchema.safeParse(input).success,true);
 for(const candidate of [{...input,fileKey:undefined},{...input,variables:[]},{...input,extra:true},{...input,variables:[input.variables[0],input.variables[0]]},...['key','collectionKey','resolvedType'].map(field=>({...input,variables:[{...input.variables[0],[field]:'wrong'}]}))])assert.equal(implementation.importVariablesSchema.safeParse(candidate).success,false);
});
test('wrong file is not_applied and does not call import',async()=>{const m=fixture();m.input.fileKey='other';await assert.rejects(run(m),e=>e.operationStatus==='not_applied');assert.equal(m.imports(),0);});
test('missing import, mismatched identity/type/collection and read-back IDs never claim complete or rollback',async()=>{
 for(const kind of ['reject','null','key','type','collection','id','readback']){
  const m=fixture();if(kind==='reject')m.figma.variables.importVariableByKeyAsync=async()=>{throw Error('unavailable');};if(kind==='null')m.figma.variables.importVariableByKeyAsync=async()=>null;if(kind==='key')m.variable.key=second;if(kind==='type')m.variable.resolvedType='FLOAT';if(kind==='collection')m.collection.key=second;if(kind==='id')m.collection.id='wrong';if(kind==='readback')m.figma.variables.getVariableByIdAsync=async()=>({...m.variable,id:'wrong'});
  await assert.rejects(run(m),e=>e.operationStatus==='partial'&&e.blockers[0].evidence.complete===false&&e.blockers[0].evidence.variables.length===0,kind);
 }
});
test('later failure reports prior verified imports and unattempted keys',async()=>{
 const m=fixture();m.input.variables.push({key:second,resolvedType:'FLOAT'},{key:'d'.repeat(40),resolvedType:'COLOR'});m.figma.variables.importVariableByKeyAsync=async k=>{if(k===second)throw Error('denied');return m.variable;};
 await assert.rejects(run(m),e=>{assert.equal(e.operationStatus,'partial');const proof=e.blockers[0].evidence;assert.equal(proof.variables[0].id,m.variable.id);assert.deepEqual(proof.unattemptedKeys,['d'.repeat(40)]);assert.deepEqual(proof.attemptedKeys,[key,second]);return true;});
});
test('cancellation during native import stops further work and preserves unknown cache mutation status',async()=>{
 const m=fixture(),control={cancelled:false};m.figma.variables.importVariableByKeyAsync=async()=>{control.cancelled=true;return m.variable;};
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 await assert.rejects(new AsyncFunction('figma','executionControl',implementation.buildImportVariablesCode(m.input))(m.figma,control),e=>e.operationStatus==='partial'&&e.blockers[0].evidence.complete===false);
});
test('read timeout is bounded and remains partial after importing a resource',async()=>{
 const m=fixture();m.figma.variables.getVariableByIdAsync=()=>new Promise(()=>{});
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 await assert.rejects(new AsyncFunction('figma','setTimeout',implementation.buildImportVariablesCode(m.input))(m.figma,(fn)=>setTimeout(fn,1)),e=>e.operationStatus==='partial'&&e.code==='FIGMA_READ_TIMEOUT');
});
test('incomplete collection modes and metadata cannot be reported as complete evidence',async()=>{
 for(const mutate of [m=>m.collection.defaultModeId='missing',m=>m.collection.modes=[],m=>delete m.collection.name,m=>delete m.variable.name,m=>m.collection.modes.push({...m.collection.modes[0]})]){
  const m=fixture();mutate(m);await assert.rejects(run(m),e=>e.operationStatus==='partial');
 }
});
test('partial evidence survives the existing error wire fields',async()=>{
 const {errorDetails,remoteError}=await import('../src/bridge-errors.mjs');const {toolFailure}=await import('../src/tool-results.mjs');
 const m=fixture();m.variable.resolvedType='FLOAT';try{await run(m);assert.fail('must fail');}catch(error){const response=toolFailure(remoteError(error.message,JSON.parse(JSON.stringify(errorDetails(error)))));assert.equal(response.isError,true);assert.equal(response.structuredContent.operationStatus,'partial');assert.equal(response.structuredContent.blockers[0].evidence.complete,false);}
});
