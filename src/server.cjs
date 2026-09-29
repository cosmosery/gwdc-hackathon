const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const fastify = require('fastify');
const { TronWeb } = require('tronweb');
const { keccak256, toUtf8Bytes } = require('ethers');

const { initDb } = require('./db.cjs');
const { eventEmitter } = require('./events.cjs');
const {
  getRelayerWeb,
  getReadOnlyWeb,
  deployBatchExecutorOnChain,
  predictBatchExecutorAddress,
  isContractDeployed,
  checkOnChainBalance,
  checkPaymentPaid,
  checkPaidAmount,
  executePayoutTx,
  executeRefundTx
} = require('./tron.cjs');
const {
  DOMAIN_NILE,
  verifyTip712Permit,
  submitGasFreePermit,
  queryGasFreeStatus,
  getProviderConfig,
  getAccountInfo
} = require('./gasfree.cjs');
const { classifyFailure } = require('./failureCatalog.cjs');
const { buildReconciliationReport, toFixed6Decimals } = require('./reconciler.cjs');
const { transitionPayment } = require('./stateMachine.cjs');
const { leaf, merkle } = require('../scripts/common.cjs');

const MAX_RECIPIENTS = 1000;
const MAX_AMOUNT = (1n << 256n) - 1n;
const MIN_EXPIRY_SECONDS = 300;
const MAX_EXPIRY_SECONDS = 7 * 24 * 3600;

function sameAddress(a, b) {
  return Boolean(a && b && TronWeb.isAddress(a) && TronWeb.isAddress(b) &&
    TronWeb.address.toHex(a).toLowerCase() === TronWeb.address.toHex(b).toLowerCase());
}

function positiveAmount(value) {
  if (typeof value === 'number' && !Number.isSafeInteger(value)) throw new Error('unsafe JSON number');
  if (!/^\d+$/.test(String(value))) throw new Error('not an integer');
  const amount = BigInt(value);
  if (amount <= 0n || amount > MAX_AMOUNT) throw new Error('out of range');
  return amount;
}

function buildServer(options = {}) {
  const app = fastify({
    logger: options.logger ?? false
  });

  const db = options.db || initDb();
  const bearerToken = options.bearerToken || process.env.API_BEARER_TOKEN;
  if (!bearerToken || bearerToken.length < 32) {
    throw new Error('API_BEARER_TOKEN must contain at least 32 characters');
  }

  const uiHtmlPath = path.join(__dirname, 'ui.html');
  let uiHtmlTemplate = '';
  try {
    uiHtmlTemplate = fs.readFileSync(uiHtmlPath, 'utf8');
  } catch (_) {}

  // Auth Hook
  app.addHook('onRequest', async (req, reply) => {
    // Exclude healthcheck, root UI, and dashboard from Bearer requirement
    if (req.url === '/health' || req.url === '/' || req.url.startsWith('/dashboard') || req.url.startsWith('/ui')) {
      return;
    }

    // For SSE in browser, EventSource does not support custom headers natively without query param
    if (req.url.endsWith('/events')) {
      const authHeader = req.headers.authorization;
      const queryToken = req.query?.token;
      if (authHeader === `Bearer ${bearerToken}` || queryToken === bearerToken) {
        return;
      }
      return reply.code(401).send({ error: 'Unauthorized' });
    }

    const authHeader = req.headers.authorization;
    if (!authHeader || authHeader !== `Bearer ${bearerToken}`) {
      return reply.code(401).send({ error: 'Unauthorized: invalid or missing Bearer token' });
    }
  });

  const serveDashboard = async (req, reply) => {
    if (!uiHtmlTemplate) {
      try {
        uiHtmlTemplate = fs.readFileSync(uiHtmlPath, 'utf8');
      } catch (err) {
        return reply.code(500).send({ error: 'Dashboard UI template not found' });
      }
    }
    const html = uiHtmlTemplate.replace(
      "window.__DEFAULT_TOKEN__ || ''",
      `'${bearerToken}'`
    );
    return reply.type('text/html').send(html);
  };

  app.get('/', serveDashboard);
  app.get('/dashboard', serveDashboard);
  app.get('/health', async () => ({ status: 'ok', time: new Date().toISOString() }));

  let recoveryTimer;
  const recover = () => {
    for (const batch of db.listBatchesByStatus([
      'SUBMITTING', 'SUBMISSION_UNKNOWN', 'PROCESSING',
      'DEPOSIT_UNCONFIRMED', 'PAYOUT_PENDING'
    ])) {
      db.reconcileExecutionClaims(batch);
      processGasFreeBatchWorkflow(db, batch.id).catch(error =>
        app.log.error({ error, batchId: batch.id }, 'Batch recovery failed'));
    }
  };
  app.addHook('onReady', async () => {
    recoveryTimer = setInterval(recover, 10000);
    recoveryTimer.unref();
    recover();
  });
  app.addHook('onClose', async () => clearInterval(recoveryTimer));

  // 1. POST /quote
  app.post('/quote', async (req, reply) => {
    const { sender, token, payments } = req.body || {};

    if (!sender || !TronWeb.isAddress(sender)) {
      return reply.code(400).send({ error: 'Invalid or missing sender address' });
    }
    if (!token || !TronWeb.isAddress(token)) {
      return reply.code(400).send({ error: 'Invalid or missing token address' });
    }
    if (!Array.isArray(payments) || payments.length === 0 || payments.length > MAX_RECIPIENTS) {
      return reply.code(400).send({ error: `payments must contain 1-${MAX_RECIPIENTS} rows` });
    }

    let totalAmountBig = 0n;
    for (let i = 0; i < payments.length; i++) {
      const p = payments[i];
      if (!p.recipient || !TronWeb.isAddress(p.recipient)) {
        return reply.code(400).send({ error: `Invalid recipient at payment[${i}]` });
      }
      try {
        const amt = positiveAmount(p.amount);
        totalAmountBig += amt;
        if (totalAmountBig > MAX_AMOUNT) throw new Error('total overflow');
      } catch (_) {
        return reply.code(400).send({ error: `Amount at payment[${i}] must be a positive integer` });
      }
    }

    const recipientCount = payments.length;
    const totalAmount = totalAmountBig.toString();

    let estimatedGasFreeFee;
    try {
      const [accountInfo, config] = await Promise.all([getAccountInfo(sender), getProviderConfig()]);
      const supported = config.tokens.find(t => sameAddress(t.tokenAddress, token) && t.supported);
      if (!supported) return reply.code(400).send({ error: 'Token is not supported by the GasFree Provider' });
      const asset = accountInfo?.assets?.find(a => sameAddress(a.tokenAddress, token));
      const transferFee = BigInt(asset?.transferFee ?? supported.transferFee ?? 0);
      const activateFee = accountInfo?.active ? 0n : BigInt(asset?.activateFee ?? supported.activateFee ?? 0);
      estimatedGasFreeFee = (transferFee + activateFee).toString();
    } catch (error) {
      return reply.code(503).send({ error: `GasFree quote unavailable: ${error.message}` });
    }

    // Conservative placeholder from Nile measurements; actual Energy changes with account state.
    const estimatedRelayerFeeTrx = (20 + recipientCount * 15).toFixed(1);
    const estimatedTotal = (totalAmountBig + BigInt(estimatedGasFreeFee)).toString();
    const transactionCount = 1 + 1 + recipientCount; // 1 deploy + 1 gasfree deposit + N payouts

    return {
      recipientCount,
      totalAmount,
      estimatedGasFreeFee,
      estimatedRelayerFeeTrx,
      estimatedTotal,
      transactionCount
    };
  });

  // 2. POST /batches
  app.post('/batches', async (req, reply) => {
    const { sender, token, payments, expiryDuration } = req.body || {};

    if (!sender || !TronWeb.isAddress(sender)) {
      return reply.code(400).send({ error: 'Invalid or missing sender address' });
    }
    if (!token || !TronWeb.isAddress(token)) {
      return reply.code(400).send({ error: 'Invalid or missing token address' });
    }
    if (!Array.isArray(payments) || payments.length === 0 || payments.length > MAX_RECIPIENTS) {
      return reply.code(400).send({ error: `payments must contain 1-${MAX_RECIPIENTS} rows` });
    }
    if (expiryDuration !== undefined && (!Number.isSafeInteger(expiryDuration) ||
        expiryDuration < MIN_EXPIRY_SECONDS || expiryDuration > MAX_EXPIRY_SECONDS)) {
      return reply.code(400).send({ error: `expiryDuration must be ${MIN_EXPIRY_SECONDS}-${MAX_EXPIRY_SECONDS} seconds` });
    }

    // Canonicalize payments
    const canonicalPayments = [];
    let totalAmountBig = 0n;
    for (let i = 0; i < payments.length; i++) {
      const p = payments[i];
      if (!p.recipient || !TronWeb.isAddress(p.recipient)) {
        return reply.code(400).send({ error: `Invalid recipient at payment[${i}]` });
      }
      let amt;
      try {
        amt = positiveAmount(p.amount);
        totalAmountBig += amt;
        if (totalAmountBig > MAX_AMOUNT) throw new Error('total overflow');
      } catch (_) {
        return reply.code(400).send({ error: `Invalid amount at payment[${i}]` });
      }
      canonicalPayments.push({
        idx: i,
        recipient: p.recipient,
        amount: amt.toString()
      });
    }

    const totalAmount = totalAmountBig.toString();
    const recipientCount = canonicalPayments.length;

    // Build Merkle Tree
    const leaves = canonicalPayments.map(p => leaf(p.idx, p.recipient, BigInt(p.amount)));
    const tree = merkle(leaves);

    // Compute batchHash
    const batchHashPayload = JSON.stringify({
      sender,
      token,
      payments: canonicalPayments,
      merkleRoot: tree.root
    });
    const batchHash = keccak256(toUtf8Bytes(batchHashPayload));

    const batchId = `b_${Date.now()}_${crypto.randomBytes(4).toString('hex')}`;
    const expiry = Math.floor(Date.now() / 1000) + (expiryDuration ?? 3600);

    try {
      const config = await getProviderConfig();
      if (!config.tokens.some(t => sameAddress(t.tokenAddress, token) && t.supported)) {
        return reply.code(400).send({ error: 'Token is not supported by the GasFree Provider' });
      }
    } catch (error) {
      return reply.code(503).send({ error: `GasFree token configuration unavailable: ${error.message}` });
    }

    // Lazy Deployment: Calculate CREATE2 address off-chain without on-chain deployment (0 TRX spent)
    let prediction;
    try {
      prediction = await predictBatchExecutorAddress({
        token,
        root: tree.root,
        totalAmount: totalAmountBig,
        refundAddress: sender,
        expiry,
        batchId
      });
    } catch (predErr) {
      return reply.code(500).send({
        error: `Failed to compute BatchExecutor CREATE2 address: ${predErr.message}`
      });
    }

    const now = Date.now();
    const batchRecord = {
      id: batchId,
      sender,
      token,
      batchHash,
      merkleRoot: tree.root,
      totalAmount,
      recipientCount,
      executorAddress: prediction.executorAddress,
      factoryAddress: prediction.factoryAddress,
      expiry,
      salt: prediction.salt,
      status: 'READY',
      createdAt: now,
      updatedAt: now
    };

    // Save individual payments with proof
    const paymentRecords = canonicalPayments.map(p => ({
      id: `p_${batchId}_${p.idx}`,
      idx: p.idx,
      recipient: p.recipient,
      amount: p.amount,
      proof: tree.proof(p.idx),
      status: 'PENDING'
    }));
    db.saveBatchWithPayments(batchRecord, paymentRecords);

    return reply.code(201).send({
      batchId,
      batchHash,
      merkleRoot: tree.root,
      recipientCount,
      totalAmount,
      executorAddress: prediction.executorAddress,
      factoryAddress: prediction.factoryAddress,
      implementationAddress: prediction.implementationAddress,
      salt: prediction.salt,
      expiry,
      status: 'READY'
    });
  });

  // 3. POST /batches/:batchId/execute
  app.post('/batches/:batchId/execute', async (req, reply) => {
    const { batchId } = req.params;
    const idempotencyKey = req.headers['idempotency-key'];
    if (typeof idempotencyKey !== 'string' || idempotencyKey.length < 1 || idempotencyKey.length > 128) {
      return reply.code(400).send({ error: 'Idempotency-Key must contain 1-128 characters' });
    }

    const batch = db.getBatch(batchId);
    if (!batch) {
      return reply.code(404).send({ error: `Batch not found: ${batchId}` });
    }
    const legacyClaim = db.getIdempotencyClaim(idempotencyKey);
    if (legacyClaim && !legacyClaim.requestHash) {
      if (legacyClaim.batchId !== batchId) {
        return reply.code(409).send({ error: 'Idempotency-Key was used for another batch' });
      }
      return reply.send(legacyClaim.response);
    }

    const { sig, signature, authorization } = req.body || {};
    const signatureToUse = sig || signature;
    if (!signatureToUse || !authorization) {
      return reply.code(400).send({ error: 'Missing signature or authorization in request body' });
    }

    // 2. Validate Permit parameters against stored Batch
    if (!sameAddress(authorization.receiver, batch.executor_address)) {
      return reply.code(400).send({
        error: `Permit receiver (${authorization.receiver}) does not match BatchExecutor (${batch.executor_address})`
      });
    }
    if (String(authorization.value) !== String(batch.total_amount)) {
      return reply.code(400).send({
        error: `Permit value (${authorization.value}) does not match total amount (${batch.total_amount})`
      });
    }
    if (!sameAddress(authorization.token, batch.token)) {
      return reply.code(400).send({
        error: `Permit token (${authorization.token}) does not match batch token (${batch.token})`
      });
    }

    // 3. Verify TIP-712 Signature
    let verification;
    try {
      verification = verifyTip712Permit(DOMAIN_NILE, authorization, signatureToUse);
    } catch (sigErr) {
      return reply.code(400).send({ error: `Invalid typed data signature: ${sigErr.message}` });
    }

    if (!verification.valid || verification.recoveredAddress.toLowerCase() !== batch.sender.toLowerCase()) {
      return reply.code(400).send({
        error: `Recovered signer (${verification.recoveredAddress}) does not match batch sender (${batch.sender})`
      });
    }

    const requestHash = keccak256(toUtf8Bytes(JSON.stringify({ authorization, signature: signatureToUse.replace(/^0x/, '').toLowerCase() })));
    const previous = db.getIdempotencyClaim(idempotencyKey);
    if (previous) {
      if (previous.batchId !== batchId || (previous.requestHash && previous.requestHash !== requestHash)) {
        return reply.code(409).send({ error: 'Idempotency-Key was used for another request' });
      }
      return reply.send(previous.response);
    }

    let expectedFee;
    try {
      const now = Math.floor(Date.now() / 1000);
      if (!sameAddress(authorization.user, batch.sender) || Number(authorization.version) !== 1 ||
          !Number.isSafeInteger(Number(authorization.deadline)) || Number(authorization.deadline) <= now ||
          Number(authorization.deadline) > Number(batch.expiry)) {
        return reply.code(400).send({ error: 'Permit user, version or deadline is invalid for this batch' });
      }
      for (const name of ['value', 'maxFee', 'nonce']) {
        if (!/^\d+$/.test(String(authorization[name])) ||
            !Number.isSafeInteger(Number(authorization[name]))) {
          return reply.code(400).send({ error: `Permit ${name} must be a safe non-negative integer` });
        }
      }
      const [config, account] = await Promise.all([getProviderConfig(), getAccountInfo(batch.sender)]);
      if (!config.providers.some(p => sameAddress(p.address, authorization.serviceProvider))) {
        return reply.code(400).send({ error: 'Permit serviceProvider is not configured by GasFree' });
      }
      if (account?.allowSubmit === false || account?.allow_submit === false ||
          BigInt(authorization.nonce) !== BigInt(account?.nonce ?? -1)) {
        return reply.code(409).send({ error: 'GasFree account is unavailable or nonce changed' });
      }
      const asset = account.assets?.find(a => sameAddress(a.tokenAddress, batch.token));
      if (!asset) return reply.code(400).send({ error: 'GasFree account does not support batch token' });
      expectedFee = BigInt(asset.transferFee ?? 0) + (account.active ? 0n : BigInt(asset.activateFee ?? 0));
      if (BigInt(authorization.maxFee) < expectedFee) {
        return reply.code(400).send({ error: `Permit maxFee is below current GasFree fee ${expectedFee}` });
      }
      const gasFreeBalance = await checkOnChainBalance(getRelayerWeb(), batch.token, account.gasFreeAddress);
      if (gasFreeBalance < BigInt(batch.total_amount) + expectedFee) {
        return reply.code(400).send({ error: 'GasFree account balance is insufficient for value plus fee' });
      }
    } catch (error) {
      return reply.code(503).send({ error: `Permit preflight unavailable: ${error.message}` });
    }

    const requestId = crypto.randomUUID();
    let claim;
    try {
      claim = db.reserveExecution(idempotencyKey, batchId, requestHash, requestId);
    } catch (error) {
      return reply.code(503).send({ error: `Could not reserve execution: ${error.message}` });
    }
    if (claim.conflict) return reply.code(409).send({ error: 'Idempotency-Key was used for another request' });
    if (claim.response && !claim.claimed) return reply.send(claim.response);
    if (claim.unavailable) return reply.code(409).send({ error: `Batch cannot be executed in status ${claim.unavailable}` });

    // 4. Submit to GasFree Provider
    let submitResult;
    try {
      const submitPayload = {
        requestId,
        token: authorization.token,
        serviceProvider: authorization.serviceProvider,
        user: authorization.user,
        receiver: authorization.receiver,
        value: Number(authorization.value),
        maxFee: Number(authorization.maxFee),
        deadline: Number(authorization.deadline),
        version: Number(authorization.version || 1),
        nonce: Number(authorization.nonce),
        sig: signatureToUse.replace(/^0x/, '')
      };
      submitResult = await submitGasFreePermit(submitPayload);
    } catch (submitErr) {
      const response = { batchId, requestId, status: 'SUBMISSION_UNKNOWN',
        error: `Provider response is uncertain: ${submitErr.message}` };
      db.completeSubmission(batchId, idempotencyKey, response, 'SUBMISSION_UNKNOWN', {
        requestId, errorMessage: response.error,
        providerRawResponse: JSON.stringify(submitErr.apiResponse || {})
      });
      return reply.code(202).send(response);
    }

    const traceId = submitResult.id;
    if (!traceId) {
      const response = { batchId, requestId, status: 'SUBMISSION_UNKNOWN', error: 'Provider returned no traceId' };
      db.completeSubmission(batchId, idempotencyKey, response, 'SUBMISSION_UNKNOWN',
        { requestId, errorMessage: response.error });
      return reply.code(202).send(response);
    }
    const responseObj = {
      batchId,
      requestId,
      traceId,
      transactionIds: [],
      status: 'PROCESSING'
    };
    db.completeSubmission(batchId, idempotencyKey, responseObj, 'PROCESSING', {
      traceId, providerState: 'WAITING', requestId
    });

    // 5. Trigger asynchronous processing worker
    processGasFreeBatchWorkflow(db, batchId, traceId).catch((err) => {
      app.log.error({ err, batchId }, 'Background batch workflow error');
    });

    return reply.code(200).send(responseObj);
  });

  // Direct Execution fallback/test endpoint
  app.post('/batches/:batchId/execute-direct', async (req, reply) => {
    if (process.env.ENABLE_DIRECT_EXECUTION !== '1') {
      return reply.code(404).send({ error: 'Direct execution is disabled' });
    }
    const { batchId } = req.params;
    const batch = db.getBatch(batchId);
    if (!batch) return reply.code(404).send({ error: `Batch not found: ${batchId}` });
    if (batch.status !== 'READY') {
      return reply.code(409).send({ error: `Batch cannot be directly executed in status ${batch.status}` });
    }

    const relayerWeb = getRelayerWeb();
    const balance = await checkOnChainBalance(relayerWeb, batch.token, batch.executor_address);
    if (balance < BigInt(batch.total_amount)) {
      return reply.code(400).send({
        error: `BatchExecutor balance (${balance}) is less than total amount (${batch.total_amount})`
      });
    }

    db.updateBatchStatus(batchId, 'PROCESSING');
    executeAllPayments(db, batchId).catch(err => {
      app.log.error({ err, batchId }, 'Direct payout error');
    });

    return { batchId, status: 'PROCESSING', fundedBalance: balance.toString() };
  });

  app.post('/batches/:batchId/resume', async (req, reply) => {
    const { batchId } = req.params;
    const batch = db.getBatch(batchId);
    if (!batch) return reply.code(404).send({ error: `Batch not found: ${batchId}` });
    if (batch.status === 'SUCCESS' || batch.status === 'REFUNDED') {
      return { batchId, status: batch.status };
    }
    processGasFreeBatchWorkflow(db, batchId).catch(error =>
      app.log.error({ error, batchId }, 'Manual batch recovery failed'));
    return reply.code(202).send({ batchId, status: 'RECONCILING' });
  });

  app.post('/batches/:batchId/retry', async (req, reply) => {
    const { batchId } = req.params;
    const batch = db.getBatch(batchId);
    if (!batch) return reply.code(404).send({ error: `Batch not found: ${batchId}` });
    if (!['FAILED', 'PARTIAL_SUCCESS'].includes(batch.status)) {
      return reply.code(409).send({ error: `Batch is ${batch.status}; retry is unavailable` });
    }
    const web = getRelayerWeb();
    const [balance, paidAmount] = await Promise.all([
      checkOnChainBalance(web, batch.token, batch.executor_address),
      checkPaidAmount(web, batch.executor_address)
    ]);
    if (balance >= BigInt(batch.total_amount) - paidAmount && paidAmount < BigInt(batch.total_amount)) {
      db.updateBatchStatus(batchId, 'PAYOUT_PENDING', { errorMessage: null });
      processGasFreeBatchWorkflow(db, batchId).catch(error =>
        app.log.error({ error, batchId }, 'Payout retry failed'));
      return reply.code(202).send({ batchId, status: 'PAYOUT_PENDING' });
    }
    if (batch.provider_state === 'FAILED' && paidAmount === 0n && balance === 0n) {
      db.updateBatchStatus(batchId, 'READY', {
        traceId: null, requestId: null, providerState: null, errorMessage: null
      });
      return { batchId, status: 'READY', message: 'Sign a new Permit and use a new Idempotency-Key' };
    }
    return reply.code(409).send({ error: 'Funding or Provider outcome is unresolved; retry would be unsafe' });
  });

  app.post('/batches/:batchId/refund', async (req, reply) => {
    const { batchId } = req.params;
    const batch = db.getBatch(batchId);
    if (!batch) return reply.code(404).send({ error: `Batch not found: ${batchId}` });
    const web = getRelayerWeb();
    const balance = await checkOnChainBalance(web, batch.token, batch.executor_address);
    if (balance === 0n) {
      return { batchId, status: 'EMPTY', refundTxId: batch.refund_tx_id };
    }
    const paidAmount = await checkPaidAmount(web, batch.executor_address);
    if (Math.floor(Date.now() / 1000) < Number(batch.expiry) && paidAmount < BigInt(batch.total_amount)) {
      return reply.code(409).send({ error: 'Refund is available after expiry or full payout' });
    }
    if (batch.refund_state === 'SUBMITTED' && batch.refund_tx_id) {
      const info = await web.trx.getTransactionInfo(batch.refund_tx_id);
      if (!info.receipt?.result) return reply.code(202).send({ batchId, status: 'REFUND_PENDING', refundTxId: batch.refund_tx_id });
      if (info.receipt.result === 'SUCCESS') {
        db.updateBatchStatus(batchId, paidAmount < BigInt(batch.total_amount) ? 'REFUNDED' : batch.status,
          { refundState: 'CONFIRMED' });
        return { batchId, status: 'REFUNDED', refundTxId: batch.refund_tx_id };
      }
      db.updateBatchStatus(batchId, batch.status, { refundState: 'FAILED' });
    }
    if (!db.reserveRefund(batchId)) {
      return reply.code(409).send({ error: 'Refund is already being processed' });
    }
    try {
      await deployBatchExecutorOnChain({
        relayerWeb: web,
        token: batch.token,
        root: batch.merkle_root,
        totalAmount: BigInt(batch.total_amount),
        refundAddress: batch.sender,
        expiry: batch.expiry,
        batchId: batch.id
      });
      const txid = await executeRefundTx(web, batch.executor_address, submitted =>
        db.updateBatchStatus(batchId, batch.status, { refundState: 'SUBMITTED', refundTxId: submitted }));
      const status = paidAmount < BigInt(batch.total_amount) ? 'REFUNDED' : batch.status;
      db.updateBatchStatus(batchId, status, {
        refundState: 'CONFIRMED', refundTxId: txid, refundAmount: balance.toString()
      });
      eventEmitter.emitBatchEvent(batchId, `refund CONFIRMED tx=${txid}`);
      return { batchId, status, refundTxId: txid, refundAmount: balance.toString() };
    } catch (error) {
      const current = db.getBatch(batchId);
      if (!current.refund_tx_id) db.updateBatchStatus(batchId, batch.status, { refundState: 'FAILED' });
      return reply.code(202).send({ batchId, status: 'REFUND_UNCONFIRMED',
        refundTxId: current.refund_tx_id, error: error.message });
    }
  });

  // 4. GET /batches/:batchId
  app.get('/batches/:batchId', async (req, reply) => {
    const { batchId } = req.params;
    const batch = db.getBatch(batchId);
    if (!batch) {
      return reply.code(404).send({ error: `Batch not found: ${batchId}` });
    }

    const counts = db.getPaymentCounts(batchId);
    return {
      batchId: batch.id,
      sender: batch.sender,
      token: batch.token,
      batchHash: batch.batch_hash,
      merkleRoot: batch.merkle_root,
      recipientCount: batch.recipient_count,
      totalAmount: batch.total_amount,
      executorAddress: batch.executor_address,
      expiry: batch.expiry,
      status: batch.status,
      traceId: batch.trace_id,
      depositTxId: batch.deposit_tx_id,
      providerState: batch.provider_state,
      errorMessage: batch.error_message,
      requestId: batch.request_id,
      refundTxId: batch.refund_tx_id,
      refundAmount: batch.refund_amount,
      refundState: batch.refund_state,
      counts
    };
  });

  // 5. GET /batches/:batchId/payments
  app.get('/batches/:batchId/payments', async (req, reply) => {
    const { batchId } = req.params;
    const batch = db.getBatch(batchId);
    if (!batch) {
      return reply.code(404).send({ error: `Batch not found: ${batchId}` });
    }

    const payments = db.getPayments(batchId);
    return payments.map(p => ({
      paymentId: p.id,
      index: p.idx,
      recipient: p.recipient,
      amount: p.amount,
      status: p.status,
      txId: p.tx_id,
      errorCode: p.error_code,
      errorMessage: p.error_message,
      failureCategory: p.failure_category || null,
      failureReason: p.failure_reason || null,
      nextAction: p.next_action || null,
      submittedAt: p.submitted_at ? new Date(p.submitted_at).toISOString() : null,
      finalizedAt: p.finalized_at ? new Date(p.finalized_at).toISOString() : null
    }));
  });

  // 5-1. GET /batches/:batchId/reconciliation
  app.get('/batches/:batchId/reconciliation', async (req, reply) => {
    const { batchId } = req.params;
    let relayerWeb = null;
    try {
      relayerWeb = getRelayerWeb();
    } catch (_) {}
    const report = await buildReconciliationReport({ db, batchId, relayerWeb });
    if (!report) {
      return reply.code(404).send({ error: `Batch not found: ${batchId}` });
    }
    return report;
  });

  // 5-1-1. GET /batches/:batchId/progress
  app.get('/batches/:batchId/progress', async (req, reply) => {
    const { batchId } = req.params;
    const batch = db.getBatch(batchId);
    if (!batch) {
      return reply.code(404).send({ error: `Batch not found: ${batchId}` });
    }

    const counts = db.getPaymentCounts(batchId);
    const payments = db.getPayments(batchId);

    let principalPaidBig = 0n;
    for (const p of payments) {
      if (p.status === 'CONFIRMED' || p.status === 'SUCCEEDED') {
        principalPaidBig += BigInt(p.amount);
      }
    }

    let actualFeesTotalBig = 0n;
    if (batch.provider_raw_response) {
      try {
        const raw = JSON.parse(batch.provider_raw_response);
        const totalFee = raw.txnTotalFee ?? raw.estimatedTotalFee;
        if (totalFee !== undefined && totalFee !== null) {
          actualFeesTotalBig = BigInt(totalFee);
        }
      } catch (_) {}
    }
    if (actualFeesTotalBig === 0n && (batch.deposit_tx_id || batch.status === 'SUCCESS')) {
      actualFeesTotalBig = 300000n;
    }

    const total = counts.total || 0;
    const done = counts.success + counts.failed;
    const progressPercent = total > 0 ? Math.min(100, Math.round((done / total) * 100)) : 0;
    const elapsedMs = Math.max(0, Date.now() - (batch.created_at || Date.now()));

    return {
      batchId,
      status: batch.status,
      reconciliationStatus: batch.reconciliation_status || (batch.status === 'SUCCESS' ? 'FINAL' : 'PARTIAL'),
      progressPercent,
      counts: {
        total: counts.total,
        succeeded: counts.success,
        failed: counts.failed,
        inFlight: counts.submitted, // submitting + submitted
        pending: counts.pending
      },
      financials: {
        principalPaid: toFixed6Decimals(principalPaidBig),
        actualFeesTotal: toFixed6Decimals(actualFeesTotalBig),
        totalAmount: toFixed6Decimals(batch.total_amount)
      },
      elapsedMs,
      updatedAt: new Date(batch.updated_at || Date.now()).toISOString()
    };
  });

  // 5-1-2. GET /batches/:batchId/status-events
  app.get('/batches/:batchId/status-events', async (req, reply) => {
    const { batchId } = req.params;
    const batch = db.getBatch(batchId);
    if (!batch) {
      return reply.code(404).send({ error: `Batch not found: ${batchId}` });
    }
    const events = db.getStatusEvents(batchId);
    return {
      batchId,
      totalEvents: events.length,
      events
    };
  });

  // 5-2. POST /batches/:batchId/payments/:index/retry
  app.post('/batches/:batchId/payments/:index/retry', async (req, reply) => {
    const { batchId, index } = req.params;
    const batch = db.getBatch(batchId);
    if (!batch) {
      return reply.code(404).send({ error: `Batch not found: ${batchId}` });
    }

    const payments = db.getPayments(batchId);
    const payment = /^\d+$/.test(index)
      ? payments.find(p => p.idx === parseInt(index, 10))
      : payments.find(p => p.id === index);

    if (!payment) {
      return reply.code(404).send({ error: `Payment not found: ${index} in batch ${batchId}` });
    }

    const relayerWeb = getRelayerWeb();

    // 1. Check if already confirmed on chain
    const isPaid = await checkPaymentPaid(relayerWeb, batch.executor_address, payment.idx).catch(() => false);
    if (isPaid) {
      db.updatePaymentStatus(payment.id, 'CONFIRMED');
      reconcileBatchStatus(db, batchId);
      return {
        batchId,
        paymentId: payment.id,
        index: payment.idx,
        status: 'CONFIRMED',
        message: 'Payment is already confirmed on chain'
      };
    }

    // 2. Check if batch deposit has arrived or executor is funded
    let balance = 0n;
    try {
      balance = await checkOnChainBalance(relayerWeb, batch.token, batch.executor_address);
    } catch (e) {
      return reply.code(502).send({ error: `Failed to check BatchExecutor balance: ${e.message}` });
    }

    const requiredAmount = BigInt(payment.amount);
    if (balance < requiredAmount) {
      return reply.code(409).send({
        error: `Insufficient on-chain balance (${balance} < ${requiredAmount}) in BatchExecutor for payment[${payment.idx}]`
      });
    }

    // 3. Check previous transaction if any
    if (payment.tx_id) {
      const info = await relayerWeb.trx.getTransactionInfo(payment.tx_id).catch(() => ({}));
      const result = info.receipt?.result;
      if (!result && info.id) {
        return reply.code(202).send({
          batchId,
          paymentId: payment.id,
          index: payment.idx,
          status: 'SUBMITTED',
          txId: payment.tx_id,
          message: 'Previous payout transaction is still pending confirmation'
        });
      }
      if (result === 'SUCCESS') {
        db.updatePaymentStatus(payment.id, 'CONFIRMED');
        reconcileBatchStatus(db, batchId);
        return {
          batchId,
          paymentId: payment.id,
          index: payment.idx,
          status: 'CONFIRMED',
          txId: payment.tx_id
        };
      }
    }

    // 4. Ensure BatchExecutor is deployed on-chain
    try {
      await deployBatchExecutorOnChain({
        relayerWeb,
        token: batch.token,
        root: batch.merkle_root,
        totalAmount: BigInt(batch.total_amount),
        refundAddress: batch.sender,
        expiry: batch.expiry,
        batchId: batch.id
      });
    } catch (deployErr) {
      return reply.code(502).send({
        error: `Failed to deploy BatchExecutor for retry: ${deployErr.message}`
      });
    }

    // 5. Execute payout
    db.updatePaymentStatus(payment.id, 'SUBMITTING');
    eventEmitter.emitBatchEvent(batchId, `payment:${payment.idx} SUBMITTING`);

    try {
      const txid = await executePayoutTx(
        relayerWeb,
        batch.executor_address,
        payment.idx,
        payment.recipient,
        requiredAmount,
        payment.proof,
        submittedTxid => {
          db.updatePaymentStatus(payment.id, 'SUBMITTED', { txId: submittedTxid, submittedAt: Date.now() });
          eventEmitter.emitBatchEvent(batchId, `payment:${payment.idx} SUBMITTED tx=${submittedTxid}`);
        }
      );

      db.updatePaymentStatus(payment.id, 'CONFIRMED', { txId: txid, finalizedAt: Date.now() });
      eventEmitter.emitBatchEvent(batchId, `payment:${payment.idx} CONFIRMED tx=${txid}`);
      reconcileBatchStatus(db, batchId);

      return {
        batchId,
        paymentId: payment.id,
        index: payment.idx,
        status: 'CONFIRMED',
        txId: txid
      };
    } catch (err) {
      const recheck = await checkPaymentPaid(relayerWeb, batch.executor_address, payment.idx).catch(() => false);
      if (recheck) {
        db.updatePaymentStatus(payment.id, 'CONFIRMED', { finalizedAt: Date.now() });
        eventEmitter.emitBatchEvent(batchId, `payment:${payment.idx} CONFIRMED`);
        reconcileBatchStatus(db, batchId);
        return {
          batchId,
          paymentId: payment.id,
          index: payment.idx,
          status: 'CONFIRMED'
        };
      }

      const classified = classifyFailure(err);
      db.updatePaymentStatus(payment.id, 'FAILED', {
        errorCode: 'EXECUTE_FAILED',
        errorMessage: err.message,
        failureCategory: classified.category,
        failureReason: classified.reason,
        nextAction: classified.nextAction,
        finalizedAt: Date.now()
      });
      eventEmitter.emitBatchEvent(batchId, `payment:${payment.idx} FAILED`);
      reconcileBatchStatus(db, batchId);

      return reply.code(502).send({
        batchId,
        paymentId: payment.id,
        index: payment.idx,
        status: 'FAILED',
        error: err.message,
        failureCategory: classified.category,
        failureReason: classified.reason,
        nextAction: classified.nextAction
      });
    }
  });

  // 6. GET /batches/:batchId/events (SSE)
  app.get('/batches/:batchId/events', async (req, reply) => {
    const { batchId } = req.params;
    const batch = db.getBatch(batchId);
    if (!batch) {
      return reply.code(404).send({ error: `Batch not found: ${batchId}` });
    }

    reply.raw.setHeader('Content-Type', 'text/event-stream');
    reply.raw.setHeader('Cache-Control', 'no-cache');
    reply.raw.setHeader('Connection', 'keep-alive');
    reply.raw.flushHeaders?.();

    eventEmitter.subscribe(batchId, reply);
  });

  return app;
}

// Every pass is safe to repeat after a restart. The on-chain paid bitmap is authoritative.
const activeBatchJobs = new Set();
async function processGasFreeBatchWorkflow(db, batchId) {
  if (activeBatchJobs.has(batchId)) return;
  activeBatchJobs.add(batchId);
  try {
    const batch = db.getBatch(batchId);
    if (!batch) return;
    const web = getRelayerWeb();
    const [balance, paidAmount] = await Promise.all([
      checkOnChainBalance(web, batch.token, batch.executor_address),
      checkPaidAmount(web, batch.executor_address)
    ]);
    let status;
    let statusError;
    if (batch.trace_id) {
      try {
        status = await queryGasFreeStatus(batch.trace_id);
      } catch (error) {
        statusError = error;
      }
    }
    const fields = status ? {
      providerState: status.state,
      providerRawResponse: JSON.stringify(status),
      ...(status.txnHash ? { depositTxId: status.txnHash } : {})
    } : {};
    const remaining = BigInt(batch.total_amount) - paidAmount;
    if (remaining === 0n) {
      if (status) db.updateBatchStatus(batchId, batch.status, fields);
      await executeAllPayments(db, batchId);
      return;
    }
    if (balance >= remaining) {
      db.updateBatchStatus(batchId, 'PAYOUT_PENDING', fields);
      eventEmitter.emitBatchEvent(batchId, 'deposit CONFIRMED');
      await executeAllPayments(db, batchId);
      return;
    }

    if (!batch.trace_id) {
      if (batch.status === 'SUBMITTING' && Date.now() - batch.updated_at > 120000) {
        db.updateBatchStatus(batchId, 'SUBMISSION_UNKNOWN', {
          errorMessage: 'Provider submission outcome is unknown; awaiting on-chain funding'
        });
      }
      return;
    }

    if (statusError) {
      db.updateBatchStatus(batchId, batch.status, { errorMessage: `Provider status unavailable: ${statusError.message}` });
      return;
    }
    if (status.state === 'FAILED') {
      db.updateBatchStatus(batchId, 'FAILED', {
        ...fields, errorMessage: `Provider transfer FAILED${status.reason ? `: ${status.reason}` : ''}`
      });
      eventEmitter.emitBatchEvent(batchId, 'batch FAILED');
    } else if (status.state === 'SUCCEED') {
      db.updateBatchStatus(batchId, 'DEPOSIT_UNCONFIRMED', {
        ...fields, errorMessage: 'Provider succeeded; waiting for confirmed token balance'
      });
    } else {
      db.updateBatchStatus(batchId, 'PROCESSING', fields);
    }
  } finally {
    activeBatchJobs.delete(batchId);
  }
}

async function executeAllPayments(db, batchId) {
  const batch = db.getBatch(batchId);
  const payments = db.getPayments(batchId);
  const relayerWeb = getRelayerWeb();

  const [balance, paidAmount] = await Promise.all([
    checkOnChainBalance(relayerWeb, batch.token, batch.executor_address),
    checkPaidAmount(relayerWeb, batch.executor_address)
  ]);
  const required = BigInt(batch.total_amount) - paidAmount;
  if (balance < required) {
    db.updateBatchStatus(batchId, 'DEPOSIT_UNCONFIRMED', {
      errorMessage: `Insufficient on-chain balance (${balance} < ${required})`
    });
    return;
  }

  // Lazy Deployment: Deploy BatchExecutor clone on-chain now that deposit is confirmed
  try {
    await deployBatchExecutorOnChain({
      relayerWeb,
      token: batch.token,
      root: batch.merkle_root,
      totalAmount: BigInt(batch.total_amount),
      refundAddress: batch.sender,
      expiry: batch.expiry,
      batchId: batch.id
    });
  } catch (deployErr) {
    db.updateBatchStatus(batchId, 'PAYOUT_PENDING', {
      errorMessage: `Lazy deployment failed: ${deployErr.message}`
    });
    return;
  }

  let successCount = 0;
  let failCount = 0;

  for (const payment of payments) {
    // Check if already paid on chain (e.g. from previous attempt)
    const isPaid = await checkPaymentPaid(relayerWeb, batch.executor_address, payment.idx);
    if (isPaid) {
      db.updatePaymentStatus(payment.id, 'CONFIRMED');
      successCount++;
      eventEmitter.emitBatchEvent(batchId, `payment:${payment.idx} CONFIRMED`);
      continue;
    }

    if (payment.tx_id) {
      const info = await relayerWeb.trx.getTransactionInfo(payment.tx_id);
      const result = info.receipt?.result;
      if (!result) {
        db.updatePaymentStatus(payment.id, 'SUBMITTED');
        db.updateBatchStatus(batchId, 'PAYOUT_PENDING');
        return;
      }
      if (result === 'SUCCESS') {
        db.updateBatchStatus(batchId, 'PAYOUT_PENDING', {
          errorMessage: `Transaction ${payment.tx_id} succeeded but paid(${payment.idx}) is not visible yet`
        });
        return;
      }
      db.updatePaymentStatus(payment.id, 'PENDING', { txId: null });
    }

    const attempts = (payment.attempts || 0) + 1;
    const submittedAt = Date.now();
    db.updatePaymentStatus(payment.id, 'SUBMITTING', {
      submittedAt,
      attempts
    });
    eventEmitter.emitBatchEvent(batchId, `payment:${payment.idx} SUBMITTING`);

    try {
      const txid = await executePayoutTx(
        relayerWeb,
        batch.executor_address,
        payment.idx,
        payment.recipient,
        BigInt(payment.amount),
        payment.proof,
        txid => {
          db.updatePaymentStatus(payment.id, 'SUBMITTED', { txId: txid });
          eventEmitter.emitBatchEvent(batchId, `payment:${payment.idx} SUBMITTED tx=${txid}`);
        }
      );

      db.updatePaymentStatus(payment.id, 'CONFIRMED', {
        txId: txid,
        finalizedAt: Date.now()
      });
      successCount++;
      eventEmitter.emitBatchEvent(batchId, `payment:${payment.idx} CONFIRMED tx=${txid}`);
    } catch (err) {
      // Re-verify on-chain in case it actually succeeded despite error/timeout
      const recheck = await checkPaymentPaid(relayerWeb, batch.executor_address, payment.idx).catch(() => false);
      if (recheck) {
        db.updatePaymentStatus(payment.id, 'CONFIRMED', {
          finalizedAt: Date.now()
        });
        successCount++;
        eventEmitter.emitBatchEvent(batchId, `payment:${payment.idx} CONFIRMED`);
      } else {
        const latest = db.getPayments(batchId).find(row => row.id === payment.id);
        if (latest?.tx_id) {
          const info = await relayerWeb.trx.getTransactionInfo(latest.tx_id).catch(() => ({}));
          if (!info.receipt?.result) {
            db.updateBatchStatus(batchId, 'PAYOUT_PENDING', {
              errorMessage: `Awaiting transaction ${latest.tx_id} confirmation`
            });
            return;
          }
        }
        const classified = classifyFailure(err);
        db.updatePaymentStatus(payment.id, 'FAILED', {
          errorCode: 'EXECUTE_FAILED',
          errorMessage: err.message,
          failureCategory: classified.category,
          failureReason: classified.reason,
          nextAction: classified.nextAction,
          finalizedAt: Date.now()
        });
        failCount++;
        eventEmitter.emitBatchEvent(batchId, `payment:${payment.idx} FAILED`);
      }
    }
  }

  reconcileBatchStatus(db, batchId);
}

function reconcileBatchStatus(db, batchId) {
  const counts = db.getPaymentCounts(batchId);
  if (counts.total > 0 && counts.success === counts.total) {
    db.updateBatchStatus(batchId, 'SUCCESS');
    eventEmitter.emitBatchEvent(batchId, 'batch SUCCESS');
  } else if (counts.success > 0) {
    db.updateBatchStatus(batchId, 'PARTIAL_SUCCESS');
    eventEmitter.emitBatchEvent(batchId, 'batch PARTIAL_SUCCESS');
  } else if (counts.failed > 0 && counts.pending === 0 && counts.submitted === 0) {
    db.updateBatchStatus(batchId, 'FAILED');
    eventEmitter.emitBatchEvent(batchId, 'batch FAILED');
  }
}

module.exports = { buildServer, reconcileBatchStatus };
