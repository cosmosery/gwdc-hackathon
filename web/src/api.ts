import type { Batch, BatchProgressView, Payment, Quote, Reconciliation, ReviewRow } from './domain';
import { TOKEN } from './domain';
export class ApiError extends Error { constructor(message:string,public status:number){super(message);} }
const DEMO_BEARER_TOKEN = '22016109c55d3b06a55a164172a0c03142bf4a13b34b3e77b47264152345d4df';
let apiToken = DEMO_BEARER_TOKEN;
export function setApiToken(value:string){apiToken=value.trim() || DEMO_BEARER_TOKEN;}
async function request(path:string,body?:unknown,key?:string){
  const res=await fetch('/api'+path,{method:body?'POST':'GET',headers:{...(body?{'Content-Type':'application/json'}:{}),...(key?{'Idempotency-Key':key}:{}),...(apiToken?{Authorization:'Bearer '+apiToken}:{})},body:body?JSON.stringify(body):undefined,signal:AbortSignal.timeout(16000)});
  const value=await res.json(); if(!res.ok)throw new ApiError(value.error||'Engine request failed',res.status);return value;
}
export function assertQuote(v:any):Quote {
  for(const field of ['totalAmount','estimatedGasFreeFee','estimatedTotal'])if(typeof v[field]!=='string'||!/^\d+$/.test(v[field]))throw Error('Unexpected quote amount format');
  if(!Number.isSafeInteger(v.recipientCount)||!Number.isSafeInteger(v.transactionCount)||typeof v.estimatedRelayerFeeTrx!=='string'||!/^\d+(\.\d+)?$/.test(v.estimatedRelayerFeeTrx))throw Error('Unexpected quote response');
  const cap=v.gasFreeFeeCap??(BigInt(v.estimatedGasFreeFee)*2n).toString();
  if(typeof cap!=='string'||!/^\d+$/.test(cap)||BigInt(cap)<BigInt(v.estimatedGasFreeFee))throw Error('Unexpected fee cap');
  const debit=(BigInt(v.totalAmount)+BigInt(cap)).toString();
  if(v.customerDebitCap!==undefined&&v.customerDebitCap!==debit)throw Error('Unexpected maximum debit');
  return {...v,gasFreeFeeCap:cap,customerDebitCap:debit};
}
function id(value:string){if(!/^[A-Za-z0-9_-]{1,128}$/.test(value))throw Error('Enter a valid engine batch ID');return encodeURIComponent(value);}
export function normalizeProgress(value:any,batch:Batch,payments:Payment[]):BatchProgressView {
  if(value.batchId!==batch.batchId||!Number.isInteger(value.progressPercent)||value.progressPercent<0||value.progressPercent>100)throw Error('Unexpected progress response');
  const depositRecorded=Boolean(batch.depositTxId),submitted=Boolean(batch.traceId);
  const funded=depositRecorded||['PAYOUT_PENDING','SUCCESS','PARTIAL_SUCCESS','REFUNDED'].includes(batch.status)||payments.some(p=>Boolean(p.txId));
  const finalized=payments.filter(p=>['CONFIRMED','FAILED'].includes(p.status)).length;
  const stages:BatchProgressView['stages']=[
    {key:'prepared',label:'List prepared',detail:'Saved by the engine',state:'COMPLETE'},
    {key:'authorization',label:'Payment authorization',detail:submitted?'Provider tracking reference recorded':'Awaiting provider acceptance',state:submitted?'COMPLETE':batch.status==='READY'?'WAITING':'INVESTIGATING'},
    {key:'funding',label:'Funding confirmed',detail:depositRecorded?'Funding transaction recorded by the engine':funded?'Executor funded; manual transfer hash not recorded':'Awaiting confirmed Executor funds',state:funded?'COMPLETE':'WAITING'},
    {key:'executor',label:'Executor',detail:'See recorded recipient transactions',state:payments.some(p=>p.txId)?'COMPLETE':'WAITING'},
    {key:'payouts',label:'Recipient payments',detail:`${batch.counts.success} of ${batch.counts.total} confirmed`,state:batch.status==='SUCCESS'?'COMPLETE':batch.counts.failed?'ATTENTION':funded?'ACTIVE':'WAITING'},
    {key:'reconciliation',label:'Result review',detail:'Open the engine reconciliation report',state:'WAITING'},
  ];
  return {...value,status:batch.status,currentStage:batch.status,stages,counts:batch.counts,paymentPercent:payments.length?Math.floor(finalized/payments.length*100):0,isTerminal:['SUCCESS','FAILED','REFUNDED'].includes(batch.status),evidence:{providerTrace:submitted,fundingTransaction:depositRecorded,payoutTransactions:payments.filter(p=>p.txId).length,refundTransaction:Boolean(batch.refundTxId)}};
}
export type FundingBalance={batchId:string;executorAddress:string;balance:string;required:string;funded:boolean;network:'NILE';source:string};
export const engine={
  create:(sender:string,rows:ReviewRow[])=>request('/batches',{sender,token:TOKEN,payments:rows.map(r=>({recipient:r.address,amount:r.atomic}))}),
  fundingBalance:async(batchId:string):Promise<FundingBalance>=>{
    const value=await request('/batches/'+id(batchId)+'/funding-balance');
    if(value.batchId!==batchId||!/^\d+$/.test(value.balance)||!/^\d+$/.test(value.required)||value.funded!==(BigInt(value.balance)>=BigInt(value.required)))throw Error('Unexpected on-chain funding response');
    return value;
  },
  executeFunded:async(batchId:string,key:string)=>{
    if(!key)throw Error('An execution idempotency key is required');
    const value=await request('/batches/'+id(batchId)+'/execute',{mode:'direct'},key);
    if(value.batchId!==batchId||!['PROCESSING','PAYOUT_PENDING','SUCCESS','PARTIAL_SUCCESS','FAILED','REFUNDED'].includes(value.status))throw Error('Unexpected execution response; check batch status before retrying');
    return value;
  },
  fees:(batchId:string)=>request('/batches/'+id(batchId)+'/fees'),
  signingContext:(batchId:string)=>request('/batches/'+id(batchId)+'/signing-context'),
  execute:(batchId:string,authorization:unknown,signature:string,key:string)=>request('/batches/'+id(batchId)+'/execute',{authorization,signature},key),
  health:()=>request('/health'),
  quote:async(sender:string,rows:ReviewRow[])=>assertQuote(await request('/quote',{sender,token:TOKEN,payments:rows.map(r=>({recipient:r.address,amount:r.atomic}))})),
  progress:async(batchId:string):Promise<BatchProgressView>=>{
    const value=await request('/batches/'+id(batchId)+'/progress');
    if(!Array.isArray(value.stages)){
      const {batch,payments}=await engine.snapshot(batchId);
      return normalizeProgress(value,batch,payments);
    }
    if(value.batchId!==batchId||!Number.isInteger(value.progressPercent))throw Error('Unexpected progress response');
    return value;
  },
  snapshot:async(batchId:string):Promise<{batch:Batch;payments:Payment[]}>=>{
    const path='/batches/'+id(batchId);const [batch,payments]=await Promise.all([request(path),request(path+'/payments')]);
    if(batch.batchId!==batchId||!batch.counts||typeof batch.status!=='string'||!Array.isArray(payments))throw Error('Unexpected batch response');
    for(const p of payments)if(!Number.isInteger(p.index)||typeof p.amount!=='string'||!/^\d+$/.test(p.amount)||typeof p.status!=='string')throw Error('Unexpected payment response');
    return {batch,payments};
  },
  reconciliation:async(batchId:string):Promise<Reconciliation>=>{
    const r=await request('/batches/'+id(batchId)+'/reconciliation');
    if(r.batchId!==batchId||r.decimals!==6||!r.summary||!Array.isArray(r.items)||!['FINAL','PARTIAL','MISMATCH'].includes(r.reconciliationStatus))throw Error('Unexpected reconciliation response');return r;
  },
};
