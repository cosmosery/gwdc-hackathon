const crypto = require('node:crypto');
const { verifyTypedData } = require('ethers');
const { TronWeb } = require('tronweb');

const BASE_URL = process.env.GASFREE_BASE_URL || 'https://open-test.gasfree.io';
const API_PATH = process.env.GASFREE_API_PATH || '/nile/api/v1';

const DOMAIN_NILE = {
  name: 'GasFreeController',
  version: 'V1.0.0',
  chainId: 3448148188,
  verifyingContract: 'THQGuFzL87ZqhxkgqYEryRAd7gqFqL5rdc'
};

const TYPES_PERMIT = {
  PermitTransfer: [
    { name: 'token', type: 'address' },
    { name: 'serviceProvider', type: 'address' },
    { name: 'user', type: 'address' },
    { name: 'receiver', type: 'address' },
    { name: 'value', type: 'uint256' },
    { name: 'maxFee', type: 'uint256' },
    { name: 'deadline', type: 'uint256' },
    { name: 'version', type: 'uint256' },
    { name: 'nonce', type: 'uint256' }
  ]
};

async function apiRequest(method, endpoint, body) {
  const apiKey = process.env.GASFREE_API_KEY;
  const apiSecret = process.env.GASFREE_API_SECRET;
  if (!apiKey || !apiSecret) {
    throw new Error('GASFREE_API_KEY and GASFREE_API_SECRET must be configured');
  }

  const path = API_PATH + endpoint;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac('sha256', apiSecret)
    .update(method + path + timestamp).digest('base64');

  const headers = {
    Timestamp: timestamp,
    Authorization: `ApiKey ${apiKey}:${signature}`
  };
  if (body) {
    headers['Content-Type'] = 'application/json';
  }

  const response = await fetch(BASE_URL + path, {
    method,
    headers,
    ...(body ? { body: JSON.stringify(body) } : {})
  });

  const json = await response.json();
  return { status: response.status, ok: response.ok, body: json };
}

function verifyTip712Permit(domain, message, signature) {
  // Normalize addresses for typed data verification
  // TRON Web trx._signTypedData uses standard EIP-712 under the hood, but addresses in message can be base58.
  // In ethers verifyTypedData, addresses must be 0x-hex format.
  const toEvm = (addr) => {
    if (!addr) return addr;
    if (addr.startsWith('0x')) return addr;
    return `0x${TronWeb.address.toHex(addr).slice(2)}`;
  };

  const evmDomain = {
    name: domain.name,
    version: domain.version,
    chainId: domain.chainId,
    verifyingContract: toEvm(domain.verifyingContract)
  };

  const evmMessage = {
    token: toEvm(message.token),
    serviceProvider: toEvm(message.serviceProvider),
    user: toEvm(message.user),
    receiver: toEvm(message.receiver),
    value: String(message.value),
    maxFee: String(message.maxFee),
    deadline: String(message.deadline),
    version: Number(message.version),
    nonce: Number(message.nonce)
  };

  const sig = signature.startsWith('0x') ? signature : `0x${signature}`;
  const recoveredEvmAddress = verifyTypedData(evmDomain, TYPES_PERMIT, evmMessage, sig);
  const recoveredTronAddress = TronWeb.address.fromHex(`41${recoveredEvmAddress.slice(2)}`);

  return {
    valid: recoveredTronAddress.toLowerCase() === message.user.toLowerCase(),
    recoveredAddress: recoveredTronAddress
  };
}

async function submitGasFreePermit(payload) {
  const res = await apiRequest('POST', '/gasfree/submit', payload);
  if (!res.ok || res.body.code !== 200) {
    const errorMsg = res.body?.message || res.body?.reason || `HTTP ${res.status}`;
    const err = new Error(`GasFree submit failed: ${errorMsg}`);
    err.apiResponse = res.body;
    throw err;
  }
  return res.body.data;
}

async function queryGasFreeStatus(traceId) {
  const res = await apiRequest('GET', `/gasfree/${traceId}`);
  if (!res.ok || res.body.code !== 200) {
    const errorMsg = res.body?.message || res.body?.reason || `HTTP ${res.status}`;
    const err = new Error(`GasFree query failed: ${errorMsg}`);
    err.apiResponse = res.body;
    throw err;
  }
  return res.body.data;
}

async function getProviderConfig() {
  const [tokensRes, providersRes] = await Promise.all([
    apiRequest('GET', '/config/token/all'),
    apiRequest('GET', '/config/provider/all')
  ]);
  return {
    tokens: tokensRes.body?.data?.tokens || [],
    providers: providersRes.body?.data?.providers || []
  };
}

async function getAccountInfo(userAddress) {
  const res = await apiRequest('GET', `/address/${userAddress}`);
  return res.body?.data;
}

module.exports = {
  DOMAIN_NILE,
  TYPES_PERMIT,
  verifyTip712Permit,
  submitGasFreePermit,
  queryGasFreeStatus,
  getProviderConfig,
  getAccountInfo
};
