import test from 'node:test';
import assert from 'node:assert/strict';
import { createFigmaMock, executeGenerated } from './helpers/figma-mock.mjs';
import { toolFailure } from '../src/tool-results.mjs';

// Only the Plugin API boundary is doubled. Both commands run compiled production code.
async function api() { return import('../src/library-template.mjs').catch(e => e.code === 'ERR_MODULE_NOT_FOUND' ? {} : Promise.reject(e)); }
function fixture(source = false) {
  const m = createFigmaMock();
  m.figma.fileKey = source ? 'source-file' : 'target-file';
  const metadata = {};
  m.figma.root.getPluginData = k => metadata[k] || '';
  m.figma.root.setPluginData = (k,v) => { metadata[k] = v; };
  m.page.parent = m.figma.root;
  m.figma.createPage = () => { const p = m.make('PAGE', {}, null); p.parent = m.figma.root; m.figma.root.children.push(p); return p; };
  m.figma.loadAllPagesAsync = async () => {};
  const style = { id: source ? 'source-style' : 'target-style', key: 'paint-key', type: 'PAINT', name: 'Цвет' };
  m.figma.getStyleByIdAsync = async id => id === style.id ? style : null;
  m.figma.importStyleByKeyAsync = async key => { assert.equal(key, 'paint-key'); return style; };
  const collection = { id: source ? 'source-collection' : 'target-collection', key: 'collection-key', modes: [{ modeId: source ? 'source-mode' : 'target-mode', name: 'Light' }] };
  const variable = { id: source ? 'source-variable' : 'target-variable', key: 'variable-key', variableCollectionId: collection.id, resolvedType: 'COLOR' };
  m.figma.variables.getVariableByIdAsync = async id => id === variable.id ? variable : null;
  m.figma.variables.getVariableCollectionByIdAsync = async id => id === collection.id ? collection : null;
  m.figma.variables.getLocalVariablesAsync = async () => [variable];
  m.figma.variables.importVariableByKeyAsync = async key => { assert.equal(key, 'variable-key'); return variable; };
  function instance(key, name, parent) {
    const n = m.make('INSTANCE', { name }, parent);
    n.getMainComponentAsync = async () => ({ type: 'COMPONENT', key });
    n.overrides = [];
    return n;
  }
  function card(parent) {
    const root = instance('card-key', 'Карточка', parent);
    const body = instance('body-key', 'Тело', root);
    body.visible = false;
    const text = m.make('TEXT', { name: 'Текст', characters: 'Base', locked: false, textDecorationSkipInk: false }, body);
    let runs;
    const rangeValues = new Map();
    text.getStyledTextSegments = (fields,start=0,end=text.characters.length) => {
      if(runs)return runs;
      if(fields.length===1&&fields[0]==='hyperlink'){
        const result=[];
        for(let i=start;i<end;i++){
          let hyperlink=text.hyperlink;
          for(const [key,value] of rangeValues){const [a,b,field]=key.split(':');if(field==='hyperlink'&&i>=Number(a)&&i<Number(b))hyperlink=value;}
          const previous=result.at(-1);
          if(previous&&JSON.stringify(previous.hyperlink)===JSON.stringify(hyperlink))previous.end=i+1;
          else result.push({start:i,end:i+1,hyperlink});
        }
        return result;
      }
      return [{start,end,...Object.fromEntries(fields.filter(f => text[f] !== undefined).map(f => [f,text[f]]))}];
    };
    for(const field of ['fontName','fontSize','hyperlink','textDecorationSkipInk']) {
      const title=field[0].toUpperCase()+field.slice(1);
      text['setRange'+title]=(start,end,value)=>{rangeValues.set(start+':'+end+':'+field,value);if(field==='fontName')(text.appliedRuns ||= []).push({start,end,fontName:value});};
      text['getRange'+title]=(start,end)=>rangeValues.get(start+':'+end+':'+field)??text[field];
    }
    root.fixtureText = text;
    root.fixtureBody = body;
    root.setFixtureRuns = value => { runs = value; };
    for (const n of [root,body,text]) n.setExplicitVariableModeForCollection = (c,mode) => { n.explicitVariableModes = { [c.id]: mode }; };
    return root;
  }
  m.figma.importComponentByKeyAsync = async key => {
    assert.equal(key,'card-key');
    return { type: 'COMPONENT', key, createInstance: () => card(m.page) };
  };
  if (source) {
    const c = card(m.page);
    c.fixtureText.characters = 'Task link';
    c.fixtureText.locked = true;
    c.fixtureText.textDecorationSkipInk = true;
    c.fixtureText.fillStyleId = style.id;
    c.fixtureText.boundVariables = { fills: [{ type: 'VARIABLE_ALIAS', id: variable.id }] };
    c.fixtureText.fills = [{type:'SOLID',color:{r:1,g:0,b:0},boundVariables:{color:{type:'VARIABLE_ALIAS',id:variable.id}}}];
    c.fixtureText.explicitVariableModes = { [collection.id]: collection.modes[0].modeId };
    c.setFixtureRuns([
      { start:0,end:4,fontName:{family:'Inter',style:'Bold'},fontSize:14,hyperlink:null },
      { start:4,end:9,fontName:{family:'Inter',style:'Regular'},fontSize:14,hyperlink:{type:'URL',value:'https://jira.example/T-1'} },
    ]);
    c.overrides = [{ id: c.fixtureText.id, overriddenFields:['characters','locked','fillStyleId','fills','styledTextSegments','textDecorationSkipInk'] }];
    m.card = c;
  }
  m.metadata = metadata;
  return m;
}
async function capture() {
  const module = await api();
  assert.equal(typeof module.buildCaptureLibraryTemplateCode, 'function', 'capture compiler must exist');
  const source = fixture(true);
  const before = source.writes.length;
  const { snapshot } = await executeGenerated(source.figma, module.buildCaptureLibraryTemplateCode({fileKey:'source-file',pageIds:[source.page.id]}));
  assert.equal(source.writes.length, before, 'capture writes no source node');
  return { module, snapshot, source };
}
const assemble = (module,m,snapshot,mode='apply') => executeGenerated(m.figma,module.buildAssembleLibraryTemplateCode({fileKey:m.figma.fileKey,snapshot,mode}));

test('capture preserves hidden instance keys, exact override values, mixed ranges and portable resources without writes', async () => {
  const { snapshot } = await capture();
  assert.equal(snapshot.schemaVersion,2);
  assert.deepEqual(snapshot.nodes.filter(n=>n.libraryKey).map(n=>n.libraryKey),['card-key','body-key']);
  const text = snapshot.nodes.find(n=>n.type==='TEXT');
  assert.equal(text.overrides.characters,'Task link');
  assert.equal(text.overrides.locked,true);
  assert.equal(text.overrides.styledTextSegments[1].hyperlink.value,'https://jira.example/T-1');
  assert.equal(snapshot.resources.styles[0].key,'paint-key');
  assert.equal(snapshot.resources.variables[0].key,'variable-key');
  assert.equal(JSON.stringify(snapshot.resources).includes('source-variable'),false);
});
test('apply imports attached instances and exact text; verify and reuse preserve later Jira text without nodes or imports', async () => {
  const {module,snapshot} = await capture(); const target = fixture();
  const result = await assemble(module,target,snapshot);
  assert.equal(result.status,'assembled'); assert.equal(result.verification.status,'passed');
  assert.deepEqual(result.instanceKeys.map(n=>n.libraryKey),['card-key','body-key']);
  assert.equal([...target.nodes.values()].filter(n=>n.type==='COMPONENT').length,0);
  const text = [...target.nodes.values()].find(n=>n.type==='TEXT');
  assert.equal(text.characters,'Task link'); assert.equal(text.locked,true);
  assert.equal(text.fillStyleId,'target-style');
  assert.equal(text.fills[0].boundVariables.color.id,'target-variable');
  assert.deepEqual(text.explicitVariableModes,{'target-collection':'target-mode'});
  assert.deepEqual(text.appliedRuns.map(r=>r.fontName.style),['Bold','Regular']);
  text.characters='Jira edited';
  const count = target.nodes.size, writes = target.writes.length;
  target.figma.importComponentByKeyAsync = async () => { throw new Error('must not import'); };
  assert.equal((await assemble(module,target,snapshot,'verify')).status,'verified');
  assert.equal((await assemble(module,target,snapshot)).status,'reused');
  assert.equal(target.nodes.size,count); assert.equal(target.writes.length,writes); assert.equal(text.characters,'Jira edited');
});
test('source protection, unmanaged content and malformed snapshots reject before canvas writes', async () => {
  const {module,snapshot,source} = await capture();
  await assert.rejects(assemble(module,source,snapshot),e=>e.code==='SOURCE_TARGET_FORBIDDEN'&&e.operationStatus==='not_applied');
  const target=fixture(); target.make('FRAME'); const count=target.nodes.size;
  await assert.rejects(assemble(module,target,snapshot),e=>e.code==='TARGET_NOT_EMPTY'); assert.equal(target.nodes.size,count);
  await assert.rejects(assemble(module,fixture(),snapshot,'verify'),e=>e.code==='TEMPLATE_NOT_MANAGED');
  for (const mutate of [s=>s.nodes[1].overrides.unknownUnsafe=true,s=>s.resources.styles.push({...s.resources.styles[0]})]) {
    const bad=structuredClone(snapshot); mutate(bad);
    await assert.rejects(async()=>assemble(module,fixture(),bad));
  }
});
test('import/font/write failures roll back only owned canvas; library drift rejects and never writes definitions', async () => {
  const {module,snapshot}=await capture();
  for(const failure of ['import','font','write','drift']) {
    const target=fixture(); const oldName=target.page.name;
    if(failure==='import')target.figma.importComponentByKeyAsync=async()=>{throw new Error('import failed');};
    if(failure==='font')target.figma.loadFontAsync=async()=>{throw new Error('font failed');};
    if(failure==='write')target.rejectWrites((n,f,v)=>f==='characters'&&v==='Task link');
    if(failure==='drift'){const original=target.figma.importComponentByKeyAsync;target.figma.importComponentByKeyAsync=async key=>{const c=await original(key);const create=c.createInstance;c.createInstance=()=>{const n=create();n.children[0].getMainComponentAsync=async()=>({key:'changed-key'});return n;};return c;};}
    await assert.rejects(assemble(module,target,snapshot),e=>['not_applied','rolled_back'].includes(e.operationStatus));
    assert.equal(target.page.children.length,0,failure); assert.equal(target.page.name,oldName,failure);
  }
});
test('verify reads actual nested identity and rejects detached nodes or wrong keys even with a valid marker', async()=>{
  const {module,snapshot}=await capture();
  for(const detach of [false,true]){const t=fixture();await assemble(module,t,snapshot);const body=[...t.nodes.values()].find(n=>n.name==='Тело');if(detach)body.type='FRAME';else body.getMainComponentAsync=async()=>({key:'wrong'});
    await assert.rejects(assemble(module,t,snapshot,'verify'),e=>e.code==='TEMPLATE_STRUCTURE_MISMATCH');}
});

test('readback detects a silently ignored range or explicit mode write and rolls back',async()=>{
  const {module,snapshot}=await capture();
  for(const kind of ['range','mode']){const t=fixture();const original=t.figma.importComponentByKeyAsync;t.figma.importComponentByKeyAsync=async key=>{const c=await original(key),create=c.createInstance;c.createInstance=()=>{const n=create();if(kind==='range')n.fixtureText.setRangeFontName=()=>{};else n.fixtureText.setExplicitVariableModeForCollection=()=>{};return n;};return c;};
    await assert.rejects(assemble(module,t,snapshot),e=>e.code==='TEMPLATE_VALUE_MISMATCH');assert.equal(t.page.children.length,0);}
});

test('range hyperlink mismatch reports typed bounded expected and native observations without changing rollback',async()=>{
  const {module,snapshot}=await capture();
  for(const [actual,want] of [[undefined,{kind:'undefined'}],[Symbol('mixed'),{kind:'mixed'}],[{type:'URL',value:'https://example.test/'},{kind:'target',type:'URL',value:'https://example.test/'}],[{type:'URL',value:'x'.repeat(5000)},{kind:'target',type:'URL',value:'x'.repeat(2048),truncated:true}]]){
    const t=fixture(),original=t.figma.importComponentByKeyAsync;
    t.figma.importComponentByKeyAsync=async key=>{const c=await original(key),create=c.createInstance;c.createInstance=()=>{const n=create(),read=n.fixtureText.getStyledTextSegments;n.fixtureText.getRangeHyperlink=()=>actual;n.fixtureText.getStyledTextSegments=(fields,start,end)=>fields.length===1&&fields[0]==='hyperlink'?[{start,end,hyperlink:actual}]:read(fields,start,end);return n;};return c;};
    let failure;try{await assemble(module,t,snapshot);}catch(e){failure=e;}
    assert.equal(failure?.code,'TEMPLATE_VALUE_MISMATCH');assert.equal(failure.operationStatus,'rolled_back');
    const wire=toolFailure(failure).structuredContent;
    assert.match(wire.error,/; hyperlink=/);
    const detail=JSON.parse(wire.error.split('; hyperlink=')[1]);
    assert.deepEqual(detail,{path:'0/0/0/0',start:0,end:4,expected:{kind:'null'},actual:want,afterWrite:want});
    assert.ok(wire.error.length<5000);assert.equal(wire.error.includes('Task link'),false);assert.equal(t.page.children.length,0);
  }
});

test('range hyperlink readback uses exact styled segment coverage when legacy getter returns a number',async()=>{
  const {module,snapshot}=await capture(),t=fixture(),original=t.figma.importComponentByKeyAsync;
  t.figma.importComponentByKeyAsync=async key=>{const c=await original(key),create=c.createInstance;c.createInstance=()=>{
    const n=create(),read=n.fixtureText.getStyledTextSegments;
    n.fixtureText.getRangeHyperlink=()=>123;
    n.fixtureText.getStyledTextSegments=(fields,start,end)=>fields.length===1&&fields[0]==='hyperlink'?(start===0?[{start:0,end:2,hyperlink:null},{start:2,end:4,hyperlink:null}]:[{start:4,end:9,hyperlink:{type:'URL',value:'https://jira.example/T-1'}}]):read(fields,start,end);
    return n;
  };return c;};
  assert.equal((await assemble(module,t,snapshot)).status,'assembled');
});

test('range hyperlink segment verification rejects wrong values and incomplete or malformed coverage',async()=>{
  const {module,snapshot}=await capture();
  for(const invalid of [
    [{start:0,end:4,hyperlink:{type:'URL',value:'https://wrong.example/'}}],
    [{start:0,end:3,hyperlink:null}],
    [{start:1,end:4,hyperlink:null}],
    [{start:0,end:2,hyperlink:null},{start:1,end:4,hyperlink:null}],
    [{start:0,end:2,hyperlink:null},{start:3,end:4,hyperlink:null}],
    [{start:0,end:5,hyperlink:null}],
    [{start:0,end:0,hyperlink:null}],
    [{start:0,end:2.5,hyperlink:null},{start:2.5,end:4,hyperlink:null}],
    [{start:'0',end:4,hyperlink:null}],
    [{start:0,end:4,hyperlink:123}],
    [{start:0,end:4,hyperlink:Symbol('mixed')}],
    [{start:0,end:4}],[],null,
    [Object.assign([],{start:0,end:4,hyperlink:null})],
    [{start:0,end:4,hyperlink:{type:'URL',value:'https://jira.example/T-1',extra:true}}],
  ]){
    const t=fixture(),original=t.figma.importComponentByKeyAsync;
    t.figma.importComponentByKeyAsync=async key=>{const c=await original(key),create=c.createInstance;c.createInstance=()=>{
      const n=create(),read=n.fixtureText.getStyledTextSegments;
      n.fixtureText.getStyledTextSegments=(fields,start,end)=>fields.length===1&&fields[0]==='hyperlink'?invalid:read(fields,start,end);
      return n;
    };return c;};
    await assert.rejects(assemble(module,t,snapshot),e=>e.code==='TEMPLATE_VALUE_MISMATCH'&&e.operationStatus==='rolled_back'&&JSON.parse(e.message.split('; hyperlink=')[1]).start===0);
    assert.equal(t.page.children.length,0);
  }
  const t=fixture(),original=t.figma.importComponentByKeyAsync;
  t.figma.importComponentByKeyAsync=async key=>{const c=await original(key),create=c.createInstance;c.createInstance=()=>{const n=create(),read=n.fixtureText.getStyledTextSegments;n.fixtureText.getStyledTextSegments=(fields,start,end)=>fields.length===1&&fields[0]==='hyperlink'?[{start,end,hyperlink:null}]:read(fields,start,end);return n;};return c;};
  await assert.rejects(assemble(module,t,snapshot),e=>e.code==='TEMPLATE_VALUE_MISMATCH'&&e.message.includes('range hyperlink')&&e.operationStatus==='rolled_back');
});
test('managed verify permits captured Status variants only from the same component set',async()=>{
  const module=await api(),s=fixture(true);const body=s.card.fixtureBody;
  body.componentProperties={Status:{type:'VARIANT',value:'todo'}};
  const set={type:'COMPONENT_SET',key:'status-set',children:[]};
  set.children=[{type:'COMPONENT',key:'body-key',name:'Status=todo',variantProperties:{Status:'todo'},parent:set},{type:'COMPONENT',key:'done-key',name:'Status=done',variantProperties:{Status:'done'},parent:set}];
  body.getMainComponentAsync=async()=>set.children[0];
  const {snapshot}=await executeGenerated(s.figma,module.buildCaptureLibraryTemplateCode({fileKey:s.figma.fileKey,pageIds:[s.page.id]}));
  const t=fixture();await assemble(module,t,snapshot);const actual=[...t.nodes.values()].find(n=>n.name==='Тело');
  actual.getMainComponentAsync=async()=>set.children[1];
  const verified=await assemble(module,t,snapshot,'verify');
  assert.equal(verified.status,'verified');
  assert.equal(verified.instanceKeys.find(n=>n.path==='0/0/0').libraryKey,'done-key');
  actual.getMainComponentAsync=async()=>({...set.children[1],parent:{type:'COMPONENT_SET',key:'unrelated-set'}});
  await assert.rejects(assemble(module,t,snapshot,'verify'),e=>e.code==='TEMPLATE_STRUCTURE_MISMATCH');
});
test('capture resolves an otherwise unused remote collection anchor by published metadata without imports',async()=>{
  const module=await api(),s=fixture(true);
  s.page.explicitVariableModes={'remote-id': 'dark-id'};
  const get=s.figma.variables.getVariableCollectionByIdAsync;
  s.figma.variables.getVariableCollectionByIdAsync=async id=>id==='remote-id'?{id,key:'remote-key',variableIds:[],modes:[{modeId:'dark-id',name:'Dark'}]}:get(id);
  s.figma.teamLibrary.getVariablesInLibraryCollectionAsync=async key=>{assert.equal(key,'remote-key');return [{key:'remote-anchor',name:'Token',resolvedType:'COLOR'}];};
  s.figma.variables.importVariableByKeyAsync=async()=>{throw new Error('capture must not import');};
  const {snapshot}=await executeGenerated(s.figma,module.buildCaptureLibraryTemplateCode({fileKey:s.figma.fileKey,pageIds:[s.page.id]}));
  assert.deepEqual(snapshot.resources.collections.find(c=>c.key==='remote-key'),{key:'remote-key',anchorVariableKey:'remote-anchor',modes:['Dark']});
  assert.deepEqual(snapshot.resources.variables.find(v=>v.key==='remote-anchor'),{key:'remote-anchor',collectionKey:'remote-key',resolvedType:'COLOR'});
});
test('saved paint style survives explicit paints that clear a style binding in the native API',async()=>{
  const {module,snapshot}=await capture(),t=fixture();const original=t.figma.importComponentByKeyAsync;
  t.figma.importComponentByKeyAsync=async key=>{const c=await original(key),create=c.createInstance;c.createInstance=()=>{const n=create(),text=n.fixtureText;let paints=text.fills;Object.defineProperty(text,'fills',{get:()=>paints,set:v=>{paints=v;text.fillStyleId='';},configurable:true});return n;};return c;};
  await assemble(module,t,snapshot);assert.equal([...t.nodes.values()].find(n=>n.type==='TEXT').fillStyleId,'target-style');
});

test('apply rechecks the original empty target after awaited imports before creating canvas',async()=>{
  const {module,snapshot}=await capture();
  for(const change of ['page','node','name','marker']){
    const t=fixture(),original=t.figma.importComponentByKeyAsync;
    let foreign;
    t.figma.importComponentByKeyAsync=async key=>{
      if(change==='page'){foreign=t.figma.createPage();foreign.name='Чужая страница';}
      if(change==='node')foreign=t.make('TEXT',{characters:'Чужой текст'});
      if(change==='name')t.page.name='Ручное имя';
      if(change==='marker')t.metadata['codex-library-template-v2']='foreign-marker';
      return original(key);
    };
    await assert.rejects(assemble(module,t,snapshot),e=>e.operationStatus==='not_applied'&&e.code==='TEMPLATE_CONCURRENT_EDIT');
    assert.equal([...t.nodes.values()].some(n=>n.type==='INSTANCE'),false);
    if(foreign)assert.equal(foreign.removed,false);
    if(change==='name')assert.equal(t.page.name,'Ручное имя');
    if(change==='marker')assert.equal(t.metadata['codex-library-template-v2'],'foreign-marker');
  }
});

test('rollback preserves concurrent foreign descendants inside owned frame and page, and reports partial cleanup',async()=>{
  const module=await api(),s=fixture(true),frame=s.make('FRAME',{name:'Оболочка'});frame.appendChild(s.card);
  const extra=s.figma.createPage();extra.name='Вторая';
  const {snapshot}=await executeGenerated(s.figma,module.buildCaptureLibraryTemplateCode({fileKey:s.figma.fileKey,pageIds:[s.page.id,extra.id]}));
  for(const place of ['frame','page']){
    const t=fixture(),load=t.figma.loadFontAsync;let foreign,parent;
    t.figma.loadFontAsync=async font=>{
      if([...t.nodes.values()].some(n=>n.type==='INSTANCE')){
        parent=place==='frame'?[...t.nodes.values()].find(n=>n.name==='Оболочка'):t.figma.root.children[1];
        foreign=t.make('TEXT',{characters:'Не удалять'},parent);
        throw new Error('failure after concurrent edit');
      }return load(font);
    };
    await assert.rejects(assemble(module,t,snapshot),e=>e.operationStatus==='partial'&&e.rollbackErrors.some(message=>message.includes(foreign.id)));
    assert.equal(foreign.removed,false);assert.equal(foreign.parent,parent);assert.equal(parent.removed,false);assert.equal(foreign.characters,'Не удалять');
    assert.equal(t.metadata['codex-library-template-v2']||'','');
  }
});

test('rollback compares written page name and marker before restore and preserves concurrent metadata',async()=>{
  const {module,snapshot}=await capture();
  for(const field of ['name','marker']){
    const t=fixture(),load=t.figma.loadFontAsync;
    t.figma.loadFontAsync=async font=>{
      if([...t.nodes.values()].some(n=>n.type==='INSTANCE')){
        if(field==='name')t.page.name='Ручное имя после сборки';
        else t.metadata['codex-library-template-v2']='foreign-marker';
        throw new Error('failure after metadata edit');
      }return load(font);
    };
    await assert.rejects(assemble(module,t,snapshot),e=>e.operationStatus==='partial'&&e.rollbackErrors.some(message=>message.includes(field)));
    if(field==='name')assert.equal(t.page.name,'Ручное имя после сборки');
    else assert.equal(t.metadata['codex-library-template-v2'],'foreign-marker');
  }
});

test('final readback rejects a concurrently added page before setting the managed marker',async()=>{
  const {module,snapshot}=await capture(),t=fixture(),load=t.figma.loadFontAsync;let foreign;
  t.figma.loadFontAsync=async font=>{if(!foreign&&[...t.nodes.values()].some(n=>n.type==='INSTANCE')){foreign=t.figma.createPage();foreign.name='Ручная страница';}return load(font);};
  await assert.rejects(assemble(module,t,snapshot),e=>e.code==='TEMPLATE_CONCURRENT_EDIT');
  assert.equal(foreign.removed,false);assert.equal(t.figma.root.children.includes(foreign),true);
  assert.equal(t.metadata['codex-library-template-v2']||'','');assert.equal(t.page.children.length,0);
});

test('outer direct variable binding round-trips through portable key and unsupported binding shapes stop capture',async()=>{
  const module=await api(),s=fixture(true),frame=s.make('FRAME',{name:'Связанный контейнер'});frame.appendChild(s.card);
  const sourceVariable={id:'source-padding',key:'padding-key',resolvedType:'FLOAT',variableCollectionId:'source-collection'};
  const get=s.figma.variables.getVariableByIdAsync;
  s.figma.variables.getVariableByIdAsync=async id=>id===sourceVariable.id?sourceVariable:get(id);
  frame.boundVariables={paddingTop:{type:'VARIABLE_ALIAS',id:sourceVariable.id}};
  const {snapshot}=await executeGenerated(s.figma,module.buildCaptureLibraryTemplateCode({fileKey:s.figma.fileKey,pageIds:[s.page.id]}));
  const saved=snapshot.nodes.find(n=>n.name==='Связанный контейнер');
  assert.deepEqual(saved.props.boundVariables,{paddingTop:{type:'VARIABLE_ALIAS',key:'padding-key'}});
  const t=fixture(),importVariable=t.figma.variables.importVariableByKeyAsync;
  const targetVariable={...sourceVariable,id:'target-padding',variableCollectionId:'target-collection'};
  t.figma.variables.importVariableByKeyAsync=async key=>key==='padding-key'?targetVariable:importVariable(key);
  const targetGet=t.figma.variables.getVariableByIdAsync;
  t.figma.variables.getVariableByIdAsync=async id=>id==='target-padding'?targetVariable:targetGet(id);
  await assemble(module,t,snapshot);
  const targetFrame=[...t.nodes.values()].find(n=>n.name==='Связанный контейнер');
  assert.equal(targetFrame.boundVariables.paddingTop.id,'target-padding');
  assert.equal((await t.figma.variables.getVariableByIdAsync(targetFrame.boundVariables.paddingTop.id)).key,'padding-key');
  for(const binding of [{width:[]},{unsupported:{type:'VARIABLE_ALIAS',id:sourceVariable.id}},{paddingTop:{value:12}}]){
    frame.boundVariables=binding;
    await assert.rejects(executeGenerated(s.figma,module.buildCaptureLibraryTemplateCode({fileKey:s.figma.fileKey,pageIds:[s.page.id]})),e=>e.code==='UNSUPPORTED_TEMPLATE_BINDING'&&e.operationStatus==='not_applied');
  }
});

test('outer scalar and paint-derived bindings round-trip together and readback still catches either wrong alias',async()=>{
  const module=await api(),source=fixture(true);
  source.card.remove();
  const frame=source.make('FRAME',{name:'Scalar and paint',paddingTop:16});
  const padding={id:'source-padding',key:'padding-key',resolvedType:'FLOAT',variableCollectionId:'source-collection'};
  const originalGet=source.figma.variables.getVariableByIdAsync;
  source.figma.variables.getVariableByIdAsync=async id=>id===padding.id?padding:originalGet(id);
  frame.fills=[{type:'SOLID',color:{r:1,g:0,b:0},boundVariables:{color:{type:'VARIABLE_ALIAS',id:'source-variable'}}}];
  frame.boundVariables={paddingTop:{type:'VARIABLE_ALIAS',id:padding.id},fills:[{type:'VARIABLE_ALIAS',id:'source-variable'}]};
  const {snapshot}=await executeGenerated(source.figma,module.buildCaptureLibraryTemplateCode({fileKey:source.figma.fileKey,pageIds:[source.page.id]}));
  assert.deepEqual(snapshot.nodes[1].props.boundVariables,{paddingTop:{type:'VARIABLE_ALIAS',key:'padding-key'}});
  for(const corrupt of [null,'scalar','paint']){
    const target=fixture(),create=target.figma.createFrame,importVariable=target.figma.variables.importVariableByKeyAsync;
    target.figma.variables.importVariableByKeyAsync=async key=>key==='padding-key'?{...padding,id:'target-padding',variableCollectionId:'target-collection'}:importVariable(key);
    target.figma.createFrame=()=>{
      const node=create();let direct={};
      Object.defineProperty(node,'boundVariables',{
        configurable:true,
        get:()=>({...direct,...(node.fills.length?{fills:node.fills.flatMap(p=>Object.values(p.boundVariables||{}))}:{})}),
        set:value=>{direct=Object.fromEntries(Object.entries(value).filter(([key])=>key!=='fills'));},
      });
      const set=node.setBoundVariable;
      node.setBoundVariable=(field,variable)=>{
        set.call(node,field,variable);
        if(corrupt==='scalar')direct[field]={type:'VARIABLE_ALIAS',id:'wrong-padding'};
        if(corrupt==='paint')node.fills[0].boundVariables.color.id='wrong-color';
      };
      return node;
    };
    if(corrupt){await assert.rejects(assemble(module,target,snapshot),e=>e.code==='TEMPLATE_VALUE_MISMATCH'&&e.operationStatus==='rolled_back');continue;}
    assert.equal((await assemble(module,target,snapshot)).status,'assembled');
    const actual=target.page.children[0];
    assert.deepEqual(actual.boundVariables,{paddingTop:{type:'VARIABLE_ALIAS',id:'target-padding'},fills:[{type:'VARIABLE_ALIAS',id:'target-variable'}]});
    assert.equal(actual.fills[0].boundVariables.color.id,'target-variable');
  }
});

function nullableDecorationTarget({ignoreDecoration=false}={}) {
  const target=fixture(),original=target.figma.importComponentByKeyAsync;
  target.figma.importComponentByKeyAsync=async key=>{
    const component=await original(key),create=component.createInstance;
    component.createInstance=()=>{
      const instance=create(),text=instance.fixtureText;
      let decoration='UNDERLINE',skipInk=true;
      const ranges=new Map();
      Object.defineProperty(text,'textDecoration',{configurable:true,get:()=>decoration,set:value=>{if(!ignoreDecoration)decoration=value;}});
      Object.defineProperty(text,'textDecorationSkipInk',{
        configurable:true,get:()=>decoration==='UNDERLINE'?skipInk:null,
        set:value=>{if(typeof value!=='boolean')throw new Error('Expected boolean, received '+value);skipInk=value;},
      });
      text.setRangeTextDecoration=(start,end,value)=>{if(!ignoreDecoration)ranges.set(start+':'+end,value);};
      text.getRangeTextDecoration=(start,end)=>ranges.get(start+':'+end)??decoration;
      text.setRangeTextDecorationSkipInk=(_start,_end,value)=>{if(typeof value!=='boolean')throw new Error('Expected boolean range, received '+value);skipInk=value;};
      text.getRangeTextDecorationSkipInk=(start,end)=>text.getRangeTextDecoration(start,end)==='UNDERLINE'?skipInk:null;
      return instance;
    };
    return component;
  };
  return target;
}

for(const form of ['scalar','range','both'])test(`nullable ${form} SkipInk is not-applicable for saved non-underlined text, with exact readback`,async()=>{
  const {module,snapshot}=await capture();
  for(const decoration of ['NONE','STRIKETHROUGH']){
    const saved=structuredClone(snapshot),text=saved.nodes.find(n=>n.type==='TEXT');
    text.overrides={characters:'Task link'};
    if(form!=='range')Object.assign(text.overrides,{textDecoration:decoration,textDecorationSkipInk:null});
    if(form!=='scalar')text.overrides.styledTextSegments=[{start:0,end:9,textDecoration:decoration,textDecorationSkipInk:null}];
    const target=nullableDecorationTarget();
    assert.equal((await assemble(module,target,saved)).status,'assembled');
    const actual=[...target.nodes.values()].find(n=>n.type==='TEXT');
    if(form!=='range'){assert.equal(actual.textDecoration,decoration);assert.equal(actual.textDecorationSkipInk,null);}
    if(form!=='scalar'){assert.equal(actual.getRangeTextDecoration(0,9),decoration);assert.equal(actual.getRangeTextDecorationSkipInk(0,9),null);}
    await assert.rejects(assemble(module,nullableDecorationTarget({ignoreDecoration:true}),saved),e=>e.code==='TEMPLATE_VALUE_MISMATCH'&&e.operationStatus==='rolled_back');
  }
});

test('invalid or ambiguous nullable SkipInk is rejected before imports and canvas writes',async()=>{
  const {module,snapshot}=await capture();
  const cases=[
    {textDecoration:'UNDERLINE',textDecorationSkipInk:null},
    {textDecorationSkipInk:null},
    {styledTextSegments:[{start:0,end:9,textDecoration:'UNDERLINE',textDecorationSkipInk:null}]},
    {styledTextSegments:[{start:0,end:9,textDecorationSkipInk:null}]},
    {textDecoration:'NONE',textDecorationSkipInk:null,styledTextSegments:[{start:0,end:9,textDecoration:'UNDERLINE',textDecorationSkipInk:true}]},
    {textDecoration:'NONE',textDecorationSkipInk:'null'},
  ];
  for(const overrides of cases){
    const saved=structuredClone(snapshot),text=saved.nodes.find(n=>n.type==='TEXT');text.overrides={characters:'Task link',...overrides};
    const target=nullableDecorationTarget(),before=target.writes.length;
    target.figma.importStyleByKeyAsync=async()=>{throw new Error('invalid nullable state must fail before importing');};
    await assert.rejects(async()=>assemble(module,target,saved),e=>e.code==='INVALID_TEMPLATE_DECORATION'&&e.operationStatus==='not_applied');
    assert.equal(target.writes.length,before);assert.equal(target.page.children.length,0);
  }
});

test('underlined boolean SkipInk remains explicit for scalar and ranged setters',async()=>{
  const {module,snapshot}=await capture();
  for(const form of ['scalar','range'])for(const value of [false,true]){
    const saved=structuredClone(snapshot),text=saved.nodes.find(n=>n.type==='TEXT');text.overrides={characters:'Task link'};
    if(form==='scalar')Object.assign(text.overrides,{textDecoration:'UNDERLINE',textDecorationSkipInk:value});
    else text.overrides.styledTextSegments=[{start:0,end:9,textDecoration:'UNDERLINE',textDecorationSkipInk:value}];
    const target=nullableDecorationTarget();await assemble(module,target,saved);
    const actual=[...target.nodes.values()].find(n=>n.type==='TEXT');
    assert.equal(form==='scalar'?actual.textDecorationSkipInk:actual.getRangeTextDecorationSkipInk(0,9),value);
  }
});

// Literal saved Cover layout state (the full snapshot stays in the application
// repo); only the native applicability boundary is modeled, not layout geometry.
const coverLayoutState={
  layoutMode:'NONE',layoutWrap:'NO_WRAP',itemSpacing:0,counterAxisSpacing:0,
  paddingTop:0,paddingRight:0,paddingBottom:0,paddingLeft:0,
  primaryAxisAlignItems:'MIN',counterAxisAlignItems:'MIN',
  primaryAxisSizingMode:'AUTO',counterAxisSizingMode:'FIXED',
  layoutSizingHorizontal:'FIXED',layoutSizingVertical:'FIXED',
  layoutPositioning:'AUTO',layoutAlign:'INHERIT',layoutGrow:0,
  minWidth:null,maxWidth:null,minHeight:null,maxHeight:null,
  strokesIncludedInLayout:false,itemReverseZIndex:false,
};
function layoutSnapshot(props){return {
  schemaVersion:2,sourceFileKey:'source-file',pages:[{sourceId:'source-page',path:'0',name:'Cover page'}],
  nodes:[{sourceId:'source-page',path:'0',parentPath:null,type:'PAGE',name:'Cover page',props:{},overrides:{}},
    {sourceId:'source-cover',path:'0/0',parentPath:'0',type:'FRAME',name:'Cover',props,overrides:{}}],
  resources:{styles:[],variables:[],collections:[]},fonts:[],
};}
function strictLayoutTarget({defaults={},rejectField}={}){
  const target=fixture(),create=target.figma.createFrame;
  target.figma.createFrame=()=>{
    const node=create();Object.assign(node,coverLayoutState,defaults);
    const auto=n=>['HORIZONTAL','VERTICAL'].includes(n?.layoutMode);
    for(const field of Object.keys(coverLayoutState).filter(f=>f!=='layoutMode')){
      let current=node[field];
      Object.defineProperty(node,field,{configurable:true,get:()=>current,set:value=>{
        const applicable=field==='layoutWrap'?node.layoutMode==='HORIZONTAL'
          :field==='counterAxisSpacing'?auto(node)&&node.layoutWrap==='WRAP'
          :['layoutPositioning','layoutAlign','layoutGrow'].includes(field)?auto(node.parent)
          :['layoutSizingHorizontal','layoutSizingVertical','minWidth','maxWidth','minHeight','maxHeight'].includes(field)?auto(node)||auto(node.parent)
          :auto(node);
        if(!applicable)throw new Error('in set_'+field+': inapplicable layoutMode '+node.layoutMode);
        if(field!==rejectField)current=value;
      }});
    }
    return node;
  };
  return target;
}

test('saved Cover layout NONE retains exact inactive layout getters without invalid setters',async()=>{
  const module=await api(),snapshot=layoutSnapshot({...coverLayoutState}),target=strictLayoutTarget();
  assert.equal((await assemble(module,target,snapshot)).status,'assembled');
  const actual=target.page.children[0];
  for(const [field,value]of Object.entries(coverLayoutState))assert.deepEqual(actual[field],value,field);
});

test('layout prerequisites precede active writes regardless of snapshot object order',async()=>{
  const module=await api();
  const props={strokesIncludedInLayout:true,itemReverseZIndex:true,counterAxisSpacing:24,paddingTop:16,itemSpacing:8,layoutWrap:'WRAP',layoutMode:'HORIZONTAL'};
  const snapshot=layoutSnapshot(props),target=strictLayoutTarget();
  assert.equal((await assemble(module,target,snapshot)).status,'assembled');
  for(const [field,value]of Object.entries(props))assert.deepEqual(target.page.children[0][field],value,field);
  await assert.rejects(assemble(module,strictLayoutTarget({rejectField:'strokesIncludedInLayout'}),snapshot),e=>e.code==='TEMPLATE_VALUE_MISMATCH');
});

test('inactive layout differences stop explicitly instead of dropping a saved value',async()=>{
  const module=await api();
  for(const [field,value] of [['strokesIncludedInLayout',true],['itemReverseZIndex',true],['paddingTop',12],['counterAxisSpacing',7],['primaryAxisSizingMode','FIXED']]){
    const target=strictLayoutTarget();
    await assert.rejects(assemble(module,target,layoutSnapshot({...coverLayoutState,[field]:value})),e=>e.code==='UNSUPPORTED_TEMPLATE_LAYOUT_STATE'&&e.message.includes(field)&&e.operationStatus==='rolled_back');
    assert.equal(target.page.children.length,0);
  }
});

function enablePageModes(page){
  page.explicitVariableModes={};
  page.setExplicitVariableModeForCollection=(collection,mode)=>{page.explicitVariableModes={...page.explicitVariableModes,[collection.id]:mode};};
  page.clearExplicitVariableModeForCollection=collection=>{const modes={...page.explicitVariableModes};delete modes[collection.id];page.explicitVariableModes=modes;};
}
test('failed apply restores reused-page modes owned by this operation and preserves concurrent mode edits',async()=>{
  const {module,snapshot}=await capture();
  snapshot.nodes[0].overrides.explicitVariableModes=[{collectionKey:'collection-key',modeName:'Light'}];
  for(const scenario of ['absent','existing','already-saved','concurrent','concurrent-clear','setter-throws-before-write','setter-throws-after-write']){
    const target=fixture();enablePageModes(target.page);
    if(scenario==='existing')target.page.explicitVariableModes={'target-collection':'prior-mode','unrelated-collection':'untouched'};
    if(scenario==='already-saved'){
      target.page.explicitVariableModes={'target-collection':'target-mode'};
      target.page.setExplicitVariableModeForCollection=()=>{throw new Error('unchanged baseline must not be owned or rewritten');};
      target.page.clearExplicitVariableModeForCollection=()=>{throw new Error('unchanged baseline must not be cleared');};
    }
    if(scenario==='setter-throws-after-write'){
      const set=target.page.setExplicitVariableModeForCollection;
      target.page.setExplicitVariableModeForCollection=(collection,mode)=>{set(collection,mode);throw new Error('after page mode write');};
    }else if(scenario==='setter-throws-before-write')target.page.setExplicitVariableModeForCollection=()=>{throw new Error('before page mode write');};
    else target.rejectWrites((node,field,value)=>{
      if(field!=='characters'||value!=='Task link')return false;
      if(scenario==='concurrent')target.page.explicitVariableModes={'target-collection':'user-mode','other-collection':'user-added'};
      if(scenario==='concurrent-clear')target.page.explicitVariableModes={};
      return true;
    });
    await assert.rejects(assemble(module,target,snapshot),e=>{
      if(['concurrent','concurrent-clear'].includes(scenario))return e.operationStatus==='partial'&&e.rollbackErrors.some(message=>message.includes('mode'));
      return e.operationStatus==='rolled_back';
    });
    const expected=scenario==='existing'?{'target-collection':'prior-mode','unrelated-collection':'untouched'}
      :scenario==='already-saved'?{'target-collection':'target-mode'}
      :scenario==='concurrent'?{'target-collection':'user-mode','other-collection':'user-added'}:{};
    assert.deepEqual(target.page.explicitVariableModes,expected,scenario);
    assert.equal(target.page.children.length,0);
  }
});

test('page-mode rollback preserves the original failure when the page is removed or either readback throws',async()=>{
  const {module,snapshot}=await capture();
  snapshot.nodes[0].overrides.explicitVariableModes=[{collectionKey:'collection-key',modeName:'Light'}];
  for(const scenario of ['removed','initial-readback','final-readback']){
    const target=fixture();
    let modes={},broken=false,removedReads=0,foreign;
    Object.defineProperty(target.page,'explicitVariableModes',{get:()=>{
      if(target.page.removed){removedReads++;throw new Error('removed page getter');}
      if(broken)throw new Error(scenario+' getter');
      return modes;
    }});
    target.page.setExplicitVariableModeForCollection=(collection,mode)=>{modes={...modes,[collection.id]:mode};};
    target.page.clearExplicitVariableModeForCollection=collection=>{
      delete modes[collection.id];
      if(scenario==='final-readback')broken=true;
    };
    const failure=Object.assign(new Error('original apply failure'),{code:'ORIGINAL_APPLY_FAILURE'});
    target.rejectWrites((node,field,value)=>{
      if(field==='characters'&&value==='Task link'){
        assert.equal(modes['target-collection'],'target-mode','failure occurs after the owned mode write');
        foreign=target.figma.createPage();foreign.name='Чужая страница';
        if(scenario==='removed')target.page.remove();
        if(scenario==='initial-readback')broken=true;
        throw failure;
      }
      return false;
    });
    await assert.rejects(assemble(module,target,snapshot),error=>{
      assert.equal(error,failure,scenario);
      assert.equal(error.code,'ORIGINAL_APPLY_FAILURE');
      assert.equal(error.operationStatus,'partial');
      assert.equal(error.resourceImportsMayRemain,true);
      assert.ok(error.rollbackErrors.some(message=>message.includes('mode')),scenario);
      if(scenario!=='removed')assert.ok(error.rollbackErrors.some(message=>message.includes(scenario+' getter')));
      return true;
    });
    assert.equal(removedReads,0,'removed page must be guarded before its mode getter');
    assert.equal(foreign.removed,false);assert.ok(target.figma.root.children.includes(foreign));
    assert.equal(target.metadata['codex-library-template-v2']||'','');
  }
});

test('HUG recomputation mismatch reports bounded saved and native geometry through the typed failure without text',async()=>{
  const module=await api(),target=fixture();
  const snapshot=layoutSnapshot({width:3000,height:3964,layoutMode:'VERTICAL',itemSpacing:80,layoutSizingVertical:'HUG'});
  snapshot.nodes[1].name='SECRET_SUMMARY_NAME';
  for(const [i,height] of [1244,779,1781].entries())snapshot.nodes.push({
    sourceId:'child-'+i,path:'0/0/'+i,parentPath:'0/0',type:'FRAME',name:'SECRET_CHILD_NAME',
    props:{width:3000,height,layoutMode:'VERTICAL',layoutSizingVertical:'HUG'},overrides:{},
  });
  // A native-like HUG setter recalculates from content, rather than retaining
  // resize's requested height. This is a diagnostic scenario, not a claimed
  // reproduction of the still-unknown live 0/0.height value.
  const create=target.figma.createFrame;
  target.figma.createFrame=()=>{
    const node=create();let sizing='FIXED';
    node.scaleFactor=2;node.relativeTransform=[[1,0,0],[0,1,0]];
    node.characters='SECRET_TEXT';node.hyperlink={type:'URL',value:'https://SECRET_LINK'};
    Object.defineProperty(node,'layoutSizingVertical',{get:()=>sizing,set:value=>{
      sizing=value;
      if(value==='HUG'&&node.children.length)node.height=node.children.reduce((sum,c)=>sum+c.height,0)+(node.children.length-1)*node.itemSpacing;
      else if(value==='HUG'&&node.height===1244)node.height=1300;
    }});
    return node;
  };
  let failure;try{await assemble(module,target,snapshot);}catch(e){failure=e;}
  assert.equal(failure?.code,'TEMPLATE_VALUE_MISMATCH');
  assert.equal(failure.operationStatus,'rolled_back');
  const wire=toolFailure(failure).structuredContent;
  assert.equal(wire.code,'TEMPLATE_VALUE_MISMATCH');
  assert.match(wire.error,/geometry=/);
  const diagnostic=JSON.parse(wire.error.split('geometry=')[1]);
  assert.equal(diagnostic.path,'0/0');assert.equal(diagnostic.field,'height');
  assert.equal(diagnostic.expected,3964);assert.equal(diagnostic.actual,4020);
  assert.equal(diagnostic.nodes[0].actual.layoutSizingVertical,'HUG');
  assert.equal(diagnostic.nodes.find(n=>n.path==='0/0/0').expected.height,1244);
  assert.equal(diagnostic.nodes.find(n=>n.path==='0/0/0').actual.height,1300);
  assert.equal(diagnostic.nodes.find(n=>n.path==='0/0/1').actual.height,779);
  assert.equal(diagnostic.nodes[0].actual.scaleFactor,2);
  assert.deepEqual(diagnostic.nodes[0].actual.relativeTransform,[[1,0,0],[0,1,0]]);
  assert.equal(wire.error.includes('SECRET_'),false);
  assert.equal(target.page.children.length,0);
});

test('geometry diagnostics bound large neighborhoods and cannot replace the original failure with getter errors',async()=>{
  const module=await api(),target=fixture(),snapshot=layoutSnapshot({width:3000,height:3964});
  for(let i=0;i<30;i++)snapshot.nodes.push({sourceId:'child-'+i,path:'0/0/'+i,parentPath:'0/0',type:'FRAME',name:'private',props:{},overrides:{}});
  const create=target.figma.createFrame;
  target.figma.createFrame=()=>{
    const node=create(),resize=node.resize;
    node.resize=(w,h)=>resize.call(node,w,h===3964?4000:h);
    Object.defineProperty(node,'itemSpacing',{get:()=>{throw new Error('SECRET_NATIVE_ERROR');}});
    return node;
  };
  await assert.rejects(assemble(module,target,snapshot),e=>{
    assert.equal(e.code,'TEMPLATE_VALUE_MISMATCH');assert.equal(e.operationStatus,'rolled_back');
    assert.match(e.message,/geometry=/);
    const diagnostic=JSON.parse(e.message.split('geometry=')[1]);
    assert.equal(diagnostic.actual,4000);assert.equal(diagnostic.truncated,true);
    assert.ok(diagnostic.nodes.length<=16);assert.ok(e.message.length<17000);
    assert.equal(e.message.includes('SECRET_NATIVE_ERROR'),false);
    return true;
  });
});

function emptyHugFixture(source=false,{ignoreSeed=false,ignoreRestore=false,concurrentVisible=false}={}){
  const target=fixture(source);
  function addList(card){
    card.width=3000;card.height=1781;
    const list=target.make('FRAME',{name:'List',width:2600,height:780,layoutMode:'VERTICAL',layoutSizingHorizontal:'FILL',itemSpacing:60},card);
    let vertical='HUG';
    Object.defineProperty(list,'layoutSizingVertical',{get:()=>vertical,set:value=>{if(!(ignoreRestore&&vertical==='FIXED'&&value==='HUG'))vertical=value;}});
    const rows=[0,1].map(i=>{
      const row=target.make('FRAME',{name:'Row'+i,width:2600,height:108},list);
      let visible=!source;
      Object.defineProperty(row,'visible',{get:()=>visible,set:value=>{
        visible=value;
        // All-hidden auto-layout retains the last non-empty height. Native
        // acceptance of resize+restore HUG still requires the controller gate.
        const shown=list.children.filter(c=>c.visible);
        if(shown.length)list.height=shown.length*108+(shown.length-1)*60;
      }});
      return row;
    });
    let cardSizing='HUG';
    Object.defineProperty(card,'layoutSizingVertical',{get:()=>cardSizing,set:value=>{
      cardSizing=value;if(value==='HUG')card.height=1001+list.height;
      if(concurrentVisible)rows[0].visible=true;
    }});
    list.resizeWithoutConstraints=(w,h)=>{
      assert.ok(rows.every(c=>c.visible===false),'fallback resize must follow all descendant visibility writes');
      if(!ignoreSeed){list.width=w;list.height=h;}
      list.layoutSizingHorizontal='FIXED';vertical='FIXED';
      card.height=1001+list.height;
    };
    if(source)card.overrides.push({id:list.id,overriddenFields:['visible']},...rows.map(row=>({id:row.id,overriddenFields:['visible']})));
    target.list=list;target.rows=rows;
    return card;
  }
  if(source)addList(target.card);
  else {const original=target.figma.importComponentByKeyAsync;target.figma.importComponentByKeyAsync=async key=>{
    const component=await original(key);return {...component,createInstance:()=>addList(component.createInstance())};
  };}
  return target;
}
test('capture records only inherited all-hidden HUG frame fallback without source writes',async()=>{
  const module=await api(),source=emptyHugFixture(true),before=source.writes.length;
  const {snapshot}=await executeGenerated(source.figma,module.buildCaptureLibraryTemplateCode({fileKey:source.figma.fileKey,pageIds:[source.page.id]}));
  const list=snapshot.nodes.find(n=>n.name==='List');
  assert.deepEqual(list.emptyHugLayout,{width:2600,height:780,layoutMode:'VERTICAL',layoutSizingHorizontal:'FILL',layoutSizingVertical:'HUG',hiddenChildSourceIds:source.rows.map(n=>n.id)});
  assert.equal(source.writes.length,before);
  source.rows[0].visible=true;
  const {snapshot:visible}=await executeGenerated(source.figma,module.buildCaptureLibraryTemplateCode({fileKey:source.figma.fileKey,pageIds:[source.page.id]}));
  assert.equal(visible.nodes.find(n=>n.name==='List').emptyHugLayout,undefined);
});

test('empty HUG fallback is seeded late, retains FILL/HUG, and managed reuse permits later visible contents',async()=>{
  const module=await api(),source=emptyHugFixture(true);
  const {snapshot}=await executeGenerated(source.figma,module.buildCaptureLibraryTemplateCode({fileKey:source.figma.fileKey,pageIds:[source.page.id]}));
  // Literal metadata keeps assembly regression RED independently of capture.
  snapshot.nodes.find(n=>n.name==='List').emptyHugLayout={width:2600,height:780,layoutMode:'VERTICAL',layoutSizingHorizontal:'FILL',layoutSizingVertical:'HUG',hiddenChildSourceIds:source.rows.map(n=>n.id)};
  const target=emptyHugFixture();
  assert.equal((await assemble(module,target,snapshot)).status,'assembled');
  assert.equal(target.list.height,780);assert.equal(target.list.layoutSizingHorizontal,'FILL');assert.equal(target.list.layoutSizingVertical,'HUG');
  target.rows[0].visible=true;
  const writes=target.writes.length;
  assert.equal((await assemble(module,target,snapshot,'verify')).status,'verified');
  assert.equal((await assemble(module,target,snapshot)).status,'reused');
  assert.equal(target.list.height,108);assert.equal(target.writes.length,writes);
});

test('empty HUG fallback rejects invalid saved guards, concurrent visibility and ignored native seed',async()=>{
  const module=await api(),source=emptyHugFixture(true);
  const {snapshot}=await executeGenerated(source.figma,module.buildCaptureLibraryTemplateCode({fileKey:source.figma.fileKey,pageIds:[source.page.id]}));
  const entry=snapshot.nodes.find(n=>n.name==='List');
  entry.emptyHugLayout={width:2600,height:780,layoutMode:'VERTICAL',layoutSizingHorizontal:'FILL',layoutSizingVertical:'HUG',hiddenChildSourceIds:source.rows.map(n=>n.id)};
  for(const mutate of [n=>n.emptyHugLayout.hiddenChildSourceIds.reverse(),n=>n.emptyHugLayout.layoutSizingVertical='FIXED',n=>n.props.height=10]){
    const invalid=structuredClone(snapshot);mutate(invalid.nodes.find(n=>n.name==='List'));
    const target=emptyHugFixture();target.figma.importStyleByKeyAsync=async()=>assert.fail('invalid fallback must fail before imports');
    await assert.rejects(async()=>assemble(module,target,invalid),e=>e.code==='INVALID_TEMPLATE_EMPTY_HUG'&&e.operationStatus==='not_applied');
    assert.equal(target.page.children.length,0);
  }
  await assert.rejects(assemble(module,emptyHugFixture(false,{concurrentVisible:true}),snapshot),e=>e.code==='TEMPLATE_EMPTY_HUG_GUARD'&&e.operationStatus==='rolled_back');
  await assert.rejects(assemble(module,emptyHugFixture(false,{ignoreSeed:true}),snapshot),e=>e.code==='TEMPLATE_VALUE_MISMATCH'&&e.operationStatus==='rolled_back');
  await assert.rejects(assemble(module,emptyHugFixture(false,{ignoreRestore:true}),snapshot),e=>e.code==='TEMPLATE_VALUE_MISMATCH'&&e.operationStatus==='rolled_back');
});

// The native boundary recomputes HUG from children on every read. Literal saved
// heights are independent historical measurements, including 780 -> 108 live.
function naturalHugScenario({naturalHeight=108,wrongDelta=0,drift=false,guard,policy='natural',readonlyProof=false,proofDrift}={}) {
  const target=fixture(),nodes=[];
  const vertical={layoutMode:'VERTICAL',layoutWrap:'NO_WRAP',layoutSizingVertical:'HUG',primaryAxisAlignItems:'MIN',counterAxisAlignItems:'MIN',paddingTop:0,paddingBottom:0,paddingLeft:0,paddingRight:0,itemSpacing:0,strokesIncludedInLayout:false,minHeight:null,maxHeight:null};
  function entry(path,type,name,props,overrides={}) {const n={sourceId:'saved-'+path,path,parentPath:path.includes('/')?path.slice(0,path.lastIndexOf('/')):null,type,name,props,overrides};nodes.push(n);return n;}
  const geom=(x,y,width,height)=>({x,y,width,height,rotation:0,visible:true,layoutPositioning:'AUTO',layoutSizingVertical:'HUG'});
  entry('0','PAGE','Master',{});
  entry('0/0','FRAME','Summary',{...vertical,...geom(0,838,3000,3964),itemSpacing:80,layoutSizingHorizontal:'HUG'});
  entry('0/0/0','FRAME','Card',geom(0,0,3000,1244),{height:1244,width:3000});
  entry('0/0/1','FRAME','Description',geom(0,1324,3000,779),{height:779,width:3000});
  entry('0/0/2','INSTANCE','Links',{...vertical,...geom(0,2183,3000,1781),layoutSizingHorizontal:'FIXED',itemSpacing:120,paddingTop:200,paddingBottom:200,paddingLeft:200,paddingRight:200}).libraryKey='links-key';
  entry('0/0/2/0','FRAME','Title',geom(200,200,2600,481));
  const list=entry('0/0/2/1','FRAME','List',{...vertical,x:200,y:801,rotation:0,visible:true,layoutPositioning:'AUTO',layoutSizingHorizontal:'FILL',itemSpacing:60});
  list.emptyHugLayout={policy,width:2600,height:780,layoutMode:'VERTICAL',layoutSizingHorizontal:'FILL',layoutSizingVertical:'HUG',hiddenChildSourceIds:Array.from({length:12},(_,i)=>'saved-0/0/2/1/'+i)};
  for(let i=0;i<12;i++)entry('0/0/2/1/'+i,'FRAME','Row'+i,{}, {visible:false});
  entry('0/1','FRAME','Cover',{x:3300,y:838,width:711,height:400});
  const snapshot={schemaVersion:2,sourceFileKey:'source-file',pages:[{sourceId:'saved-0',path:'0',name:'Master'}],nodes,resources:{styles:[],variables:[],collections:[]},fonts:[]};
  if(readonlyProof)for(const n of nodes.filter(n=>['Title','List'].includes(n.name))){n.geometryProof=n.props;n.props={};}
  function native(node) {
    node.layoutPositioning='AUTO';node.minHeight=null;node.maxHeight=null;
    let height=node.height;
    Object.defineProperty(node,'height',{configurable:true,get:()=>{
      if(node.name==='List'&&node.layoutSizingVertical==='HUG'){
        const shown=node.children.filter(c=>c.visible);
        return shown.length?shown.reduce((sum,c)=>sum+c.height,0)+(shown.length-1)*node.itemSpacing:naturalHeight;
      }
      if(node.layoutSizingVertical==='HUG'&&node.children.length){
        const shown=node.children.filter(c=>c.visible);
        return node.paddingTop+node.paddingBottom+shown.reduce((sum,c)=>sum+c.height,0)+Math.max(0,shown.length-1)*node.itemSpacing+(node.name==='Links'?wrongDelta:0);
      }
      return height+(drift&&node.name==='Card'?1:0);
    },set:v=>{height=v;}});
    return node;
  }
  const create=target.figma.createFrame;target.figma.createFrame=()=>native(create());
  let resizeCalls=0;
  target.figma.importComponentByKeyAsync=async key=>{
    assert.equal(key,'links-key');return {key,type:'COMPONENT',createInstance:()=>{
      const links=native(target.make('INSTANCE',{...vertical,name:'Links',width:3000,layoutSizingHorizontal:'FIXED'}));
      if(guard==='ancestorBinding')links.boundVariables={height:{type:'VARIABLE_ALIAS',id:'unexpected'}};
      if(guard==='scale')links.scaleFactor=2;
      links.getMainComponentAsync=async()=>({key:guard==='identity'?'wrong-key':key});
      const title=target.make('FRAME',{name:'Title',x:200,y:200,width:2600,height:481,layoutSizingVertical:'HUG',layoutPositioning:'AUTO'},links);
      const actualList=native(target.make('FRAME',{...vertical,name:'List',x:200,y:801,width:2600,layoutSizingHorizontal:'FILL',itemSpacing:60},links));
      if(readonlyProof)for(const n of [title,actualList])for(const field of Object.keys(nodes.find(s=>s.name===n.name).geometryProof)){
        const inherited=proofDrift?.node===n.name&&proofDrift.field===field?proofDrift.value:n[field];
        Object.defineProperty(n,field,{configurable:true,get:()=>inherited,set:()=>{throw new Error('set_'+field+' cannot be overridden in instance: relative-transform');}});
      }
      for(let i=0;i<12;i++)target.make('FRAME',{name:'Row'+i,width:2600,height:108},actualList);
      actualList.resize=()=>{resizeCalls++;};
      actualList.resizeWithoutConstraints=()=>{resizeCalls++;};
      if(guard==='mode')Object.defineProperty(actualList,'layoutSizingVertical',{get:()=> 'FIXED',set:()=>{}});
      if(guard==='visible')Object.defineProperty(actualList.children[0],'visible',{get:()=>true,set:()=>{}});
      if(guard==='binding')actualList.boundVariables={height:{type:'VARIABLE_ALIAS',id:'unexpected'}};
      if(guard==='width')actualList.width=2601;
      if(guard==='position')Object.defineProperty(actualList,'x',{get:()=>201,set:()=>{}});
      target.list=actualList;return links;
    }};
  };
  return {target,snapshot,resizeCalls:()=>resizeCalls};
}

test('natural empty HUG accepts measured and variant extents with exact dependent deltas and no resize',async()=>{
  const module=await api();
  for(const [height,links,summary,delta] of [[108,1109,3292,-672],[156,1157,3340,-624]]) {
    const s=naturalHugScenario({naturalHeight:height}),result=await assemble(module,s.target,s.snapshot);
    assert.equal(result.status,'assembled');assert.equal(s.resizeCalls(),0);
    assert.equal(s.target.list.height,height);
    assert.equal(s.target.list.layoutSizingVertical,'HUG');assert.equal(s.target.list.layoutSizingHorizontal,'FILL');
    assert.equal(s.target.list.parent.height,links);assert.equal(s.target.page.children[0].height,summary);
    assert.deepEqual(result.verification.naturalHugDeltas,[{path:'0/0/2/1',before:780,after:height,delta,ancestors:['0/0/2','0/0']}]);
    s.target.list.children[0].visible=true;
    const count=s.target.nodes.size,writes=s.target.writes.length;
    s.target.figma.importComponentByKeyAsync=()=>assert.fail('reuse must not import');
    assert.equal((await assemble(module,s.target,s.snapshot,'verify')).status,'verified');
    assert.equal((await assemble(module,s.target,s.snapshot)).status,'reused');
    assert.equal(s.target.nodes.size,count);assert.equal(s.target.writes.length,writes);assert.equal(s.resizeCalls(),0);assert.equal(s.target.list.children[0].visible,true);
  }
});

test('read-only geometry proof assembles inherited fields without setters and still rejects native drift',async()=>{
  const module=await api();
  const s=naturalHugScenario({readonlyProof:true});
  assert.equal((await assemble(module,s.target,s.snapshot)).status,'assembled');
  s.target.list.children[0].visible=true;
  const count=s.target.nodes.size,writes=s.target.writes.length;
  assert.equal((await assemble(module,s.target,s.snapshot,'verify')).status,'verified');
  assert.equal((await assemble(module,s.target,s.snapshot)).status,'reused');
  assert.equal(s.target.nodes.size,count);assert.equal(s.target.writes.length,writes);
  for(const proofDrift of [{node:'Title',field:'rotation',value:1},{node:'Title',field:'x',value:201},{node:'Title',field:'height',value:482},{node:'List',field:'itemSpacing',value:61}]){
    const d=naturalHugScenario({readonlyProof:true,proofDrift});
    await assert.rejects(assemble(module,d.target,d.snapshot),e=>e.code==='TEMPLATE_VALUE_MISMATCH'&&e.operationStatus==='rolled_back');
  }
});

test('geometry proof rejects conflicting writes, malformed and unrelated evidence before imports',async()=>{
  const module=await api();
  for(const mutate of [
    s=>s.nodes.find(n=>n.name==='Title').props.rotation=90,
    s=>s.nodes.find(n=>n.name==='Title').overrides.x=201,
    s=>s.nodes.find(n=>n.name==='List').geometryProof.height=779,
    s=>s.nodes.find(n=>n.name==='Title').geometryProof.rotation='0',
    s=>s.nodes.find(n=>n.name==='Title').geometryProof.opacity=1,
    s=>s.nodes.find(n=>n.name==='Title').geometryProof={},
    s=>s.nodes.find(n=>n.name==='Cover').geometryProof={rotation:0},
  ]){
    const s=naturalHugScenario({readonlyProof:true});mutate(s.snapshot);
    s.target.figma.importComponentByKeyAsync=()=>assert.fail('invalid evidence must fail before imports');
    await assert.rejects(async()=>assemble(module,s.target,s.snapshot),e=>e.operationStatus==='not_applied'&&(e.name==='ZodError'||['INVALID_TEMPLATE_GEOMETRY_PROOF','UNSUPPORTED_TEMPLATE_NATURAL_HUG'].includes(e.code)));
  }
});

test('intentional inherited transform writes remain native errors rather than silently suppressed',async()=>{
  const module=await api(),s=naturalHugScenario({readonlyProof:true});
  const title=s.snapshot.nodes.find(n=>n.name==='Title');
  title.props.rotation=title.geometryProof.rotation;
  await assert.rejects(assemble(module,s.target,s.snapshot),e=>e.message.includes('set_rotation cannot be overridden in instance: relative-transform')&&e.operationStatus==='rolled_back');
});

test('natural empty HUG rejects wrong dependent delta, unrelated drift, guard failures and invalid dimensions',async()=>{
  const module=await api();
  for(const options of [{wrongDelta:1},{drift:true},{guard:'mode'},{guard:'visible'},{guard:'identity'},{guard:'binding'},{guard:'ancestorBinding'},{guard:'scale'},{guard:'width'},{guard:'position'},{naturalHeight:NaN},{naturalHeight:0},{naturalHeight:Infinity}]) {
    const s=naturalHugScenario(options);
    await assert.rejects(assemble(module,s.target,s.snapshot),e=>['TEMPLATE_VALUE_MISMATCH','TEMPLATE_EMPTY_HUG_GUARD','TEMPLATE_STRUCTURE_MISMATCH','UNSUPPORTED_TEMPLATE_NATURAL_HUG'].includes(e.code)&&e.operationStatus==='rolled_back',JSON.stringify(options));
  }
});

test('natural empty HUG rejects explicit size conflicts and unsupported dependency layouts',async()=>{
  const module=await api();
  for(const mutate of [
    s=>s.nodes.find(n=>n.name==='Links').overrides.height=1781,
    s=>s.nodes.find(n=>n.name==='List').overrides.height=780,
    s=>s.nodes.find(n=>n.name==='Links').props.layoutWrap='WRAP',
    s=>s.nodes.find(n=>n.name==='Links').props.primaryAxisAlignItems='CENTER',
    s=>s.nodes.find(n=>n.name==='Links').props.minHeight=100,
    s=>s.nodes.find(n=>n.name==='Links').props.layoutSizingVertical='FIXED',
    s=>delete s.nodes.find(n=>n.name==='Links').props.itemSpacing,
    s=>s.nodes.find(n=>n.name==='Title').props.rotation=90,
    s=>s.nodes.find(n=>n.name==='Title').props.layoutPositioning='ABSOLUTE',
    s=>s.nodes.find(n=>n.name==='Title').props.layoutSizingVertical='FILL',
    s=>delete s.nodes.find(n=>n.name==='Title').props.layoutSizingVertical,
    s=>s.nodes.find(n=>n.name==='Title').props.height=480,
    s=>s.nodes.splice(-1,0,{sourceId:'extra',path:'0/0/2/2',parentPath:'0/0/2',type:'FRAME',name:'Extra',props:{},overrides:{}}),
    s=>s.nodes.find(n=>n.name==='List').emptyHugLayout.policy='permissive',
  ]) {
    const s=naturalHugScenario();mutate(s.snapshot);
    await assert.rejects(async()=>assemble(module,s.target,s.snapshot));
  }
});

test('strict empty HUG retains rejection when native natural height cannot restore the historical extent',async()=>{
  const module=await api();
  for(const policy of ['strict',undefined]) {
    const s=naturalHugScenario({policy});if(policy===undefined)delete s.snapshot.nodes.find(n=>n.name==='List').emptyHugLayout.policy;
    await assert.rejects(assemble(module,s.target,s.snapshot),e=>e.code==='TEMPLATE_VALUE_MISMATCH');
    assert.equal(s.resizeCalls(),1);
  }
});
