// Deterministic engine integration tests. Real server, SQLite, signatures and
// Merkle code; only external GasFree/TRON boundaries are replaced. No .env.
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { TronWeb } = require('tronweb');
const tron = require('../src/tron.cjs');
const gas = require('../src/gasfree.cjs');
const { initDb } = require('../src/db.cjs');
const { leaf, merkle } = require('../scripts/common.cjs');
const { classifyFailure } = require('../src/failureCatalog.cjs');
// Fail closed if a boundary mock is accidentally bypassed.
const denyNetwork = () => { throw Error('Unexpected external network access in isolated scenario'); };
global.fetch = denyNetwork;
for (const name of ['node:http', 'node:https']) {
  require(name).request = denyNetwork;
  require(name).get = denyNetwork;
}
const KEY = '01'.repeat(32);
const sender = TronWeb.address.fromPrivateKey(KEY);
const token = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf';
const receiver = 'TXa8D4wuNgyE3UueLhzCKWMUS74YgMCLSr';
const provider = 'TKtWbdzEq5ss9vTS9kwRhBp5mXmBfBns3E';
const gasAddress = 'TQZE7vxcx9qr6d8BczbYYLwfeHJ5ZbDj7c';
const recipient = 'TPCozYqnistWHH9VaoJtjXp5djKX4VJgai';
const authHeaders = { authorization: 'Bearer ' + 'isolated-test-'.repeat(4) };
let s;
const web = { trx: { getTransactionInfo: async id => {
  if (s.receiptError) throw Error('RPC timeout');
  return s.receipts[id] || {};
} } };
Object.assign(tron, {
  getRelayerWeb: () => web, getReadOnlyWeb: () => web,
  predictBatchExecutorAddress: async () => ({ executorAddress: receiver, factoryAddress: provider, implementationAddress: provider, salt: '0x'+'01'.repeat(32) }),
  isContractDeployed: async () => true,
  checkOnChainBalance: async (_w,_t,address) => {
    if(s.balanceError) throw Error('RPC balance unavailable');
    return address===gasAddress?s.accountBalance:s.balance;
  },
  checkPaidAmount: async () => { if(s.paidAmountError) throw Error('RPC paidAmount unavailable'); return s.paidAmount; },
  checkPaymentPaid: async (_w,_e,i) => { if(s.paidError) throw Error('RPC paid unavailable'); return s.paid.has(i); },
  deployBatchExecutorOnChain: async args => {s.deploys++;s.deploymentArgs=args; if(s.deployError) throw Error(s.deployError); return {executorAddress:receiver};},
  executePayoutTx: async (_w,_e,i,_r,amount,_proof,submitted) => {
    s.payouts.push(i);
    if(s.preCallbackTimeout) throw Error('RPC timeout before txId response');
    if(s.payoutDelay) await s.payoutDelay;
    if(s.failIndices.has(i)) throw Error('OUT_OF_ENERGY');
    const tx='payout-'+i;
    submitted(tx);
    if(s.broadcastTimeout) throw Error('RPC timeout after broadcast');
    s.paid.add(i);s.paidAmount+=amount;s.balance-=amount;
    if(s.timeoutAfterPaid) throw Error('RPC timeout after confirmation');
    return tx;
  },
  executeRefundTx: async (_w,_e,submitted) => {
    s.refunds++;if(s.preRefundTimeout)throw Error('RPC timeout before txId response');submitted('refund-tx');
    if(s.refundTimeout)throw Error('RPC timeout after refund broadcast');
    s.balance=0n;return 'refund-tx';
  }
});
Object.assign(gas, {
  getProviderConfig: async () => { if(s.configError)throw Error('Provider unavailable'); return {providers:[{address:provider}],tokens:[{tokenAddress:token,supported:true,transferFee:'300000',activateFee:'1000000'}]}; },
  getAccountInfo: async () => ({active:s.active,allowSubmit:s.allowSubmit,nonce:s.nonce,gasFreeAddress:gasAddress,assets:[{tokenAddress:token,transferFee:'300000',activateFee:'1000000'}]}),
  submitGasFreePermit: async () => {s.submits++;if(s.submitError)throw Error('Provider timeout');return s.noTrace?{}:{id:'trace-1'};},
  queryGasFreeStatus: async () => {if(s.statusError)throw Error('Provider status timeout');return {state:s.providerState,txnHash:'deposit-tx'};}
});
const { buildServer } = require('../src/server.cjs');
const tick = () => new Promise(resolve=>setImmediate(resolve));
async function drain(){for(let i=0;i<25;i++)await tick();}
const cases=[];
function test(name, fn){cases.push({name,fn});}
function seed(db, fields={}, count=2){
  const id=fields.id||'batch';const amounts=Array(count).fill('1000000');
  const tree=merkle(amounts.map((a,i)=>leaf(i,recipient,BigInt(a))));
  db.saveBatch({id,sender,token,batchHash:'hash',merkleRoot:tree.root,totalAmount:String(count*1000000),recipientCount:count,executorAddress:receiver,factoryAddress:provider,expiry:Math.floor(Date.now()/1000)+3600,salt:'salt',status:'READY',createdAt:Date.now(),updatedAt:Date.now(),...fields});
  db.savePayments(id,amounts.map((amount,idx)=>({id:id+'-'+idx,idx,recipient,amount,proof:tree.proof(idx),status:'PENDING'})));
  return id;
}
async function permit(db, changes={}, key=KEY){
  const b=db.getBatch('batch');
  const authorization={token,serviceProvider:provider,user:sender,receiver,value:b.total_amount,maxFee:'1300000',deadline:String(b.expiry-1),version:1,nonce:0,...changes};
  const signer=new TronWeb({fullHost:'http://127.0.0.1:1',privateKey:key});
  const sig=await signer.trx._signTypedData(gas.DOMAIN_NILE,gas.TYPES_PERMIT,authorization,key);
  return {sig,authorization};
}
const payload={sender,token,payments:[{recipient,amount:'1000000'}]};
test('fee cap: twice current fee, principal unaffected',async c=>{const r=(await c.req('/quote',payload)).json();assert.equal(r.gasFreeFeeCap,'600000');assert.equal(r.customerDebitCap,'1600000');assert.equal(r.feePolicy.relayerPaidBy,'OPERATOR');});
test('signing context: exact batch permit and fresh nonce without submission',async c=>{seed(c.db);const r=await c.get('/batches/batch/signing-context');assert.equal(r.statusCode,200);assert.equal(r.json().authorization.receiver,receiver);assert.equal(r.json().authorization.value,'2000000');assert.equal(r.json().authorization.maxFee,'600000');assert.equal(s.submits,0);assert.equal(s.deploys,0);});
test('signing context: activation included in cap',async c=>{seed(c.db);s.active=false;assert.equal((await c.get('/batches/batch/signing-context')).json().authorization.maxFee,'2600000');});
test('signing context: submitted batch cannot obtain a new permit',async c=>{seed(c.db,{status:'PROCESSING'});assert.equal((await c.get('/batches/batch/signing-context')).statusCode,409);});
test('signing context: expired batch rejected',async c=>{seed(c.db,{expiry:1});assert.equal((await c.get('/batches/batch/signing-context')).statusCode,409);});
test('signing context: provider outage fails closed',async c=>{seed(c.db);s.configError=true;assert.equal((await c.get('/batches/batch/signing-context')).statusCode,503);});
test('auth: missing bearer rejected', async c=>assert.equal((await c.app.inject({method:'POST',url:'/quote',payload})).statusCode,401));
test('quote: active account exact units', async c=>{const r=await c.req('/quote',payload);assert.equal(r.statusCode,200);assert.equal(r.json().estimatedTotal,'1300000');});
test('quote: inactive account activation fee included', async c=>{s.active=false;assert.equal((await c.req('/quote',payload)).json().estimatedGasFreeFee,'1300000');});
for(const [label,value] of [['zero','0'],['negative','-1'],['fraction','1.1'],['exponent','1e6'],['unsafe-number',Number.MAX_SAFE_INTEGER+1],['uint256-overflow',(1n<<256n).toString()]])test('quote rejects '+label,async c=>assert.equal((await c.req('/quote',{...payload,payments:[{recipient,amount:value}]})).statusCode,400));
test('quote rejects empty list',async c=>assert.equal((await c.req('/quote',{...payload,payments:[]})).statusCode,400));
test('quote rejects 1001 rows',async c=>assert.equal((await c.req('/quote',{...payload,payments:Array(1001).fill(payload.payments[0])})).statusCode,400));
test('quote accepts 1000 rows',async c=>assert.equal((await c.req('/quote',{...payload,payments:Array(1000).fill(payload.payments[0])})).statusCode,200));
test('quote rejects invalid address',async c=>assert.equal((await c.req('/quote',{...payload,sender:'bad'})).statusCode,400));
test('quote: provider outage returns 503, no invented estimate',async c=>{s.configError=true;assert.equal((await c.req('/quote',payload)).statusCode,503);});
test('create: lazy persistence without deployment',async c=>{const r=await c.req('/batches',payload);assert.equal(r.statusCode,201);assert.equal(c.db.getPayments(r.json().batchId).length,1);assert.equal(s.deploys,0);assert.equal(s.submits,0);});
test('create rejects expired-duration request',async c=>assert.equal((await c.req('/batches',{...payload,expiryDuration:299})).statusCode,400));
test('engine API journey: create, sign, submit, payout, query, report',async c=>{
  const created=(await c.req('/batches',payload)).json();const id=created.batchId;
  const authorization={token,serviceProvider:provider,user:sender,receiver,value:'1000000',maxFee:'1300000',deadline:String(created.expiry-1),version:1,nonce:0};
  const signer=new TronWeb({fullHost:'http://127.0.0.1:1',privateKey:KEY});
  const sig=await signer.trx._signTypedData(gas.DOMAIN_NILE,gas.TYPES_PERMIT,authorization,KEY);
  s.balance=1000000n;
  assert.equal((await c.req('/batches/'+id+'/execute',{authorization,sig},{'idempotency-key':'journey'})).statusCode,200);
  await drain();assert.equal((await c.get('/batches/'+id)).json().status,'SUCCESS');
  assert.equal((await c.get('/batches/'+id+'/payments')).json()[0].status,'CONFIRMED');
  assert.equal((await c.get('/batches/'+id+'/reconciliation')).json().summary.principalPaid,'1.000000');
  assert.equal(s.submits,1);assert.deepEqual(s.payouts,[0]);
});
for(const route of ['/quote','/batches'])test('INPUT: '+route+' null row returns 400, not internal error',async c=>assert.equal((await c.req(route,{...payload,payments:[null]})).statusCode,400));
test('restart: persisted pending batch recovered at server startup',async c=>{
  seed(c.db,{status:'PAYOUT_PENDING'});s.balance=2000000n;
  const restarted=buildServer({db:c.db,bearerToken:authHeaders.authorization.slice(7),logger:false});
  try{await restarted.ready();await drain();assert.equal(c.db.getBatch('batch').status,'SUCCESS');assert.deepEqual(s.payouts,[0,1]);}finally{await restarted.close();}
});
test('restart: abandoned submission becomes UNKNOWN without resubmit',async c=>{
  seed(c.db,{status:'SUBMITTING',updatedAt:Date.now()-180000});
  const restarted=buildServer({db:c.db,bearerToken:authHeaders.authorization.slice(7),logger:false});
  try{await restarted.ready();await drain();assert.equal(c.db.getBatch('batch').status,'SUBMISSION_UNKNOWN');assert.equal(s.submits,0);assert.equal(s.payouts.length,0);}finally{await restarted.close();}
});
test('SQLite transaction: failed payment insert rolls back batch',async c=>{
  seed(c.db);const batch=c.db.getBatch('batch');
  assert.throws(()=>c.db.saveBatchWithPayments({id:'rollback',sender,token,batchHash:'x',merkleRoot:batch.merkle_root,totalAmount:'1',recipientCount:1,expiry:batch.expiry,salt:'x',status:'READY',createdAt:Date.now(),updatedAt:Date.now()},[{id:'batch-0',idx:0,recipient,amount:'1',proof:[],status:'PENDING'}]));
  assert.equal(c.db.getBatch('rollback'),undefined);
});
for(const [label,changes,code] of [
 ['wrong receiver',{receiver:recipient},400],['wrong value',{value:'1'},400],['wrong token',{token:recipient},400],
 ['expired permit',{deadline:'1'},400],['wrong version',{version:2},400],['unknown provider',{serviceProvider:recipient},400],
 ['nonce mismatch',{nonce:1},409],['maxFee insufficient',{maxFee:'1'},400]
])test('execute rejects '+label,async c=>{seed(c.db);const r=await c.req('/batches/batch/execute',await permit(c.db,changes),{'idempotency-key':'k'});assert.equal(r.statusCode,code);assert.equal(s.submits,0);});
test('execute rejects forged signer',async c=>{seed(c.db);assert.equal((await c.req('/batches/batch/execute',await permit(c.db,{},'02'.repeat(32)),{'idempotency-key':'k'})).statusCode,400);assert.equal(s.submits,0);});
test('execute rejects insufficient GasFree balance',async c=>{seed(c.db);s.accountBalance=0n;assert.equal((await c.req('/batches/batch/execute',await permit(c.db),{'idempotency-key':'k'})).statusCode,400);assert.equal(s.submits,0);});
test('execute: same request submitted once',async c=>{seed(c.db);const p=await permit(c.db);for(let i=0;i<2;i++)assert.equal((await c.req('/batches/batch/execute',p,{'idempotency-key':'k'})).statusCode,200);assert.equal(s.submits,1);assert.equal(c.db.getBatch('batch').authorized_fee_cap,'1300000');assert.equal(c.db.getBatch('batch').gasfree_address,gasAddress);});
test('execute: idempotency key with changed request rejected',async c=>{seed(c.db);await c.req('/batches/batch/execute',await permit(c.db),{'idempotency-key':'k'});assert.equal((await c.req('/batches/batch/execute',await permit(c.db,{maxFee:'1400000'}),{'idempotency-key':'k'})).statusCode,409);assert.equal(s.submits,1);});
test('execute: simultaneous distinct keys submit only once',async c=>{seed(c.db);const p=await permit(c.db);const rs=await Promise.all(['a','b'].map(k=>c.req('/batches/batch/execute',p,{'idempotency-key':k})));assert.deepEqual(rs.map(r=>r.statusCode).sort(),[200,409]);assert.equal(s.submits,1);});
for(const mode of ['submitError','noTrace'])test('execute: '+mode+' remains unknown without payout',async c=>{seed(c.db);s[mode]=true;assert.equal((await c.req('/batches/batch/execute',await permit(c.db),{'idempotency-key':'k'})).statusCode,202);assert.equal(c.db.getBatch('batch').status,'SUBMISSION_UNKNOWN');assert.equal(s.payouts.length,0);});
test('workflow: provider FAILED never pays unfunded batch',async c=>{seed(c.db,{traceId:'trace',status:'PROCESSING'});s.providerState='FAILED';await c.resume();assert.equal(c.db.getBatch('batch').status,'FAILED');assert.equal(s.payouts.length,0);});
test('workflow: provider success without balance stays unconfirmed',async c=>{seed(c.db,{traceId:'trace'});s.providerState='SUCCEED';await c.resume();assert.equal(c.db.getBatch('batch').status,'DEPOSIT_UNCONFIRMED');assert.equal(s.payouts.length,0);});
test('workflow: provider outage preserves pending state',async c=>{seed(c.db,{traceId:'trace',status:'PROCESSING'});s.statusError=true;await c.resume();assert.equal(c.db.getBatch('batch').status,'PROCESSING');assert.equal(s.payouts.length,0);});
test('workflow: funded batch succeeds despite provider outage',async c=>{seed(c.db,{traceId:'trace'});s.balance=2000000n;s.statusError=true;await c.resume();assert.equal(c.db.getBatch('batch').status,'SUCCESS');assert.deepEqual(s.payouts,[0,1]);});
test('workflow: partial payout failure preserved',async c=>{seed(c.db);s.balance=2000000n;s.failIndices.add(1);await c.resume();assert.equal(c.db.getBatch('batch').status,'PARTIAL_SUCCESS');assert.equal(c.db.getPayments('batch')[1].status,'FAILED');});
test('workflow: all payouts fail',async c=>{seed(c.db);s.balance=2000000n;s.failIndices=new Set([0,1]);await c.resume();assert.equal(c.db.getBatch('batch').status,'FAILED');});
test('workflow: lazy deployment failure does not payout',async c=>{seed(c.db);s.balance=2000000n;s.deployError='OUT_OF_ENERGY';await c.resume();assert.equal(c.db.getBatch('batch').status,'PAYOUT_PENDING');assert.equal(s.payouts.length,0);});
test('deployment: persisted factory and executor bind recovery across configuration changes',async c=>{seed(c.db);s.balance=2000000n;await c.resume();assert.equal(s.deploymentArgs.factoryAddressOverride,provider);assert.equal(s.deploymentArgs.expectedExecutorAddress,receiver);});
test('workflow: repeated recovery skips confirmed on-chain rows',async c=>{seed(c.db);s.paid.add(0);s.paidAmount=1000000n;s.balance=1000000n;await c.resume();await c.resume();assert.deepEqual(s.payouts,[1]);assert.equal(c.db.getBatch('batch').status,'SUCCESS');});
test('workflow: simultaneous resume runs one worker',async c=>{seed(c.db);s.balance=2000000n;await Promise.all([c.resume(),c.resume()]);assert.deepEqual(s.payouts,[0,1]);});
test('workflow: broadcast timeout keeps submitted, no resend',async c=>{seed(c.db);s.balance=2000000n;s.broadcastTimeout=true;await c.resume();await c.resume();assert.equal(c.db.getPayments('batch')[0].status,'SUBMITTED');assert.deepEqual(s.payouts,[0]);});
test('workflow: timeout after on-chain payment is confirmed',async c=>{seed(c.db);s.balance=2000000n;s.timeoutAfterPaid=true;await c.resume();assert.equal(c.db.getBatch('batch').status,'SUCCESS');});
test('workflow: prior receipt success but bitmap absent waits',async c=>{seed(c.db);s.balance=2000000n;c.db.updatePaymentStatus('batch-0','SUBMITTED',{txId:'old'});s.receipts.old={receipt:{result:'SUCCESS'}};await c.resume();assert.equal(s.payouts.length,0);assert.equal(c.db.getBatch('batch').status,'PAYOUT_PENDING');});
test('retry batch: unknown funding outcome blocked',async c=>{seed(c.db,{status:'FAILED'});assert.equal((await c.req('/batches/batch/retry',{})).statusCode,409);assert.equal(s.submits,0);});
test('retry batch: definitive provider failure resets to READY',async c=>{seed(c.db,{status:'FAILED',providerState:'FAILED'});assert.equal((await c.req('/batches/batch/retry',{})).json().status,'READY');assert.equal(s.submits,0);});
test('retry row: already paid skips send',async c=>{seed(c.db);s.paid.add(0);assert.equal((await c.req('/batches/batch/payments/0/retry',{})).json().status,'CONFIRMED');assert.equal(s.payouts.length,0);});
test('retry row: unfunded blocked',async c=>{seed(c.db);assert.equal((await c.req('/batches/batch/payments/0/retry',{})).statusCode,409);assert.equal(s.payouts.length,0);});
test('retry row: known pending receipt blocks resend',async c=>{seed(c.db);s.balance=2000000n;c.db.updatePaymentStatus('batch-0','SUBMITTED',{txId:'old'});s.receipts.old={id:'old'};assert.equal((await c.req('/batches/batch/payments/0/retry',{})).statusCode,202);assert.equal(s.payouts.length,0);});
test('SAFETY: row retry must not resend when previous receipt missing',async c=>{seed(c.db);s.balance=2000000n;c.db.updatePaymentStatus('batch-0','SUBMITTED',{txId:'old'});await c.req('/batches/batch/payments/0/retry',{});assert.equal(s.payouts.length,0,'Unknown prior tx was broadcast again');});
test('SAFETY: row retry must stop when paid bitmap RPC fails',async c=>{seed(c.db);s.balance=2000000n;s.paidError=true;await c.req('/batches/batch/payments/0/retry',{});assert.equal(s.payouts.length,0,'RPC failure was treated as unpaid');});
test('SAFETY: row broadcast timeout remains unresolved, not FAILED',async c=>{seed(c.db);s.balance=2000000n;s.broadcastTimeout=true;await c.req('/batches/batch/payments/0/retry',{});assert.notEqual(c.db.getPayments('batch')[0].status,'FAILED','Unknown broadcast incorrectly finalized FAILED');});
test('SAFETY: simultaneous row retries must broadcast once',async c=>{seed(c.db);s.balance=2000000n;let release;s.payoutDelay=new Promise(r=>release=r);const pending=[c.req('/batches/batch/payments/0/retry',{}),c.req('/batches/batch/payments/0/retry',{})];await drain();release();await Promise.all(pending);assert.equal(s.payouts.length,1,'No per-row execution lock');});
test('refund: active unpaid batch blocked',async c=>{seed(c.db);s.balance=2000000n;assert.equal((await c.req('/batches/batch/refund',{})).statusCode,409);assert.equal(s.refunds,0);});
test('refund: expired deployed batch returns remaining balance',async c=>{seed(c.db,{expiry:1});s.balance=2000000n;const r=await c.req('/batches/batch/refund',{});assert.equal(r.json().status,'REFUNDED');assert.equal(r.json().refundAmount,'2000000');assert.equal(s.refunds,1);});
test('refund: empty executor does not send',async c=>{seed(c.db);assert.equal((await c.req('/batches/batch/refund',{})).json().status,'EMPTY');assert.equal(s.refunds,0);});
test('refund: broadcast timeout not resubmitted',async c=>{seed(c.db,{expiry:1});s.balance=2000000n;s.refundTimeout=true;await c.req('/batches/batch/refund',{});assert.equal((await c.req('/batches/batch/refund',{})).json().status,'REFUND_PENDING');assert.equal(s.refunds,1);});
test('SAFETY: refund receipt reconciled even after balance becomes zero',async c=>{seed(c.db,{expiry:1});c.db.updateBatchStatus('batch','READY',{refundState:'SUBMITTED',refundTxId:'old'});s.receipts.old={receipt:{result:'SUCCESS'}};await c.req('/batches/batch/refund',{});assert.equal(c.db.getBatch('batch').refund_state,'CONFIRMED','Zero balance early return leaves refund permanently SUBMITTED');});
test('reconciliation: missing batch 404',async c=>assert.equal((await c.get('/batches/missing/reconciliation')).statusCode,404));
test('reconciliation: mixed statuses and exact principal',async c=>{seed(c.db);c.db.updatePaymentStatus('batch-0','CONFIRMED');c.db.updatePaymentStatus('batch-1','FAILED');s.paidAmount=1000000n;const r=(await c.get('/batches/batch/reconciliation')).json();assert.equal(r.reconciliationStatus,'PARTIAL');assert.equal(r.summary.principalPaid,'1.000000');assert.deepEqual(r.items.map(x=>x.statusGroup),['success','failure']);});
test('reconciliation: nonzero chain disagreement detected',async c=>{seed(c.db);c.db.updatePaymentStatus('batch-0','CONFIRMED');s.paidAmount=2000000n;assert.equal((await c.get('/batches/batch/reconciliation')).json().reconciliationStatus,'MISMATCH');});
test('SAFETY: zero on-chain paid amount must not be ignored',async c=>{seed(c.db);for(let i=0;i<2;i++)c.db.updatePaymentStatus('batch-'+i,'CONFIRMED');const r=(await c.get('/batches/batch/reconciliation')).json();assert.notEqual(r.reconciliationStatus,'FINAL','Zero chain amount silently replaced with DB total');});
test('SAFETY: RPC outage must not produce FINAL reconciliation',async c=>{seed(c.db);for(let i=0;i<2;i++)c.db.updatePaymentStatus('batch-'+i,'CONFIRMED');s.paidAmountError=true;assert.notEqual((await c.get('/batches/batch/reconciliation')).json().reconciliationStatus,'FINAL','No chain evidence but FINAL');});
test('SAFETY: estimated provider fee must not become actual fee',async c=>{seed(c.db,{providerRawResponse:JSON.stringify({estimatedTotalFee:987654})});const r=(await c.get('/batches/batch/reconciliation')).json();assert.notEqual(r.summary.actualFeesTotal,'0.987654','Estimated fee exposed as actual');});
test('SAFETY: row fee allocations must sum to actual total',async c=>{seed(c.db,{providerRawResponse:JSON.stringify({txnTotalFee:300001})});for(let i=0;i<2;i++)c.db.updatePaymentStatus('batch-'+i,'CONFIRMED');s.paidAmount=2000000n;const r=(await c.get('/batches/batch/reconciliation')).json();const units=x=>BigInt(x.replace('.',''));assert.equal(r.items.reduce((n,x)=>n+units(x.actualFee),0n),units(r.summary.actualFeesTotal),'Fee allocation loses smallest unit');});
test('POLICY: relayer fee shortage must not demand customer top-up',async()=>{const r=classifyFailure(Error('OUT_OF_ENERGY'),{actor:'relayer'});assert.notEqual(r.category,'USER_ACTION','Relayer fee failure asks user to TOP_UP_TRX');});
test('POLICY: network timeout must reconcile before resubmit',async()=>{const r=classifyFailure(Error('RPC timeout after broadcast'));assert.notEqual(r.nextAction,'RETRY_PAYOUT','Uncertain outcome is directly marked retry');});
test('recovery: row timeout without txId must retain persisted claim',async c=>{seed(c.db);s.balance=2000000n;s.preCallbackTimeout=true;await c.req('/batches/batch/payments/0/retry',{});await c.req('/batches/batch/payments/0/retry',{});await c.resume();assert.deepEqual(s.payouts,[0]);assert.equal(c.db.getPayments('batch')[0].status,'SUBMITTING');});
test('recovery: worker timeout without txId must not auto-resend',async c=>{seed(c.db);s.balance=2000000n;s.preCallbackTimeout=true;await c.resume();await c.resume();assert.deepEqual(s.payouts,[0]);assert.equal(c.db.getPayments('batch')[0].status,'SUBMITTING');});
test('recovery: row retry and batch worker share exclusion',async c=>{seed(c.db);s.balance=2000000n;let release;s.payoutDelay=new Promise(r=>release=r);const pending=c.req('/batches/batch/payments/0/retry',{});await drain();await c.resume();release();await pending;assert.deepEqual(s.payouts,[0]);});
test('retry: expired batch must not broadcast payout',async c=>{seed(c.db,{expiry:1});s.balance=2000000n;assert.equal((await c.req('/batches/batch/payments/0/retry',{})).statusCode,409);assert.equal(s.payouts.length,0);});
test('refund: timeout without txId keeps claim and blocks resend',async c=>{seed(c.db,{expiry:1});s.balance=2000000n;s.preRefundTimeout=true;await c.req('/batches/batch/refund',{});assert.equal((await c.req('/batches/batch/refund',{})).statusCode,409);assert.equal(s.refunds,1);assert.equal(c.db.getBatch('batch').refund_state,'SUBMITTING');});
test('reconciliation: missing fee and balance evidence remains unknown',async c=>{seed(c.db,{status:'SUCCESS'});for(let i=0;i<2;i++)c.db.updatePaymentStatus('batch-'+i,'CONFIRMED');s.paidAmount=2000000n;const r=(await c.get('/batches/batch/reconciliation')).json();assert.equal(r.summary.actualFeesTotal,null);assert.equal(r.summary.balanceCheck.matched,null);assert.equal(r.summary.balanceCheck.actualDecrease,null);assert.equal(r.summary.evidence.complete,false);assert.notEqual(r.reconciliationStatus,'FINAL');});
test('reconciliation: confirmed zero fee is preserved',async c=>{seed(c.db,{providerRawResponse:JSON.stringify({txnTotalFee:0})});assert.equal((await c.get('/batches/batch/reconciliation')).json().summary.actualFeesTotal,'0.000000');});
test('reconciliation: failed rows share funding fee without lost units',async c=>{seed(c.db,{providerRawResponse:JSON.stringify({txnTotalFee:300001})});c.db.updatePaymentStatus('batch-0','CONFIRMED');c.db.updatePaymentStatus('batch-1','FAILED');s.paidAmount=1000000n;const r=(await c.get('/batches/batch/reconciliation')).json();assert.deepEqual(r.items.map(x=>x.actualFee),['0.150001','0.150000']);});

(async()=>{
  const results=[];
  for(const t of cases){
    s={balance:0n,accountBalance:100000000n,paidAmount:0n,paid:new Set(),receipts:{},payouts:[],deploys:0,refunds:0,submits:0,failIndices:new Set(),providerState:'WAITING',active:true,allowSubmit:true,nonce:0};
    const db=initDb(':memory:');const app=buildServer({db,bearerToken:authHeaders.authorization.slice(7),logger:false});await app.ready();
    const req=(url,payload,headers={})=>app.inject({method:'POST',url,payload,headers:{...authHeaders,...headers}});
    const context={app,db,req,get:url=>app.inject({method:'GET',url,headers:authHeaders}),resume:async()=>{await req('/batches/batch/resume',{});await drain();}};
    try{await t.fn(context);results.push({scenario:t.name,status:'PASS'});console.log('PASS',t.name);}
    catch(e){results.push({scenario:t.name,status:'FAIL',error:e.message});console.log('FAIL',t.name,':',e.message);}
    finally{await drain();await app.close();db.db.close();}
  }
  const report={timestamp:new Date().toISOString(),scope:'Isolated engine integration; real API/DB/signatures, simulated external boundaries; no on-chain transfer',total:results.length,passed:results.filter(r=>r.status==='PASS').length,failed:results.filter(r=>r.status==='FAIL').length,results};
  const out=path.join(__dirname,'../artifacts/engine-scenarios.json');fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');
  console.log(JSON.stringify({total:report.total,passed:report.passed,failed:report.failed,report:out}));
  process.exitCode=report.failed?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});
