import { createHash } from 'node:crypto';
import { z } from 'zod';
import { compileOperation } from './scene-access.mjs';

const jsonValue = z.lazy(() => z.union([z.string(), z.number().finite(), z.boolean(), z.null(), z.array(jsonValue), z.record(jsonValue)]));
const id = z.string().min(1).max(300);
const properties = z.record(jsonValue);
// Saved getters used only as evidence, never as property assignments.
const geometryProofSchema=z.object({
  x:z.number().finite(),y:z.number().finite(),width:z.number().finite().positive(),height:z.number().finite().positive(),rotation:z.number().finite(),visible:z.boolean(),
  layoutMode:z.enum(['NONE','HORIZONTAL','VERTICAL']),layoutWrap:z.enum(['NO_WRAP','WRAP']),layoutSizingHorizontal:z.enum(['FIXED','FILL','HUG']),layoutSizingVertical:z.enum(['FIXED','FILL','HUG']),layoutPositioning:z.enum(['AUTO','ABSOLUTE']),
  primaryAxisAlignItems:z.enum(['MIN','MAX','CENTER','SPACE_BETWEEN']),counterAxisAlignItems:z.enum(['MIN','MAX','CENTER','BASELINE']),
  itemSpacing:z.number().finite().nonnegative(),paddingTop:z.number().finite().nonnegative(),paddingRight:z.number().finite().nonnegative(),paddingBottom:z.number().finite().nonnegative(),paddingLeft:z.number().finite().nonnegative(),
  minHeight:z.number().finite().nonnegative().nullable(),maxHeight:z.number().finite().nonnegative().nullable(),strokesIncludedInLayout:z.boolean(),
}).partial().strict().refine(value=>Object.keys(value).length>0,'Geometry proof must be nonempty');
const emptyHugLayoutSchema=z.object({policy:z.enum(['strict','natural']).optional(),width:z.number().finite().positive(),height:z.number().finite().positive(),layoutMode:z.enum(['HORIZONTAL','VERTICAL']),layoutSizingHorizontal:z.enum(['FIXED','FILL','HUG']),layoutSizingVertical:z.enum(['FIXED','FILL','HUG']),hiddenChildSourceIds:z.array(id).min(1).max(1000)}).strict();
const nodeSchema = z.object({ sourceId:id, path:id, parentPath:id.nullable(), type:id, name:z.string().max(1000), libraryKey:id.optional(), statusVariants:z.object({setKey:id,variants:z.array(z.object({key:id,name:id,value:id}).strict()).min(1).max(100)}).strict().optional(), emptyHugLayout:emptyHugLayoutSchema.optional(), geometryProof:geometryProofSchema.optional(), props:properties, overrides:properties }).strict();
export const libraryTemplateSnapshotSchema = z.object({
  schemaVersion:z.literal(2), sourceFileKey:id,
  pages:z.array(z.object({sourceId:id,path:id,name:z.string().max(1000)}).strict()).min(1).max(20),
  nodes:z.array(nodeSchema).min(1).max(1000),
  resources:z.object({
    styles:z.array(z.object({key:id,type:z.enum(['PAINT','TEXT','EFFECT','GRID'])}).strict()).max(1000),
    variables:z.array(z.object({key:id,collectionKey:id,resolvedType:id}).strict()).max(1000),
    collections:z.array(z.object({key:id,anchorVariableKey:id,modes:z.array(z.string().max(200)).max(100)}).strict()).max(1000),
  }).strict(),
  fonts:z.array(z.object({family:id,style:id}).strict()).max(1000),
}).strict();
export const captureLibraryTemplateInputSchema = {fileKey:id,pageIds:z.array(id).min(1).max(20)};
export const captureLibraryTemplateSchema = z.object(captureLibraryTemplateInputSchema).strict();
export const assembleLibraryTemplateInputSchema = {fileKey:id,snapshot:libraryTemplateSnapshotSchema,mode:z.enum(['apply','verify'])};
export const assembleLibraryTemplateSchema = z.object(assembleLibraryTemplateInputSchema).strict();

// Kept inside a function because the same contract executes in the native sandbox.
function templateContract(snapshot) {
  const outer = ['x','y','width','height','rotation','visible','locked','opacity','fills','strokes','effects','fillStyleId','strokeStyleId','effectStyleId',
    'layoutMode','layoutWrap','itemSpacing','counterAxisSpacing','paddingTop','paddingRight','paddingBottom','paddingLeft','primaryAxisAlignItems','counterAxisAlignItems',
    'primaryAxisSizingMode','counterAxisSizingMode','layoutSizingHorizontal','layoutSizingVertical','layoutPositioning','layoutAlign','layoutGrow','constraints',
    'minWidth','maxWidth','minHeight','maxHeight','clipsContent','cornerRadius','topLeftRadius','topRightRadius','bottomLeftRadius','bottomRightRadius','cornerSmoothing',
    'strokeWeight','strokeAlign','strokeTopWeight','strokeRightWeight','strokeBottomWeight','strokeLeftWeight','dashPattern','blendMode','strokesIncludedInLayout','itemReverseZIndex',
    'boundVariables','explicitVariableModes'];
  const text = ['characters','fontName','fontSize','textStyleId','hyperlink','styledTextSegments','textDecoration','textDecorationSkipInk','textCase','letterSpacing','lineHeight',
    'textAutoResize','textAlignHorizontal','textAlignVertical','paragraphSpacing','paragraphIndent'];
  const range = ['fontName','fontSize','fills','fillStyleId','textStyleId','textCase','textDecoration','textDecorationSkipInk','letterSpacing','lineHeight','hyperlink','boundVariables'];
  const allowed = [...outer,...text,'name'];
  const directBindingFields = ['width','height','minWidth','maxWidth','minHeight','maxHeight','opacity','visible','itemSpacing','counterAxisSpacing',
    'paddingTop','paddingRight','paddingBottom','paddingLeft','topLeftRadius','topRightRadius','bottomLeftRadius','bottomRightRadius','strokeWeight'];
  const error = (code, message) => { const e = new Error(code + ': ' + message); e.code=code; e.operationStatus='not_applied'; throw e; };
  const canonical = value => JSON.stringify(value && typeof value==='object' ? Array.isArray(value) ? value.map(v=>JSON.parse(canonical(v))) : Object.fromEntries(Object.keys(value).sort().map(k=>[k,JSON.parse(canonical(value[k]))])) : value);
  if (!snapshot) return {outer,text,range,allowed,directBindingFields,error,canonical};
  if (JSON.stringify(snapshot).length>2_000_000) error('INVALID_TEMPLATE','Snapshot exceeds 2 MB');
  const paths=new Map(), ids=new Set();
  for(const n of snapshot.nodes){
    if(paths.has(n.path)||ids.has(n.sourceId))error('INVALID_TEMPLATE','Duplicate node identity');
    if(!/^\d+(\/\d+)*$/.test(n.path)||n.path.split('/').length>33)error('INVALID_TEMPLATE','Invalid path/depth '+n.path);
    if(!['PAGE','FRAME','SECTION','INSTANCE','TEXT','GROUP','VECTOR','RECTANGLE','ELLIPSE','LINE','POLYGON','STAR','BOOLEAN_OPERATION'].includes(n.type))error('UNSUPPORTED_TEMPLATE_NODE',n.type);
    if((n.type==='INSTANCE')!==Boolean(n.libraryKey))error('INVALID_TEMPLATE','Instance library key required '+n.path);
    if(n.statusVariants&&(!n.libraryKey||!n.statusVariants.variants.some(v=>v.key===n.libraryKey)||new Set(n.statusVariants.variants.map(v=>v.key)).size!==n.statusVariants.variants.length))error('INVALID_TEMPLATE','Status variant identities');
    if(n.parentPath!==null&&!paths.has(n.parentPath))error('INVALID_TEMPLATE','Parent must precede child '+n.path);
    const parent=paths.get(n.parentPath);
    if(n.parentPath!==null&&n.path.slice(0,n.path.lastIndexOf('/'))!==n.parentPath)error('INVALID_TEMPLATE','Path parent mismatch');
    let inside=false; for(let p=parent;p;p=paths.get(p.parentPath))if(p.type==='INSTANCE')inside=true;
    if(!inside&&!['PAGE','FRAME','SECTION','INSTANCE'].includes(n.type))error('UNSUPPORTED_TEMPLATE_NODE','Only containers outside instances: '+n.path);
    if(n.type==='PAGE'&&n.parentPath!==null)error('INVALID_TEMPLATE','Nested page');
    for(const [field,value] of Object.entries(n.geometryProof||{}))for(const saved of [n.props,n.overrides,n.emptyHugLayout||{}]){
      if(saved[field]!==undefined&&canonical(saved[field])!==canonical(value))error('INVALID_TEMPLATE_GEOMETRY_PROOF',n.path+' conflicting '+field);
    }
    const savedValues={...n.geometryProof,...n.props,...n.overrides};
    if(n.emptyHugLayout){
      const g=n.emptyHugLayout;
      if(g.policy!==undefined&&!['strict','natural'].includes(g.policy))error('INVALID_TEMPLATE_EMPTY_HUG',n.path+' invalid policy');
      if(n.type!=='FRAME'||!inside||!['HORIZONTAL','VERTICAL'].includes(g.layoutMode)||![g.layoutSizingHorizontal,g.layoutSizingVertical].includes('HUG')||![g.width,g.height].every(v=>Number.isFinite(v)&&v>0))error('INVALID_TEMPLATE_EMPTY_HUG',n.path+' requires an inherited auto-layout HUG frame');
      for(const field of ['width','height','layoutMode','layoutSizingHorizontal','layoutSizingVertical'])if(savedValues[field]!==undefined&&savedValues[field]!==g[field])error('INVALID_TEMPLATE_EMPTY_HUG',n.path+' conflicting '+field);
    }
    function validateSkipInk(value,path){
      if(!Object.prototype.hasOwnProperty.call(value,'textDecorationSkipInk'))return;
      if(n.type!=='TEXT'||(value.textDecorationSkipInk!==null&&typeof value.textDecorationSkipInk!=='boolean'))error('INVALID_TEMPLATE_DECORATION',path+' requires boolean or a supported non-underlined null');
      // Figma getters use null for a decoration option that is not applicable;
      // setters still require boolean. Require explicit saved decoration evidence
      // rather than treating unknown/mixed formatting as absence of underline.
      if(value.textDecorationSkipInk===null&&!['NONE','STRIKETHROUGH'].includes(value.textDecoration))error('INVALID_TEMPLATE_DECORATION',path+' null requires explicit NONE or STRIKETHROUGH');
    }
    validateSkipInk(savedValues,n.path);
    for(const [i,run] of (savedValues.styledTextSegments||[]).entries()){
      validateSkipInk(run,n.path+' range '+i);
      if(savedValues.textDecorationSkipInk===null&&!['NONE','STRIKETHROUGH'].includes(run.textDecoration))error('INVALID_TEMPLATE_DECORATION',n.path+' scalar null conflicts with range decoration');
    }
    for(const [field,value] of Object.entries({...n.props,...n.overrides})){
      if(!allowed.includes(field))error('UNSUPPORTED_TEMPLATE_PROPERTY',n.path+'.'+field);
      if(field==='boundVariables')for(const [binding,alias] of Object.entries(value)){
        if(!directBindingFields.includes(binding)||!alias||Array.isArray(alias)||alias.type!=='VARIABLE_ALIAS'||!alias.key||Object.keys(alias).some(k=>!['type','key'].includes(k)))error('UNSUPPORTED_TEMPLATE_BINDING',n.path+'.'+binding);
      }
      if(field==='layoutMode'&&!['NONE','HORIZONTAL','VERTICAL'].includes(value))error('UNSUPPORTED_TEMPLATE_PROPERTY','Grid layout');
      if(field==='styledTextSegments'){
        if(n.type!=='TEXT'||!Array.isArray(value))error('INVALID_TEMPLATE','Text ranges');
        let end=0;for(const r of value){if(!Number.isInteger(r.start)||r.start!==end||!Number.isInteger(r.end)||r.end<=r.start)error('INVALID_TEMPLATE','Non-contiguous text ranges');end=r.end;for(const f of Object.keys(r))if(!['start','end',...range].includes(f))error('UNSUPPORTED_TEMPLATE_PROPERTY','Text range '+f);}
        if(typeof n.overrides.characters==='string'&&end!==n.overrides.characters.length)error('INVALID_TEMPLATE','Range coverage');
      }
    }
    paths.set(n.path,n);ids.add(n.sourceId);
  }
  // Natural geometry has a deliberately small proof domain: a visible trailing
  // child through vertical, non-wrapping MIN/HUG parents up to a page. No sibling
  // moves and no cross-axis size changes are authorized. All proof inputs must
  // be saved explicitly; missing inherited layout is not inferred from a target.
  const naturalHugChains=[],proofPaths=new Set();
  const values=n=>({...n.emptyHugLayout,...n.geometryProof,...n.props,...n.overrides});
  function unsupported(n,reason){error('UNSUPPORTED_TEMPLATE_NATURAL_HUG',n.path+' '+reason);}
  function unboundHeight(n){
    const v=values(n);
    if(n.overrides.height!==undefined||['height','minHeight','maxHeight'].some(f=>v.boundVariables?.[f]))unsupported(n,'explicit height override or binding');
  }
  function verticalHug(n){
    const v=values(n);unboundHeight(n);
    if(v.layoutMode!=='VERTICAL'||v.layoutWrap!=='NO_WRAP'||v.layoutSizingVertical!=='HUG'||v.primaryAxisAlignItems!=='MIN'||v.counterAxisAlignItems!=='MIN'||v.rotation!==0||v.visible!==true||v.strokesIncludedInLayout!==false||v.minHeight!==null||v.maxHeight!==null)unsupported(n,'requires saved unbounded vertical MIN/HUG layout');
    if(!['width','height'].every(f=>Number.isFinite(v[f])&&v[f]>0)||!['itemSpacing','paddingTop','paddingBottom','paddingLeft','paddingRight'].every(f=>Number.isFinite(v[f])&&v[f]>=0))unsupported(n,'requires saved finite geometry and spacing');
    return v;
  }
  for(const n of snapshot.nodes.filter(n=>n.emptyHugLayout?.policy==='natural')){
    proofPaths.add(n.path);
    verticalHug(n);
    if(!['FIXED','FILL'].includes(values(n).layoutSizingHorizontal))unsupported(n,'cross-axis HUG is unsupported');
    const ancestors=[];
    for(let child=n,parent=paths.get(child.parentPath);parent&&parent.type!=='PAGE';child=parent,parent=paths.get(parent.parentPath)){
      const v=verticalHug(parent),siblings=snapshot.nodes.filter(s=>s.parentPath===parent.path);
      proofPaths.add(parent.path);
      if(siblings.at(-1)!==child)unsupported(child,'requires the last child at every dependency level');
      let y=v.paddingTop;
      for(const sibling of siblings){
        proofPaths.add(sibling.path);
        const s=values(sibling);
        if(s.visible!==true||s.layoutPositioning!=='AUTO'||s.rotation!==0||!['FIXED','HUG'].includes(s.layoutSizingVertical)||!['width','height'].every(f=>Number.isFinite(s[f])&&s[f]>0)||!Number.isFinite(s.x)||s.y!==y)unsupported(sibling,'requires explicit ordinary child geometry');
        y+=s.height+v.itemSpacing;
      }
      if(y-v.itemSpacing+v.paddingBottom!==v.height)unsupported(parent,'saved height is not the sum of saved child extents, gap and padding');
      ancestors.push(parent.path);
    }
    naturalHugChains.push({path:n.path,ancestors});
  }
  for(const n of snapshot.nodes)if(n.geometryProof&&!proofPaths.has(n.path))error('INVALID_TEMPLATE_GEOMETRY_PROOF',n.path+' evidence outside natural dependency proof');
  const roots=snapshot.nodes.filter(n=>n.parentPath===null);
  if(roots.length!==snapshot.pages.length)error('INVALID_TEMPLATE','Page count');
  snapshot.pages.forEach((p,i)=>{const n=roots[i];if(p.path!==String(i)||n.type!=='PAGE'||n.path!==p.path||n.sourceId!==p.sourceId||n.name!==p.name)error('INVALID_TEMPLATE','Page identity');});
  for(const n of snapshot.nodes){const children=snapshot.nodes.filter(c=>c.parentPath===n.path);children.forEach((c,i)=>{if(c.path!==n.path+'/'+i)error('INVALID_TEMPLATE','Child order');});
    if(n.emptyHugLayout){
      const ids=n.emptyHugLayout.hiddenChildSourceIds;
      if(!Array.isArray(ids)||!ids.length||canonical(ids)!==canonical(children.map(c=>c.sourceId))||children.some(c=>{const visible={...c.props,...c.overrides}.visible;return visible!==undefined&&visible!==false;}))error('INVALID_TEMPLATE_EMPTY_HUG',n.path+' requires exact ordered hidden children');
    }
  }
  for(const group of Object.values(snapshot.resources)){const keys=new Set();for(const r of group){if(keys.has(r.key))error('INVALID_TEMPLATE','Duplicate resource key '+r.key);keys.add(r.key);}}
  const resources=snapshot.resources;
  function refs(v){if(!v||typeof v!=='object')return;
    if(v.type==='VARIABLE_ALIAS'&&(!v.key||v.id||!resources.variables.some(r=>r.key===v.key)))error('INVALID_TEMPLATE','Nonportable variable');
    if(v.styleKey&&!resources.styles.some(r=>r.key===v.styleKey))error('INVALID_TEMPLATE','Unknown style key');
    if(v.type==='IMAGE'||v.type==='VIDEO')error('UNSUPPORTED_TEMPLATE_PROPERTY','Image/video resource');
    if(v.type==='NODE'&&v.value)error('UNSUPPORTED_TEMPLATE_PROPERTY','Source node hyperlink');
    for(const x of Object.values(v))refs(x);
  }
  for(const n of snapshot.nodes){refs(n.props);refs(n.overrides);}
  for(const c of resources.collections)if(!resources.variables.some(v=>v.key===c.anchorVariableKey&&v.collectionKey===c.key))error('INVALID_TEMPLATE','Collection anchor');
  return {outer,text,range,allowed,directBindingFields,error,canonical,naturalHugChains};
}

async function libraryTemplateOperation(figma,input,access) {
  const contract = CONTRACT_FUNCTION;
  const {outer,range,allowed,directBindingFields,error,canonical}=contract();
  const read=(promise,label)=>access.read(promise,label);
  const keyOf=async n=>{const c=await read(n.getMainComponentAsync(),'mainComponent '+n.id);if(!c?.key)error('LIBRARY_COMPONENT_UNAVAILABLE',n.id);return c.key;};
  if(input.fileKey!==figma.fileKey)error('TARGET_FILE_MISMATCH','Actual Plugin API fileKey does not match input');
  if(input.capture){
    const snapshot={schemaVersion:2,sourceFileKey:figma.fileKey,pages:[],nodes:[],resources:{styles:[],variables:[],collections:[]},fonts:[]};
    const nodes=new Map(), entries=new Map(), declarations=new Map();
    const styles=new Map(),variables=new Map(),collections=new Map();
    const font=f=>{if(!f||typeof f==='symbol'||!f.family||!f.style)error('UNSUPPORTED_TEMPLATE_PROPERTY','Unresolved font');if(!snapshot.fonts.some(x=>x.family===f.family&&x.style===f.style))snapshot.fonts.push(f);};
    async function variableById(id){
      const v=await read(figma.variables.getVariableByIdAsync(id),'variable '+id);if(!v?.key)error('VARIABLE_UNAVAILABLE',id);
      const c=await read(figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId),'collection '+v.variableCollectionId);if(!c?.key)error('VARIABLE_COLLECTION_UNAVAILABLE',v.variableCollectionId);
      variables.set(v.key,{key:v.key,collectionKey:c.key,resolvedType:v.resolvedType});
      if(!collections.has(c.key))collections.set(c.key,{key:c.key,anchorVariableKey:v.key,modes:[]});
      return {type:'VARIABLE_ALIAS',key:v.key};
    }
    async function portable(value,field){
      if(typeof value==='symbol')error('UNSUPPORTED_TEMPLATE_PROPERTY','Mixed '+field+' requires text ranges');
      if(value===undefined)error('UNSUPPORTED_TEMPLATE_PROPERTY','Unavailable property '+field);
      if(field.endsWith('StyleId')){
        if(value==='')return '';
        const s=await read(figma.getStyleByIdAsync(value),'style '+value);if(!s?.key)error('STYLE_UNAVAILABLE',value);
        styles.set(s.key,{key:s.key,type:s.type});return {styleKey:s.key};
      }
      if(value?.type==='VARIABLE_ALIAS')return variableById(value.id);
      if(value?.type==='IMAGE'||value?.type==='VIDEO')error('UNSUPPORTED_TEMPLATE_PROPERTY',field+' image/video');
      if(value?.type==='NODE')error('UNSUPPORTED_TEMPLATE_PROPERTY','Internal hyperlink '+field);
      if(Array.isArray(value))return Promise.all(value.map(v=>portable(v,'')));
      if(value&&typeof value==='object'){const result={};for(const [k,v] of Object.entries(value))result[k]=await portable(v,k);return result;}
      return value;
    }
    async function modes(node){
      const result=[];
      for(const [collectionId,modeId] of Object.entries(node.explicitVariableModes||{})){
        const c=await read(figma.variables.getVariableCollectionByIdAsync(collectionId),'collection '+collectionId);
        const mode=c?.modes.find(m=>m.modeId===modeId);if(!c?.key||!mode)error('VARIABLE_MODE_UNAVAILABLE',collectionId+' '+modeId);
        if(!collections.has(c.key)){
          let anchor;
          if(c.variableIds?.length){for(const id of c.variableIds.slice(0,1000)){const v=await read(figma.variables.getVariableByIdAsync(id),'collection anchor '+id);if(v?.variableCollectionId===collectionId&&v.key){anchor=v;break;}}}
          else anchor=(await read(figma.variables.getLocalVariablesAsync(),'collection anchors')).find(v=>v?.variableCollectionId===collectionId&&v.key);
          if(anchor)await variableById(anchor.id);
          else{
            const published=await read(figma.teamLibrary.getVariablesInLibraryCollectionAsync(c.key),'published collection anchor '+c.key);
            const candidate=published.find(v=>v.key&&v.resolvedType);
            if(!candidate)error('VARIABLE_COLLECTION_ANCHOR_UNAVAILABLE',c.key);
            variables.set(candidate.key,{key:candidate.key,collectionKey:c.key,resolvedType:candidate.resolvedType});
            collections.set(c.key,{key:c.key,anchorVariableKey:candidate.key,modes:[]});
          }
        }
        const saved=collections.get(c.key);if(!saved.modes.includes(mode.name))saved.modes.push(mode.name);
        if(c.modes.filter(m=>m.name===mode.name).length!==1)error('VARIABLE_MODE_AMBIGUOUS',mode.name);
        result.push({collectionKey:c.key,modeName:mode.name});
      }
      return result;
    }
    async function directBindings(node) {
      const result = {};
      for (const [field, alias] of Object.entries(node.boundVariables || {})) {
        // Paint-array bindings are derived from the portable paint aliases already
        // captured in fills/strokes. Never treat an arbitrary array as a scalar.
        if (['fills','strokes'].includes(field) && Array.isArray(alias)) {
          const paintIds = new Set((node[field] || []).flatMap(p => Object.values(p.boundVariables || {}).map(v => v.id)));
          if (alias.some(v => v?.type !== 'VARIABLE_ALIAS' || !v.id || !paintIds.has(v.id))) error('UNSUPPORTED_TEMPLATE_BINDING',node.id+'.'+field+' missing paint alias');
          continue;
        }
        if (!directBindingFields.includes(field) || !alias || Array.isArray(alias) || alias.type !== 'VARIABLE_ALIAS' || !alias.id || Object.keys(alias).some(k => !['type','id'].includes(k))) {
          error('UNSUPPORTED_TEMPLATE_BINDING',node.id+'.'+field);
        }
        result[field] = await variableById(alias.id);
        const expectedType = field === 'visible' ? 'BOOLEAN' : 'FLOAT';
        if (variables.get(result[field].key).resolvedType !== expectedType) error('UNSUPPORTED_TEMPLATE_BINDING',node.id+'.'+field+' requires '+expectedType);
      }
      return result;
    }
    async function walk(node,path,parentPath,inside){
      if(snapshot.nodes.length>=1000||path.split('/').length>33)error('TEMPLATE_LIMIT_EXCEEDED',path);
      if(nodes.has(node.id))error('INVALID_TEMPLATE','Duplicate source node');
      if(!inside&&!['PAGE','FRAME','SECTION','INSTANCE'].includes(node.type))error('UNSUPPORTED_TEMPLATE_NODE',node.type+' '+node.id);
      const entry={sourceId:node.id,path,parentPath,type:node.type,name:node.name,props:{},overrides:{}};
      nodes.set(node.id,node);entries.set(node.id,entry);snapshot.nodes.push(entry);
      if(node.type==='INSTANCE'){
        entry.libraryKey=await keyOf(node);
        const status=Object.entries(node.componentProperties||{}).find(([name,p])=>name.split('#')[0]==='Status'&&p.type==='VARIANT');
        if(status){
          const main=await read(node.getMainComponentAsync(),'Status main component');const set=main.parent;
          if(set?.type!=='COMPONENT_SET'||!set.key)error('STATUS_VARIANTS_UNAVAILABLE',node.id);
          const variants=set.children.filter(c=>c.type==='COMPONENT').map(c=>({key:c.key,name:c.name,value:c.variantProperties?.Status}));
          if(variants.some(v=>!v.key||!v.value))error('STATUS_VARIANTS_UNAVAILABLE',set.key);
          entry.statusVariants={setKey:set.key,variants};
        }
        for(const o of node.overrides||[]){const fields=declarations.get(o.id)||new Set();for(const f of o.overriddenFields){if(!allowed.includes(f))error('UNSUPPORTED_TEMPLATE_PROPERTY',o.id+'.'+f);fields.add(f);}declarations.set(o.id,fields);}
      }
      if(!inside){
        const fields=node.type==='PAGE'?['fills']:node.type==='INSTANCE'?['x','y','width','height','rotation','layoutSizingHorizontal','layoutSizingVertical','layoutPositioning','constraints']:outer.filter(f=>!['boundVariables','explicitVariableModes'].includes(f));
        for(const field of fields)if(node[field]!==undefined)entry.props[field]=await portable(node[field],field);
        if(['FRAME','SECTION'].includes(node.type)){
          const bindings=await directBindings(node);
          if(Object.keys(bindings).length)entry.props.boundVariables=bindings;
        }
        if(node.reactions?.length||node.layoutGrids?.length||node.isMask)error('UNSUPPORTED_TEMPLATE_PROPERTY','Outer reactions/grid/mask '+node.id);
      }
      if(node.type==='TEXT'){
        const segments=node.getStyledTextSegments(['fontName']);for(const s of segments)font(s.fontName);
      }
      if(inside&&node.type==='FRAME'&&node.children?.length&&node.children.every(child=>child.visible===false)&&['HORIZONTAL','VERTICAL'].includes(node.layoutMode)&&[node.layoutSizingHorizontal,node.layoutSizingVertical].includes('HUG')){
        entry.emptyHugLayout={width:node.width,height:node.height,layoutMode:node.layoutMode,layoutSizingHorizontal:node.layoutSizingHorizontal,layoutSizingVertical:node.layoutSizingVertical,hiddenChildSourceIds:node.children.map(child=>child.id)};
      }
      const explicit=await modes(node);if(explicit.length)entry.overrides.explicitVariableModes=explicit;
      for(const [i,child] of (node.children||[]).entries())await walk(child,path+'/'+i,path,inside||node.type==='INSTANCE');
    }
    for(const [i,pageId] of input.pageIds.entries()){
      const page=await access.node(pageId);if(page.type!=='PAGE'||!figma.root.children.includes(page))error('INVALID_TEMPLATE_PAGE',pageId);
      await read(page.loadAsync(),'page '+page.id);
      snapshot.pages.push({sourceId:page.id,path:String(i),name:page.name});await walk(page,String(i),null,false);
    }
    for(const [nodeId,fields] of declarations){const node=nodes.get(nodeId),entry=entries.get(nodeId);if(!node)error('OVERRIDE_TARGET_UNAVAILABLE',nodeId);
      for(const field of fields){
        if(field==='styledTextSegments'){
          if(node.type!=='TEXT')error('UNSUPPORTED_TEMPLATE_PROPERTY','Ranges on non-text');
          // Capture all supported style segments, including mixed hyperlink and SkipInk.
          const raw=node.getStyledTextSegments(range);
          entry.overrides[field]=await Promise.all(raw.map(async s=>{const v={start:s.start,end:s.end};for(const f of range)if(s[f]!==undefined)v[f]=await portable(s[f],f);return v;}));
        }else if(typeof node[field]==='symbol'&&node.type==='TEXT'&&range.includes(field)){
          if(!fields.has('styledTextSegments'))error('UNSUPPORTED_TEMPLATE_PROPERTY','Mixed '+field+' without declared ranges');
        }else entry.overrides[field]=await portable(node[field],field);
      }
    }
    snapshot.resources={styles:[...styles.values()],variables:[...variables.values()],collections:[...collections.values()]};
    contract(snapshot);return {snapshot};
  }
  const snapshot=input.snapshot;const {naturalHugChains}=contract(snapshot);
  if(figma.fileKey===snapshot.sourceFileKey||input.fileKey===snapshot.sourceFileKey)error('SOURCE_TARGET_FORBIDDEN','Cannot assemble in source');
  const markerKey='codex-library-template-v2', markerText=figma.root.getPluginData(markerKey);
  const byPath=new Map(snapshot.nodes.map(n=>[n.path,n]));
  const children=path=>snapshot.nodes.filter(n=>n.parentPath===path);
  const target=new Map(),actualKeys=new Map(),naturalHeightDeltas=new Map(),naturalHugDeltas=[];
  async function structure(entry,node,marker,initial=false,variantDescendant=false,instanceRoot=false){
    if(!node||node.removed||node.type!==entry.type)error('TEMPLATE_STRUCTURE_MISMATCH',entry.path+' type');
    let statusChanged=false;
    if(entry.libraryKey){const main=await read(node.getMainComponentAsync(),'verify main component '+node.id);
      actualKeys.set(entry.path,main?.key);
      if(main?.key!==entry.libraryKey){
        statusChanged=Boolean(marker&&entry.statusVariants&&main?.parent?.key===entry.statusVariants.setKey&&entry.statusVariants.variants.some(v=>v.key===main.key));
        if(!statusChanged)error('TEMPLATE_STRUCTURE_MISMATCH',entry.path+' library key');
      }
    }
    if(node.name!==entry.name&&!(initial&&(instanceRoot||entry.overrides.name!==undefined))&&!(statusChanged&&entry.statusVariants.variants.some(v=>v.name===node.name)))error('TEMPLATE_STRUCTURE_MISMATCH',entry.path+' name');
    if(marker&&!variantDescendant&&marker.ids[entry.path]!==node.id)error('TEMPLATE_STRUCTURE_MISMATCH',entry.path+' identity');
    target.set(entry.path,node);
    const expected=children(entry.path),actual=node.children||[];
    if(expected.length!==actual.length)error('TEMPLATE_STRUCTURE_MISMATCH',entry.path+' children');
    for(let i=0;i<expected.length;i++)await structure(expected[i],actual[i],marker,initial,variantDescendant||Boolean(marker&&entry.statusVariants));
  }
  function result(status){return {status,pages:snapshot.pages.map(p=>({sourceId:p.sourceId,id:target.get(p.path).id,name:p.name})),rootIds:snapshot.nodes.filter(n=>byPath.get(n.parentPath)?.type==='PAGE').map(n=>({sourceId:n.sourceId,id:target.get(n.path).id,path:n.path})),instanceKeys:snapshot.nodes.filter(n=>n.libraryKey).map(n=>({sourceId:n.sourceId,id:target.get(n.path).id,path:n.path,libraryKey:actualKeys.get(n.path)})),verification:{status:'passed',...(naturalHugDeltas.length?{naturalHugDeltas}: {})},snapshotId:input.snapshotId};}
  if(markerText){
    let marker;try{marker=JSON.parse(markerText);}catch{error('TEMPLATE_MARKER_INVALID','Invalid JSON');}
    if(marker.snapshotId!==input.snapshotId||!marker.ids||Object.keys(marker.ids).length!==snapshot.nodes.length)error('TEMPLATE_MARKER_MISMATCH','Snapshot or managed identity mismatch');
    await read(figma.loadAllPagesAsync(),'target pages');
    if(figma.root.children.length!==snapshot.pages.length)error('TEMPLATE_STRUCTURE_MISMATCH','Page count');
    for(const [i,p] of snapshot.pages.entries())await structure(byPath.get(p.path),figma.root.children[i],marker);
    return result(input.mode==='verify'?'verified':'reused');
  }
  if(input.mode==='verify')error('TEMPLATE_NOT_MANAGED','No managed marker');
  await read(figma.loadAllPagesAsync(),'all target pages');
  if(figma.root.children.length!==1||figma.root.children.some(p=>p.type!=='PAGE'||p.children.length))error('TARGET_NOT_EMPTY','Requires one empty page');
  const originalPage=figma.root.children[0],originalName=originalPage.name;
  const owned=[],styleMap=new Map(),variableMap=new Map(),collectionMap=new Map(),components=new Map();
  const ownedIdentity = new Map();
  const originalModeWrites = [];
  let writtenPageName, writtenMarker;
  let wrote=false;
  function trackCreated(node) {
    owned.push(node);
    // createInstance materializes its complete inherited tree synchronously.
    // Register that tree before yielding, so later foreign insertions cannot
    // accidentally become owned merely by appearing under a created parent.
    function remember(current) {
      ownedIdentity.set(current.id,{node:current,type:current.type});
      for(const child of current.children || []) remember(child);
    }
    remember(node);
    wrote=true;
    return node;
  }
  function assertTargetStillEmpty() {
    const pages=figma.root.children;
    if(pages.length!==1 || pages[0]!==originalPage || originalPage.removed || originalPage.children.length || originalPage.name!==originalName || figma.root.getPluginData(markerKey)!==markerText) {
      error('TEMPLATE_CONCURRENT_EDIT','Target changed during resource preparation; no canvas write performed');
    }
  }
  function assertCompleteDocument() {
    const pages=figma.root.children;
    if(pages.length!==snapshot.pages.length || snapshot.pages.some((p,i)=>pages[i]!==target.get(p.path))) {
      error('TEMPLATE_CONCURRENT_EDIT','Complete target page list changed before marker');
    }
    for(const entry of snapshot.nodes) {
      const node=target.get(entry.path), expected=children(entry.path), actual=node?.children || [];
      if(!node || node.removed || node.type!==entry.type || node.name!==entry.name || actual.length!==expected.length || expected.some((c,i)=>actual[i]!==target.get(c.path))) {
        error('TEMPLATE_CONCURRENT_EDIT','Target topology changed before marker: '+entry.path);
      }
    }
    if(figma.root.getPluginData(markerKey)!==markerText) error('TEMPLATE_CONCURRENT_EDIT','Target marker changed before commit');
  }
  function rollbackOwnedCanvas(failure) {
    const conflicts=[];
    try {
      const current=figma.root.getPluginData(markerKey);
      if(current!==markerText) {
        if(writtenMarker!==undefined && current===writtenMarker) figma.root.setPluginData(markerKey,markerText);
        else conflicts.push('Preserved concurrent marker edit; managed marker was not cleared');
      }
    } catch(e) { conflicts.push('marker cleanup: '+e.message); }
    function foreignDescendants(node) {
      const foreign=[];
      function visit(current) {
        const own=ownedIdentity.get(current.id);
        if(!own || own.node!==current || own.type!==current.type) foreign.push(current.id);
        for(const child of current.children || []) visit(child);
      }
      visit(node);
      return foreign;
    }
    for(const node of [...owned].reverse()) {
      if(node.removed) continue;
      try {
        const foreign=foreignDescendants(node);
        if(foreign.length) conflicts.push('Preserved container '+node.id+' with foreign descendants: '+foreign.join(', '));
        else node.remove();
      } catch(e) { conflicts.push('Node '+node.id+' cleanup: '+e.message); }
    }
    try {
      if(originalPage.removed) conflicts.push('Original page removed concurrently; name not restored');
      else if(originalPage.name!==originalName) {
        if(writtenPageName!==undefined && originalPage.name===writtenPageName) originalPage.name=originalName;
        else conflicts.push('Preserved concurrent original-page name edit: '+originalPage.id);
      }
    } catch(e) { conflicts.push('Original-page name cleanup: '+e.message); }
    // Only the reused page survives canvas cleanup. Restore each mode we
    // actually changed, never the whole map (which may contain foreign edits).
    for(const change of [...originalModeWrites].reverse()) {
      const {collection,before,written,completed}=change;
      try {
        if(originalPage.removed) {
          conflicts.push('Original page removed concurrently; mode not restored: '+collection.id);
          continue;
        }
        const current=originalPage.explicitVariableModes?.[collection.id];
        if(current!==written) {
          // A setter that failed before changing anything needs no cleanup.
          if(!completed && current===before) continue;
          conflicts.push('Preserved concurrent original-page mode edit: '+collection.id);
          continue;
        }
        let cleanupError;
        try {
          if(before===undefined) originalPage.clearExplicitVariableModeForCollection(collection);
          else originalPage.setExplicitVariableModeForCollection(collection,before);
        } catch(e) { cleanupError=e; }
        if(originalPage.explicitVariableModes?.[collection.id]!==before) {
          conflicts.push('Original-page mode cleanup '+collection.id+': '+(cleanupError?.message || 'read-back mismatch'));
        }
      } catch(e) { conflicts.push('Original-page mode cleanup '+collection.id+': '+e.message); }
    }
    failure.operationStatus=conflicts.length?'partial':'rolled_back';
    failure.rollbackErrors=conflicts;
    failure.resourceImportsMayRemain=true;
    if(conflicts.length) failure.nextStep='Concurrent edits were preserved. Inspect rollbackErrors and remaining containers before any manual cleanup; do not replay apply.';
    throw failure;
  }
  try{
    for(const r of snapshot.resources.styles){const s=await read(figma.importStyleByKeyAsync(r.key),'import style '+r.key);if(s?.key!==r.key||s.type!==r.type)error('STYLE_UNAVAILABLE',r.key);styleMap.set(r.key,s);}
    for(const r of snapshot.resources.variables){const v=await read(figma.variables.importVariableByKeyAsync(r.key),'import variable '+r.key);if(v?.key!==r.key||v.resolvedType!==r.resolvedType)error('VARIABLE_UNAVAILABLE',r.key);const c=await read(figma.variables.getVariableCollectionByIdAsync(v.variableCollectionId),'imported collection');if(c?.key!==r.collectionKey)error('VARIABLE_COLLECTION_UNAVAILABLE',r.collectionKey);variableMap.set(r.key,v);collectionMap.set(c.key,c);}
    for(const r of snapshot.resources.collections){const c=collectionMap.get(r.key);for(const name of r.modes)if(c?.modes.filter(m=>m.name===name).length!==1)error('VARIABLE_MODE_UNAVAILABLE',r.key+' '+name);}
    for(const font of snapshot.fonts)await access.loadFont(font);
    for(const n of snapshot.nodes)if(n.libraryKey){let inside=false;for(let p=byPath.get(n.parentPath);p;p=byPath.get(p.parentPath))if(p.libraryKey)inside=true;if(!inside&&!components.has(n.libraryKey)){const c=await read(figma.importComponentByKeyAsync(n.libraryKey),'import component '+n.libraryKey);if(c?.type!=='COMPONENT'||c.key!==n.libraryKey)error('LIBRARY_COMPONENT_UNAVAILABLE',n.libraryKey);components.set(n.libraryKey,c);}}
    function resolved(value){if(Array.isArray(value))return value.map(resolved);if(value&&typeof value==='object'){
      if(value.styleKey)return styleMap.get(value.styleKey).id;
      if(value.type==='VARIABLE_ALIAS')return {type:'VARIABLE_ALIAS',id:variableMap.get(value.key).id};
      return Object.fromEntries(Object.entries(value).map(([k,v])=>[k,resolved(v)]));}return value;}
    const hyperlinkAfterWrite=new Map();
    function hyperlinkEvidence(value){
      if(value===null)return {kind:'null'};
      if(value===undefined)return {kind:'undefined'};
      if(typeof value==='symbol')return {kind:'mixed'};
      if(value&&['URL','NODE'].includes(value.type)&&typeof value.value==='string')return {kind:'target',type:value.type,value:value.value.slice(0,2048),...(value.value.length>2048?{truncated:true}:{})};
      return {kind:'unsupported',valueType:typeof value};
    }
    function layoutApplicable(node,field) {
      const auto=['HORIZONTAL','VERTICAL'].includes(node.layoutMode);
      const parentAuto=['HORIZONTAL','VERTICAL'].includes(node.parent?.layoutMode);
      if(field==='layoutWrap') return node.layoutMode==='HORIZONTAL';
      if(field==='counterAxisSpacing') return auto && node.layoutWrap==='WRAP';
      if(['layoutPositioning','layoutAlign','layoutGrow'].includes(field)) return parentAuto;
      if(['layoutSizingHorizontal','layoutSizingVertical'].includes(field)) return auto || parentAuto || node.type==='TEXT';
      if(['minWidth','maxWidth','minHeight','maxHeight'].includes(field)) return auto || parentAuto;
      if(['itemSpacing','paddingTop','paddingRight','paddingBottom','paddingLeft','primaryAxisAlignItems','counterAxisAlignItems','primaryAxisSizingMode','counterAxisSizingMode','strokesIncludedInLayout','itemReverseZIndex'].includes(field)) return auto;
      return true;
    }
    function valueMismatch(entry,field,expected) {
      const label=entry.path+'.'+field;
      // Diagnostic reads only: bounded geometry/layout primitives, never node
      // names, text, URLs, paints, component properties or source-file lookups.
      const fields=['x','y','width','height','rotation','visible','layoutMode','layoutWrap','layoutSizingHorizontal','layoutSizingVertical','primaryAxisSizingMode','counterAxisSizingMode','layoutPositioning','layoutAlign','layoutGrow','itemSpacing','counterAxisSpacing','paddingTop','paddingRight','paddingBottom','paddingLeft','minWidth','maxWidth','minHeight','maxHeight','strokesIncludedInLayout','scaleFactor','relativeTransform'];
      if(!fields.includes(field))error('TEMPLATE_VALUE_MISMATCH',label);
      let detail;
      try {
        function safe(value) {
          if(value===null || typeof value==='boolean' || (typeof value==='number'&&Number.isFinite(value)))return value;
          if(typeof value==='string')return value.slice(0,64);
          if(Array.isArray(value)&&value.length===2&&value.every(row=>Array.isArray(row)&&row.length===3&&row.every(n=>typeof n==='number'&&Number.isFinite(n))))return value;
          return undefined;
        }
        function state(object) {
          const values={};
          for(const key of fields)try{const value=safe(object?.[key]);if(value!==undefined)values[key]=value;}catch{values[key]='unavailable';}
          return values;
        }
        function record(saved) {
          const node=target.get(saved.path);
          return {path:saved.path,id:node.id,type:node.type,childCount:node.children?.length || 0,expected:state({...saved.emptyHugLayout,...saved.geometryProof,...saved.props,...saved.overrides}),actual:state(node)};
        }
        const diagnostic={path:entry.path,field,expected:safe(expected),actual:safe(target.get(entry.path)[field]),nodes:[],truncated:false};
        const parent=byPath.get(entry.parentPath);
        if(parent)diagnostic.parent=record(parent);
        const queue=[{saved:entry,depth:0}];
        while(queue.length&&diagnostic.nodes.length<16) {
          const {saved,depth}=queue.shift();
          diagnostic.nodes.push(record(saved));
          const nested=children(saved.path);
          if(depth<2)for(const child of nested)queue.push({saved:child,depth:depth+1});
          else if(nested.length)diagnostic.truncated=true;
        }
        if(queue.length)diagnostic.truncated=true;
        while(JSON.stringify(diagnostic).length>16000&&diagnostic.nodes.length>1){diagnostic.nodes.pop();diagnostic.truncated=true;}
        detail=JSON.stringify(diagnostic);
      } catch { detail=JSON.stringify({path:entry.path,field,unavailable:true}); }
      // The existing error string crosses every typed Bridge transport. Keep
      // its machine code and rollback semantics; no new error plumbing needed.
      error('TEMPLATE_VALUE_MISMATCH',label+'; geometry='+detail);
    }
    async function apply(node,values,late=false,natural=false){
      const delayed=['layoutSizingHorizontal','layoutSizingVertical','primaryAxisSizingMode','counterAxisSizingMode','boundVariables'];
      const order=object=>Object.keys(object).sort((a,b)=>{const rank=f=>f==='layoutMode'?-2:f==='layoutWrap'?-1:f==='characters'?0:f.endsWith('StyleId')?(object[f]===''?1:3):f==='styledTextSegments'?4:f==='locked'?5:f==='boundVariables'?6:2;return rank(a)-rank(b);});
      const ordered=order(values);
      for(const field of ordered){if(delayed.includes(field)!==late||['width','height'].includes(field))continue;access.check();const value=values[field];
        // A validated null is the expected getter state, not a setter value.
        // Saved textDecoration is applied normally; exact null read-back remains.
        if(field==='textDecorationSkipInk'&&value===null)continue;
        if(!layoutApplicable(node,field)) {
          // Native getters expose dormant defaults whose setters are illegal.
          // Keep them only if already exact; never toggle layout temporarily or
          // discard meaningful saved state. Final read-back still checks them.
          if(canonical(node[field])!==canonical(resolved(value)))error('UNSUPPORTED_TEMPLATE_LAYOUT_STATE',node.id+'.'+field+' is inapplicable and differs from the saved value');
          continue;
        }
        if(field==='explicitVariableModes'){for(const mode of value){
          const c=collectionMap.get(mode.collectionKey),modeId=c.modes.find(m=>m.name===mode.modeName).modeId;
          if(node.explicitVariableModes?.[c.id]===modeId)continue;
          const change=node===originalPage?{collection:c,before:node.explicitVariableModes?.[c.id],written:modeId,completed:false}:null;
          // Journal before the native call: a setter may write and then throw.
          if(change)originalModeWrites.push(change);
          node.setExplicitVariableModeForCollection(c,modeId);
          if(change)change.completed=true;
        }continue;}
        if(field==='boundVariables'){for(const [f,binding] of Object.entries(value)){if(Array.isArray(binding))error('UNSUPPORTED_TEMPLATE_PROPERTY','Array binding '+f+' must use paint bindings');node.setBoundVariable(f,binding===null?null:variableMap.get(binding.key));}continue;}
        if(field==='styledTextSegments'){
          for(const run of value)for(const f of order(run)){const v=run[f];if(['start','end'].includes(f))continue;
            if(f==='textDecorationSkipInk'&&v===null)continue;
            if(f==='boundVariables'){for(const [binding,b] of Object.entries(v)){if(Array.isArray(b)){if(!run[binding])error('UNSUPPORTED_TEMPLATE_PROPERTY','Range binding array without paints '+binding);continue;}node.setRangeBoundVariable(run.start,run.end,binding,variableMap.get(b.key));}continue;}
            const method='setRange'+f[0].toUpperCase()+f.slice(1)+(f.endsWith('StyleId')?'Async':'');
            if(typeof node[method]!=='function')error('UNSUPPORTED_TEMPLATE_PROPERTY',method);
            await node[method](run.start,run.end,resolved(v));
            if(f==='hyperlink'){
              let observed;try{observed=hyperlinkEvidence(node.getRangeHyperlink(run.start,run.end));}catch{observed={kind:'unavailable'};}
              hyperlinkAfterWrite.set(node.id+':'+run.start+':'+run.end,observed);
            }
          }continue;
        }
        if(field.endsWith('StyleId')){const method='set'+field[0].toUpperCase()+field.slice(1)+'Async';if(typeof node[method]!=='function')error('UNSUPPORTED_TEMPLATE_PROPERTY',method);await node[method](resolved(value));}
        else node[field]=resolved(value);
      }
      if(!late&&!natural&&(values.width!==undefined||values.height!==undefined))node.resize(values.width??node.width,values.height??node.height);
    }
    async function create(entry,parent){
      let node;
      if(entry.type==='PAGE'){
        node=entry.path==='0'?originalPage:trackCreated(figma.createPage());
        if(node===originalPage)writtenPageName=entry.name;
        wrote=true;node.name=entry.name;target.set(entry.path,node);
      }else if(entry.type==='INSTANCE'){
        node=trackCreated(components.get(entry.libraryKey).createInstance());
        await structure(entry,node,null,true,false,true);node.name=entry.name;parent.appendChild(node);
      }else{
        node=trackCreated(entry.type==='FRAME'?figma.createFrame():figma.createSection());node.name=entry.name;parent.appendChild(node);target.set(entry.path,node);
      }
      if(entry.type!=='INSTANCE')for(const child of children(entry.path))await create(child,node);
    }
    await read(figma.loadAllPagesAsync(),'prewrite target pages');
    access.check();
    assertTargetStillEmpty();
    for(const p of snapshot.pages)await create(byPath.get(p.path),figma.root);
    // Tree identity is checked for every inherited descendant before any override.
    for(const n of snapshot.nodes){const node=target.get(n.path);if(node.type==='TEXT')for(const s of node.getStyledTextSegments(['fontName']))await access.loadFont(s.fontName);}
    for(const n of snapshot.nodes)await apply(target.get(n.path),{...n.props,...n.overrides},false,n.emptyHugLayout?.policy==='natural');
    for(const n of [...snapshot.nodes].reverse())await apply(target.get(n.path),{...n.props,...n.overrides},true);
    // Strict snapshots seed the historical empty-HUG extent after descendants.
    // Natural snapshots only observe native HUG and authorize a proven chain's
    // exact height delta; both retain all independent read-back comparisons.
    for(const n of [...snapshot.nodes].reverse())if(n.emptyHugLayout){
      const node=target.get(n.path),g=n.emptyHugLayout,expectedChildren=children(n.path);
      if(node.type!=='FRAME'||node.layoutMode!==g.layoutMode||node.layoutSizingHorizontal!==g.layoutSizingHorizontal||node.layoutSizingVertical!==g.layoutSizingVertical||node.children.length!==expectedChildren.length||node.children.some((child,i)=>child!==target.get(expectedChildren[i].path)||child.visible!==false)||node.boundVariables?.width||node.boundVariables?.height)error('TEMPLATE_EMPTY_HUG_GUARD',n.path+' empty-HUG state changed');
      if(g.policy==='natural'){
        if(![node.width,node.height].every(v=>Number.isFinite(v)&&v>0))error('TEMPLATE_EMPTY_HUG_GUARD',n.path+' invalid natural dimensions');
        const chain=naturalHugChains.find(c=>c.path===n.path),delta=node.height-g.height;
        for(const path of [n.path,...chain.ancestors]){
          const actual=target.get(path);
          if(['height','minHeight','maxHeight'].some(f=>actual.boundVariables?.[f])||(actual.scaleFactor!==undefined&&actual.scaleFactor!==1))error('UNSUPPORTED_TEMPLATE_NATURAL_HUG',path+' native height binding or scaling');
          naturalHeightDeltas.set(path,(naturalHeightDeltas.get(path)||0)+delta);
        }
        naturalHugDeltas.push({path:n.path,before:g.height,after:node.height,delta,ancestors:chain.ancestors});
        continue;
      }
      if(typeof node.resizeWithoutConstraints!=='function')error('UNSUPPORTED_TEMPLATE_PROPERTY','resizeWithoutConstraints');
      node.resizeWithoutConstraints(g.width,g.height);
      node.layoutSizingHorizontal=g.layoutSizingHorizontal;
      node.layoutSizingVertical=g.layoutSizingVertical;
      for(const field of ['width','height','layoutMode','layoutSizingHorizontal','layoutSizingVertical'])if(node[field]!==g[field])valueMismatch(n,field,g[field]);
    }
    for(const p of snapshot.pages)await structure(byPath.get(p.path),target.get(p.path));
    // Exact explicit overrides are read back; managed verification later intentionally
    // checks identity/structure only so Jira edits remain intact.
    for(const n of snapshot.nodes){const node=target.get(n.path);const fallback=n.emptyHugLayout?Object.fromEntries(['width','height','layoutMode','layoutSizingHorizontal','layoutSizingVertical'].map(f=>[f,n.emptyHugLayout[f]])):{};for(const [f,v] of Object.entries({...fallback,...n.geometryProof,...n.props,...n.overrides})){
      if(f==='styledTextSegments'){
        for(const r of v)for(const [field,value] of Object.entries(r)){
          if(['start','end'].includes(field))continue;
          if(field==='boundVariables'){for(const [binding,b] of Object.entries(value)){if(Array.isArray(b))continue;const actual=node.getRangeBoundVariable?.(r.start,r.end,binding);if(canonical(actual)!==canonical(resolved(b)))error('TEMPLATE_VALUE_MISMATCH',n.path+' range binding '+binding);}continue;}
          if(field==='hyperlink'){
            // The same documented segment reader used by capture supplies the
            // semantic partition. Never coerce a legacy range getter sentinel.
            const expected=resolved(value),segments=node.getStyledTextSegments(['hyperlink'],r.start,r.end);
            let cursor=r.start,valid=Array.isArray(segments)&&segments.length>0;
            if(valid)for(const segment of segments){
              const link=segment?.hyperlink;
              if(!segment||typeof segment!=='object'||Array.isArray(segment)||!Number.isInteger(segment.start)||!Number.isInteger(segment.end)||segment.start!==cursor||segment.end<=cursor||segment.end>r.end||!(link===null||(link&&typeof link==='object'&&!Array.isArray(link)&&['URL','NODE'].includes(link.type)&&typeof link.value==='string'&&Object.keys(link).every(k=>['type','value'].includes(k))))||canonical(link)!==canonical(expected)){valid=false;break;}
              cursor=segment.end;
            }
            if(valid&&cursor===r.end)continue;
            let detail='';
            try{let actual;try{actual=node.getRangeHyperlink(r.start,r.end);}catch{}detail='; hyperlink='+JSON.stringify({path:n.path,start:r.start,end:r.end,expected:hyperlinkEvidence(expected),actual:hyperlinkEvidence(actual),afterWrite:hyperlinkAfterWrite.get(node.id+':'+r.start+':'+r.end)||{kind:'unavailable'}});}catch{}
            error('TEMPLATE_VALUE_MISMATCH',n.path+' range hyperlink segment values/coverage'+detail);
          }
          const getter='getRange'+field[0].toUpperCase()+field.slice(1);
          if(typeof node[getter]!=='function')error('UNSUPPORTED_TEMPLATE_PROPERTY',getter);
          const actual=node[getter](r.start,r.end),expected=resolved(value);
          if(canonical(actual)!==canonical(expected)){
            error('TEMPLATE_VALUE_MISMATCH',n.path+' range '+field);
          }
        }continue;
      }
      if(f==='explicitVariableModes'){for(const mode of v){const c=collectionMap.get(mode.collectionKey);if(node.explicitVariableModes?.[c.id]!==c.modes.find(m=>m.name===mode.modeName).modeId)error('TEMPLATE_VALUE_MISMATCH',n.path+' explicit mode');}continue;}
      if(f==='boundVariables'){
        // Native boundVariables also contains paint-derived aliases. The saved
        // object is scalar-only; paints and their aliases are checked separately.
        for(const [field,alias] of Object.entries(v)){
          if(canonical(node.boundVariables?.[field])!==canonical(resolved(alias)))error('TEMPLATE_VALUE_MISMATCH',n.path+'.boundVariables.'+field);
        }
        continue;
      }
      const expected=f==='height'&&naturalHeightDeltas.has(n.path)?v+naturalHeightDeltas.get(n.path):resolved(v);
      if(canonical(node[f])!==canonical(expected))valueMismatch(n,f,expected);
    }}
    const marker={snapshotId:input.snapshotId,ids:Object.fromEntries([...target].map(([path,n])=>[path,n.id]))};
    access.check();
    assertCompleteDocument();
    writtenMarker=JSON.stringify(marker);
    figma.root.setPluginData(markerKey,writtenMarker);
    if(figma.root.getPluginData(markerKey)!==writtenMarker)error('TEMPLATE_MARKER_INVALID','Marker did not persist');
    return result('assembled');
  }catch(e){
    if(!wrote){e.operationStatus='not_applied';throw e;}
    rollbackOwnedCanvas(e);
  }
}

function compile(input,readOnly){
  const code=compileOperation(libraryTemplateOperation,input,{readOnly});
  return code.replace('CONTRACT_FUNCTION','('+templateContract.toString()+')');
}
export function buildCaptureLibraryTemplateCode(input){return compile({...captureLibraryTemplateSchema.parse(input),capture:true},true);}
export function buildAssembleLibraryTemplateCode(input){
  try{const parsed=assembleLibraryTemplateSchema.parse(input);const {canonical}=templateContract(parsed.snapshot);
    const snapshotId=createHash('sha256').update(canonical(parsed.snapshot)).digest('hex');
    return compile({...parsed,snapshotId},parsed.mode==='verify');
  }catch(e){e.operationStatus='not_applied';throw e;}
}
