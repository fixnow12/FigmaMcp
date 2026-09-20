import test from 'node:test';
import assert from 'node:assert/strict';
import {createFigmaMock,executeGenerated} from './helpers/figma-mock.mjs';
import {setNodeVariableModesSchema,buildSetNodeVariableModesCode} from '../src/node-variable-modes.mjs';
const collectionKey='a'.repeat(40),anchorVariableKey='b'.repeat(40);
function fixture(){
 const m=createFigmaMock(),collection={id:'size-id',key:collectionKey,name:'IO Size',modes:[{modeId:'base',name:'default'},{modeId:'small',name:'adaptive'}]};
 m.figma.fileKey='working';m.figma.skipInvisibleInstanceChildren=true;
 const nodes=[m.make('FRAME'),m.make('INSTANCE')];
 for(const n of nodes){n.explicitVariableModes={other:'other-mode'};n.setExplicitVariableModeForCollection=(c,id)=>{n.explicitVariableModes={...n.explicitVariableModes,[c.id]:id};};n.clearExplicitVariableModeForCollection=c=>{const copy={...n.explicitVariableModes};delete copy[c.id];n.explicitVariableModes=copy;};m.make('TEXT',{visible:false,fontName:{family:'Factor IO',style:'Regular'}},n);}
 m.figma.variables.importVariableByKeyAsync=async key=>({key,variableCollectionId:collection.id});m.figma.variables.getVariableCollectionByIdAsync=async id=>id===collection.id?collection:id==='other'?{id:'other',key:'c'.repeat(40),modes:[{modeId:'other-mode',name:'other'}]}:null;
 const input={fileKey:'working',bindings:nodes.map(n=>({nodeId:n.id,collectionKey,anchorVariableKey,modeName:'adaptive'}))};return {...m,collection,nodes,input};
}
test('node modes verify exact native targets, collection and mode; preserve libraries and return truthful no-ops',async()=>{
 const m=fixture(),before=JSON.stringify(m.collection);const result=await executeGenerated(m.figma,buildSetNodeVariableModesCode(setNodeVariableModesSchema.parse(m.input)));
 assert.equal(result.fileKey,'working');assert.equal(result.pageId,m.figma.currentPage.id);assert.equal(result.variableModesVerification.checks.length,2);
 for(const [i,check]of result.variableModesVerification.checks.entries()){assert.deepEqual(check,{id:m.nodes[i].id,collectionKey,modeName:'adaptive',collectionId:'size-id',modeId:'small',mutated:true});assert.deepEqual(m.nodes[i].explicitVariableModes,{other:'other-mode','size-id':'small'});}
 assert.ok(m.loadedFonts.some(f=>f.family==='Factor IO'));assert.equal(m.figma.skipInvisibleInstanceChildren,true);assert.equal(JSON.stringify(m.collection),before);
 for(const n of m.nodes)n.setExplicitVariableModeForCollection=()=>{throw Error('No-op setter called');};
 const second=await executeGenerated(m.figma,buildSetNodeVariableModesCode(m.input));assert.ok(second.variableModesVerification.checks.every(c=>c.mutated===false));
});
test('node mode preflight rejects wrong file, page, type, library identity, ambiguous mode and unavailable fonts before all writes',async()=>{
 for(const kind of ['file','page','type','component','anchor','collection','mode','ambiguous','font']){
  const m=fixture(),before=m.nodes.map(n=>structuredClone(n.explicitVariableModes));
  if(kind==='file')m.input.fileKey='other';if(kind==='page')m.make('PAGE',{},null).appendChild(m.nodes[1]);if(kind==='type')m.nodes[1].type='TEXT';if(kind==='component')m.make('COMPONENT').appendChild(m.nodes[1]);
  if(kind==='anchor')m.figma.variables.importVariableByKeyAsync=async()=>({key:'wrong',variableCollectionId:'size-id'});if(kind==='collection')m.collection.key='wrong';if(kind==='mode')m.input.bindings[1].modeName='missing';if(kind==='ambiguous')m.collection.modes.push({name:'adaptive',modeId:'duplicate'});if(kind==='font')m.nodes[1].children[0].fontName={family:'Missing',style:'Regular'};
  await assert.rejects(executeGenerated(m.figma,buildSetNodeVariableModesCode(m.input)),e=>e.operationStatus==='not_applied',kind);assert.deepEqual(m.nodes.map(n=>n.explicitVariableModes),before,kind);
 }
});
test('later mode failure restores prior explicit and inherited modes, including a setter that writes then throws',async()=>{
 for(const before of [undefined,'base']){const m=fixture();if(before)m.nodes[0].explicitVariableModes['size-id']=before;const snapshots=m.nodes.map(n=>structuredClone(n.explicitVariableModes));
 const setter=m.nodes[1].setExplicitVariableModeForCollection;m.nodes[1].setExplicitVariableModeForCollection=(c,id)=>{setter(c,id);if(id==='small')throw Error('later failure');};
 await assert.rejects(executeGenerated(m.figma,buildSetNodeVariableModesCode(m.input)),e=>e.operationStatus==='rolled_back');assert.deepEqual(m.nodes.map(n=>n.explicitVariableModes),snapshots);}
});
test('rollback preserves foreign mode changes and reports partial instead of claiming recovery',async()=>{
 const m=fixture();m.nodes[1].setExplicitVariableModeForCollection=()=>{m.nodes[0].explicitVariableModes['size-id']='foreign';throw Error('failure');};
 await assert.rejects(executeGenerated(m.figma,buildSetNodeVariableModesCode(m.input)),e=>e.operationStatus==='partial'&&e.rollbackErrors.length===1);assert.equal(m.nodes[0].explicitVariableModes['size-id'],'foreign');
});
test('mode schema is strict, finite and rejects duplicate node/collection pairs',()=>{
 const {input}=fixture();assert.equal(setNodeVariableModesSchema.safeParse(input).success,true);
 for(const value of [{...input,fileKey:undefined},{...input,allowComponentChanges:true},{...input,bindings:[]},{...input,bindings:Array(41).fill(input.bindings[0])},{...input,bindings:[input.bindings[0],input.bindings[0]]},{...input,bindings:[{...input.bindings[0],collectionKey:'wrong'}]},{...input,bindings:[{...input.bindings[0],extra:true}]}])assert.equal(setNodeVariableModesSchema.safeParse(value).success,false);
});

test('font traversal never reads absent children on native TEXT proxies',async()=>{
 const m=fixture();for(const node of m.nodes)node.children=node.children.map(child=>new Proxy(child,{get(target,field,receiver){if(field==='children'&&!(field in target))throw Error('Property children does not exist');return Reflect.get(target,field,receiver);}}));
 const result=await executeGenerated(m.figma,buildSetNodeVariableModesCode(m.input));assert.equal(result.variableModesVerification.checks.length,2);
});

function lazyFixture(){
 const m=fixture(),actual={...structuredClone(m.collection),id:'source-size-id',modes:[...m.collection.modes].reverse()};
 const other={id:'other',key:'c'.repeat(40),modes:[{modeId:'other-mode',name:'other'}]};
 m.figma.variables.getVariableCollectionByIdAsync=async id=>id===m.collection.id?m.collection:id===actual.id?actual:id===other.id?other:null;
 for(const n of m.nodes){n.setExplicitVariableModeForCollection=(c,id)=>{const modes={...n.explicitVariableModes};delete modes[m.collection.id];delete modes[actual.id];n.explicitVariableModes={...modes,[actual.id]:id};};n.clearExplicitVariableModeForCollection=()=>{const modes={...n.explicitVariableModes};delete modes[m.collection.id];delete modes[actual.id];n.explicitVariableModes=modes;};}
 return {...m,actual};
}
test('lazy collection IDs are resolved by exact resource key and unique mode name, including truthful no-op',async()=>{
 const m=lazyFixture(),result=await executeGenerated(m.figma,buildSetNodeVariableModesCode(m.input));
 assert.ok(result.variableModesVerification.checks.every(c=>c.collectionId===m.actual.id&&c.modeId==='small'&&c.modeName==='adaptive'));
 for(const n of m.nodes)n.setExplicitVariableModeForCollection=()=>{throw Error('No-op setter called');};
 assert.ok((await executeGenerated(m.figma,buildSetNodeVariableModesCode(m.input))).variableModesVerification.checks.every(c=>!c.mutated));
});
test('lazy-ID batch rollback clears inherited modes and restores the exact previous actual collection identity',async()=>{
 for(const previous of [undefined,'base']){
  const m=lazyFixture();if(previous)m.nodes[0].explicitVariableModes[m.actual.id]=previous;const before=m.nodes.map(n=>structuredClone(n.explicitVariableModes));
  const setter=m.nodes[1].setExplicitVariableModeForCollection;m.nodes[1].setExplicitVariableModeForCollection=(c,id)=>{setter(c,id);throw Error('later setter failed');};
  await assert.rejects(executeGenerated(m.figma,buildSetNodeVariableModesCode(m.input)),e=>e.operationStatus==='rolled_back');assert.deepEqual(m.nodes.map(n=>n.explicitVariableModes),before);
 }
});
test('lazy-ID proof rejects unresolved, ambiguous and wrong actual collection identities; CAS protects foreign modes',async()=>{
 for(const kind of ['unresolved','duplicate','ambiguous','foreign']){
  const m=lazyFixture();m.nodes[0].explicitVariableModes[m.actual.id]='base';const before=structuredClone(m.nodes[0].explicitVariableModes);
  if(kind==='unresolved')m.figma.variables.getVariableCollectionByIdAsync=async id=>id===m.collection.id?m.collection:null;
  if(kind==='duplicate')m.nodes[0].explicitVariableModes[m.collection.id]='base';
  if(kind==='ambiguous')m.actual.modes.push({modeId:'different',name:'default'});
  if(kind==='foreign')m.nodes[1].setExplicitVariableModeForCollection=()=>{m.nodes[0].explicitVariableModes[m.actual.id]='foreign';throw Error('later failure');};
  await assert.rejects(executeGenerated(m.figma,buildSetNodeVariableModesCode(m.input)),e=>e.operationStatus===(kind==='foreign'?'partial':'not_applied'),kind);
  if(kind==='foreign')assert.equal(m.nodes[0].explicitVariableModes[m.actual.id],'foreign');else if(kind!=='duplicate')assert.deepEqual(m.nodes[0].explicitVariableModes,before);
 }
});

test('lazy-ID rollback refuses a foreign full-map change after the captured synchronous write',async()=>{
 const m=lazyFixture();m.nodes[1].setExplicitVariableModeForCollection=()=>{m.nodes[0].explicitVariableModes.other='foreign-other-mode';throw Error('later failure');};
 await assert.rejects(executeGenerated(m.figma,buildSetNodeVariableModesCode(m.input)),e=>e.operationStatus==='partial');
 assert.equal(m.nodes[0].explicitVariableModes[m.actual.id],'small');assert.equal(m.nodes[0].explicitVariableModes.other,'foreign-other-mode');
});
test('lazy-ID async lookup detects map changes and refuses stale success',async()=>{
 const m=lazyFixture(),lookup=m.figma.variables.getVariableCollectionByIdAsync;let changed=false;
 m.figma.variables.getVariableCollectionByIdAsync=async id=>{const c=await lookup(id);if(!changed&&m.nodes[0].explicitVariableModes[m.actual.id]==='small'){changed=true;m.nodes[0].explicitVariableModes[m.actual.id]='base';}return c;};
 await assert.rejects(executeGenerated(m.figma,buildSetNodeVariableModesCode(m.input)),e=>e.operationStatus==='partial');assert.equal(m.nodes[0].explicitVariableModes[m.actual.id],'base');
});

test('final mode batch verification rejects earlier targets changed during a later async read',async()=>{
 const m=lazyFixture(),lookup=m.figma.variables.getVariableCollectionByIdAsync;let reads=0;
 m.figma.variables.getVariableCollectionByIdAsync=async id=>{const collection=await lookup(id);if(id===m.actual.id&&++reads===4)m.nodes[0].explicitVariableModes[m.collection.id]='small';return collection;};
 await assert.rejects(executeGenerated(m.figma,buildSetNodeVariableModesCode(m.input)),e=>e.operationStatus==='partial');
 assert.equal(m.nodes[0].explicitVariableModes[m.collection.id],'small');assert.equal(m.nodes[0].explicitVariableModes[m.actual.id],'small');
});

test('mode writes recheck later targets after async verification without overwriting foreign changes',async()=>{
 const m=lazyFixture(),lookup=m.figma.variables.getVariableCollectionByIdAsync;let changed=false;
 m.figma.variables.getVariableCollectionByIdAsync=async id=>{const collection=await lookup(id);if(id===m.actual.id&&!changed){changed=true;m.nodes[1].explicitVariableModes[m.actual.id]='base';}return collection;};
 await assert.rejects(executeGenerated(m.figma,buildSetNodeVariableModesCode(m.input)),e=>e.operationStatus==='rolled_back');
 assert.equal(m.nodes[1].explicitVariableModes[m.actual.id],'base');assert.equal(m.nodes[0].explicitVariableModes[m.actual.id],undefined);
});
test('successive collection writes on one node retain the expected state from preceding own writes',async()=>{
 const m=fixture(),n=m.nodes[0],other={id:'other',key:'c'.repeat(40),modes:[{modeId:'other-mode',name:'default'},{modeId:'other-small',name:'adaptive'}]};
 m.figma.variables.importVariableByKeyAsync=async key=>({key,variableCollectionId:key===anchorVariableKey?m.collection.id:other.id});
 m.figma.variables.getVariableCollectionByIdAsync=async id=>id===m.collection.id?m.collection:id===other.id?other:null;
 m.input.bindings=[m.input.bindings[0],{nodeId:n.id,collectionKey:other.key,anchorVariableKey:'d'.repeat(40),modeName:'adaptive'}];
 const result=await executeGenerated(m.figma,buildSetNodeVariableModesCode(m.input));assert.equal(result.variableModesVerification.checks.length,2);assert.deepEqual(n.explicitVariableModes,{other:'other-small','size-id':'small'});
});
