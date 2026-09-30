import test from 'node:test';
import assert from 'node:assert/strict';
import { workflowState } from '../src/workflow';

test('import, quote and signature screens cannot inherit a previous successful result', () => {
  for (const mode of ['demo', 'live'] as const) {
    for (const [step,index] of [[0,1],[1,2],[5,3]]) {
      const state=workflowState(step,true,'SUCCESS',mode,'');
      assert.equal(state.index,index);
      assert.equal(state.tone,'draft');
      assert.doesNotMatch(state.title,/confirmed|recipients paid/i);
    }
  }
});

test('prepared and missing server states never count as submitted or successful', () => {
  const waiting=workflowState(2,false,'READY','live','');
  assert.match(waiting.title,/Waiting for the batch transfer/);
  assert.notEqual(waiting.tone,'success');
  const funded=workflowState(2,false,'READY','live','',true);
  assert.match(funded.title,/funded on Nile/);
  assert.match(funded.title,/Payouts have not started/);
  assert.notEqual(funded.tone,'success');
  const loading=workflowState(2,false,'Not loaded','live','');
  assert.match(loading.title,/Checking/);
  assert.notEqual(loading.tone,'success');
});

test('manual transfer, engine payout, and confirmed results have distinct messages', () => {
  assert.match(workflowState(5,true,'READY','live','preparing').title,/Preparing/);
  assert.match(workflowState(5,true,'READY','live','').title,/Send USDT/);
  assert.match(workflowState(2,true,'PAYOUT_PENDING','live','sending').title,/paying recipients/);
  assert.match(workflowState(2,true,'SUCCESS','live','sending').title,/All recipients paid/);
});

test('simulated outcomes remain explicitly identified as no real payment', () => {
  for (const step of [2,3]) {
    const state=workflowState(step,true,'SUCCESS','demo','');
    assert.equal(state.tone,'demo');
    assert.match(state.title,/no real payment/);
  }
});

test('only confirmed live success is shown as all recipients paid', () => {
  assert.match(workflowState(2,false,'SUCCESS','live','').title,/All recipients paid/);
  for (const status of ['SUBMISSION_UNKNOWN','FAILED','PARTIAL_SUCCESS','REFUND_PENDING']) {
    const state=workflowState(2,false,status,'live','');
    assert.notEqual(state.tone,'success');
    assert.doesNotMatch(state.title,/All recipients paid/);
  }
});
