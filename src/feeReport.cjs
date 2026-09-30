const { TronWeb } = require('tronweb');
const TRANSFER='ddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef';
const hex = address => TronWeb.address.toHex(address).slice(-40).toLowerCase();
function tokenTransfers(receipt,token){
  if(receipt?.receipt?.result!=='SUCCESS')return [];
  return (receipt.log||[]).filter(l=>l.address.toLowerCase().replace(/^0x/,'').slice(-40)===hex(token)&&l.topics?.[0]===TRANSFER&&l.topics.length===3&&/^[a-f0-9]{64}$/i.test(l.data)).map(l=>({from:l.topics[1].slice(-40).toLowerCase(),to:l.topics[2].slice(-40).toLowerCase(),amount:BigInt('0x'+l.data)}));
}
function verifyFundingFee(receipt,batch,gasFreeAddress){
  if(!receipt?.id||receipt.receipt?.result!=='SUCCESS'||!gasFreeAddress)return null;
  const transfers=tokenTransfers(receipt,batch.token),source=hex(gasFreeAddress),target=hex(batch.executor_address);
  const funded=transfers.filter(t=>t.from===source&&t.to===target).reduce((n,t)=>n+t.amount,0n);
  if(funded!==BigInt(batch.total_amount))return null;
  const debit=transfers.reduce((n,t)=>n+(t.from===source?t.amount:0n)-(t.to===source?t.amount:0n),0n);
  if(debit<funded)return null;
  return {principal:funded.toString(),customerDebit:debit.toString(),actualFee:(debit-funded).toString(),source:'CONFIRMED_TOKEN_TRANSFER_LOGS'};
}
async function buildFeeReport(db,batch,web,getAccountInfo){
  const entries=new Map(db.getTransactions(batch.id).map(t=>[t.tx_id,{txId:t.tx_id,kind:t.kind}]));
  for(const p of db.getPayments(batch.id))if(p.tx_id&&!entries.has(p.tx_id))entries.set(p.tx_id,{txId:p.tx_id,kind:'PAYOUT'});
  if(batch.refund_tx_id)entries.set(batch.refund_tx_id,{txId:batch.refund_tx_id,kind:'REFUND'});
  const transactions=await Promise.all([...entries.values()].map(async t=>{
    try {const r=await web.trx.getTransactionInfo(t.txId);if(r.id!==t.txId||!r.receipt?.result)return {...t,status:'UNCONFIRMED',feeSun:null};if(!/^\d+$/.test(String(r.fee??0)))return {...t,status:'INVALID_RECEIPT',feeSun:null};return {...t,status:r.receipt.result,feeSun:String(r.fee??0)};}
    catch{return {...t,status:'UNAVAILABLE',feeSun:null};}
  }));
  let funding=null;
  if(batch.deposit_tx_id){try {const gasAddress=batch.gasfree_address||(await getAccountInfo(batch.sender)).gasFreeAddress;const receipt=await web.trx.getTransactionInfo(batch.deposit_tx_id);if(receipt.id===batch.deposit_tx_id)funding=verifyFundingFee(receipt,batch,gasAddress);}catch{/* Unknown remains unknown. */}}
  const cap=batch.authorized_fee_cap;
  const missing=[];
  if(!funding)missing.push('Confirmed funding token-transfer evidence');
  if(cap===null||cap===undefined)missing.push('Persisted authorized fee cap (legacy batch)');
  if(!transactions.some(t=>t.kind==='DEPLOY'))missing.push('Executor deployment transaction record');
  if(transactions.some(t=>t.feeSun===null))missing.push('One or more confirmed relayer receipts');
  const unused=cap!=null&&funding&&BigInt(cap)>=BigInt(funding.actualFee)?(BigInt(cap)-BigInt(funding.actualFee)).toString():null;
  return {batchId:batch.id,token:batch.token,decimals:6,authorizedGasFreeFeeCap:cap??null,
    funding,unusedAuthorization:unused,unusedAuthorizationTreatment:'NOT_CHARGED',
    feeCapMatched:cap!=null&&funding?BigInt(funding.actualFee)<=BigInt(cap):null,
    relayerPaidBy:'OPERATOR',relayerBurnedFeeSun:transactions.reduce((n,t)=>n+BigInt(t.feeSun||0),0n).toString(),
    relayerFeeScope:'Confirmed tracked transactions only; staked/rented resource costs excluded',
    transactions,missingEvidence:missing,status:missing.length?'PARTIAL':'VERIFIED_TRACKED_FEES',
    principalRefund:{amount:batch.refund_amount??null,txId:batch.refund_tx_id??null,status:batch.refund_state??null}};
}
module.exports={verifyFundingFee,buildFeeReport};
