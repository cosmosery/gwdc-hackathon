const test = require('node:test');
const assert = require('node:assert/strict');
const {buildServer} = require('../src/server.cjs');
const {initDb} = require('../src/db.cjs');
test('merged dashboard does not disclose bearer; progress and status events coexist', async () => {
 const db=initDb(':memory:'); const token='private-regression-token-'.repeat(3);
 const app=buildServer({db,bearerToken:token});
 try {
  for(const url of ['/','/dashboard']) {
   const r=await app.inject({url}); assert.equal(r.statusCode,200); assert.equal(r.body.includes(token),false);
  }
  const now=Date.now();
  db.saveBatchWithPayments({id:'merge_test',sender:'sender',token:'token',batchHash:'hash',merkleRoot:'root',totalAmount:'10000',recipientCount:1,expiry:1,salt:'salt',status:'READY',createdAt:now,updatedAt:now},[{id:'p_merge',idx:0,recipient:'recipient',amount:'10000',proof:[],status:'PENDING'}]);
  const headers={authorization:'Bearer '+token};
  const p=await app.inject({url:'/batches/merge_test/progress',headers});assert.equal(p.statusCode,200);
  const v=p.json();assert.equal(v.paymentPercent,0);assert.equal(v.financials.actualFeesTotal,null);assert.equal(v.reconciliationStatus,null);assert.equal(v.counts.succeeded,0);assert.ok(v.stages.length);
  db.updatePaymentStatus('p_merge','SUBMITTING');
  const e=await app.inject({url:'/batches/merge_test/status-events',headers});assert.equal(e.statusCode,200);assert.ok(e.json().events.some(x=>x.to_status==='SUBMITTING'));
 }finally {await app.close();db.db.close();}
});
