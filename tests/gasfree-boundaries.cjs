const test=require('node:test');const assert=require('node:assert/strict');
// No .env or real request: exercise the actual provider wrapper with synthetic responses.
process.env.GASFREE_API_KEY='isolated-key';process.env.GASFREE_API_SECRET='isolated-secret';
const {getProviderConfig,getAccountInfo,submitGasFreePermit}=require('../src/gasfree.cjs');
const response=(body,ok=true,status=200)=>({ok,status,json:async()=>body});
test('config HTTP failure cannot look like unsupported token',async()=>{
 global.fetch=async()=>response({code:503},false,503);await assert.rejects(getProviderConfig(),/configuration unavailable/);
});
test('config application error cannot become empty valid config',async()=>{
 global.fetch=async()=>response({code:401,data:{tokens:[],providers:[]}});await assert.rejects(getProviderConfig(),/configuration unavailable/);
});
test('config incomplete schema rejected',async()=>{
 global.fetch=async()=>response({code:200,data:{}});await assert.rejects(getProviderConfig(),/configuration unavailable/);
});
test('config valid schema preserved',async()=>{
 global.fetch=async()=>response({code:200,data:{tokens:[{tokenAddress:'token'}],providers:[{address:'provider'}]}});
 assert.equal((await getProviderConfig()).tokens[0].tokenAddress,'token');
});
test('account HTTP failure rejected',async()=>{
 global.fetch=async()=>response({code:429},false,429);await assert.rejects(getAccountInfo('address'),/information unavailable/);
});
test('account missing assets rejected',async()=>{
 global.fetch=async()=>response({code:200,data:{}});await assert.rejects(getAccountInfo('address'),/information unavailable/);
});
test('provider requests carry bounded cancellation signal',async()=>{
 global.fetch=async(_url,options)=>{assert.ok(options.signal instanceof AbortSignal);return response({code:200,data:{assets:[]}});};
 await getAccountInfo('address');
});
test('submit failure stays error for uncertain-submission handling',async()=>{
 global.fetch=async()=>response({code:503,message:'unavailable'},false,503);await assert.rejects(submitGasFreePermit({}),/submit failed/);
});
