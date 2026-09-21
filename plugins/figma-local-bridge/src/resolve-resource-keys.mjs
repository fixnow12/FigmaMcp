import {z} from 'zod';
import {compileOperation} from './scene-access.mjs';
import {fileKeyDescription} from './file-target.mjs';
const ids=()=>z.array(z.string().min(1).max(512)).max(100);
export const resolveResourceKeysInputSchema={fileKey:z.string().min(1).max(160).describe(fileKeyDescription),variableIds:ids().optional(),nodeIds:ids().optional()};
export const resolveResourceKeysSchema=z.object(resolveResourceKeysInputSchema).strict().refine(input=>{
 const vars=input.variableIds||[],nodes=input.nodeIds||[];return vars.length+nodes.length>0&&vars.length+nodes.length<=100&&new Set(vars).size===vars.length&&new Set(nodes).size===nodes.length;
},'Нужны 1–100 уникальных идентификаторов ресурсов');
async function resolveResourceKeys(figma,input,access){
 const variables=[],nodes=[],unresolved=[];
 const key=value=>typeof value==='string'&&/^[a-f0-9]{40}$/.test(value);
 const target=()=>{access.check();if(figma.fileKey!==input.fileKey)throw Error('Неверный целевой файл target');};
 target();
 for(const id of input.variableIds||[]){
  target();try{
   const variable=await access.read(figma.variables.getVariableByIdAsync(id),'variable '+id);target();
   if(!variable||variable.id!==id||!key(variable.key)||!['COLOR','FLOAT','STRING','BOOLEAN'].includes(variable.resolvedType)||!variable.variableCollectionId)throw Error('Invalid variable');
   const collection=await access.read(figma.variables.getVariableCollectionByIdAsync(variable.variableCollectionId),'variable collection');target();
   if(!collection||collection.id!==variable.variableCollectionId||!key(collection.key))throw Error('Invalid collection');
   variables.push({id:variable.id,key:variable.key,resolvedType:variable.resolvedType,variableCollectionId:variable.variableCollectionId,collectionKey:collection.key});
  }catch{target();unresolved.push({kind:'variable',id,reason:'unavailable-or-invalid'});}
 }
 for(const id of input.nodeIds||[]){
  target();try{
   const node=await access.read(figma.getNodeByIdAsync(id),'component '+id);target();
   if(!node||node.id!==id||!['COMPONENT','COMPONENT_SET'].includes(node.type)||!key(node.key))throw Error('Invalid component');
   nodes.push({id:node.id,type:node.type,key:node.key,semanticKey:node.getPluginData?.(access.dataKey)||null});
  }catch{target();unresolved.push({kind:'node',id,reason:'unavailable-or-invalid'});}
 }
 target();return {operationStatus:'read',fileKey:figma.fileKey,pageId:access.page.id,complete:unresolved.length===0,coverage:{requested:(input.variableIds?.length||0)+(input.nodeIds?.length||0),verified:variables.length+nodes.length,unresolved},variables,nodes};
}
export const buildResolveResourceKeysCode=input=>compileOperation(resolveResourceKeys,input,{readOnly:true});
