const test=require('node:test');const assert=require('node:assert/strict');
const http=require('node:http');
const {buildServer}=require('../src/server.cjs');const {initDb}=require('../src/db.cjs');const {eventEmitter}=require('../src/events.cjs');
test('SSE streams engine events, removes listener, and gates query authentication',async()=>{
 const db=initDb(':memory:');const token='sse-test-'.repeat(5);const app=buildServer({db,bearerToken:token});
 db.saveBatch({id:'events',sender:'sender',token:'token',batchHash:'hash',merkleRoot:'root',totalAmount:'1',recipientCount:1,expiry:1,salt:'salt',status:'READY',createdAt:1,updatedAt:1});
 const old=process.env.ENABLE_SSE_QUERY_TOKEN;
 try{
  const base=await app.listen({port:0,host:'127.0.0.1'});
  delete process.env.ENABLE_SSE_QUERY_TOKEN;
  assert.equal((await app.inject({method:'GET',url:'/batches/events/events?token='+token})).statusCode,401);
  const stream=async(url,headers={})=>{
   await new Promise((resolve,reject)=>{
    const req=http.get(url,{headers},res=>{
     let body='';res.setEncoding('utf8');
     res.on('data',part=>{
      body+=part;
      if(body.includes(': connected')&&!body.includes('data:'))eventEmitter.emitBatchEvent('events','payment:0 CONFIRMED');
      if(body.includes('data: payment:0 CONFIRMED\n\n')){res.destroy();resolve();}
     });res.on('error',reject);
    });req.on('error',reject);req.setTimeout(2000,()=>req.destroy(Error('SSE stream timeout')));
   });
   for(let i=0;i<30&&eventEmitter.listenerCount('batch:events');i++)await new Promise(r=>setTimeout(r,10));
   assert.equal(eventEmitter.listenerCount('batch:events'),0);
  };
  await stream(base+'/batches/events/events',{authorization:'Bearer '+token});
  process.env.ENABLE_SSE_QUERY_TOKEN='1';await stream(base+'/batches/events/events?token='+token);
 }finally{if(old===undefined)delete process.env.ENABLE_SSE_QUERY_TOKEN;else process.env.ENABLE_SSE_QUERY_TOKEN=old;await app.close();db.db.close();}
});
