const crypto = require('node:crypto');
const { TronWeb } = require('tronweb');

const key = process.env.NILE_USER_PRIVATE_KEY;
if (!/^[0-9a-fA-F]{64}$/.test(key || '')) throw new Error('NILE_USER_PRIVATE_KEY must be 64 hex characters');
const web = new TronWeb({ fullHost: 'https://nile.trongrid.io', privateKey: key });
const user = web.address.fromPrivateKey(key);
const token = process.env.NILE_USDT_ADDRESS;
const base = 'https://open-test.gasfree.io';
const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

async function api(method, endpoint, body) {
  const path = `/nile/api/v1${endpoint}`;
  const timestamp = String(Math.floor(Date.now() / 1000));
  const signature = crypto.createHmac('sha256', process.env.GASFREE_API_SECRET)
    .update(method + path + timestamp).digest('base64');
  const response = await fetch(base + path, {
    method,
    headers: {
      Timestamp: timestamp,
      Authorization: `ApiKey ${process.env.GASFREE_API_KEY}:${signature}`,
      ...(body ? { 'Content-Type': 'application/json' } : {})
    },
    ...(body ? { body: JSON.stringify(body) } : {})
  });
  const json = await response.json();
  if (!response.ok || json.code !== 200) throw new Error(JSON.stringify(json));
  return json.data;
}

async function main() {
  const [account, providers] = await Promise.all([
    api('GET', `/address/${user}`), api('GET', '/config/provider/all')
  ]);
  const provider = providers.providers[0];
  const asset = account.assets.find(a => a.tokenAddress === token);
  if (!asset) throw new Error('USDT asset missing from GasFree account');
  if (account.allowSubmit === false || account.allow_submit === false) throw new Error('GasFree account has a pending authorization');
  const receiver = process.env.GASFREE_CONTROL_RECEIVER === 'self'
    ? account.gasFreeAddress
    : process.env.GASFREE_CONTROL_RECEIVER || user;
  if (!TronWeb.isAddress(receiver)) throw new Error('Invalid GASFREE_CONTROL_RECEIVER');
  const amount = Number(process.env.GASFREE_CONTROL_AMOUNT_MICRO || 100000);
  if (!Number.isSafeInteger(amount) || amount <= 0) throw new Error('Invalid GASFREE_CONTROL_AMOUNT_MICRO');
  const estimatedFee = Number(asset.transferFee) + (account.active ? 0 : Number(asset.activateFee));
  const maxFee = process.env.GASFREE_MAX_FEE_MICRO
    ? Number(process.env.GASFREE_MAX_FEE_MICRO)
    : estimatedFee;
  if (!Number.isSafeInteger(maxFee) || maxFee < estimatedFee) throw new Error('Invalid max fee cap');
  const message = {
    token, serviceProvider: provider.address, user, receiver,
    value: String(amount), maxFee: String(maxFee),
    deadline: String(Math.floor(Date.now() / 1000) + provider.config.defaultDeadlineDuration),
    version: 1, nonce: Number(account.nonce)
  };
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
  const sig = await web.trx._signTypedData(domain, types, message, key);
  const requestId = crypto.randomUUID();
  console.log(JSON.stringify({ receiver, requestId, amount, maxFee }));
  const submitted = await api('POST', '/gasfree/submit', {
    requestId, ...message, value: amount, maxFee,
    deadline: Number(message.deadline), sig: sig.replace(/^0x/, '')
  });
  console.log(`traceId=${submitted.id}`);
  for (let i = 0; i < 80; i++) {
    const status = await api('GET', `/gasfree/${submitted.id}`);
    if (['SUCCEED', 'FAILED'].includes(status.state)) {
      console.log(JSON.stringify({ traceId: submitted.id, state: status.state, txnHash: status.txnHash, txnState: status.txnState }));
      if (status.state !== 'SUCCEED') process.exitCode = 1;
      return;
    }
    await sleep(3000);
  }
  throw new Error(`Control transfer is still pending: ${submitted.id}`);
}

main().catch(error => { console.error(error); process.exitCode = 1; });
