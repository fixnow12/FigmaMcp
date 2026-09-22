import {z} from 'zod';
import {compileOperation} from './scene-access.mjs';
import {fileKeyDescription} from './file-target.mjs';
const key=z.string().regex(/^[a-f0-9]{40}$/);
export const importVariablesInputSchema={
 operationId:z.string().uuid().optional(),
 attempt:z.number().int().min(1).optional(),
 fileKey:z.string().min(1).max(160).describe(fileKeyDescription),
 variables:z.array(z.object({key,resolvedType:z.enum(['COLOR','FLOAT','STRING','BOOLEAN']),collectionKey:key.optional()}).strict()).min(1).max(100),
};
export const importVariablesSchema=z.object(importVariablesInputSchema).strict().refine(input=>new Set(input.variables.map(v=>v.key)).size===input.variables.length,'Повторяющийся ключ переменной');

async function importVariables(figma,input,access){
 const variables=[],attemptedKeys=[];
 const progress=(stage,requested,id)=>{if(typeof executionControl!=='undefined'&&executionControl.report)executionControl.report({stage,key:requested?.key,id});};
 const fail=message=>{throw Error(message);};
 function target(){access.check();if(figma.fileKey!==input.fileKey)fail('Неверный целевой файл');}
 const coverage=()=>({requested:input.variables.length,verified:variables.length,complete:variables.length===input.variables.length});
 try{
  target();
  for(const requested of input.variables){
   target();
   attemptedKeys.push(requested.key);
   // Imports can settle after cancellation. Keep the mutating execution lock until
   // the native promise settles; never abandon it via access.read/Promise.race.
   progress('native-import',requested);
   const imported=await figma.variables.importVariableByKeyAsync(requested.key);
   progress('variable-read',requested,imported?.id);
   target();
   if(!imported?.id||imported.key!==requested.key||imported.resolvedType!==requested.resolvedType)fail('Импортированная переменная не соответствует key/resolvedType');
   const actual=await access.read(figma.variables.getVariableByIdAsync(imported.id),'импортированная переменная '+requested.key);
   target();
   if(!actual||actual.id!==imported.id||actual.key!==requested.key||actual.resolvedType!==requested.resolvedType||!actual.variableCollectionId)fail('Не подтверждена точная переменная назначения');
   progress('collection-read',requested,actual.id);
   const collection=await access.read(figma.variables.getVariableCollectionByIdAsync(actual.variableCollectionId),'коллекция импортированной переменной '+requested.key);
   target();
   if(!collection?.id||collection.id!==actual.variableCollectionId||!collection.key||requested.collectionKey&&collection.key!==requested.collectionKey)fail('Не подтверждена коллекция импортированной переменной');
   if(typeof actual.name!=='string'||typeof collection.name!=='string'||typeof actual.remote!=='boolean'||typeof collection.remote!=='boolean'||!Array.isArray(collection.modes)||!collection.modes.length||collection.modes.some(m=>!m.modeId||typeof m.name!=='string')||new Set(collection.modes.map(m=>m.modeId)).size!==collection.modes.length||!collection.modes.some(m=>m.modeId===collection.defaultModeId))fail('Неполные метаданные режимов коллекции');
   variables.push({id:actual.id,key:actual.key,name:actual.name,resolvedType:actual.resolvedType,remote:actual.remote,variableCollectionId:actual.variableCollectionId,collectionKey:collection.key,
    collection:{id:collection.id,key:collection.key,name:collection.name,remote:collection.remote,modes:collection.modes.map(m=>({modeId:m.modeId,name:m.name})),defaultModeId:collection.defaultModeId}});
  }
  target();
  progress('verified');
  return {fileKey:input.fileKey,complete:true,variables,coverage:coverage()};
 }catch(error){
  error.operationStatus=attemptedKeys.length?'partial':'not_applied';
  error.fileKey=input.fileKey;
  const previous=error.blockers||[];
  error.blockers=[{type:'variable_import',resource:attemptedKeys[attemptedKeys.length-1]||input.fileKey,evidence:{fileKey:input.fileKey,complete:false,variables,coverage:{...coverage(),complete:false},attemptedKeys,unattemptedKeys:input.variables.map(v=>v.key).filter(k=>!attemptedKeys.includes(k)),cacheState:attemptedKeys.length?'may_have_imported_resources':'unchanged'}},...previous];
  error.nextStep='Импорт не удаляет ресурсы и не откатывает библиотеку. Сохраните подтверждённые переменные из blockers[0].evidence; после тайм-аута проверьте get_status этого fileKey и дождитесь завершения активной операции. Не повторяйте импорт вслепую.';
  throw error;
 }
}
export const buildImportVariablesCode=input=>compileOperation(importVariables,input);
