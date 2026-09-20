import test from 'node:test';
import assert from 'node:assert/strict';
import { createFigmaMock, executeGenerated } from './helpers/figma-mock.mjs';
import { buildPatchCode, buildRenderCode } from '../src/figma-code.mjs';
import { applyExactParagraphRanges } from '../src/text-paragraphs.mjs';

function nativeParagraphMock(){
 const m=createFigmaMock(),styles=new Map(),created=[],removed=[];
 const fields=['fontName','fontSize','lineHeight','letterSpacing','textCase','textDecoration','paragraphSpacing','paragraphIndent','listSpacing','textWrapStyle','listOptions','indentation','fills','hyperlink'];
 const base={fontName:{family:'Inter',style:'Regular'},fontSize:18,lineHeight:{unit:'PIXELS',value:24},letterSpacing:{unit:'PIXELS',value:0},textCase:'ORIGINAL',textDecoration:'NONE',paragraphSpacing:16,paragraphIndent:0,listSpacing:0,textWrapStyle:'WRAP',listOptions:{type:'NONE'},indentation:0,fills:[],hyperlink:null,boundVariables:{}};
 function text(){
  const n=m.make('TEXT');let chars='',cells=[];
  Object.defineProperty(n,'characters',{configurable:true,get:()=>chars,set:value=>{chars=value;cells=Array.from(value,()=>structuredClone(base));}});
  n.getStyledTextSegments=(wanted,start=0,end=chars.length)=>cells.slice(start,end).map((cell,i)=>({start:start+i,end:start+i+1,characters:chars[start+i],...Object.fromEntries(wanted.filter(f=>cell[f]!==undefined).map(f=>[f,structuredClone(cell[f])]))}));
  for(const field of fields){
   const read=(start,end)=>{const vals=cells.slice(start,end).map(c=>c[field]);return vals.every(v=>JSON.stringify(v)===JSON.stringify(vals[0]))?structuredClone(vals[0]??base[field]):m.figma.mixed;};
   Object.defineProperty(n,field,{configurable:true,get:()=>read(0,chars.length),set:v=>cells.forEach(c=>c[field]=structuredClone(v))});
   n['getRange'+field[0].toUpperCase()+field.slice(1)]=read;
   n['setRange'+field[0].toUpperCase()+field.slice(1)]=(start,end,v)=>{if(['paragraphSpacing','paragraphIndent'].includes(field)){start=chars.lastIndexOf('\n',start-1)+1;const next=chars.indexOf('\n',end-1);end=next<0?chars.length:next+1;}for(let i=start;i<end;i++)cells[i][field]=structuredClone(v);};
  }
  n.setRangeTextStyleIdAsync=async(start,end,id)=>{for(let i=start;i<end;i++)Object.assign(cells[i],structuredClone(styles.get(id)));};
  n.setRangeBoundVariable=(start,end,field,variable)=>{for(let i=start;i<end;i++){if(variable)cells[i].boundVariables[field]={type:'VARIABLE_ALIAS',id:variable.id};else delete cells[i].boundVariables[field];}};
  n.characters='aaaBBBccc';return n;
 }
 m.figma.createText=text;
 m.figma.createTextStyle=()=>{const id='temporary-'+created.length,values={};styles.set(id,values);created.push(id);return new Proxy({id,setBoundVariable(field,variable){values.boundVariables??={};values.boundVariables[field]={type:'VARIABLE_ALIAS',id:variable.id};},remove(){styles.delete(id);removed.push(id);}},{set(target,key,value){values[key]=value;target[key]=value;return true;}});};
 m.figma.getStyleByIdAsync=async id=>styles.get(id)??null;
 return {...m,text,created,removed,styles};
}
const runs=[{start:0,end:3,paragraphSpacing:16},{start:3,end:6,paragraphSpacing:0},{start:6,end:9,paragraphSpacing:16}];
const spacing=n=>n.getStyledTextSegments(['paragraphSpacing']).map(s=>s.paragraphSpacing);

test('generated create and patch preserve exact mixed paragraph ranges and clean temporary styles',async()=>{
 const m=nativeParagraphMock();
 await executeGenerated(m.figma,buildRenderCode({spec:{type:'screen',key:'screen',name:'Screen',width:100,height:100,children:[{type:'text',key:'text',name:'Text',content:'aaaBBBccc',fontFamily:'Inter',fontStyle:'Regular',fontSize:18,paragraphSpacing:16,textRuns:runs}]}}));
 const n=[...m.nodes.values()].find(n=>n.type==='TEXT');assert.deepEqual(spacing(n),[16,16,16,0,0,0,16,16,16]);
 await executeGenerated(m.figma,buildPatchCode({patches:[{id:n.id,set:{textRuns:[{start:0,end:3,paragraphSpacing:4,paragraphIndent:2}]}}]}));
 assert.deepEqual(spacing(n),[4,4,4,0,0,0,16,16,16]);assert.deepEqual(m.removed,m.created);assert.equal(m.styles.size,0);
});

test('generated rollback restores mixed paragraph ranges after a later patch fails',async()=>{
 const m=nativeParagraphMock(),n=m.text(),bad=m.make('FRAME');
 await applyExactParagraphRanges(m.figma,n,runs);const before=spacing(n);
 m.rejectWrites((node,field,value)=>node.id===bad.id&&field==='opacity'&&value===0.5);
 await assert.rejects(()=>executeGenerated(m.figma,buildPatchCode({patches:[{id:n.id,set:{paragraphSpacing:9,textRuns:[{start:0,end:9,paragraphSpacing:9}]}},{id:bad.id,set:{opacity:0.5}}]})),e=>e.operationStatus==='rolled_back');
 assert.deepEqual(spacing(n),before);assert.deepEqual(m.removed,m.created);assert.equal(m.styles.size,0);
});


test('bound paragraph restoration preserves alias identity and becomes an exact no-op on retry',async()=>{
 const m=nativeParagraphMock(),n=m.text(),variable=m.addVariable({id:'size',value:18});
 n.setRangeBoundVariable(0,9,'fontSize',variable);
 n.setRangeBoundVariable=()=>{n.paragraphSpacing=16;throw Error('Node alias writes collapse paragraph metadata');};
 await applyExactParagraphRanges(m.figma,n,runs);
 assert.deepEqual(spacing(n),[16,16,16,0,0,0,16,16,16]);
 for(const segment of n.getStyledTextSegments(['boundVariables']))assert.equal(segment.boundVariables.fontSize.id,variable.id);
 const retry=await applyExactParagraphRanges(m.figma,n,runs);assert.deepEqual(retry,{createdStyleIds:[],removedStyleIds:[]});
 assert.equal(m.styles.size,0);assert.deepEqual(m.created,m.removed);
});
