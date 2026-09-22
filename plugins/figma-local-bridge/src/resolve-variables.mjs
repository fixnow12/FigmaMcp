import {z} from 'zod';
import {compileOperation} from './scene-access.mjs';
import {fileKeyDescription} from './file-target.mjs';
const key=z.string().regex(/^[a-f0-9]{40}$/);
export const resolveVariablesInputSchema={
 fileKey:z.string().min(1).max(160).describe(fileKeyDescription),
 variables:z.array(z.object({id:z.string().min(1).max(512),key,resolvedType:z.enum(['COLOR','FLOAT','STRING','BOOLEAN']),collectionKey:key.optional()}).strict()).min(1).max(100),
};
export const resolveVariablesSchema=z.object(resolveVariablesInputSchema).strict().refine(input=>new Set(input.variables.map(v=>v.id)).size===input.variables.length&&new Set(input.variables.map(v=>v.key)).size===input.variables.length,'Повторяющийся ID или ключ переменной');
async function resolveVariables(figma,input,access){
 const variables=[],unresolved=[];
 const target=()=>{access.check();if(figma.fileKey!==input.fileKey)throw Error('Неверный целевой файл');};
 const validKey=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
 target();
 for(const requested of input.variables){
  target();
  const actual=await access.read(figma.variables.getVariableByIdAsync(requested.id),'переменная '+requested.id);
  target();
  let reason=null;
  if(!actual)reason='variable_missing';
  else if(actual.id!==requested.id||actual.key!==requested.key||actual.resolvedType!==requested.resolvedType||!actual.variableCollectionId)reason='variable_identity_mismatch';
  if(reason){unresolved.push({...requested,reason});continue;}
  const collection=await access.read(figma.variables.getVariableCollectionByIdAsync(actual.variableCollectionId),'коллекция переменной '+requested.id);
  target();
  if(!collection)reason='collection_missing';
  else if(collection.id!==actual.variableCollectionId||!validKey(collection.key)||(requested.collectionKey&&collection.key!==requested.collectionKey))reason='collection_identity_mismatch';
  else if(typeof actual.name!=='string'||typeof actual.remote!=='boolean'||typeof collection.name!=='string'||typeof collection.remote!=='boolean'||!Array.isArray(collection.modes)||!collection.modes.length||collection.modes.some(m=>typeof m.modeId!=='string'||!m.modeId||typeof m.name!=='string')||new Set(collection.modes.map(m=>m.modeId)).size!==collection.modes.length||!collection.modes.some(m=>m.modeId===collection.defaultModeId))reason='incomplete_metadata';
  if(reason){unresolved.push({...requested,reason});continue;}
  variables.push({id:actual.id,key:actual.key,name:actual.name,resolvedType:actual.resolvedType,remote:actual.remote,variableCollectionId:actual.variableCollectionId,collectionKey:collection.key,
   collection:{id:collection.id,key:collection.key,name:collection.name,remote:collection.remote,modes:collection.modes.map(m=>({modeId:m.modeId,name:m.name})),defaultModeId:collection.defaultModeId}});
 }
 target();
 return {operationStatus:'read',fileKey:input.fileKey,complete:unresolved.length===0,variables,unresolved,coverage:{requested:input.variables.length,verified:variables.length,complete:unresolved.length===0}};
}
export const buildResolveVariablesCode=input=>compileOperation(resolveVariables,input,{readOnly:true});
