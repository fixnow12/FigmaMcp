import { z } from 'zod';
import { compileOperation } from './scene-access.mjs';
import { fileKeyDescription } from './file-target.mjs';
const id=z.string().min(1).max(160),key=z.string().regex(/^[a-f0-9]{40}$/);
export const setNodeVariableModesInputSchema={
 fileKey:id.describe(fileKeyDescription),
 bindings:z.array(z.object({nodeId:id,collectionKey:key,anchorVariableKey:key,modeName:z.string().trim().min(1).max(160)}).strict()).min(1).max(40),
};
export const setNodeVariableModesSchema=z.object(setNodeVariableModesInputSchema).strict().refine(input=>new Set(input.bindings.map(b=>JSON.stringify([b.nodeId,b.collectionKey]))).size===input.bindings.length,'Повторяющаяся пара узел/коллекция');

async function setNodeVariableModes(figma,input,access){
 const prepared=[],resources=new Map(),fonts=new Map(),visited=new Map();
 const equal=(a,b)=>Object.keys(a).length===Object.keys(b).length&&Object.keys(a).every(key=>a[key]===b[key]);
 const sameMode=(a,b)=>a===undefined?b===undefined:b!==undefined&&a.collectionId===b.collectionId&&a.modeId===b.modeId;
 const fail=message=>{throw new Error(message);};
 const previousSkip=figma.skipInvisibleInstanceChildren;
 async function resource(binding){
  const token=JSON.stringify([binding.collectionKey,binding.anchorVariableKey,binding.modeName]);
  if(!resources.has(token)){
   const anchor=await access.read(figma.variables.importVariableByKeyAsync(binding.anchorVariableKey),'импорт переменной режима');
   if(anchor?.key!==binding.anchorVariableKey)fail('Неверный ключ импортированной переменной');
   const collection=await access.read(figma.variables.getVariableCollectionByIdAsync(anchor.variableCollectionId),'коллекция режима');
   if(!collection?.id||collection.id!==anchor.variableCollectionId||collection.key!==binding.collectionKey)fail('Ключ коллекции режима не совпал');
   const matches=collection.modes.filter(mode=>mode.name===binding.modeName);
   if(matches.length!==1||!matches[0].modeId)fail('VARIABLE_MODE_UNAVAILABLE: '+binding.modeName);
   resources.set(token,{collection,modeId:matches[0].modeId});
  }
  return resources.get(token);
 }
 async function readMode(node,collectionKey){
  const modes=access.copy(node.explicitVariableModes),matches=[];
  for(const [collectionId,modeId]of Object.entries(modes)){
   const collection=await access.read(figma.variables.getVariableCollectionByIdAsync(collectionId),'явная коллекция режима');
   if(!collection||collection.id!==collectionId||!collection.key)fail('Неразрешённая явная коллекция режима');
   if(collection.key!==collectionKey)continue;
   const selected=collection.modes.filter(mode=>mode.modeId===modeId);
   if(selected.length!==1||collection.modes.filter(mode=>mode.name===selected[0].name).length!==1)fail('Неоднозначный явный режим');
   matches.push({collection,collectionId,modeId,modeName:selected[0].name});
  }
  if(matches.length>1)fail('Неоднозначная явная коллекция режима');
  if(!equal(node.explicitVariableModes,modes))fail('Явные режимы изменились во время чтения');
  return {mode:matches[0],modes};
 }
 function checkedMode(node,read){
  if(!equal(node.explicitVariableModes,read.modes))fail('Явные режимы изменились после чтения');
  return read.mode;
 }
 function collectFonts(node){
  if(visited.has(node.id))return;
  if(visited.size>=2000)fail('Слишком большое поддерево для проверки шрифтов');
  visited.set(node.id,{node,parent:node.parent,children:'children'in node?[...node.children]:null});
  if(['COMPONENT','COMPONENT_SET'].includes(node.type))fail('Изменение режима затронет определение компонента');
  if(node.type==='TEXT'){
   const segments=typeof node.getStyledTextSegments==='function'?node.getStyledTextSegments(['fontName']):[];
   for(const font of segments.length?segments.map(s=>s.fontName):[node.fontName]){
    if(!font||typeof font.family!=='string'||!font.family||typeof font.style!=='string'||!font.style)fail('Не удалось определить текущий шрифт перед сменой режима');
    fonts.set(JSON.stringify(font),font);
   }
  }
  if('children'in node)for(const child of node.children)collectFonts(child);
 }
 try{
  if(figma.fileKey!==input.fileKey)fail('Неверный целевой файл');
  figma.skipInvisibleInstanceChildren=false;
  for(const binding of input.bindings){
   const node=await access.node(binding.nodeId);access.editable(node);
   if(!['FRAME','INSTANCE'].includes(node.type)||typeof node.setExplicitVariableModeForCollection!=='function'||typeof node.clearExplicitVariableModeForCollection!=='function'||!node.explicitVariableModes||typeof node.explicitVariableModes!=='object'||Array.isArray(node.explicitVariableModes))fail('Режимы разрешены только для доступных FRAME/INSTANCE');
   const {collection,modeId}=await resource(binding),before=checkedMode(node,await readMode(node,binding.collectionKey)),modes=access.copy(node.explicitVariableModes);
   prepared.push({binding,node,parent:node.parent,collection,modeId,before,modes,mutated:before?.modeName!==binding.modeName});
   if(before?.modeName!==binding.modeName)collectFonts(node);
  }
  for(const font of fonts.values())await access.loadFont(font);
  access.stablePage();
  for(const {node,parent,children}of visited.values())if(node.removed||node.parent!==parent||children&&(node.children.length!==children.length||children.some((child,i)=>node.children[i]!==child)))fail('Структура изменилась во время проверки режима');
  for(const entry of prepared){access.editable(entry.node);if(entry.node.parent!==entry.parent||!equal(entry.node.explicitVariableModes,entry.modes))fail('Режим или родитель изменился до записи');}
 }catch(error){error.operationStatus='not_applied';throw error;}
 finally{figma.skipInvisibleInstanceChildren=previousSkip;}
 const rollback=[],expectedModes=new Map(prepared.map(entry=>[entry.node.id,entry.modes]));
 try{
  for(const entry of prepared){
   const {node,collection,modeId,before}=entry;
   access.stablePage();access.editable(node);
   if(node.parent!==entry.parent||!equal(node.explicitVariableModes,expectedModes.get(node.id)))throw Error('Цель или режим изменились перед записью '+node.id);
   if(!entry.mutated)continue;
   const beforeWriteModes=access.copy(node.explicitVariableModes);
   rollback.push(async()=>{
    if(equal(node.explicitVariableModes,beforeWriteModes))return;
    if(!entry.writtenModes||!equal(node.explicitVariableModes,entry.writtenModes))throw Error('Конфликт отката режима '+node.id);
    const current=checkedMode(node,await readMode(node,entry.binding.collectionKey));
    if(!equal(node.explicitVariableModes,entry.writtenModes))throw Error('Конфликт отката режима '+node.id);
    if(before===undefined)node.clearExplicitVariableModeForCollection(current?.collection||collection);else node.setExplicitVariableModeForCollection(before.collection,before.modeId);
    const restored=checkedMode(node,await readMode(node,entry.binding.collectionKey));
    if(!sameMode(restored,before)||!equal(node.explicitVariableModes,beforeWriteModes))throw Error('Режим не восстановился '+node.id);
   });
   try{node.setExplicitVariableModeForCollection(collection,modeId);}finally{entry.writtenModes=access.copy(node.explicitVariableModes);expectedModes.set(node.id,entry.writtenModes);}
   const actual=checkedMode(node,await readMode(node,entry.binding.collectionKey));
   if(actual?.modeName!==entry.binding.modeName)throw Error('Режим не совпал после записи '+node.id);
   entry.written=actual;
  }
  access.stablePage();
  const checks=[],verifiedMaps=[];
  for(const {binding,node,collection,mutated}of prepared){
   access.editable(node);const read=await readMode(node,binding.collectionKey),actual=checkedMode(node,read);verifiedMaps.push(read.modes);
   if(actual?.modeName!==binding.modeName)throw Error('Итоговый режим изменился '+node.id);
   checks.push({id:node.id,collectionKey:collection.key,modeName:actual.modeName,collectionId:actual.collectionId,modeId:actual.modeId,mutated});
  }
  access.stablePage();
  for(let i=0;i<checks.length;i++){
   access.editable(prepared[i].node);
   if(prepared[i].node.parent!==prepared[i].parent||!equal(prepared[i].node.explicitVariableModes,verifiedMaps[i]))throw Error('Итоговая цель или режим изменились '+checks[i].id);
  }
  return {fileKey:figma.fileKey,pageId:access.page.id,variableModesVerification:{checks}};
 }catch(error){return await access.failWithRollback(error,rollback);}
}
export const buildSetNodeVariableModesCode=input=>compileOperation(setNodeVariableModes,input);
