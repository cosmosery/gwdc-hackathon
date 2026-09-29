const assert = require('node:assert/strict');
const { TronWeb } = require('tronweb');
const { compile, leaf } = require('./common.cjs');

const key = process.env.NILE_USER_PRIVATE_KEY;
if (!/^[0-9a-fA-F]{64}$/.test(key || '')) throw new Error('Invalid NILE_USER_PRIVATE_KEY');
const batchAddress = process.env.NILE_BATCH_ADDRESS;
if (!TronWeb.isAddress(batchAddress)) throw new Error('NILE_BATCH_ADDRESS is required');
const amount = BigInt(process.env.NILE_AMOUNT_MICRO);
const web = new TronWeb({ fullHost: 'https://nile.trongrid.io', privateKey: key });
const user = web.address.fromPrivateKey(key);
const tokenAddress = process.env.NILE_USDT_ADDRESS;
const tokenAbi = [
  { name: 'balanceOf', type: 'function', stateMutability: 'view', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] },
  { name: 'transfer', type: 'function', stateMutability: 'nonpayable', inputs: [{ name: 'to', type: 'address' }, { name: 'amount', type: 'uint256' }], outputs: [{ type: 'bool' }] }
];

async function waitForSuccess(txid) {
  for (let i = 0; i < 40; i++) {
    const info = await web.trx.getTransactionInfo(txid);
    const result = info.receipt?.result;
    if (result === 'SUCCESS') return info;
    if (result && result !== 'SUCCESS') {
      throw new Error(`Transaction ${txid} failed: ${result} ${info.contractResult?.[0] || ''}`);
    }
    await new Promise(resolve => setTimeout(resolve, 2500));
  }
  throw new Error(`Transaction ${txid} was not confirmed`);
}

async function main() {
  const batch = web.contract(compile().BatchExecutor.abi, batchAddress);
  const token = web.contract(tokenAbi, tokenAddress);
  const root = leaf(0, user, amount);
  assert.equal(await batch.paymentsRoot().call(), root);
  assert.equal(BigInt(await batch.totalAmount().call()), amount);
  assert.equal(TronWeb.address.toHex(await batch.token().call()), TronWeb.address.toHex(tokenAddress));
  assert.equal(await batch.paid(0).call(), false);
  assert.ok(Number(await batch.expiry().call()) > Math.floor(Date.now() / 1000));

  const before = BigInt(await token.balanceOf(user).call());
  const initialFunding = BigInt(await token.balanceOf(batchAddress).call());
  const fundingAmount = initialFunding < amount ? amount - initialFunding : 0n;
  let fundingTx = null;
  if (fundingAmount > 0n) {
    fundingTx = await token.transfer(batchAddress, fundingAmount.toString()).send({ feeLimit: 100_000_000 });
    console.log(`Direct USDT funding tx: ${fundingTx}`);
    await waitForSuccess(fundingTx);
  }
  assert.ok(BigInt(await token.balanceOf(batchAddress).call()) >= amount);
  const payoutTx = await batch.execute(0, user, amount.toString(), []).send({ feeLimit: 300_000_000 });
  console.log(`Batch payout tx: ${payoutTx}`);
  await waitForSuccess(payoutTx);
  assert.equal(await batch.paid(0).call(), true);
  assert.equal(BigInt(await token.balanceOf(user).call()), before + amount - fundingAmount);
  let duplicateRejected = false;
  try {
    const simulation = await web.transactionBuilder.triggerConstantContract(
      batchAddress, 'execute(uint256,address,uint256,bytes32[])', {},
      [
        { type: 'uint256', value: 0 },
        { type: 'address', value: user },
        { type: 'uint256', value: amount.toString() },
        { type: 'bytes32[]', value: [] }
      ], user
    );
    duplicateRejected = simulation.result?.result === false;
  }
  catch (_) { duplicateRejected = true; }
  assert.ok(duplicateRejected);
  console.log(JSON.stringify({ result: 'PASS', batchAddress, fundingTx, payoutTx, duplicateRejected }));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
