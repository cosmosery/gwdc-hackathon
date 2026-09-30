const test=require('node:test');
const assert=require('node:assert/strict');
const fs=require('node:fs');const os=require('node:os');const path=require('node:path');
const {isContractDeployed,checkPaymentPaid,checkPaidAmount}=require('../src/tron.cjs');
const {initDb}=require('../src/db.cjs');
const web=read=>({defaultAddress:{base58:'test'},trx:{getContract:async()=>({contract_address:'test',bytecode:'ff'})},transactionBuilder:{triggerConfirmedConstantContract:read}});
test('real TRON adapter propagates deployment RPC outage',async()=>{
 await assert.rejects(isContractDeployed({trx:{getContract:async()=>{throw Error('RPC timeout')}}},'test'),/timeout/);
});
test('real TRON adapter handles explicit undeployed contract',async()=>{
 assert.equal(await isContractDeployed({trx:{getContract:async()=>{throw Error('Contract does not exist')}}},'test'),false);
});
test('real TRON adapter propagates paid bitmap and amount failure',async()=>{
 const w=web(async()=>{throw Error('RPC timeout')});
 await assert.rejects(checkPaymentPaid(w,'test',0),/timeout/);
 await assert.rejects(checkPaidAmount(w,'test'),/timeout/);
});
test('real TRON adapter preserves confirmed zero',async()=>{
 const w=web(async()=>({result:{result:true},constant_result:['0'.repeat(64)]}));
 assert.equal(await checkPaidAmount(w,'test'),0n);assert.equal(await checkPaymentPaid(w,'test',0),false);
});
test('malformed confirmed read cannot become zero',async()=>{
 const w=web(async()=>({result:{result:false}}));await assert.rejects(checkPaidAmount(w,'test'),/Confirmed contract read failed/);
});
test('SQLite claim survives reopen and excludes second connection',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'payroll-claim-'));const file=path.join(dir,'test.db');let a,b;
 try{
  a=initDb(file);a.saveBatch({id:'b',sender:'sender',token:'token',batchHash:'hash',merkleRoot:'root',totalAmount:'1',recipientCount:1,expiry:1,salt:'salt',status:'READY',createdAt:1,updatedAt:1});
  a.savePayments('b',[{id:'p',idx:0,recipient:'recipient',amount:'1',proof:[],status:'PENDING'}]);
  b=initDb(file);assert.equal(a.reservePayment('p'),true);assert.equal(b.reservePayment('p'),false);
  a.db.close();a=initDb(file);assert.equal(a.reservePayment('p'),false);assert.equal(a.getPayments('b')[0].attempts,1);
  // Verified failure may reopen that exact old tx, but a stale reader may not
  // overwrite a newer reservation after the tx was cleared by another worker.
  a.updatePaymentStatus('p','FAILED',{txId:'old'});
  assert.equal(a.clearFailedPaymentTx('p','old'),true);
  assert.equal(a.reservePayment('p'),true);
  assert.equal(b.clearFailedPaymentTx('p','old'),false);
  assert.equal(b.reservePayment('p'),false);
 }finally{a?.db.close();b?.db.close();fs.rmSync(dir,{recursive:true,force:true});}
});
