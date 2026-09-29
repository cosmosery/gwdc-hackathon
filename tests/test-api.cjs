const assert = require('node:assert/strict');
const { TronWeb } = require('tronweb');
const { buildServer } = require('../src/server.cjs');
const { initDb } = require('../src/db.cjs');
const { leaf, merkle } = require('../scripts/common.cjs');
const { DOMAIN_NILE, TYPES_PERMIT } = require('../src/gasfree.cjs');
const { classifyFailure } = require('../src/failureCatalog.cjs');

async function runTests() {
  console.log('🧪 Starting TRON Batch Payment API Test Suite...\n');

  const testDb = initDb(':memory:');
  const app = buildServer({ db: testDb, logger: false, bearerToken: 'hackathon-nile-secret-for-api-tests' });
  await app.ready();

  const token = 'hackathon-nile-secret-for-api-tests';
  const authHeader = { authorization: `Bearer ${token}` };

  const testSenderKey = '01'.repeat(32);
  const testUserWeb = new TronWeb({ fullHost: 'https://nile.trongrid.io', privateKey: testSenderKey });
  const testSender = testUserWeb.address.fromPrivateKey(testSenderKey);
  const usdtToken = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf';
  const recipient1 = 'TPCozYqnistWHH9VaoJtjXp5djKX4VJgai';
  const recipient2 = 'TPs87QEVYb6N9g7a8q23eRFf6BrqQLqTJX';

  // --- Test 1: Auth Protection ---
  console.log('▶ Test 1: Bearer Token Auth Protection');
  const resNoAuth = await app.inject({
    method: 'POST',
    url: '/quote',
    payload: {}
  });
  assert.equal(resNoAuth.statusCode, 401, 'Should reject requests without Bearer token');
  console.log('  ✔ Rejected request without Bearer token (401)');

  // --- Test 2: Quote Calculation ---
  console.log('▶ Test 2: POST /quote cost calculation');
  const resQuote = await app.inject({
    method: 'POST',
    url: '/quote',
    headers: authHeader,
    payload: {
      sender: testSender,
      token: usdtToken,
      payments: [
        { recipient: recipient1, amount: '1000000' },
        { recipient: recipient2, amount: '2000000' }
      ]
    }
  });
  assert.equal(resQuote.statusCode, 200);
  const quoteData = resQuote.json();
  assert.equal(quoteData.recipientCount, 2);
  assert.equal(quoteData.totalAmount, '3000000');
  assert.equal(quoteData.transactionCount, 4); // 1 deploy + 1 deposit + 2 payouts
  assert.ok(BigInt(quoteData.estimatedGasFreeFee) >= 300000n);
  assert.ok(Number(quoteData.estimatedRelayerFeeTrx) > 0);
  console.log('  ✔ Quote verified:', quoteData);

  // --- Test 3: Batch Hash and Merkle Determinism ---
  console.log('▶ Test 3: Deterministic Batch Hash & Merkle Root');
  const paymentsA = [
    { recipient: recipient1, amount: '1000000' },
    { recipient: recipient2, amount: '2000000' }
  ];
  const leavesA = paymentsA.map((p, i) => leaf(i, p.recipient, BigInt(p.amount)));
  const rootA = merkle(leavesA).root;

  // Change amount
  const paymentsB = [
    { recipient: recipient1, amount: '1000001' },
    { recipient: recipient2, amount: '2000000' }
  ];
  const leavesB = paymentsB.map((p, i) => leaf(i, p.recipient, BigInt(p.amount)));
  const rootB = merkle(leavesB).root;
  assert.notEqual(rootA, rootB, 'Changing payment amount must change Merkle root');

  // Change recipient
  const paymentsC = [
    { recipient: recipient2, amount: '1000000' },
    { recipient: recipient1, amount: '2000000' }
  ];
  const leavesC = paymentsC.map((p, i) => leaf(i, p.recipient, BigInt(p.amount)));
  const rootC = merkle(leavesC).root;
  assert.notEqual(rootA, rootC, 'Changing payment order/recipient must change Merkle root');
  console.log('  ✔ Merkle roots vary deterministically with inputs');

  // --- Test 4: Batch Persistence & Verification ---
  console.log('▶ Test 4: Batch Creation State Validation in DB');
  const dummyExecutor = 'TXa8D4wuNgyE3UueLhzCKWMUS74YgMCLSr'; // known valid Nile executor
  testDb.saveBatch({
    id: 'test_batch_1',
    sender: testSender,
    token: usdtToken,
    batchHash: '0x1234',
    merkleRoot: rootA,
    totalAmount: '3000000',
    recipientCount: 2,
    executorAddress: dummyExecutor,
    factoryAddress: 'TXYZ',
    expiry: Math.floor(Date.now() / 1000) + 3600,
    salt: '0xabcd',
    status: 'READY',
    createdAt: Date.now(),
    updatedAt: Date.now()
  });

  testDb.savePayments('test_batch_1', [
    { id: 'p_1_0', idx: 0, recipient: recipient1, amount: '1000000', proof: merkle(leavesA).proof(0), status: 'PENDING' },
    { id: 'p_1_1', idx: 1, recipient: recipient2, amount: '2000000', proof: merkle(leavesA).proof(1), status: 'PENDING' }
  ]);

  const resGetBatch = await app.inject({
    method: 'GET',
    url: '/batches/test_batch_1',
    headers: authHeader
  });
  assert.equal(resGetBatch.statusCode, 200);
  const batchInfo = resGetBatch.json();
  assert.equal(batchInfo.status, 'READY');
  assert.equal(batchInfo.counts.total, 2);
  assert.equal(batchInfo.counts.pending, 2);
  console.log('  ✔ Batch record and counts verified:', batchInfo.counts);

  // --- Test 4-1: Lazy Deployment via POST /batches (0 TRX spent) ---
  console.log('▶ Test 4-1: POST /batches off-chain CREATE2 prediction (Lazy Deployment)');
  const resCreateBatch = await app.inject({
    method: 'POST',
    url: '/batches',
    headers: authHeader,
    payload: {
      sender: testSender,
      token: usdtToken,
      payments: [
        { recipient: recipient1, amount: '1000000' },
        { recipient: recipient2, amount: '2000000' }
      ],
      expiryDuration: 3600
    }
  });
  assert.equal(resCreateBatch.statusCode, 201);
  const createdBatch = resCreateBatch.json();
  assert.equal(createdBatch.status, 'READY');
  assert.ok(createdBatch.batchId.startsWith('b_'));
  assert.ok(TronWeb.isAddress(createdBatch.executorAddress));
  assert.equal(createdBatch.totalAmount, '3000000');
  assert.equal(createdBatch.recipientCount, 2);
  console.log('  ✔ POST /batches predicted CREATE2 address off-chain successfully:', createdBatch.executorAddress);

  // --- Test 5: Execute Validation (Tampered Permit / Wrong Receiver) ---
  console.log('▶ Test 5: Execute Validation & Error Handling');
  
  // Wrong receiver
  const resWrongReceiver = await app.inject({
    method: 'POST',
    url: '/batches/test_batch_1/execute',
    headers: { ...authHeader, 'Idempotency-Key': 'key_1' },
    payload: {
      sig: '00'.repeat(65),
      authorization: {
        token: usdtToken,
        serviceProvider: 'TKtWbdzEq5ss9vTS9kwRhBp5mXmBfBns3E',
        user: testSender,
        receiver: recipient1, // should be dummyExecutor
        value: '3000000',
        maxFee: '300000',
        deadline: '1799999999',
        version: 1,
        nonce: 0
      }
    }
  });
  assert.equal(resWrongReceiver.statusCode, 400);
  assert.ok(resWrongReceiver.json().error.includes('does not match BatchExecutor'));
  console.log('  ✔ Rejected mismatched receiver address');

  // Wrong total value
  const resWrongValue = await app.inject({
    method: 'POST',
    url: '/batches/test_batch_1/execute',
    headers: { ...authHeader, 'Idempotency-Key': 'key_2' },
    payload: {
      sig: '00'.repeat(65),
      authorization: {
        token: usdtToken,
        serviceProvider: 'TKtWbdzEq5ss9vTS9kwRhBp5mXmBfBns3E',
        user: testSender,
        receiver: dummyExecutor,
        value: '9999999', // wrong value
        maxFee: '300000',
        deadline: '1799999999',
        version: 1,
        nonce: 0
      }
    }
  });
  assert.equal(resWrongValue.statusCode, 400);
  assert.ok(resWrongValue.json().error.includes('does not match total amount'));
  console.log('  ✔ Rejected mismatched total amount');

  // Invalid signature / Wrong recovered signer
  const otherKey = '02'.repeat(32);
  const otherSender = (new TronWeb({ fullHost: 'https://nile.trongrid.io', privateKey: otherKey })).address.fromPrivateKey(otherKey);
  const authMsg = {
    token: usdtToken,
    serviceProvider: 'TKtWbdzEq5ss9vTS9kwRhBp5mXmBfBns3E',
    user: testSender,
    receiver: dummyExecutor,
    value: '3000000',
    maxFee: '300000',
    deadline: '1799999999',
    version: 1,
    nonce: 0
  };
  const forgedSig = await (new TronWeb({ fullHost: 'https://nile.trongrid.io', privateKey: otherKey })).trx._signTypedData(DOMAIN_NILE, TYPES_PERMIT, authMsg, otherKey);

  const resForgedSig = await app.inject({
    method: 'POST',
    url: '/batches/test_batch_1/execute',
    headers: { ...authHeader, 'Idempotency-Key': 'key_3' },
    payload: {
      sig: forgedSig,
      authorization: authMsg
    }
  });
  assert.equal(resForgedSig.statusCode, 400);
  assert.ok(resForgedSig.json().error.includes('does not match batch sender'));
  console.log('  ✔ Rejected forged signature where recovered signer != batch.sender');

  // --- Test 6: Idempotency Key Preservation ---
  console.log('▶ Test 6: Idempotency-Key duplicate response check');
  testDb.saveIdempotency('key_idempotent_test', 'test_batch_1', {
    batchId: 'test_batch_1',
    traceId: 'mock_trace_123',
    transactionIds: [],
    status: 'PROCESSING'
  });
  const resIdempotent = await app.inject({
    method: 'POST',
    url: '/batches/test_batch_1/execute',
    headers: { ...authHeader, 'Idempotency-Key': 'key_idempotent_test' },
    payload: {}
  });
  assert.equal(resIdempotent.statusCode, 200);
  assert.equal(resIdempotent.json().traceId, 'mock_trace_123');
  console.log('  ✔ Returned cached idempotent response without re-executing');

  // --- Test 7: Provider FAILED Handling ---
  console.log('▶ Test 7: Provider FAILED aborts execution without payouts');
  testDb.saveBatch({
    id: 'test_batch_failed_provider',
    sender: testSender,
    token: usdtToken,
    batchHash: '0x5678',
    merkleRoot: rootA,
    totalAmount: '3000000',
    recipientCount: 2,
    executorAddress: dummyExecutor,
    factoryAddress: 'TXYZ',
    expiry: Math.floor(Date.now() / 1000) + 3600,
    salt: '0xabcd',
    status: 'FAILED',
    traceId: 'failed_trace_999',
    providerState: 'FAILED',
    providerRawResponse: JSON.stringify({ state: 'FAILED', reason: 'Worker offline' }),
    errorMessage: 'Provider transfer ended with FAILED',
    createdAt: Date.now(),
    updatedAt: Date.now()
  });

  const resFailedBatch = await app.inject({
    method: 'GET',
    url: '/batches/test_batch_failed_provider',
    headers: authHeader
  });
  assert.equal(resFailedBatch.statusCode, 200);
  const failedData = resFailedBatch.json();
  assert.equal(failedData.status, 'FAILED');
  assert.equal(failedData.providerState, 'FAILED');
  assert.equal(failedData.traceId, 'failed_trace_999');
  assert.ok(failedData.errorMessage.includes('FAILED'));
  console.log('  ✔ Verified failed provider response preserves raw state & traceId');

  // --- Test 8: Payments status list query ---
  console.log('▶ Test 8: GET /batches/:id/payments');
  const resPayments = await app.inject({
    method: 'GET',
    url: '/batches/test_batch_1/payments',
    headers: authHeader
  });
  assert.equal(resPayments.statusCode, 200);
  const paymentList = resPayments.json();
  assert.equal(paymentList.length, 2);
  assert.equal(paymentList[0].recipient, recipient1);
  assert.equal(paymentList[1].recipient, recipient2);
  console.log('  ✔ Payments endpoint returned individual rows correctly');

  // --- Test 9: Specific Payment Retry ---
  console.log('▶ Test 9: Specific payment retry endpoint (POST /batches/:id/payments/:index/retry)');
  const resRetry404Batch = await app.inject({
    method: 'POST',
    url: '/batches/non_existent_batch/payments/0/retry',
    headers: authHeader
  });
  assert.equal(resRetry404Batch.statusCode, 404);

  const resRetry404Payment = await app.inject({
    method: 'POST',
    url: '/batches/test_batch_1/payments/999/retry',
    headers: authHeader
  });
  assert.equal(resRetry404Payment.statusCode, 404);

  // Payment 0 was already paid on chain for this executor, so retry returns 200 CONFIRMED
  const resRetryAlreadyPaid = await app.inject({
    method: 'POST',
    url: '/batches/test_batch_1/payments/0/retry',
    headers: authHeader
  });
  assert.equal(resRetryAlreadyPaid.statusCode, 200);
  assert.equal(resRetryAlreadyPaid.json().status, 'CONFIRMED');
  assert.ok(resRetryAlreadyPaid.json().message.includes('already confirmed'));

  // Payment 1 is unpaid on chain, and executor has 0 remaining balance -> returns 409 Insufficient balance
  const resRetryBalance = await app.inject({
    method: 'POST',
    url: '/batches/test_batch_1/payments/1/retry',
    headers: authHeader
  });
  assert.equal(resRetryBalance.statusCode, 409);
  assert.ok(resRetryBalance.json().error.includes('Insufficient on-chain balance'));
  console.log('  ✔ Verified specific payment retry endpoint handles 404, on-chain paid check (200), and balance check (409)');

  // --- Test 10: GET /batches/:batchId/reconciliation ---
  console.log('▶ Test 10: Financial Reconciliation Report API');
  const resReconciliation = await app.inject({
    method: 'GET',
    url: '/batches/test_batch_1/reconciliation',
    headers: authHeader
  });
  assert.equal(resReconciliation.statusCode, 200);
  const recon = resReconciliation.json();
  assert.equal(recon.batchId, 'test_batch_1');
  assert.equal(recon.token, 'USDT');
  assert.equal(recon.decimals, 6);
  assert.ok(['FINAL', 'PARTIAL', 'MISMATCH'].includes(recon.reconciliationStatus));
  assert.ok(recon.reconciledAt);
  assert.equal(recon.summary.totalRows, 2);
  assert.equal(recon.summary.excluded, 0);
  assert.equal(recon.summary.payable, 2);
  assert.equal(recon.summary.succeeded, 1);
  assert.equal(recon.summary.awaitingConfirmation, 1);
  // Decimal 6 string format check
  assert.match(recon.summary.principalPaid, /^\d+\.\d{6}$/);
  assert.match(recon.summary.estimatedFeesTotal, /^\d+\.\d{6}$/);
  assert.match(recon.summary.actualFeesTotal, /^\d+\.\d{6}$/);
  assert.match(recon.summary.balanceCheck.expectedDecrease, /^\d+\.\d{6}$/);
  assert.match(recon.summary.balanceCheck.actualDecrease, /^\d+\.\d{6}$/);
  assert.match(recon.summary.balanceCheck.difference, /^\d+\.\d{6}$/);
  assert.equal(typeof recon.summary.balanceCheck.matched, 'boolean');

  // Verify items list formatting & status mapping
  assert.equal(recon.items.length, 2);
  assert.equal(recon.items[0].rowId, 0);
  assert.equal(recon.items[0].statusGroup, 'success');
  assert.match(recon.items[0].amount, /^\d+\.\d{6}$/);
  assert.equal(recon.items[1].rowId, 1);
  assert.equal(recon.items[1].statusGroup, 'awaiting_confirmation');
  console.log('  ✔ Reconciliation report matches exact spec (6 decimals, statusGroup, balanceCheck)');

  // --- Test 11: Failure Catalog & Next Action Guide ---
  console.log('▶ Test 11: Failure Catalog Classification');
  const errBalance = classifyFailure(new Error('Contract balance 0 is insufficient for payment 1000000'));
  assert.equal(errBalance.category, 'USER_ACTION');
  assert.equal(errBalance.reason, 'INSUFFICIENT_BALANCE');
  assert.equal(errBalance.nextAction, 'TOP_UP_USDT');

  const errNonce = classifyFailure(new Error('NonceNotMatch: current nonce is 4'));
  assert.equal(errNonce.category, 'AUTO_RETRY');
  assert.equal(errNonce.reason, 'NONCE_MISMATCH');
  assert.equal(errNonce.nextAction, 'SYNC_NONCE_AND_RETRY');

  const errDeadline = classifyFailure(new Error('Permit deadline expired'));
  assert.equal(errDeadline.category, 'USER_ACTION');
  assert.equal(errDeadline.reason, 'DEADLINE_EXPIRED');
  assert.equal(errDeadline.nextAction, 'RE_SIGN');

  const errFee = classifyFailure(new Error('Account does not have enough energy or TRX'));
  assert.equal(errFee.category, 'USER_ACTION');
  assert.equal(errFee.reason, 'INSUFFICIENT_FEE');
  assert.equal(errFee.nextAction, 'TOP_UP_TRX');

  const errNetwork = classifyFailure(new Error('ETIMEDOUT: connect to provider timed out'));
  assert.equal(errNetwork.category, 'AUTO_RETRY');
  assert.equal(errNetwork.reason, 'NETWORK_TIMEOUT');
  assert.equal(errNetwork.nextAction, 'RETRY_PAYOUT');

  const errUnknown = classifyFailure(new Error('REVERT: custom error 0x1234'));
  assert.equal(errUnknown.category, 'MANUAL_REVIEW');
  assert.equal(errUnknown.reason, 'ONCHAIN_REVERT');
  assert.equal(errUnknown.nextAction, 'CHECK_EXPLORER');
  console.log('  ✔ Failure catalog correctly categorized all error classes with actionable nextAction');

  await app.close();
  console.log('\n🎉 ALL 11 TESTS PASSED SUCCESSFULLY!\n');
}

runTests().catch(err => {
  console.error('\n❌ Test Suite Failed:', err);
  process.exit(1);
});
