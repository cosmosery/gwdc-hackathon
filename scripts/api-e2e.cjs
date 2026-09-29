const crypto = require('node:crypto');
const { TronWeb } = require('tronweb');
const { buildServer } = require('../src/server.cjs');
const { initDb } = require('../src/db.cjs');
const { DOMAIN_NILE, TYPES_PERMIT, getAccountInfo, getProviderConfig } = require('../src/gasfree.cjs');
const { getRelayerWeb, checkOnChainBalance, checkPaymentPaid } = require('../src/tron.cjs');

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function main() {
  const key = process.env.NILE_USER_PRIVATE_KEY;
  const token = process.env.NILE_USDT_ADDRESS;
  const web = new TronWeb({ fullHost: process.env.NILE_RPC || 'https://nile.trongrid.io', privateKey: key });
  const sender = web.address.fromPrivateKey(key);
  const db = initDb(process.env.E2E_DB_PATH || '/tmp/gwdc-api-e2e.sqlite');
  const app = buildServer({ db, logger: false });
  const headers = { authorization: `Bearer ${process.env.API_BEARER_TOKEN}` };
  await app.ready();
  try {
    const quote = await app.inject({ method: 'POST', url: '/quote', headers,
      payload: { sender, token, payments: [{ recipient: sender, amount: '100000' }] } });
    if (quote.statusCode !== 200) throw new Error(`Quote ${quote.statusCode}: ${quote.body}`);

    let batch;
    if (process.env.E2E_BATCH_ID) {
      const response = await app.inject({ method: 'GET',
        url: `/batches/${process.env.E2E_BATCH_ID}`, headers });
      if (response.statusCode !== 200) throw new Error(`Existing batch ${response.statusCode}: ${response.body}`);
      batch = response.json();
      if (batch.status !== 'READY') throw new Error(`Existing batch is ${batch.status}, expected READY`);
    } else {
      const created = await app.inject({ method: 'POST', url: '/batches', headers,
        payload: { sender, token, payments: [{ recipient: sender, amount: '100000' }], expiryDuration: 3600 } });
      if (created.statusCode !== 201) throw new Error(`Create ${created.statusCode}: ${created.body}`);
      batch = created.json();
    }
    console.log(JSON.stringify({ stage: 'CREATED', batchId: batch.batchId,
      executorAddress: batch.executorAddress, factoryAddress: batch.factoryAddress }));

    const [account, config] = await Promise.all([getAccountInfo(sender), getProviderConfig()]);
    const asset = account.assets.find(item => item.tokenAddress === token);
    const provider = config.providers[0];
    const maxFee = BigInt(asset.transferFee) + (account.active ? 0n : BigInt(asset.activateFee));
    const message = {
      token, serviceProvider: provider.address, user: sender,
      receiver: batch.executorAddress, value: batch.totalAmount,
      maxFee: maxFee.toString(),
      deadline: String(Math.min(Math.floor(Date.now() / 1000) + 180, batch.expiry - 1)),
      version: 1, nonce: Number(account.nonce)
    };
    const signature = await web.trx._signTypedData(DOMAIN_NILE, TYPES_PERMIT, message, key);
    const idempotencyKey = crypto.randomUUID();
    const input = { authorization: message, signature };
    const submitted = await app.inject({ method: 'POST', url: `/batches/${batch.batchId}/execute`,
      headers: { ...headers, 'Idempotency-Key': idempotencyKey }, payload: input });
    if (submitted.statusCode !== 200) throw new Error(`Execute ${submitted.statusCode}: ${submitted.body}`);
    const initial = submitted.json();
    console.log(JSON.stringify({ stage: 'SUBMITTED', batchId: batch.batchId, traceId: initial.traceId }));
    const duplicate = await app.inject({ method: 'POST', url: `/batches/${batch.batchId}/execute`,
      headers: { ...headers, 'Idempotency-Key': idempotencyKey }, payload: input });
    if (duplicate.statusCode !== 200 || duplicate.json().traceId !== initial.traceId) {
      throw new Error(`Idempotency replay failed: ${duplicate.statusCode} ${duplicate.body}`);
    }

    let result;
    for (let i = 0; i < 60; i++) {
      await sleep(5000);
      const response = await app.inject({ method: 'GET', url: `/batches/${batch.batchId}`, headers });
      result = response.json();
      if (['SUCCESS', 'PARTIAL_SUCCESS', 'FAILED', 'REFUNDED'].includes(result.status)) break;
    }
    if (result?.status !== 'SUCCESS') throw new Error(`Batch did not succeed: ${JSON.stringify(result)}`);
    const paymentResponse = await app.inject({ method: 'GET',
      url: `/batches/${batch.batchId}/payments`, headers });
    const payments = paymentResponse.json();
    if (payments.length !== 1 || payments[0].status !== 'CONFIRMED' ||
        !await checkPaymentPaid(getRelayerWeb(), batch.executorAddress, 0) ||
        await checkOnChainBalance(getRelayerWeb(), token, batch.executorAddress) !== 0n) {
      throw new Error(`Payment reconciliation failed: ${JSON.stringify(payments)}`);
    }
    console.log(JSON.stringify({ result: 'PASS', batchId: batch.batchId,
      gasFreeTx: result.depositTxId, payoutTx: payments[0].txId,
      replayTraceId: duplicate.json().traceId }));
  } finally {
    await app.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
