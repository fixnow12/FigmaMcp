import test from 'node:test';
import assert from 'node:assert/strict';
import {createFigmaMock,executeGenerated} from './helpers/figma-mock.mjs';
const implementation=await import('../src/resolve-variables.mjs').catch(()=>({}));
const key='a'.repeat(40),second='b'.repeat(40),collectionKey='c'.repeat(40);
function fixture(){
 const m=createFigmaMock();m.figma.fileKey='working';let imports=0;
 const collection={id:'actual-collection',key:collectionKey,name:'Library',remote:true,modes:[{modeId:'default-id',name:'default'}],defaultModeId:'default-id'};
 const variable={id:'opaque-destination-id',key,name:'Token',resolvedType:'COLOR',remote:true,variableCollectionId:collection.id};
 m.figma.variables.importVariableByKeyAsync=async()=>{imports++;return variable;};
 m.figma.variables.getVariableByIdAsync=async()=>variable;
 m.figma.variables.getVariableCollectionByIdAsync=async()=>collection;
 return {...m,variable,collection,input:{fileKey:'working',variables:[{id:variable.id,key,resolvedType:'COLOR',collectionKey}]},imports:()=>imports};
}
const run=m=>executeGenerated(m.figma,implementation.buildResolveVariablesCode(m.input));
test('reads exact identities and full modes without any import or write',async()=>{
 const m=fixture(),result=await run(m);
 assert.equal(result.operationStatus,'read');assert.equal(result.complete,true);
 assert.deepEqual(result.variables[0],{...m.variable,collectionKey,collection:{...m.collection}});
 assert.equal(m.imports(),0);assert.equal(m.writes.length,0);
});
test('strict schema rejects missing id, duplicate IDs/keys and extra fields',()=>{
 const {input}=fixture();assert.equal(implementation.resolveVariablesSchema.safeParse(input).success,true);
 for(const candidate of [{...input,fileKey:undefined},{...input,variables:[]},{...input,extra:true},{...input,variables:[input.variables[0],input.variables[0]]},...['id','key','collectionKey','resolvedType'].map(field=>({...input,variables:[{...input.variables[0],[field]:''}]})),{...input,variables:[{...input.variables[0],extra:true}]}])assert.equal(implementation.resolveVariablesSchema.safeParse(candidate).success,false);
});
test('wrong file is rejected before any variable lookup',async()=>{
 const m=fixture();m.input.fileKey='foreign';m.figma.variables.getVariableByIdAsync=()=>assert.fail('must not read');
 await assert.rejects(run(m),/Неверный целевой файл/);assert.equal(m.imports(),0);
});
test('missing resources and mismatches remain explicit unresolved without import',async()=>{
 for(const kind of ['null','key','type','collectionKey','collectionId','id','collectionMissing','modes']){
  const m=fixture();if(kind==='null')m.figma.variables.getVariableByIdAsync=async()=>null;if(kind==='key')m.variable.key=second;if(kind==='type')m.variable.resolvedType='FLOAT';if(kind==='collectionKey')m.collection.key=second;if(kind==='collectionId')m.collection.id='wrong';if(kind==='id')m.variable.id='wrong';if(kind==='collectionMissing')m.figma.variables.getVariableCollectionByIdAsync=async()=>null;if(kind==='modes')m.collection.defaultModeId='missing';
  const result=await run(m);assert.equal(result.complete,false,kind);assert.equal(result.variables.length,0);assert.equal(result.unresolved.length,1);assert.equal(result.unresolved[0].id,m.input.variables[0].id);assert.equal(m.imports(),0);
 }
});
test('timeout is bounded and never reported as a missing resource',async()=>{
 const m=fixture();m.figma.variables.getVariableByIdAsync=()=>new Promise(()=>{});
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 await assert.rejects(new AsyncFunction('figma','setTimeout',implementation.buildResolveVariablesCode(m.input))(m.figma,(fn)=>setTimeout(fn,1)),e=>e.code==='FIGMA_READ_TIMEOUT');assert.equal(m.imports(),0);
});
test('collection timeout stays a read failure',async()=>{
 const m=fixture();m.figma.variables.getVariableCollectionByIdAsync=()=>new Promise(()=>{});
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 await assert.rejects(new AsyncFunction('figma','setTimeout',implementation.buildResolveVariablesCode(m.input))(m.figma,(fn)=>setTimeout(fn,1)),e=>e.code==='FIGMA_READ_TIMEOUT');assert.equal(m.imports(),0);
});
test('read cancellation stops immediately without writes',async()=>{
 const m=fixture(),control={cancelled:false};m.figma.variables.getVariableByIdAsync=async()=>{control.cancelled=true;return m.variable;};
 const AsyncFunction=Object.getPrototypeOf(async function(){}).constructor;
 await assert.rejects(new AsyncFunction('figma','executionControl',implementation.buildResolveVariablesCode(m.input))(m.figma,control));assert.equal(m.imports(),0);assert.equal(m.writes.length,0);
});
test('server registers resolver with strict schema and read-only execution',async()=>{
 const {readFile}=await import('node:fs/promises');const source=await readFile(new URL('../src/server.mjs',import.meta.url),'utf8');
 const block=source.slice(source.indexOf("registerGeneratedTool('resolve_variables'"),source.indexOf("registerGeneratedTool('import_variables'"));
 assert.match(block,/readOnlyHint:true/);assert.match(block,/resolveVariablesSchema, buildResolveVariablesCode, \{mutating:false\}/);
});
