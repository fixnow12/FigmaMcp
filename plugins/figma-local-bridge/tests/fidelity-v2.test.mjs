import test from 'node:test';
import assert from 'node:assert/strict';
import { createFigmaMock, executeGenerated } from './helpers/figma-mock.mjs';
import { buildPatchCode, buildInspectCode, buildRenderCode } from '../src/figma-code.mjs';
import { patchNodesSchema, parseRenderScreenInput, normalizeScreenSpec } from '../src/schemas.mjs';
import { bindVariablesSchema } from '../src/operation-schemas.mjs';
import { buildBindVariablesCode } from '../src/variable-bindings.mjs';
import { runtimeDiagnostics, runtimeInfo, pluginRevision } from '../src/runtime-info.mjs';
const patch = (m, patches) => executeGenerated(m.figma, buildPatchCode(patchNodesSchema.parse({ patches })));
const bind = (m, bindings) => executeGenerated(m.figma, buildBindVariablesCode(bindVariablesSchema.parse({ bindings })));
const glass = { type:'GLASS', visible:true, radius:20, refraction:0.24, depth:2, lightAngle:-45, lightIntensity:0.8, dispersion:0, splay:0 };
function rich(m) {
  const n=m.make('TEXT'); const values=Array.from({length:4},()=>({fontName:{family:'Inter',style:'Regular'}, fontSize:14, fontWeight:400, fills:[{type:'SOLID',color:{r:1,g:0,b:0}}],lineHeight:{unit:'AUTO'},boundVariables:{}}));
  n.characters='abcd';
  for(const field of ['fontName','fontSize','fontWeight','fills','lineHeight']) {
    const read=(s,e)=>{ const vals=values.slice(s,e).map(v=>v[field]); return vals.every(v=>JSON.stringify(v)===JSON.stringify(vals[0]))?structuredClone(vals[0]):m.figma.mixed; };
    Object.defineProperty(n,field,{configurable:true,get:()=>read(0,4),set:v=>values.forEach(x=>x[field]=structuredClone(v))});
    n['getRange'+field[0].toUpperCase()+field.slice(1)]=read;
    n['setRange'+field[0].toUpperCase()+field.slice(1)]=(s,e,v)=>values.slice(s,e).forEach(x=>x[field]=structuredClone(v));
  }
  n.getStyledTextSegments=(fields,s=0,e=4)=>values.slice(s,e).map((v,i)=>({start:s+i,end:s+i+1,characters:n.characters[s+i],...Object.fromEntries(fields.map(f=>[f,structuredClone(v[f]??n[f])]))}));
  n.getRangeBoundVariable=(s,e,f)=>values[s].boundVariables[f]||null;
  n.setRangeBoundVariable=(s,e,f,v)=>values.slice(s,e).forEach(x=>{if(v){x.boundVariables[f]={type:'VARIABLE_ALIAS',id:v.id}; if(f==='fontFamily')x.fontName.family=v.resolveForConsumer(n).value; else if(f==='fontWeight')x.fontName.style=v.resolveForConsumer(n).value===700?'Bold':'Regular'; else x[f]=v.resolveForConsumer(n).value;}else delete x.boundVariables[f];});
  return {n,values};
}
test('v2 schema accepts GLASS, list runs and vector patch properties, rejects malformed fields',()=>{
  assert.equal(patchNodesSchema.safeParse({patches:[{id:'a',set:{effects:[glass],vectorPaths:[{windingRule:'NONZERO',data:'M0 0L1 1Z'}],booleanOperation:'UNION',pointCount:3}}]}).success,true);
  assert.equal(parseRenderScreenInput({spec:{type:'screen',key:'a',name:'a',width:100,height:100,nodes:[{type:'text',key:'t',name:'t',content:'a',listOptions:{type:'ORDERED'},listSpacing:8,indentation:1,textRuns:[{start:0,end:1,listOptions:{type:'UNORDERED'},indentation:2}]}]}}).spec.nodes[0].indentation,1);
  for(const effect of [{...glass,depth:0},{...glass,refraction:2},{...glass,mystery:1},{type:'LAYER_BLUR',radius:2,splay:0}]) assert.equal(patchNodesSchema.safeParse({patches:[{id:'a',set:{effects:[effect]}}]}).success,false);
});
test('v2 vector properties are type checked before first write, read back and rollback',async()=>{
 const m=createFigmaMock(); const a=m.make('VECTOR',{vectorPaths:[],effects:[]}); const b=m.make('BOOLEAN_OPERATION',{booleanOperation:'UNION'});
 await patch(m,[{id:a.id,set:{vectorPaths:[{windingRule:'NONZERO',data:'M0 0L1 1Z'}],effects:[glass]}},{id:b.id,set:{booleanOperation:'SUBTRACT'}}]);
 const out=await executeGenerated(m.figma,buildInspectCode({nodeIds:[a.id,b.id],depth:1,maxNodes:10,detail:'full'}));
 assert.deepEqual(out.selection[0].effects,[glass]); assert.equal(out.selection[1].booleanOperation,'SUBTRACT');
 const before=structuredClone(a.vectorPaths); m.writes.length=0;
 await assert.rejects(patch(m,[{id:a.id,set:{name:'changed'}},{id:b.id,set:{vectorPaths:before}}]),e=>e.operationStatus==='not_applied');assert.equal(m.writes.length,0);
 const instance=m.make('INSTANCE');const nested=m.make('VECTOR',{vectorPaths:before},instance);
 await patch(m,[{id:nested.id,set:{vectorPaths:before}}]);
 await assert.rejects(patch(m,[{id:nested.id,set:{vectorPaths:[{windingRule:'NONE',data:'M0 0L9 9'}]}}]),/экземпляр/);
 m.rejectWrites((n,f,v)=>n.id===b.id&&f==='booleanOperation'&&v==='INTERSECT');
 await assert.rejects(patch(m,[{id:a.id,set:{vectorPaths:[{windingRule:'NONE',data:'M0 0L8 8'}]}},{id:b.id,set:{booleanOperation:'INTERSECT'}}]),e=>e.operationStatus==='rolled_back');assert.deepEqual(a.vectorPaths,before);
});
test('v2 range variable schema validates paired boundaries and overlaps',()=>{
 const item={nodeId:'a',field:'fontFamily',variableId:'v',start:0,end:2};assert.equal(bindVariablesSchema.safeParse({bindings:[item]}).success,true);
 for(const items of [[{...item,end:undefined}],[{...item,field:'opacity'}],[item,{...item,start:1,end:3}]])assert.equal(bindVariablesSchema.safeParse({bindings:items}).success,false);
 assert.equal(bindVariablesSchema.safeParse({bindings:[item,{...item,start:2,end:4}]}).success,true);
});
test('v2 binds mixed ranges, loads target font and preserves surrounding fill',async()=>{
 const m=createFigmaMock();const {n,values}=rich(m); values[2].fontSize=20;
 m.addVariable({id:'size',value:32});m.addVariable({id:'family',type:'STRING',value:'Factor IO'});m.addVariable({id:'color',type:'COLOR',value:{r:0,g:1,b:0}});
 const result=await bind(m,[{nodeId:n.id,field:'fontSize',variableId:'size',start:0,end:2},{nodeId:n.id,field:'fontFamily',variableId:'family',start:0,end:2},{nodeId:n.id,field:'fills',variableId:'color',start:0,end:2}]);
 assert.equal(values[0].fontSize,32);assert.equal(values[2].fontSize,20);assert.equal(values[0].fontName.family,'Factor IO');assert.equal(values[0].fills[0].boundVariables.color.id,'color');assert.equal(values[2].fills[0].boundVariables,undefined);assert.ok(m.loadedFonts.some(f=>f.family==='Factor IO'));assert.equal(result.bindings[0].start,0);assert.equal(result.bindings[0].end,2);assert.ok(result.bindings[0].actual);
});
test('v2 range preflight rejects missing variable and UTF16 split without writes',async()=>{
 const m=createFigmaMock();const {n}=rich(m); m.addVariable({id:'size',value:32});m.writes.length=0;
 await assert.rejects(bind(m,[{nodeId:n.id,field:'fontSize',variableId:'size',start:0,end:2},{nodeId:n.id,field:'fontSize',variableId:'missing',start:2,end:4}]),e=>e.operationStatus==='not_applied');assert.equal(m.writes.length,0);
 n.characters='😀ab';await assert.rejects(bind(m,[{nodeId:n.id,field:'fontSize',variableId:'size',start:1,end:3}]),/UTF-16/);
});
test('v2 range rollback removes new bindings and restores mixed runs after later setter fails',async()=>{
 const m=createFigmaMock();const {n,values}=rich(m);values[2].fontSize=20;const before=structuredClone(values);m.addVariable({id:'size',value:32});m.addVariable({id:'opacity',value:0.5});const bad=m.make('FRAME');m.rejectWrites((n,f,v)=>n.id===bad.id&&f==='opacity'&&v===0.5);
 await assert.rejects(bind(m,[{nodeId:n.id,field:'fontSize',variableId:'size',start:0,end:2},{nodeId:bad.id,field:'opacity',variableId:'opacity'}]),e=>e.operationStatus==='rolled_back');assert.deepEqual(values,before);
});
test('v2 capabilities require explicit target and responsive matching runtime',()=>{
 const status={connected:true,runtime:runtimeInfo,files:[{fileKey:'target',pluginBuild:pluginRevision()}],execution:[{fileKey:'target',responsive:true,busy:false}]};
 assert.ok(runtimeDiagnostics(status,{fileKey:'target'}).capabilities.includes('text-range-variables-v1'));
 for(const [s,options] of [[status,{}],[{...status,execution:[]},{fileKey:'target'}],[{...status,execution:[{fileKey:'target',responsive:false}]},{fileKey:'target'}],[status,{fileKey:'absent'}]])assert.deepEqual(runtimeDiagnostics(s,options).capabilities,[]);
});

test('v2 render schema supports native polygon, star and booleanOperation without coercing shapes',()=>{
 const spec={type:'screen',key:'a',name:'a',width:100,height:100,nodes:[{type:'polygon',key:'p',name:'p',pointCount:3},{type:'star',key:'s',name:'s',pointCount:5},{type:'booleanOperation',key:'b',name:'b',booleanOperation:'SUBTRACT'},{type:'rectangle',key:'r1',name:'r1',parentKey:'b'},{type:'ellipse',key:'r2',name:'r2',parentKey:'b'}]};
 assert.equal(parseRenderScreenInput({spec}).spec.nodes[0].pointCount,3);
 assert.throws(()=>parseRenderScreenInput({spec:{...spec,nodes:[{type:'rectangle',key:'r',name:'r',pointCount:3}]}}));
});
test('v2 patch validates all append text ranges before modifying the first target',async()=>{
 const m=createFigmaMock(),a=m.make('FRAME'),b=m.make('FRAME');m.writes.length=0;
 await assert.rejects(patch(m,[{id:a.id,set:{name:'changed'}},{id:b.id,append:[{key:'t',type:'text',name:'t',content:'ab',textRuns:[{start:0,end:9,fontSize:30}]}]}]),e=>e.operationStatus==='not_applied');assert.equal(m.writes.length,0);
});
test('v2 fonts for a later patch are checked before changing an earlier node',async()=>{
 const m=createFigmaMock(),a=m.make('FRAME'),b=m.make('TEXT');m.writes.length=0;
 await assert.rejects(patch(m,[{id:a.id,set:{name:'changed'}},{id:b.id,set:{fontFamily:'Missing'}}]),e=>e.operationStatus==='not_applied');assert.equal(m.writes.length,0);
});

test('v2 vector rollback restores dimensions changed by the native path setter',async()=>{
 const m=createFigmaMock();const n=m.make('VECTOR');let paths=[{windingRule:'NONE',data:'M0 0L1 1'}];
 Object.defineProperty(n,'vectorPaths',{get:()=>paths,set:value=>{paths=value;n.width=300;}});const bad=m.make('FRAME');m.rejectWrites((n,f,v)=>n.id===bad.id&&f==='name'&&v==='bad');
 await assert.rejects(patch(m,[{id:n.id,set:{vectorPaths:[{windingRule:'NONE',data:'M0 0L2 2'}]}},{id:bad.id,set:{name:'bad'}}]),e=>e.operationStatus==='rolled_back');assert.equal(n.width,100);
});

test('v2 patch applies native geometry before requested dimensions',async()=>{
 const m=createFigmaMock();const n=m.make('VECTOR');let paths=[];Object.defineProperty(n,'vectorPaths',{get:()=>paths,set:value=>{paths=value;n.width=300;}});
 await patch(m,[{id:n.id,set:{width:40,vectorPaths:[{windingRule:'NONE',data:'M0 0L2 2'}]}}]);assert.equal(n.width,40);
});

test('v2 exact native instance stroke geometry allows zero vector height and refuses zero frame',async()=>{
 const m=createFigmaMock(),instance=m.make('INSTANCE'),vector=m.make('VECTOR',{height:0,strokeCap:'NONE',strokeJoin:'MITER'},instance);
 await patch(m,[{id:vector.id,set:{height:0,strokeCap:'NONE',strokeJoin:'MITER'}}]);assert.equal(vector.height,0);
 await assert.rejects(patch(m,[{id:vector.id,set:{strokeCap:'ROUND'}}]),/экземпляр/);
 const frame=m.make('FRAME');m.writes.length=0;await assert.rejects(patch(m,[{id:frame.id,set:{height:0}}]),e=>e.operationStatus==='not_applied');assert.equal(m.writes.length,0);
 assert.equal(parseRenderScreenInput({spec:{type:'screen',key:'s',name:'s',width:100,height:100,nodes:[{type:'vector',key:'v',name:'v',height:0,vectorPaths:[{windingRule:'NONE',data:'M0 0L2 0'}]}]}}).spec.nodes[0].height,0);
});

test('v2 render keeps boolean operands and creates native point-count nodes',async()=>{
 const m=createFigmaMock();m.figma.createPolygon=()=>m.make('POLYGON',{pointCount:5});m.figma.createStar=()=>m.make('STAR',{pointCount:5});m.figma.createBooleanOperation=()=>m.make('FRAME',{type:'BOOLEAN_OPERATION',booleanOperation:'UNION',layoutMode:'NONE'});
 const parsed=parseRenderScreenInput({spec:{type:'screen',key:'s',name:'s',width:100,height:100,nodes:[{type:'polygon',key:'p',name:'p',pointCount:3},{type:'star',key:'star',name:'star',pointCount:7},{type:'booleanOperation',key:'b',name:'b',booleanOperation:'SUBTRACT'},{type:'rectangle',key:'r1',name:'r1',parentKey:'b'},{type:'ellipse',key:'r2',name:'r2',parentKey:'b'}]}});
 const result=await executeGenerated(m.figma,buildRenderCode({...parsed,spec:normalizeScreenSpec(parsed.spec)}));const root=m.nodes.get(result.rootId);assert.equal(root.children[0].type,'POLYGON');assert.equal(root.children[0].pointCount,3);assert.equal(root.children[1].pointCount,7);assert.equal(root.children[2].booleanOperation,'SUBTRACT');assert.deepEqual(root.children[2].children.map(n=>n.type),['RECTANGLE','ELLIPSE']);
});

test('v2 captured NONE layout defaults are accepted as native no-op, changed values fail preflight',async()=>{
 const layout={direction:'none',gap:0,padding:{top:0,right:0,bottom:0,left:0},primaryAlign:'start',counterAlign:'start',wrap:false,counterAxisSpacing:0,strokesIncludedInLayout:false,itemReverseZIndex:false};
 const m=createFigmaMock(),n=m.make('INSTANCE',{layoutMode:'NONE',counterAxisSpacing:0,strokesIncludedInLayout:false,itemReverseZIndex:false});
 await patch(m,[{id:n.id,set:{layout}}]);assert.equal(n.layoutMode,'NONE');assert.equal(n.itemSpacing,0);
 for(const changed of [{wrap:true},{counterAxisSpacing:8},{strokesIncludedInLayout:true},{itemReverseZIndex:true}]){
  m.writes.length=0;await assert.rejects(patch(m,[{id:n.id,set:{name:'must not change'}},{id:n.id,set:{layout:{...layout,...changed}}}]),e=>e.operationStatus==='not_applied');assert.equal(m.writes.length,0);
 }
});

test('v2 rollback leaves equal structural instance fields untouched after a later failure',async()=>{
 const m=createFigmaMock(),instance=m.make('INSTANCE'),vector=m.make('VECTOR',{vectorPaths:[{windingRule:'NONE',data:'M0 0L2 0'}],strokeCap:'NONE',strokeJoin:'MITER'},instance),bad=m.make('FRAME');
 m.rejectWrites((n,f,v)=>n.id===vector.id&&['vectorPaths','strokeCap','strokeJoin'].includes(f)||n.id===bad.id&&f==='name'&&v==='bad');
 await assert.rejects(patch(m,[{id:vector.id,set:{vectorPaths:vector.vectorPaths,strokeCap:'NONE',strokeJoin:'MITER'}},{id:bad.id,set:{name:'bad'}}]),e=>e.operationStatus==='rolled_back'&&e.rollbackErrors.length===0);
 assert.equal(vector.parent,instance);assert.equal(vector.vectorPaths[0].data,'M0 0L2 0');
});

test('v2 rollback skips unchanged inactive layout properties after another patch fails',async()=>{
 const m=createFigmaMock(),n=m.make('INSTANCE',{layoutMode:'NONE',counterAxisSpacing:0,strokesIncludedInLayout:false,itemReverseZIndex:false}),bad=m.make('FRAME');
 m.rejectWrites((node,field,value)=>node.id===n.id&&field==='strokesIncludedInLayout'||node.id===bad.id&&field==='name'&&value==='bad');
 await assert.rejects(patch(m,[{id:n.id,set:{layout:{direction:'none',strokesIncludedInLayout:false}}},{id:bad.id,set:{name:'bad'}}]),e=>e.operationStatus==='rolled_back'&&e.rollbackErrors.length===0);assert.equal(n.layoutMode,'NONE');
});

const instanceImmutableValues = {isMask:false,maskType:'ALPHA',x:0,y:0,rotation:0,layoutPositioning:'AUTO',constraints:{horizontal:'SCALE',vertical:'SCALE'}};
function readonlyInstanceFixture() {
 const m=createFigmaMock(),instance=m.make('INSTANCE',{layoutMode:'NONE'}),node=m.make('VECTOR',structuredClone(instanceImmutableValues),instance);
 m.rejectWrites((n,f)=>n.id===node.id&&(Object.keys(instanceImmutableValues).includes(f)||['width','height','layoutSizingHorizontal','layoutSizingVertical'].includes(f)));
 return {m,instance,node};
}
test('v2 inherited instance geometry and mask properties are true no-ops including dimensions',async()=>{
 const {m,node}=readonlyInstanceFixture();await patch(m,[{id:node.id,set:{...structuredClone(instanceImmutableValues),width:node.width,height:node.height}}]);
 assert.deepEqual(node.constraints,instanceImmutableValues.constraints);assert.equal(node.isMask,false);
});
test('v2 differing inherited instance properties block the whole package before mutation',async()=>{
 for(const change of [{isMask:true},{maskType:'VECTOR'},{x:1},{y:1},{rotation:1},{layoutPositioning:'ABSOLUTE'},{constraints:{horizontal:'MIN',vertical:'SCALE'}}]){
  const {m,node}=readonlyInstanceFixture();const other=m.make('FRAME');m.writes.length=0;
  await assert.rejects(patch(m,[{id:other.id,set:{name:'must not change'}},{id:node.id,set:change}]),e=>e.operationStatus==='not_applied'&&/экземпляр/.test(e.message));assert.equal(m.writes.length,0);
 }
});
test('v2 rollback after a later failure preserves all inherited instance fields without forbidden setters',async()=>{
 const {m,node,instance}=readonlyInstanceFixture();const bad=m.make('FRAME');m.rejectWrites((n,f,v)=>n.id===node.id&&(Object.keys(instanceImmutableValues).includes(f)||['width','height','layoutSizingHorizontal','layoutSizingVertical'].includes(f))||n.id===bad.id&&f==='name'&&v==='bad');
 await assert.rejects(patch(m,[{id:node.id,set:{...structuredClone(instanceImmutableValues),width:node.width,height:node.height}},{id:bad.id,set:{name:'bad'}}]),e=>e.operationStatus==='rolled_back'&&e.rollbackErrors.length===0);assert.equal(node.parent,instance);
});

test('v2 exact no-op equality ignores object key order without dropping keys',async()=>{
 const {m,node}=readonlyInstanceFixture();Object.defineProperty(node,'constraints',{configurable:true,get:()=>({vertical:'SCALE',horizontal:'SCALE'}),set:()=>{throw Error('readonly constraints');}});
 await patch(m,[{id:node.id,set:{constraints:{horizontal:'SCALE',vertical:'SCALE'}}}]);
 assert.deepEqual(node.constraints,{horizontal:'SCALE',vertical:'SCALE'});
});

function scaledInstanceFixture(m, parent=m.page) {
 const calls=[];const n=m.make('INSTANCE',{scaleFactor:1,width:100,height:40,layoutMode:'NONE'},parent);
 const child=m.make('RECTANGLE',{x:-2,width:104,height:1,strokeWeight:1},n);
 n.rescale=function(ratio){assert.ok(ratio>=0.01,'native ratio floor');calls.push(['scale',ratio]);this.scaleFactor*=ratio;this.width*=ratio;this.height*=ratio;for(const c of this.findAll()){c.x*=ratio;c.y*=ratio;c.width*=ratio;c.height*=ratio;c.strokeWeight*=ratio;if(c.type==='TEXT')c.fontSize*=ratio;}};
 n.resize=function(w,h){calls.push(['resize',w,h]);this.width=w;this.height=h;};
 return {n,child,calls};
}
test('v2 native instance scaling precedes sizing and full inspection reports source factor',async()=>{
 const m=createFigmaMock(),{n,child,calls}=scaledInstanceFixture(m);await patch(m,[{id:n.id,set:{scaleFactor:1.25,width:371,height:36}}]);
 assert.deepEqual(calls[0],['scale',1.25]);assert.equal(n.scaleFactor,1.25);assert.equal(n.width,371);assert.equal(n.height,36);assert.equal(child.x,-2.5);assert.equal(child.height,1.25);
 const read=await executeGenerated(m.figma,buildInspectCode({nodeId:n.id,depth:2,maxNodes:10,detail:'full'}));assert.equal(read.selection[0].scaleFactor,1.25);
});
test('v2 scale schema and preflight reject invalid type, nested change and unsafe native ratios',async()=>{
 for(const value of [0,-1,Infinity,NaN])assert.equal(patchNodesSchema.safeParse({patches:[{id:'a',set:{scaleFactor:value}}]}).success,false);
 const m=createFigmaMock(),frame=m.make('FRAME'),outer=m.make('INSTANCE'),{n}=scaledInstanceFixture(m,outer);m.writes.length=0;
 for(const [node,scaleFactor] of [[frame,2],[n,2]])await assert.rejects(patch(m,[{id:node.id,set:{scaleFactor}}]),e=>e.operationStatus==='not_applied');assert.equal(m.writes.length,0);
 await patch(m,[{id:n.id,set:{scaleFactor:1}}]);
 const root=scaledInstanceFixture(m).n;for(const scaleFactor of [0.001,1000])await assert.rejects(patch(m,[{id:root.id,set:{scaleFactor}}]),e=>e.operationStatus==='not_applied');
});
test('v2 scaling preloads all descendant fonts including hidden text before any writes',async()=>{
 const m=createFigmaMock(),{n}=scaledInstanceFixture(m),early=m.make('FRAME');m.make('TEXT',{visible:false,fontName:{family:'Missing',style:'Regular'}},n);m.figma.skipInvisibleInstanceChildren=true;m.writes.length=0;
 await assert.rejects(patch(m,[{id:early.id,set:{name:'must not change'}},{id:n.id,set:{scaleFactor:1.25}}]),e=>e.operationStatus==='not_applied');assert.equal(m.writes.length,0);assert.equal(m.figma.skipInvisibleInstanceChildren,true);
});
test('v2 scale rollback restores original scale and dimensions after a later patch failure',async()=>{
 const m=createFigmaMock(),{n,child}=scaledInstanceFixture(m),bad=m.make('FRAME'),text=m.make('TEXT',{fontSize:16},n);m.rejectWrites((node,field,value)=>node.id===bad.id&&field==='name'&&value==='bad');
 await assert.rejects(patch(m,[{id:n.id,set:{scaleFactor:1.25,width:371,height:36}},{id:bad.id,set:{name:'bad'}}]),e=>e.operationStatus==='rolled_back');assert.equal(n.scaleFactor,1);assert.equal(n.width,100);assert.equal(n.height,40);assert.equal(child.x,-2);assert.equal(child.height,1);assert.equal(text.fontSize,16);assert.ok(m.loadedFonts.some(font=>font.family==='Inter'));
});
test('v2 scale package rejects overlapping descendant patches before mutation',async()=>{
 const m=createFigmaMock(),{n,child}=scaledInstanceFixture(m);m.writes.length=0;
 await assert.rejects(patch(m,[{id:n.id,set:{scaleFactor:1.25}},{id:child.id,set:{opacity:0.5}}]),e=>e.operationStatus==='not_applied');assert.equal(m.writes.length,0);
});
test('v2 inherited min/max meaningful changes fail during preflight',async()=>{
 const m=createFigmaMock(),instance=m.make('INSTANCE'),n=m.make('VECTOR',{minWidth:null,maxWidth:null,minHeight:null,maxHeight:null},instance);m.writes.length=0;
 for(const field of ['minWidth','maxWidth','minHeight','maxHeight'])await assert.rejects(patch(m,[{id:n.id,set:{[field]:8}}]),e=>e.operationStatus==='not_applied');assert.equal(m.writes.length,0);
});


test('v2 native scale failure after mutation restores original subtree scale',async()=>{
 const m=createFigmaMock(),{n,child}=scaledInstanceFixture(m);const rescale=n.rescale;let fail=true;
 n.rescale=function(ratio){rescale.call(this,ratio);if(fail){fail=false;throw Error('native failure after scaling');}};
 await assert.rejects(patch(m,[{id:n.id,set:{scaleFactor:1.0373859405517578,width:371.0000305175781,height:36}}]),e=>e.operationStatus==='rolled_back'&&e.rollbackErrors.length===0);
 assert.equal(n.scaleFactor,1);assert.equal(n.width,100);assert.equal(n.height,40);assert.equal(child.x,-2);assert.equal(child.height,1);
});
test('v2 inherited nullable min/max exact no-op never calls forbidden setters',async()=>{
 const m=createFigmaMock(),instance=m.make('INSTANCE'),n=m.make('VECTOR',{minWidth:null,maxWidth:null,minHeight:null,maxHeight:null},instance);
 const fields=['minWidth','maxWidth','minHeight','maxHeight'];m.rejectWrites((node,field)=>node.id===n.id&&fields.includes(field));
 await patch(m,[{id:n.id,set:Object.fromEntries(fields.map(field=>[field,null]))}]);
 for(const field of fields)assert.equal(n[field],null);
});


const nativePaint = {type:'SOLID',visible:true,opacity:1,blendMode:'NORMAL',color:{r:0.9,g:0.3,b:0.7},boundVariables:{}};
test('v2 absent and empty paint aliases skip setters that recompute inherited boolean geometry',async()=>{
 for(const field of ['fills','strokes']){
  const m=createFigmaMock(),instance=m.make('INSTANCE',{layoutMode:'NONE'}),n=m.make('BOOLEAN_OPERATION',{x:0.406374454498291,booleanOperation:'UNION',fills:[],strokes:[]},instance);
  let paints=[structuredClone(nativePaint)],x=n.x;Object.defineProperty(n,field,{get:()=>paints,set:value=>{paints=value;x+=0.14955;}});
  Object.defineProperty(n,'x',{get:()=>x,set:()=>{throw Error('readonly inherited relative-transform');}});
  const {boundVariables,...requested}=nativePaint;
  await patch(m,[{id:n.id,set:{[field]:[requested],x:n.x,width:n.width,height:n.height,booleanOperation:'UNION'}}]);
  assert.equal(n.x,0.406374454498291);assert.deepEqual(n[field],[nativePaint]);
 }
});
test('v2 paint comparison keeps nonempty aliases and actual color changes meaningful',async()=>{
 const m=createFigmaMock(),n=m.make('RECTANGLE',{fills:[{...nativePaint,boundVariables:{color:{type:'VARIABLE_ALIAS',id:'v'}}}]});
 const {boundVariables,...requested}=nativePaint;
 await patch(m,[{id:n.id,set:{fills:[requested]}}]);assert.equal(n.fills[0].boundVariables,undefined);
 await patch(m,[{id:n.id,set:{fills:[{...requested,color:{r:0,g:0,b:0}}]}}]);assert.equal(n.fills[0].color.r,0);
});
test('v2 gradient stop empty aliases skip identical native paint setters',async()=>{
 const m=createFigmaMock();const paint={type:'GRADIENT_LINEAR',gradientTransform:[[1,0,0],[0,1,0]],gradientStops:[{position:0,color:{r:0,g:0,b:0,a:1},boundVariables:{}},{position:1,color:{r:1,g:1,b:1,a:1},boundVariables:{}}]};
 const n=m.make('RECTANGLE',{fills:[paint]});m.rejectWrites((node,field)=>node.id===n.id&&field==='fills');
 const requested={...paint,gradientStops:paint.gradientStops.map(({boundVariables,...stop})=>stop)};
 await patch(m,[{id:n.id,set:{fills:[requested]}}]);assert.deepEqual(n.fills,[paint]);
});
test('v2 rollback skips unchanged style setters after a later package failure',async()=>{
 const m=createFigmaMock(),n=m.make('RECTANGLE',{fills:[nativePaint],fillStyleId:'native-style',strokeStyleId:'',effects:[],effectStyleId:''}),bad=m.make('FRAME');
 n.setFillStyleIdAsync=async()=>{throw Error('unchanged style setter recomputes geometry');};n.setStrokeStyleIdAsync=async()=>{throw Error('unchanged stroke style setter');};n.setEffectStyleIdAsync=async()=>{throw Error('unchanged effect style setter');};
 m.rejectWrites((node,field,value)=>node.id===bad.id&&field==='name'&&value==='bad');
 await assert.rejects(patch(m,[{id:n.id,set:{fills:[nativePaint],strokes:[],effects:[]}},{id:bad.id,set:{name:'bad'}}]),e=>e.operationStatus==='rolled_back'&&e.rollbackErrors.length===0);
});


test('v2 render preserves inactive NONE layout spacing without enabling Auto Layout',async()=>{
 const m=createFigmaMock(),gap=35.989524841308594;
 const parsed=parseRenderScreenInput({spec:{type:'screen',key:'s',name:'s',width:100,height:100,nodes:[{type:'frame',key:'grid',name:'common-grid',width:80,height:60,layout:{direction:'none',gap,padding:{top:0,right:gap,bottom:0,left:gap},primaryAlign:'center',counterAlign:'end'}}]}});
 const result=await executeGenerated(m.figma,buildRenderCode({...parsed,spec:normalizeScreenSpec(parsed.spec)}));const n=m.nodes.get(result.rootId).children[0];
 assert.equal(n.layoutMode,'NONE');assert.equal(n.itemSpacing,gap);assert.equal(n.paddingLeft,gap);assert.equal(n.paddingRight,gap);assert.equal(n.primaryAxisAlignItems,'CENTER');assert.equal(n.counterAxisAlignItems,'MAX');
});
test('v2 patch repairs inactive NONE spacing while preserving manual child geometry',async()=>{
 const m=createFigmaMock(),n=m.make('FRAME',{layoutMode:'NONE'}),child=m.make('RECTANGLE',{x:24,y:35},n),gap=35.989524841308594;
 m.rejectWrites((node,field,value)=>node.id===n.id&&field==='layoutMode'&&value!=='NONE');
 await patch(m,[{id:n.id,set:{layout:{direction:'none',gap,padding:{top:0,right:gap,bottom:0,left:gap}}}}]);
 assert.equal(n.layoutMode,'NONE');assert.equal(n.itemSpacing,gap);assert.equal(n.paddingLeft,gap);assert.equal(child.x,24);assert.equal(child.y,35);
 await patch(m,[{id:n.id,set:{gap:12,padding:4}}]);assert.equal(n.itemSpacing,12);assert.equal(n.paddingLeft,4);
});
test('v2 failed later patch restores inactive spacing and leaves unsupported NONE setters untouched',async()=>{
 const m=createFigmaMock(),n=m.make('FRAME',{layoutMode:'NONE',strokesIncludedInLayout:false}),bad=m.make('FRAME');
 m.rejectWrites((node,field,value)=>node.id===n.id&&field==='strokesIncludedInLayout'||node.id===bad.id&&field==='name'&&value==='bad');
 await assert.rejects(patch(m,[{id:n.id,set:{layout:{direction:'none',gap:36,padding:36,strokesIncludedInLayout:false}}},{id:bad.id,set:{name:'bad'}}]),e=>e.operationStatus==='rolled_back'&&e.rollbackErrors.length===0);
 assert.equal(n.itemSpacing,0);assert.equal(n.paddingLeft,0);assert.equal(n.layoutMode,'NONE');
});
