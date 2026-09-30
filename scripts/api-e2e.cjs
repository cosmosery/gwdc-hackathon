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
  const count = Number(process.env.E2E_PAYMENT_COUNT || 1);
  if (!Number.isInteger(count) || count < 1 || count > 3) throw Error('Live harness accepts 1–3 self-payments only');
  const paymentList = Array.from({length: count}, (_, i) => ({recipient: sender, amount: String(10000 * (i + 1))}));
  const db = process.env.E2E_HTTP_URL ? null : initDb(process.env.E2E_DB_PATH || '/tmp/gwdc-api-e2e.sqlite');
  const app = process.env.E2E_HTTP_URL ? { ready: async()=>{}, close: async()=>{}, inject: async ({method,url,headers,payload})=>{
    if(process.env.E2E_HTTP_URL !== 'http://127.0.0.1:3000')throw Error('Live harness only supports local engine');
    const r=await fetch(process.env.E2E_HTTP_URL+url,{method,headers:{...headers,'Content-Type':'application/json'},...(payload?{body:JSON.stringify(payload)}:{})});const body=await r.text();return {statusCode:r.status,body,json:()=>JSON.parse(body)};
  }} : buildServer({ db, logger: false });
  const headers = { authorization: `Bearer ${process.env.API_BEARER_TOKEN}` };
  await app.ready();
  try {
    const quote = await app.inject({ method: 'POST', url: '/quote', headers,
      payload: { sender, token, payments: paymentList } });
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
        payload: { sender, token, payments: paymentList, expiryDuration: 3600 } });
      if (created.statusCode !== 201) throw new Error(`Create ${created.statusCode}: ${created.body}`);
      batch = created.json();
    }
    console.log(JSON.stringify({ stage: 'CREATED', batchId: batch.batchId,
      executorAddress: batch.executorAddress, factoryAddress: batch.factoryAddress }));

    const prepared = await app.inject({method:'GET',url:`/batches/${batch.batchId}/signing-context`,headers});
    if (prepared.statusCode !== 200) throw Error(`Signing context ${prepared.statusCode}: ${prepared.body}`);
    const context = prepared.json();
    const message = context.authorization;
    if (message.receiver !== batch.executorAddress || message.value !== batch.totalAmount || context.customerDebitCap !== quote.json().customerDebitCap) throw Error('Context differs from quote/batch');
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
    for (let i = 0; i < 120; i++) {
      await sleep(5000);
      const response = await app.inject({ method: 'GET', url: `/batches/${batch.batchId}`, headers });
      result = response.json();
      if (['SUCCESS', 'PARTIAL_SUCCESS', 'FAILED', 'REFUNDED'].includes(result.status)) break;
    }
    if (result?.status !== 'SUCCESS') throw new Error(`Batch did not succeed: ${JSON.stringify(result)}`);
    const paymentResponse = await app.inject({ method: 'GET',
      url: `/batches/${batch.batchId}/payments`, headers });
    const payments = paymentResponse.json();
    if (payments.length !== count || payments.some(p=>p.status !== 'CONFIRMED') ||
        !(await Promise.all(payments.map(p=>checkPaymentPaid(getRelayerWeb(),batch.executorAddress,p.index)))).every(Boolean) ||
        await checkOnChainBalance(getRelayerWeb(), token, batch.executorAddress) !== 0n) {
      throw new Error(`Payment reconciliation failed: ${JSON.stringify(payments)}`);
    }
    const evidence = { result: 'PASS', verifiedAt: new Date().toISOString(), batchId: batch.batchId,
      executorAddress: batch.executorAddress, recipientCount: count, principal: batch.totalAmount,
      gasFreeFeeCap: message.maxFee, gasFreeTx: result.depositTxId, payoutTxs: payments.map(p=>p.txId),
      allPaidBitmaps: true, executorBalance: '0', replayTraceId: duplicate.json().traceId };
    require('node:fs').writeFileSync(require('node:path').join(__dirname,'../artifacts/nile-wallet-context-e2e.json'),JSON.stringify(evidence,null,2)+'\n');
    console.log(JSON.stringify(evidence));
  } finally {
    await app.close();
  }
}

main().catch(error => { console.error(error.message); process.exitCode = 1; });
