const { TronWeb } = require('tronweb');
const {
  compile,
  evmAddress,
  leaf,
  pair,
  merkle,
  tronCreate2,
  cloneInitCode,
  batchIdBytes,
  batchSalt
} = require('../scripts/common.cjs');

const NILE_RPC = process.env.NILE_RPC || 'https://nile.trongrid.io';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

let cachedCompiled = null;
function getCompiled() {
  if (!cachedCompiled) {
    cachedCompiled = compile();
  }
  return cachedCompiled;
}

function getRelayerWeb(privateKey = process.env.NILE_RELAYER_PRIVATE_KEY) {
  if (!privateKey || !/^[0-9a-fA-F]{64}$/.test(privateKey)) {
    throw new Error('Valid 64-hex relayer private key required');
  }
  return new TronWeb({ fullHost: NILE_RPC, privateKey });
}

function getReadOnlyWeb() {
  const web = new TronWeb({ fullHost: NILE_RPC });
  web.setAddress('T9yD14Nj9j7xAB4dbGeiX9h8unkKHxuWwb');
  return web;
}

const cachedImplementationAddresses = new Map();
async function getImplementationAddress(web, factoryAddress = process.env.NILE_FACTORY_ADDRESS) {
  if (cachedImplementationAddresses.has(factoryAddress)) return cachedImplementationAddresses.get(factoryAddress);
  const compiled = getCompiled();
  const factoryInstance = web.contract(compiled.BatchFactory.abi, factoryAddress);
  const raw = await factoryInstance.implementation().call();
  const address = web.address.fromHex(raw);
  cachedImplementationAddresses.set(factoryAddress, address);
  return address;
}

async function isContractDeployed(web, address) {
  try {
    const c = await web.trx.getContract(address);
    return Boolean(c.contract_address && (c.bytecode || c.code_hash));
  } catch (error) {
    if (/contract (does not exist|not found)/i.test(String(error?.message || error))) return false;
    throw error;
  }
}

async function predictBatchExecutorAddress({
  token,
  root,
  totalAmount,
  refundAddress,
  expiry,
  batchId,
  factoryAddressOverride,
  web
}) {
  const factoryAddress = factoryAddressOverride || process.env.NILE_FACTORY_ADDRESS;
  if (!factoryAddress) {
    throw new Error('NILE_FACTORY_ADDRESS is required; deploy the shared factory once with npm run deploy:factory');
  }
  const clientWeb = web || getReadOnlyWeb();
  const implementationAddress = await getImplementationAddress(clientWeb, factoryAddress);
  const salt = batchSalt(token, refundAddress, root, totalAmount, expiry, batchId);
  const initCode = cloneInitCode(implementationAddress);
  const predictedAddress = tronCreate2(factoryAddress, salt, initCode);
  return {
    factoryAddress,
    implementationAddress,
    executorAddress: predictedAddress,
    salt
  };
}

async function waitForContract(web, address, maxAttempts = 25) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const result = await web.trx.getContract(address);
      if (result.contract_address && (result.bytecode || result.code_hash)) return true;
    } catch (_) { /* pending */ }
    await sleep(2500);
  }
  throw new Error(`Contract did not appear on chain: ${address}`);
}

async function waitForTx(web, txid, maxAttempts = 25) {
  for (let i = 0; i < maxAttempts; i++) {
    try {
      const info = await web.trx.getTransactionInfo(txid);
      if (info.id) {
        if (info.receipt?.result && info.receipt.result !== 'SUCCESS') {
          throw new Error(`Transaction failed: ${txid} ${JSON.stringify(info.receipt)}`);
        }
        if (info.receipt?.result === 'SUCCESS') return info;
      }
    } catch (e) {
      if (e.message?.includes('Transaction failed')) throw e;
    }
    await sleep(2500);
  }
  throw new Error(`Transaction pending timeout: ${txid}`);
}

async function deployBatchExecutorOnChain({
  relayerWeb,
  token,
  root,
  totalAmount,
  refundAddress,
  expiry,
  batchId,
  factoryAddressOverride,
  expectedExecutorAddress,
  onSubmitted
}) {
  const compiled = getCompiled();
  const factoryArtifact = compiled.BatchFactory;
  const executorArtifact = compiled.BatchExecutor;

  let factoryAddress = factoryAddressOverride || process.env.NILE_FACTORY_ADDRESS;
  if (!factoryAddress) {
    throw new Error('NILE_FACTORY_ADDRESS is required; deploy the shared factory once with npm run deploy:factory');
  }
  await waitForContract(relayerWeb, factoryAddress);

  const factoryInstance = relayerWeb.contract(factoryArtifact.abi, factoryAddress);
  let implementationAddress;
  try {
    implementationAddress = relayerWeb.address.fromHex(await factoryInstance.implementation().call());
    await waitForContract(relayerWeb, implementationAddress);
  } catch (error) {
    throw new Error(`Factory does not expose a deployed clone implementation; configure a new BatchFactory: ${error.message}`);
  }

  const salt = batchSalt(token, refundAddress, root, totalAmount, expiry, batchId);
  const onChainSalt = await factoryInstance.batchSalt(
    batchIdBytes(batchId), token, root, totalAmount.toString(), refundAddress, expiry
  ).call();
  if (onChainSalt.toLowerCase() !== salt.toLowerCase()) {
    throw new Error('Factory salt does not match local batch commitment');
  }
  const initCode = cloneInitCode(implementationAddress);
  const predictedAddress = tronCreate2(factoryAddress, salt, initCode);

  if (expectedExecutorAddress && predictedAddress !== expectedExecutorAddress) {
    throw new Error('Predicted executor differs from persisted batch; refusing deployment');
  }

  // Check if already deployed
  const alreadyDeployed = await isContractDeployed(relayerWeb, predictedAddress);

  let deploymentTx = null;
  if (!alreadyDeployed) {
    deploymentTx = await factoryInstance.createBatch(
      batchIdBytes(batchId), token, root, totalAmount.toString(), refundAddress, expiry
    ).send({ feeLimit: 1_000_000_000 });
    if (onSubmitted) onSubmitted(deploymentTx);
    await waitForTx(relayerWeb, deploymentTx);
  }

  await waitForContract(relayerWeb, predictedAddress);

  // Verify on-chain state
  const executor = relayerWeb.contract(executorArtifact.abi, predictedAddress);
  const onChainFactory = relayerWeb.address.fromHex(await executor.factory().call());
  const initialized = await executor.initialized().call();
  const onChainToken = relayerWeb.address.fromHex(await executor.token().call());
  const onChainRoot = await executor.paymentsRoot().call();
  const onChainTotal = BigInt(await executor.totalAmount().call());
  const onChainRefund = relayerWeb.address.fromHex(await executor.refundAddress().call());
  const onChainExpiry = Number(await executor.expiry().call());
  if (onChainFactory !== factoryAddress || !initialized || onChainToken !== token ||
      onChainRoot.toLowerCase() !== root.toLowerCase() || onChainTotal !== BigInt(totalAmount) ||
      onChainRefund !== refundAddress || onChainExpiry !== Number(expiry)) {
    throw new Error('Deployed clone state does not match the batch');
  }

  return {
    factoryAddress,
    implementationAddress,
    executorAddress: predictedAddress,
    salt,
    deploymentTx,
    onChainState: {
      token: onChainToken,
      root: onChainRoot,
      totalAmount: onChainTotal.toString(),
      refundAddress: onChainRefund,
      expiry: onChainExpiry
    }
  };
}

async function checkOnChainBalance(web, tokenAddress, accountAddress) {
  return confirmedUint(web, tokenAddress, 'balanceOf(address)',
    [{ type: 'address', value: accountAddress }]);
}

async function confirmedUint(web, contractAddress, signature, parameters) {
  const response = await web.transactionBuilder.triggerConfirmedConstantContract(
    contractAddress, signature, {}, parameters, web.defaultAddress.base58
  );
  if (!response.result?.result || !response.constant_result?.[0]) {
    throw new Error(`Confirmed contract read failed: ${signature}`);
  }
  return BigInt(`0x${response.constant_result[0]}`);
}

async function checkPaymentPaid(web, executorAddress, index) {
  if (!await isContractDeployed(web, executorAddress)) return false;
  return (await confirmedUint(web, executorAddress, 'paid(uint256)',
    [{ type: 'uint256', value: index }])) !== 0n;
}

async function checkPaidAmount(web, executorAddress) {
  if (!await isContractDeployed(web, executorAddress)) return 0n;
  return await confirmedUint(web, executorAddress, 'paidAmount()', []);
}

async function executePayoutTx(relayerWeb, executorAddress, index, recipient, amount, proof, onSubmitted) {
  const compiled = getCompiled();
  const executor = relayerWeb.contract(compiled.BatchExecutor.abi, executorAddress);
  const txid = await executor.execute(index, recipient, amount.toString(), proof)
    .send({ feeLimit: 300_000_000 });
  if (onSubmitted) onSubmitted(txid);
  await waitForTx(relayerWeb, txid);
  return txid;
}

async function executeRefundTx(relayerWeb, executorAddress, onSubmitted) {
  const executor = relayerWeb.contract(getCompiled().BatchExecutor.abi, executorAddress);
  const txid = await executor.refund().send({ feeLimit: 300_000_000 });
  if (onSubmitted) onSubmitted(txid);
  await waitForTx(relayerWeb, txid);
  return txid;
}

module.exports = {
  getRelayerWeb,
  getReadOnlyWeb,
  getCompiled,
  deployBatchExecutorOnChain,
  predictBatchExecutorAddress,
  isContractDeployed,
  checkOnChainBalance,
  checkPaymentPaid,
  checkPaidAmount,
  executePayoutTx,
  executeRefundTx,
  waitForContract,
  waitForTx
};
