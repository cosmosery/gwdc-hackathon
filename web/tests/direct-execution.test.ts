import test from 'node:test';
import assert from 'node:assert/strict';
import {engine} from '../src/api';
import {directExecutionKey} from '../src/direct-execution';
test('manual execute sends only direct mode and preserves idempotency header',async()=>{
 const original=globalThis.fetch;
 const calls:any[]=[];
 globalThis.fetch=async(url,options)=>{calls.push({url,options});return new Response(JSON.stringify({batchId:'b_test',status:'PROCESSING'}),{status:200});};
 try{await engine.executeFunded('b_test','stable-key');assert.equal(calls[0].url,'/api/batches/b_test/execute');assert.equal(calls[0].options.method,'POST');assert.deepEqual(JSON.parse(calls[0].options.body),{mode:'direct'});assert.equal(calls[0].options.headers['Idempotency-Key'],'stable-key');}finally{globalThis.fetch=original;}
});
test('execution key survives reload and is isolated by batch',()=>{
 const values=new Map<string,string>();const storage={getItem:(k:string)=>values.get(k)??null,setItem:(k:string,v:string)=>{values.set(k,v);}};
 const first=directExecutionKey(storage,'b_one');assert.equal(directExecutionKey(storage,'b_one'),first);assert.notEqual(directExecutionKey(storage,'b_two'),first);
});
test('insufficient balance remains an error rather than accepted execution',async()=>{
 const original=globalThis.fetch;
 globalThis.fetch=async()=>new Response(JSON.stringify({error:'BatchExecutor balance (0) is insufficient'}),{status:400});
 try{await assert.rejects(engine.executeFunded('b_test','stable-key'),/insufficient/);}finally{globalThis.fetch=original;}
});
