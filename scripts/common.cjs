const fs = require('node:fs');
const path = require('node:path');
const solc = require('solc');
const { AbiCoder, concat, getBytes, keccak256, toUtf8Bytes } = require('ethers');
const { TronWeb } = require('tronweb');

const abiCoder = AbiCoder.defaultAbiCoder();

function compile() {
  const source = fs.readFileSync(path.join(__dirname, '../contracts/BatchExecutor.sol'), 'utf8');
  const mock = fs.readFileSync(path.join(__dirname, '../contracts/MockToken.sol'), 'utf8');
  const input = {
    language: 'Solidity',
    sources: { 'BatchExecutor.sol': { content: source }, 'MockToken.sol': { content: mock } },
    settings: {
      optimizer: { enabled: true, runs: 200 },
      evmVersion: 'paris',
      outputSelection: { '*': { '*': ['abi', 'evm.bytecode.object'] } }
    }
  };
  const output = JSON.parse(solc.compile(JSON.stringify(input)));
  const errors = (output.errors || []).filter(x => x.severity === 'error');
  if (errors.length) throw new Error(errors.map(x => x.formattedMessage).join('\n'));
  return { ...output.contracts['BatchExecutor.sol'], ...output.contracts['MockToken.sol'] };
}

function evmAddress(tronAddress) {
  if (!TronWeb.isAddress(tronAddress)) throw new Error(`Invalid TRON address: ${tronAddress}`);
  return `0x${TronWeb.address.toHex(tronAddress).slice(2)}`;
}

function leaf(index, recipient, amount) {
  return keccak256(abiCoder.encode(
    ['uint256', 'address', 'uint256'], [index, evmAddress(recipient), amount]
  ));
}

function pair(left, right) {
  const [a, b] = BigInt(left) < BigInt(right) ? [left, right] : [right, left];
  return keccak256(concat([a, b]));
}

function merkle(leaves) {
  if (!leaves.length) throw new Error('Empty Merkle tree');
  const levels = [leaves];
  while (levels.at(-1).length > 1) {
    const current = levels.at(-1);
    const next = [];
    for (let i = 0; i < current.length; i += 2) {
      // Odd final nodes are promoted unchanged. The proof for them omits this level.
      next.push(i + 1 < current.length ? pair(current[i], current[i + 1]) : current[i]);
    }
    levels.push(next);
  }
  function proof(index) {
    const result = [];
    for (const level of levels.slice(0, -1)) {
      const sibling = index ^ 1;
      if (sibling < level.length) result.push(level[sibling]);
      index = Math.floor(index / 2);
    }
    return result;
  }
  return { root: levels.at(-1)[0], proof };
}

function tronCreate2(factory, salt, initCode) {
  const packed = concat(['0x41', evmAddress(factory), salt, keccak256(initCode)]);
  const evm = keccak256(packed).slice(-40);
  return TronWeb.address.fromHex(`41${evm}`);
}

function cloneInitCode(implementation) {
  return concat([
    '0x3d602d80600a3d3981f3',
    '0x363d3d373d3d3d363d73',
    evmAddress(implementation),
    '0x5af43d82803e903d91602b57fd5bf3'
  ]);
}

function batchIdBytes(batchId) {
  return /^0x[0-9a-fA-F]{64}$/.test(batchId) ? batchId : keccak256(toUtf8Bytes(batchId));
}

function batchSalt(token, owner, root, total, expiry, batchId) {
  return keccak256(abiCoder.encode(
    ['address', 'bytes32', 'uint256', 'address', 'uint256', 'bytes32'],
    [evmAddress(token), root, total, evmAddress(owner), expiry, batchIdBytes(batchId)]
  ));
}

module.exports = { compile, evmAddress, leaf, pair, merkle, tronCreate2, cloneInitCode, batchIdBytes, batchSalt };
