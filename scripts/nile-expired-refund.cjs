// Live Nile regression: deliberately fund an expired counterfactual executor,
// then exercise the engine refund endpoint. This is a recovery fixture, not
// the normal batch creation API (which correctly rejects expired batches).
const fs=require('node:fs');const path=require('node:path');const crypto=require('node:crypto');
const {TronWeb}=require('tronweb');const {leaf,merkle}=require('./common.cjs');
const {initDb}=require('../src/db.cjs');const {buildServer}=require('../src/server.cjs');
const {getRelayerWeb,predictBatchExecutorAddress,checkOnChainBalance,isContractDeployed}=require('../src/tron.cjs');
const {DOMAIN_NILE,TYPES_PERMIT,getAccountInfo,getProviderConfig,submitGasFreePermit,queryGasFreeStatus}=require('../src/gasfree.cjs');
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
async function main(){
 const key=process.env.NILE_USER_PRIVATE_KEY;
 const web=getRelayerWeb(),signer=new TronWeb({fullHost:'https://nile.trongrid.io',privateKey:key});
 const sender=signer.address.fromPrivateKey(key);const token=process.env.NILE_USDT_ADDRESS;
 if(!web.fullNode.host.includes('nile')||!process.env.GASFREE_BASE_URL?.includes('open-test')&&process.env.GASFREE_BASE_URL)throw Error('Nile-only regression');
 const amount=100000n;const [account,config]=await Promise.all([getAccountInfo(sender),getProviderConfig()]);
 const asset=account.assets.find(x=>x.tokenAddress===token);const fee=BigInt(asset.transferFee)+(account.active?0n:BigInt(asset.activateFee));
 if(fee>1300000n)throw Error('Test fee cap exceeded');
 if(await checkOnChainBalance(web,token,account.gasFreeAddress)<amount+fee)throw Error('Test USDT unavailable');
 if(await web.trx.getBalance(web.defaultAddress.base58)<300000000)throw Error('Need test TRX reserve');
 const db=initDb();
 const existing=process.env.NILE_REFUND_BATCH_ID?db.getBatch(process.env.NILE_REFUND_BATCH_ID):null;
 if(process.env.NILE_REFUND_BATCH_ID&&!existing)throw Error('Recovery fixture not found');
 if(existing&&(existing.sender!==sender||existing.token!==token||existing.total_amount!==String(amount)))throw Error('Recovery fixture mismatch');
 const id=existing?.id||'refund_regression_'+crypto.randomUUID().replaceAll('-','');
 const expiry=existing?.expiry??Math.floor(Date.now()/1000)-1;const tree=merkle([leaf(0,sender,amount)]);
 const prediction=await predictBatchExecutorAddress({token,root:tree.root,totalAmount:amount,refundAddress:sender,expiry,batchId:id});
 if(existing&&existing.executor_address!==prediction.executorAddress)throw Error('Persisted executor mismatch; do not submit');
 if(!existing&&await isContractDeployed(web,prediction.executorAddress))throw Error('Fixture executor already deployed');
 const app=buildServer({db,logger:false});await app.ready();
 try{
  if(!existing) db.saveBatchWithPayments({id,sender,token,batchHash:crypto.createHash('sha256').update(id).digest('hex'),merkleRoot:tree.root,totalAmount:String(amount),recipientCount:1,executorAddress:prediction.executorAddress,factoryAddress:prediction.factoryAddress,expiry,salt:prediction.salt,status:'READY',createdAt:Date.now(),updatedAt:Date.now()},[{id:id+'_0',idx:0,recipient:sender,amount:String(amount),proof:tree.proof(0),status:'PENDING'}]);
  const message={token,serviceProvider:config.providers[0].address,user:sender,receiver:prediction.executorAddress,value:String(amount),maxFee:String(fee),deadline:String(Math.floor(Date.now()/1000)+180),version:1,nonce:account.nonce};
  const sig=await signer.trx._signTypedData(DOMAIN_NILE,TYPES_PERMIT,message,key);
  // Do not retry this submission automatically on any transport failure.
  if(existing&&!existing.trace_id)throw Error('Existing submission outcome unknown; do not resubmit');
  const submitted=existing?{id:existing.trace_id}:await submitGasFreePermit({...message,value:Number(amount),maxFee:Number(fee),deadline:Number(message.deadline),sig:sig.replace(/^0x/,''),requestId:crypto.randomUUID()});
  db.updateBatchStatus(id,'READY',{traceId:submitted.id});
  console.log(JSON.stringify({stage:'EXPIRED_ADDRESS_FUNDING',batchId:id,executorAddress:prediction.executorAddress,traceId:submitted.id}));
  let providerStatus;
  for(let i=0;i<60;i++){
   try { providerStatus=await queryGasFreeStatus(submitted.id); }
   catch (_) { console.log(JSON.stringify({stage:'PROVIDER_QUERY_RETRY',batchId:id}));await sleep(5000);continue; }
   if(providerStatus.state==='FAILED')throw Error('Regression funding failed');
   if(await checkOnChainBalance(web,token,prediction.executorAddress)===amount)break;
   await sleep(5000);
  }
  if(await checkOnChainBalance(web,token,prediction.executorAddress)!==amount)throw Error('Funding not confirmed; fixture retained for recovery');
  db.updateBatchStatus(id,'READY',{depositTxId:providerStatus.txnHash,providerState:providerStatus.state,providerRawResponse:JSON.stringify(providerStatus)});
  const ownerBefore=await checkOnChainBalance(web,token,sender);
  const res=await app.inject({method:'POST',url:'/batches/'+id+'/refund',headers:{authorization:'Bearer '+process.env.API_BEARER_TOKEN},payload:{}});
  if(res.statusCode!==200||res.json().status!=='REFUNDED')throw Error('Refund unconfirmed: '+res.body);
  const remaining=await checkOnChainBalance(web,token,prediction.executorAddress);const ownerAfter=await checkOnChainBalance(web,token,sender);
  if(remaining!==0n||ownerAfter-ownerBefore!==amount)throw Error('Refund balance mismatch');
  const record={network:'nile',scenario:'expired_undeployed_refund',result:'PASS',batchId:id,executor:prediction.executorAddress,factory:prediction.factoryAddress,depositTx:providerStatus.txnHash,refundTx:res.json().refundTxId,returnedAtomic:String(ownerAfter-ownerBefore),remainingAtomic:String(remaining),timestamp:new Date().toISOString()};
  fs.writeFileSync(path.join(__dirname,'../artifacts/nile-expired-refund.json'),JSON.stringify(record,null,2)+'\n');console.log(JSON.stringify(record));
 }finally{await app.close();db.db.close();}
}
main().catch(e=>{console.error(e.message);process.exitCode=1;});
