import test from 'node:test';
import assert from 'node:assert/strict';
import {createRequire} from 'node:module';
import {commitment,verifySigningContext,connectWallet,assertWallet,signPermit,FACTORY,IMPLEMENTATION,NILE_CHAIN} from '../src/wallet';
import {SENDER,TOKEN,type ReviewRow} from '../src/domain';
const require=createRequire(import.meta.url);
const common=require('../../scripts/common.cjs');
const {DOMAIN_NILE,TYPES_PERMIT}=require('../../src/gasfree.cjs');
function fixture(){
 const rows=[{address:SENDER,atomic:'100000'},{address:FACTORY,atomic:'200001'},{address:IMPLEMENTATION,atomic:'17'}] as ReviewRow[];
 const tree=common.merkle(rows.map((r,i)=>common.leaf(i,r.address,BigInt(r.atomic!))));
 const c=commitment(SENDER,rows),expiry=Math.floor(Date.now()/1000)+3600,batchId='wallet-test';
 const salt=common.batchSalt(TOKEN,SENDER,tree.root,BigInt(c.total),expiry,batchId);
 const executorAddress=common.tronCreate2(FACTORY,salt,common.cloneInitCode(IMPLEMENTATION));
 const batch={batchId,batchHash:c.hash,merkleRoot:tree.root,totalAmount:c.total,recipientCount:rows.length,expiry,salt,executorAddress,factoryAddress:FACTORY,implementationAddress:IMPLEMENTATION};
 const context={batchId,domain:DOMAIN_NILE,types:TYPES_PERMIT,authorization:{token:TOKEN,serviceProvider:SENDER,user:SENDER,receiver:executorAddress,value:c.total,maxFee:'600000',deadline:Math.floor(Date.now()/1000)+180,version:1,nonce:'3'}};
 return {rows,batch,context};
}
test('independent browser commitment matches engine odd-leaf Merkle and TRON CREATE2',async()=>{const f=fixture();await verifySigningContext(f.batch,f.context,SENDER,f.rows,'600000');});
for(const [label,mutate] of [
 ['changed CSV amount',(f:any)=>f.rows[0].atomic='100001'],
 ['changed recipient',(f:any)=>f.rows[0].address=FACTORY],
 ['untrusted factory',(f:any)=>f.batch.factoryAddress=SENDER],
 ['changed executor',(f:any)=>f.batch.executorAddress=SENDER],
 ['changed domain',(f:any)=>f.context.domain={...f.context.domain,chainId:1}],
 ['fee above approved cap',(f:any)=>f.context.authorization.maxFee='600001'],
 ['expired permit',(f:any)=>f.context.authorization.deadline=1],
 ['wrong schema',(f:any)=>f.context.types={}],
 ['changed permit principal',(f:any)=>f.context.authorization.value='1'],
] as const)test('signing refuses '+label,async()=>{const f=fixture();mutate(f);await assert.rejects(verifySigningContext(f.batch,f.context,SENDER,f.rows,'600000'));});
function provider(){return {request:async()=> '0x'+NILE_CHAIN.toString(16),tronWeb:{defaultAddress:{base58:SENDER},trx:{_signTypedData:async()=> 'ab'.repeat(65)}}};}
test('wrong wallet network is rejected',async()=>{const p=provider();p.request=async()=> '0x1';await assert.rejects(assertWallet(p),/Nile/);});
test('wallet cancellation is propagated without submission',async()=>{const p=provider();p.tronWeb.trx._signTypedData=async()=>{throw Error('User rejected');};await assert.rejects(signPermit(fixture().context,SENDER,p),/rejected/);});
test('account change during signing invalidates signature',async()=>{const p=provider();p.tronWeb.trx._signTypedData=async()=>{p.tronWeb.defaultAddress.base58=FACTORY;return 'ab'.repeat(65);};await assert.rejects(signPermit(fixture().context,SENDER,p),/changed/);});
test('valid signature is returned only after post-sign wallet check',async()=>{assert.equal(await signPermit(fixture().context,SENDER,provider()),'ab'.repeat(65));});
test('authorized TronLink connection is reused without a connect popup',async()=>{
 const calls:string[]=[];const p={...provider(),ready:true};Object.assign(p.tronWeb,{ready:true});
 p.request=async(args?:any)=>{calls.push(args.method);return '0x'+NILE_CHAIN.toString(16);};
 assert.equal(await connectWallet(p),SENDER);assert.deepEqual(calls,['eth_chainId']);
});
test('explicit third-party permit rejection is not repeatedly prompted',async()=>{
 const p=provider();let calls=0;p.tronWeb.trx._signTypedData=async()=>{calls++;throw Error('TronLink does not support permit transfer requests from a third party');};
 await assert.rejects(signPermit(fixture().context,SENDER,p),/No signed permit was submitted/);
 await assert.rejects(signPermit(fixture().context,SENDER,p),/No signed permit was submitted/);
 assert.equal(calls,1);
});

test('older TronLink Unknown method falls back to native connection and verifies Nile node',async()=>{
 const calls:string[]=[];const p={request:async({method}:{method:string})=>{calls.push(method);if(method==='tron_requestAccounts')return {code:200};throw Error('Unknown method called');},tronWeb:{defaultAddress:{base58:SENDER},fullNode:{host:'https://nile.trongrid.io'}}};
 assert.equal(await connectWallet(p),SENDER);
 assert.deepEqual(calls,['eth_requestAccounts','tron_requestAccounts','eth_chainId']);
 p.tronWeb.fullNode.host='https://api.trongrid.io';await assert.rejects(assertWallet(p),/Nile/);
 p.tronWeb.fullNode.host='https://nile.trongrid.io.attacker.example';await assert.rejects(assertWallet(p),/Nile/);
});
test('connection rejection never triggers a legacy retry',async()=>{
 let calls=0;const p={request:async()=>{calls++;throw Object.assign(Error('User rejected'),{code:4001});}};
 await assert.rejects(connectWallet(p),/rejected/);assert.equal(calls,1);
});
test('legacy pending authorization never advances to a quote',async()=>{
 const p={request:async({method}:{method:string})=>{if(method==='tron_requestAccounts')return {code:4000};throw Object.assign(Error('Unsupported'),{code:4200});}};
 await assert.rejects(connectWallet(p),/pending/);
});
