const assert = require('node:assert/strict');
const ganache = require('ganache');
const { BrowserProvider, ContractFactory, Contract, getCreate2Address, keccak256 } = require('ethers');
const { TronWeb } = require('tronweb');
const { compile, leaf, pair, merkle, tronCreate2, cloneInitCode, batchSalt } = require('./common.cjs');

const contracts = compile();
assert.ok(contracts.BatchExecutor.abi.length && contracts.BatchFactory.abi.length);
const a = TronWeb.address.fromPrivateKey('1'.repeat(64));
const b = TronWeb.address.fromPrivateKey('2'.repeat(64));
const c = TronWeb.address.fromPrivateKey('3'.repeat(64));
const rows = [[a, 100n], [b, 500n], [c, 700n]];
const leaves = rows.map(([to, amount], i) => leaf(i, to, amount));
const tree = merkle(leaves);
for (let i = 0; i < rows.length; i++) {
  const computed = tree.proof(i).reduce(pair, leaves[i]);
  assert.equal(computed, tree.root);
}
assert.notEqual(tree.proof(1).reduce(pair, leaf(1, b, 501n)), tree.root);
assert.notEqual(tree.proof(1).reduce(pair, leaf(1, a, 500n)), tree.root);
const salt = batchSalt(a, a, tree.root, 1300n, 2000000000n, '0x' + '42'.repeat(32));
const initCode = cloneInitCode(a);
assert.equal(tronCreate2(b, salt, initCode), tronCreate2(b, salt, initCode));
assert.notEqual(tronCreate2(b, salt, initCode), tronCreate2(c, salt, initCode));
async function run() {
  const provider = new BrowserProvider(ganache.provider({ logging: { quiet: true } }));
  const [deployer, alice, bob, carol, hacker] = await Promise.all(
    [0, 1, 2, 3, 4].map(i => provider.getSigner(i))
  );
  const token = await new ContractFactory(contracts.MockToken.abi, contracts.MockToken.evm.bytecode.object, deployer).deploy();
  await token.waitForDeployment();
  const factory = await new ContractFactory(contracts.BatchFactory.abi, contracts.BatchFactory.evm.bytecode.object, deployer).deploy();
  await factory.waitForDeployment();
  const tron = address => TronWeb.address.fromHex(`41${address.slice(2)}`);
  const recipients = await Promise.all([alice, bob, carol].map(x => x.getAddress()));
  const amounts = [100n, 500n, 700n];
  const localTree = merkle(recipients.map((to, i) => leaf(i, tron(to), amounts[i])));
  const expiry = BigInt((await provider.getBlock('latest')).timestamp + 1000);
  const owner = await deployer.getAddress();
  const localBatchId = '0x' + '11'.repeat(32);
  const localSalt = batchSalt(tron(await token.getAddress()), tron(owner), localTree.root, 1300n, expiry, localBatchId);
  const localInitCode = cloneInitCode(tron(await factory.implementation()));
  const predictedEvm = getCreate2Address(await factory.getAddress(), localSalt, keccak256(localInitCode));
  await (await factory.createBatch(localBatchId, await token.getAddress(), localTree.root, 1300n, owner, expiry)).wait();
  assert.notEqual(await provider.getCode(predictedEvm), '0x');
  const batch = new Contract(predictedEvm, contracts.BatchExecutor.abi, deployer);
  await assert.rejects(batch.execute.staticCall(1, recipients[1], amounts[1], localTree.proof(1)));
  await (await token.mint(predictedEvm, 1300n)).wait();
  await (await token.setReturnFalse(true)).wait();
  assert.equal(await token.balanceOf(predictedEvm), 1300n);
  await assert.rejects(batch.execute.staticCall(1, await hacker.getAddress(), 500n, localTree.proof(1)));
  await assert.rejects(batch.execute.staticCall(1, recipients[1], 501n, localTree.proof(1)));
  await (await batch.execute(1, recipients[1], 500n, localTree.proof(1))).wait();
  assert.equal(await token.balanceOf(recipients[1]), 500n);
  assert.equal(await batch.paid(1), true);
  await assert.rejects(batch.execute.staticCall(1, recipients[1], 500n, localTree.proof(1)));
  await (await batch.execute(0, recipients[0], 100n, localTree.proof(0))).wait();
  await provider.send('evm_increaseTime', [1001]);
  await provider.send('evm_mine', []);
  await assert.rejects(batch.execute.staticCall(2, recipients[2], 700n, localTree.proof(2)));
  await (await batch.connect(hacker).refund()).wait();
  assert.equal(await token.balanceOf(owner), 700n);
  assert.equal(await token.balanceOf(recipients[2]), 0n);
  console.log('PASS: compile, Merkle proofs, CREATE2 deployment, funding gate, tamper rejection, payout, duplicate rejection, expiry refund.');
}

run().catch(error => { console.error(error); process.exitCode = 1; });
