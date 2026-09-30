const http = require('node:http');
function createFrontendBridge(options = {}) {
const allowedOrigins = new Set(['http://127.0.0.1:5173', 'http://localhost:5173']);
const engine = (options.engine || process.env.ENGINE_API_URL || 'http://127.0.0.1:3000').replace(/\/+$/, '');
const upstreamFetch = options.fetch || fetch;
const bearer = options.bearerToken || process.env.API_BEARER_TOKEN;
const server = http.createServer(async (req, res) => {
  res.setHeader('Cache-Control', 'no-store');
  res.setHeader('Content-Type', 'application/json');
  const send = (status, value) => { res.writeHead(status); res.end(JSON.stringify(value)); };
  const host = req.headers.host || '';
  if (!/^(127\.0\.0\.1|localhost)(:\d+)?$/.test(host)) return send(403, {error:'Local host required'});
  const origin = req.headers.origin;
  if (origin && !allowedOrigins.has(origin)) return send(403, { error: 'Origin is not allowed' });
  if (req.headers['sec-fetch-site'] === 'cross-site') return send(403, { error: 'Cross-site requests are not allowed' });
  const url = new URL(req.url, 'http://127.0.0.1');
  const route = url.pathname.replace(/^\/api(?=\/)/, '');
  const fundingRoute=req.method==='GET'&&/^\/batches\/[a-zA-Z0-9_-]{1,128}\/funding-balance$/.test(route);
  const read = req.method === 'GET' && (route === '/health' || /^\/batches\/[a-zA-Z0-9_-]{1,128}(\/(payments|reconciliation|signing-context|fees|progress))?$/.test(route));
  const write = req.method === 'POST' && (route === '/quote' || route === '/batches' || /^\/batches\/[a-zA-Z0-9_-]{1,128}\/(execute|resume)$/.test(route));
  if (write && !allowedOrigins.has(origin)) return send(403, { error: 'Same-origin browser request required' });
  if ((!read && !write && !fundingRoute) || !url.pathname.startsWith('/api/') || url.search) return send(404, { error: 'Endpoint is not enabled in this preview' });
  if (!bearer) return send(503, { error: 'Engine authentication is not configured' });
  try {
    if(fundingRoute){
      const batchPath=route.replace(/\/funding-balance$/,'');
      const upstream=await upstreamFetch(engine+batchPath,{headers:{Authorization:'Bearer '+bearer},redirect:'error',signal:AbortSignal.timeout(15000)});
      const batch=await upstream.json();if(!upstream.ok)return send(upstream.status,batch);
      return send(200,await require('./frontendFunding.cjs').readFundingBalance(batch));
    }
    let body = '';
    for await (const chunk of req) {
      body += chunk;
      if (Buffer.byteLength(body) > 1024 * 1024) return send(413, { error: 'Request is too large' });
    }
    if (write) JSON.parse(body);
    const upstream = await upstreamFetch(engine + route, {
      method: req.method, redirect: 'error', signal: AbortSignal.timeout(15000),
      headers: { Authorization: 'Bearer ' + bearer, 'Content-Type': 'application/json', ...(req.headers['idempotency-key'] ? {'Idempotency-Key': req.headers['idempotency-key']} : {}) },
      ...(write ? { body } : {}),
    });
    const value = await upstream.json();
    if(upstream.status===404&&route.endsWith('/signing-context')) {
      const batchResponse=await upstreamFetch(engine+route.replace(/\/signing-context$/,''),{headers:{Authorization:'Bearer '+bearer},redirect:'error',signal:AbortSignal.timeout(15000)});
      if(!batchResponse.ok)return send(batchResponse.status,await batchResponse.json());
      try{return send(200,await require('./frontendSigning.cjs').signingContext(await batchResponse.json()));}
      catch{return send(503,{error:'Live GasFree signing data unavailable. No signature or payment was submitted.'});}
    }
    send(upstream.status, value);
  } catch (error) {
    send(error instanceof SyntaxError ? 400 : 502, { error: error instanceof SyntaxError ? 'Invalid JSON' : 'Engine response unavailable. Submission may have reached the engine; inspect batch status before any further action.' });
  }
});
server.requestTimeout=20000;
return server;
}
module.exports={createFrontendBridge};
