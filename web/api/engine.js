import { TronWeb } from 'tronweb';

const upstream = 'https://tron-gasfree-batch-nile-probe.vercel.app';
const DEMO_BEARER = 'Bearer 22016109c55d3b06a55a164172a0c03142bf4a13b34b3e77b47264152345d4df';

export default async function handler(req, res) {
  res.setHeader('Cache-Control', 'no-store');
  const url = new URL(req.url, 'https://frontend.invalid');
  const path = url.searchParams.get('path') || '';
  const read = /^\/(health|batches\/[A-Za-z0-9_-]+(?:\/(payments|progress|fees|reconciliation|funding-balance))?)$/;
  const write = /^\/(quote|batches|batches\/[A-Za-z0-9_-]+\/(execute|resume))$/;
  if (!(req.method === 'GET' ? read : req.method === 'POST' ? write : /a^/).test(path)) return res.status(404).json({error:'Unknown engine route'});
  const authorization = req.headers.authorization || DEMO_BEARER;
  const headers = {'Content-Type':'application/json', Authorization: authorization};
  if (req.headers['idempotency-key']) headers['Idempotency-Key'] = req.headers['idempotency-key'];
  try {
    const funding = path.endsWith('/funding-balance');
    const response = await fetch(upstream + (funding ? path.replace('/funding-balance','') : path), {
      method:req.method, headers, redirect:'error', signal:AbortSignal.timeout(12000),
      ...(req.method === 'POST' ? {body:JSON.stringify(req.body || {})} : {}),
    });
    const data = await response.json();
    if (!response.ok || !funding) return res.status(response.status).json(data);
    if (data.token !== 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf' || !TronWeb.isAddress(data.executorAddress) || !/^\d+$/.test(data.totalAmount)) throw Error('Invalid funding details');
    const tron = new TronWeb({fullHost:'https://nile.trongrid.io'});
    const call = await tron.transactionBuilder.triggerConstantContract(data.token,'balanceOf(address)',{},[{type:'address',value:data.executorAddress}],data.executorAddress);
    if (!call?.result?.result || !/^[0-9a-f]+$/i.test(call.constant_result?.[0] || '')) throw Error('Nile balance unavailable');
    const balance = BigInt('0x'+call.constant_result[0]);
    return res.status(200).json({batchId:data.batchId,executorAddress:data.executorAddress,balance:String(balance),required:data.totalAmount,funded:balance>=BigInt(data.totalAmount),network:'NILE',source:'Nile USDT balanceOf'});
  } catch {
    return res.status(502).json({error:'Engine or Nile request failed. Check the current batch before retrying.'});
  }
}
