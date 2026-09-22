import test from 'node:test';import assert from 'node:assert/strict';import {readFileSync} from 'node:fs';import vm from 'node:vm';
test('UI buffers late native ID across authenticated reconnect until durable ACK, including lost ACK retransmission',()=>{
 const html=readFileSync(new URL('../src/figma-plugin/ui.html',import.meta.url),'utf8');
 const script=html.match(/OPERATION_JOURNAL_RELAY_START([\s\S]*?)\/\/ OPERATION_JOURNAL_RELAY_END/)[1];
 let connections=[],tick;const window={__wsGetActiveConnections:()=>connections};vm.runInNewContext(script,{window,Map,setInterval:fn=>{tick=fn;}});
 const old={url:'ws://localhost:9233',readyState:3,send(){throw Error('closed');}};
 const meta={operationId:'id',fileKey:'file',argsHash:'hash',resumeToken:'private-token'};window.__journalRegister(meta,old);
 window.__journalEvent({...meta,sequence:1,stage:'variable-read',key:'key',id:'late-real-id'});
 window.__journalEvent({...meta,sequence:2,stage:'settled',success:false});
 const sent=[],fresh={url:old.url,readyState:1,send:text=>sent.push(JSON.parse(text))};connections=[{authenticated:true,ws:fresh}];
 tick();assert.equal(sent.length,2);assert.equal(sent[0].data.id,'late-real-id');
 tick();assert.equal(sent.length,4,'unacknowledged events are retained');
 window.__journalAck({operationId:'id',fileKey:'foreign',argsHash:'hash',sequence:1});tick();assert.equal(sent.length,6);
 window.__journalAck({...meta,sequence:2});window.__journalAck({...meta,sequence:1});tick();assert.equal(sent.length,6,'cleanup only after persisted acknowledgements');
});
