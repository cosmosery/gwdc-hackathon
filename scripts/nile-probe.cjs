const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const { TronWeb } = require('tronweb');
const { compile, leaf, merkle, tronCreate2, cloneInitCode, batchIdBytes, batchSalt, evmAddress } = require('./common.cjs');

const BASE = 'https://open-test.gasfree.io';
const PATH = '/nile/api/v1';
const NILE = 'https://nile.trongrid.io';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function required(name) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing ${name}; see .env.example`);
  return value;
}

function tron(privateKey) {
  if (!/^[0-9a-fA-F]{64}$/.test(privateKey)) throw new Error('Private key must be 64 hex characters');
  return new TronWeb({ fullHost: NILE, privateKey });
}

function sameAddress(a, b) { return evmAddress(a).toLowerCase() === evmAddress(b).toLowerCase(); }

function apiInteger(value, name) {
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new Error(`${name} exceeds JSON's safe integer range`);
  return number;
}

async function api(method, endpoint, body) {
  const timestamp = Math.floor(Date.now() / 1000).toString();
  const path = PATH + endpoint;
  const signature = crypto.createHmac('sha256', required('GASFREE_API_SECRET'))
    .update(method + path + timestamp).digest('base64');
  const response = await fetch(BASE + path, {
    method,
    headers: {
      Timestamp: timestamp,
      Authorization: `ApiKey ${required('GASFREE_API_KEY')}:${signature}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const json = await response.json();
  if (!response.ok || json.code !== 200) throw new Error(`${method} ${path}: ${JSON.stringify(json)}`);
  return json.data;
}

async function waitForContract(web, address) {
  for (let i = 0; i < 25; i++) {
    try {
      const result = await web.trx.getContract(address);
      if (result.contract_address && (result.bytecode || result.code_hash)) return;
    } catch (_) { /* pending */ }
    await sleep(3000);
  }
  throw new Error(`Contract did not appear on Nile: ${address}`);
}

async function waitForTx(web, txid) {
  for (let i = 0; i < 25; i++) {
    const info = await web.trx.getTransactionInfo(txid);
    if (info.id) {
      if (info.receipt?.result !== 'SUCCESS') throw new Error(`Transaction failed: ${txid} ${JSON.stringify(info.receipt)}`);
      return info;
    }
    await sleep(3000);
  }
  throw new Error(`Transaction pending: ${txid}`);
}

async function main() {
  const userKey = required('NILE_USER_PRIVATE_KEY');
  const relayerKey = required('NILE_RELAYER_PRIVATE_KEY');
  required('GASFREE_API_KEY');
  required('GASFREE_API_SECRET');
  const tokenAddress = required('NILE_USDT_ADDRESS');
  const amount = BigInt(required('NILE_AMOUNT_MICRO'));
  if (amount <= 0n) throw new Error('NILE_AMOUNT_MICRO must be positive');
  const userWeb = tron(userKey);
  const relayerWeb = tron(relayerKey);
  const owner = userWeb.address.fromPrivateKey(userKey);
  const relayer = relayerWeb.address.fromPrivateKey(relayerKey);
  const recipient = process.env.NILE_RECIPIENT_ADDRESS || owner;
  if (!process.env.NILE_RECIPIENT_ADDRESS) console.log('NILE_RECIPIENT_ADDRESS missing; using user EOA as test recipient');
  if (![tokenAddress, recipient, owner, relayer].every(address => TronWeb.isAddress(address))) throw new Error('Invalid TRON address');

  const [tokens, providers, account] = await Promise.all([
    api('GET', '/config/token/all'),
    api('GET', '/config/provider/all'),
    api('GET', `/address/${owner}`)
  ]);
  const tokenConfig = tokens.tokens.find(t => sameAddress(t.tokenAddress, tokenAddress) && t.supported);
  if (!tokenConfig) throw new Error('Configured token is not supported by Nile GasFree Provider');
  if (tokenConfig.symbol !== 'USDT' || Number(tokenConfig.decimal) !== 6) {
    throw new Error('Configured token is not the Provider\'s six-decimal USDT');
  }
  const provider = providers.providers[0];
  if (!provider) throw new Error('No Nile GasFree service provider');
  if (account.allowSubmit === false || account.allow_submit === false) throw new Error('GasFree account has a pending transfer');
  const asset = account.assets.find(a => sameAddress(a.tokenAddress, tokenAddress));
  if (!asset) throw new Error('GasFree account does not hold the configured token');
  const maxFee = BigInt(asset.transferFee || tokenConfig.transferFee || 0) +
    (account.active ? 0n : BigInt(asset.activateFee || tokenConfig.activateFee || 0));
  if (maxFee <= 0n) throw new Error('Could not derive GasFree maxFee from provider config');

  const compiled = compile();
  const factoryArtifact = compiled.BatchFactory;
  const executorArtifact = compiled.BatchExecutor;
  const tree = merkle([leaf(0, recipient, amount)]);
  const existing = process.env.NILE_FACTORY_ADDRESS && process.env.NILE_BATCH_ADDRESS && process.env.NILE_BATCH_SALT;
  let factoryAddress, expiry, salt, deploymentTx, batchId;
  if (existing) {
    factoryAddress = process.env.NILE_FACTORY_ADDRESS;
    expiry = Number(await relayerWeb.contract(executorArtifact.abi, process.env.NILE_BATCH_ADDRESS).expiry().call());
    salt = process.env.NILE_BATCH_SALT;
    if (expiry <= Math.floor(Date.now() / 1000)) throw new Error('Existing batch has expired');
    await waitForContract(relayerWeb, factoryAddress);
    console.log(`Resuming existing batch: ${process.env.NILE_BATCH_ADDRESS}`);
  } else {
    if (process.env.NILE_FACTORY_ADDRESS) {
      factoryAddress = process.env.NILE_FACTORY_ADDRESS;
    } else {
      const factory = await relayerWeb.contract().new({
        abi: factoryArtifact.abi,
        bytecode: factoryArtifact.evm.bytecode.object,
        feeLimit: 1_000_000_000,
        callValue: 0
      });
      factoryAddress = relayerWeb.address.fromHex(factory.address);
    }
    await waitForContract(relayerWeb, factoryAddress);
    expiry = Math.floor(Date.now() / 1000) + 3600;
    batchId = `0x${crypto.randomBytes(32).toString('hex')}`;
    salt = batchSalt(tokenAddress, owner, tree.root, amount, expiry, batchId);
  }
  let predicted;
  if (existing) {
    predicted = process.env.NILE_BATCH_ADDRESS;
  } else {
    const factoryInstance = relayerWeb.contract(factoryArtifact.abi, factoryAddress);
    const implementationAddress = relayerWeb.address.fromHex(await factoryInstance.implementation().call());
    const initCode = cloneInitCode(implementationAddress);
    predicted = tronCreate2(factoryAddress, salt, initCode);
    deploymentTx = await factoryInstance.createBatch(
      batchIdBytes(batchId), tokenAddress, tree.root, amount.toString(), owner, expiry
    ).send({ feeLimit: 1_000_000_000 });
    await waitForTx(relayerWeb, deploymentTx);
  }
  await waitForContract(relayerWeb, predicted);
  const executor = relayerWeb.contract(executorArtifact.abi, predicted);
  assert.ok(sameAddress(await executor.token().call(), tokenAddress));
  assert.equal(await executor.paymentsRoot().call(), tree.root);
  assert.equal(BigInt(await executor.totalAmount().call()), amount);
  assert.ok(sameAddress(await executor.refundAddress().call(), owner));
  assert.equal(BigInt(await executor.expiry().call()), BigInt(expiry));
  console.log(JSON.stringify({ factoryAddress, predicted, deploymentTx, salt, expiry, root: tree.root, amount: amount.toString(), recipient }, null, 2));
  if (process.env.NILE_ONLY_DEPLOY === '1') return;

  const duration = provider.config?.defaultDeadlineDuration || 180;
  const deadline = Math.floor(Date.now() / 1000) + duration;
  const message = {
    token: tokenAddress,
    serviceProvider: provider.address,
    user: owner,
    receiver: predicted,
    value: amount.toString(),
    maxFee: maxFee.toString(),
    deadline: deadline.toString(),
    version: 1,
    nonce: Number(account.nonce)
  };
  // Check the exact fields the user is about to authorize against deployed state.
  assert.ok(sameAddress(message.receiver, predicted));
  assert.ok(sameAddress(message.token, await executor.token().call()));
  assert.equal(BigInt(message.value), BigInt(await executor.totalAmount().call()));
  const domain = {
    name: 'GasFreeController', version: 'V1.0.0', chainId: 3448148188,
    verifyingContract: 'THQGuFzL87ZqhxkgqYEryRAd7gqFqL5rdc'
  };
  const types = { PermitTransfer: [
    { name: 'token', type: 'address' },
    { name: 'serviceProvider', type: 'address' },
    { name: 'user', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'maxFee', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'version', type: 'uint256' },
    { name: 'nonce', type: 'uint256' }
  ] };
  const sig = await userWeb.trx._signTypedData(domain, types, message, userKey);
  const requestId = crypto.randomUUID();
  console.log(`Submitting GasFree authorization: requestId=${requestId}, receiver=${predicted}`);
  const before = BigInt(await relayerWeb.contract([{ name: 'balanceOf', type: 'function', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] }], tokenAddress).balanceOf(recipient).call());
  const submitted = await api('POST', '/gasfree/submit', {
    requestId, ...message,
    value: apiInteger(message.value, 'value'),
    maxFee: apiInteger(message.maxFee, 'maxFee'),
    deadline: apiInteger(message.deadline, 'deadline'),
    sig: sig.replace(/^0x/, '')
  });
  const traceId = submitted.id;
  if (!traceId) throw new Error(`Provider returned no traceId: ${JSON.stringify(submitted)}`);
  console.log(`GasFree submitted: traceId=${traceId}, requestId=${requestId}`);
  let status;
  for (let i = 0; i < 80; i++) {
    status = await api('GET', `/gasfree/${traceId}`);
    if (status.state === 'SUCCEED' || status.state === 'FAILED') break;
    await sleep(3000);
  }
  console.log(JSON.stringify({ traceId, state: status.state, txnHash: status.txnHash, txnState: status.txnState }));
  if (status.state !== 'SUCCEED') throw new Error(`GasFree transfer did not succeed: ${JSON.stringify(status)}`);
  if (!sameAddress(status.targetAddress, predicted)) throw new Error('Provider targetAddress differs from executor');
  if (BigInt(status.amount) !== amount) throw new Error('Provider amount differs from signed value');
  const funded = BigInt(await relayerWeb.contract([{ name: 'balanceOf', type: 'function', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] }], tokenAddress).balanceOf(predicted).call());
  if (funded < amount) throw new Error(`Provider succeeded but executor balance is ${funded}`);
  console.log(`BatchExecutor funded: ${funded} base units`);

  const payoutTx = await executor.execute(0, recipient, amount.toString(), tree.proof(0))
    .send({ feeLimit: 300_000_000 });
  await waitForTx(relayerWeb, payoutTx);
  assert.equal(await executor.paid(0).call(), true);
  const after = BigInt(await relayerWeb.contract([{ name: 'balanceOf', type: 'function', inputs: [{ name: 'account', type: 'address' }], outputs: [{ type: 'uint256' }] }], tokenAddress).balanceOf(recipient).call());
  assert.equal(after - before, amount);
  let duplicateRejected = false;
  try {
    const simulation = await relayerWeb.transactionBuilder.triggerConstantContract(
      predicted, 'execute(uint256,address,uint256,bytes32[])', {},
      [
        { type: 'uint256', value: 0 },
        { type: 'address', value: recipient },
        { type: 'uint256', value: amount.toString() },
        { type: 'bytes32[]', value: [] }
      ], relayer
    );
    duplicateRejected = simulation.result?.result === false;
  } catch (_) { duplicateRejected = true; }
  assert.ok(duplicateRejected, 'Duplicate payout unexpectedly succeeded');
  console.log(JSON.stringify({ result: 'PASS', traceId, gasFreeTx: status.txnHash, payoutTx, duplicateRejected }, null, 2));
}

main().catch(error => { console.error(error); process.exitCode = 1; });
