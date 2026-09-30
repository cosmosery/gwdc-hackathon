import test from 'node:test';
import assert from 'node:assert/strict';
import {assertQuote,normalizeProgress} from '../src/api';
import type {Batch} from '../src/domain';
const quote={recipientCount:1,totalAmount:'10000',estimatedGasFreeFee:'300000',estimatedRelayerFeeTrx:'35.0',estimatedTotal:'310000',transactionCount:3};
test('remote quote uses the agreed double-fee cap without changing principal',()=>{
  assert.equal(assertQuote(quote).gasFreeFeeCap,'600000');
  assert.equal(assertQuote(quote).customerDebitCap,'610000');
  assert.equal(assertQuote(quote).totalAmount,'10000');
  assert.throws(()=>assertQuote({...quote,gasFreeFeeCap:'1'}));
  assert.throws(()=>assertQuote({...quote,customerDebitCap:'999'}));
});
test('remote READY progress remains zero without fabricated authorization or funding',()=>{
  const batch:Batch={batchId:'remote',status:'READY',totalAmount:'10000',executorAddress:'test',traceId:null,depositTxId:null,counts:{total:1,pending:1,submitted:0,success:0,failed:0}};
  const progress=normalizeProgress({batchId:'remote',progressPercent:0},batch,[]);
  assert.equal(progress.progressPercent,0);
  assert.equal(progress.stages[1].state,'WAITING');
  assert.equal(progress.stages[2].state,'WAITING');
  assert.equal(progress.evidence.payoutTransactions,0);
  assert.throws(()=>normalizeProgress({batchId:'different',progressPercent:100},batch,[]));
});
