// Real Solidity execution on an ephemeral local EVM. Not TRON TVM/energy evidence.
const assert=require('node:assert/strict');
const fs=require('node:fs');const path=require('node:path');
const ganache=require('ganache');
const {BrowserProvider,ContractFactory,Contract,getCreate2Address,keccak256}=require('ethers');
const {TronWeb}=require('tronweb');
const {compile,leaf,merkle,cloneInitCode,batchSalt}=require('../scripts/common.cjs');
(async()=>{
 const rpc=ganache.provider({logging:{quiet:true}});const provider=new BrowserProvider(rpc);provider.pollingInterval=10;
 const contracts=compile();const owner=await provider.getSigner(0), outsider=await provider.getSigner(1);const ownerAddress=await owner.getAddress(),recipient=await outsider.getAddress();
 const token=await new ContractFactory(contracts.MockToken.abi,contracts.MockToken.evm.bytecode.object,owner).deploy();await token.waitForDeployment();
 const factory=await new ContractFactory(contracts.BatchFactory.abi,contracts.BatchFactory.evm.bytecode.object,owner).deploy();await factory.waitForDeployment();
 const tron=a=>TronWeb.address.fromHex('41'+a.slice(2));const tokenAddress=await token.getAddress();const factoryAddress=await factory.getAddress();
 const tree=merkle([leaf(0,tron(recipient),100n),leaf(1,tron(recipient),200n)]);const results=[];let nonce=1;
 async function test(name,fn){try{await fn();results.push({scenario:name,status:'PASS'});console.log('PASS',name);}catch(e){results.push({scenario:name,status:'FAIL',error:e.shortMessage||e.message});console.log('FAIL',name,e.shortMessage||e.message);}}
 async function setup({deploy=true,amount=300n}={}){
  const latest=await rpc.request({method:'eth_getBlockByNumber',params:['latest',false]});const expiry=BigInt(latest.timestamp)+100n;
  const id='0x'+(nonce++).toString(16).padStart(64,'0');
  const salt=batchSalt(tron(tokenAddress),tron(ownerAddress),tree.root,300n,expiry,id);
  const address=getCreate2Address(factoryAddress,salt,keccak256(cloneInitCode(tron(await factory.implementation()))));
  const args=[id,tokenAddress,tree.root,300n,ownerAddress,expiry];
  if(deploy)await(await factory.createBatch(...args)).wait();
  if(amount)await(await token.mint(address,amount)).wait();
  return {address,args,batch:new Contract(address,contracts.BatchExecutor.abi,owner)};
 }
 try{
  await test('funding gate: partial deposit blocks all payout',async()=>{const {batch}=await setup({amount:100n});await assert.rejects(batch.execute.staticCall(0,recipient,100n,tree.proof(0)));assert.equal(await batch.paidAmount(),0n);});
  await test('proof: altered recipient rejected',async()=>{const {batch}=await setup();await assert.rejects(batch.execute.staticCall(0,ownerAddress,100n,tree.proof(0)));});
  await test('proof: altered amount rejected',async()=>{const {batch}=await setup();await assert.rejects(batch.execute.staticCall(0,recipient,101n,tree.proof(0)));});
  await test('proof: altered index rejected',async()=>{const {batch}=await setup();await assert.rejects(batch.execute.staticCall(1,recipient,100n,tree.proof(0)));});
  await test('payout: exact balance movement and duplicate rejection',async()=>{const {batch,address}=await setup();const before=await token.balanceOf(recipient);await(await batch.execute(0,recipient,100n,tree.proof(0))).wait();assert.equal(await token.balanceOf(recipient)-before,100n);assert.equal(await token.balanceOf(address),200n);assert.equal(await batch.paid(0),true);await assert.rejects(batch.execute.staticCall(0,recipient,100n,tree.proof(0)));});
  await test('Nile-style false return accepted only with actual movement',async()=>{const {batch}=await setup();await(await token.setReturnFalse(true)).wait();await(await batch.execute(0,recipient,100n,tree.proof(0))).wait();assert.equal(await batch.paidAmount(),100n);await(await token.setReturnFalse(false)).wait();});
  await test('initialize: outsider cannot reinitialize clone',async()=>{const {batch}=await setup();await assert.rejects(batch.connect(outsider).initialize.staticCall(tokenAddress,tree.root,300n,recipient,9999999999n));});
  await test('refund: active incomplete batch blocked',async()=>{const {batch}=await setup();await assert.rejects(batch.refund.staticCall());});
  await test('refund: full payout allows surplus return before expiry',async()=>{const {batch,address}=await setup({amount:350n});const before=await token.balanceOf(ownerAddress);for(const [i,a]of[[0,100n],[1,200n]])await(await batch.execute(i,recipient,a,tree.proof(i))).wait();await(await batch.refund()).wait();assert.equal(await token.balanceOf(ownerAddress)-before,50n);assert.equal(await token.balanceOf(address),0n);});
  await test('refund: expiry blocks payment, outsider can only refund original owner',async()=>{const {batch}=await setup();const before=await token.balanceOf(ownerAddress);await rpc.request({method:'evm_increaseTime',params:[101]});await rpc.request({method:'evm_mine',params:[]});await assert.rejects(batch.execute.staticCall(0,recipient,100n,tree.proof(0)));await(await batch.connect(outsider).refund()).wait();assert.equal(await token.balanceOf(ownerAddress)-before,300n);await assert.rejects(batch.refund.staticCall());});
  await test('SAFETY: funded counterfactual executor recoverable after expiry',async()=>{
   const {address,args,batch}=await setup({deploy:false});
   assert.equal(await provider.getCode(address),'0x');assert.equal(await token.balanceOf(address),300n);
   await rpc.request({method:'evm_increaseTime',params:[101]});await rpc.request({method:'evm_mine',params:[]});
   // Intended invariant: funding at the predicted address must remain recoverable.
   // Regression: the old initialize(expiry > now) stranded these funds.
   const before = await token.balanceOf(ownerAddress);
   await factory.createBatch.staticCall(...args);
   await(await factory.createBatch(...args)).wait();
   await assert.rejects(batch.execute.staticCall(0,recipient,100n,tree.proof(0)));
   await(await batch.connect(outsider).refund()).wait();
   assert.equal(await token.balanceOf(address),0n);
   assert.equal(await token.balanceOf(ownerAddress)-before,300n);
  });
 }finally{await rpc.disconnect();}
 const report={timestamp:new Date().toISOString(),scope:'Ephemeral Ganache EVM executing repository Solidity; excludes TVM and live GasFree',total:results.length,passed:results.filter(x=>x.status==='PASS').length,failed:results.filter(x=>x.status==='FAIL').length,results};
 const out=path.join(__dirname,'../artifacts/contract-scenarios.json');fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,JSON.stringify(report,null,2)+'\n');console.log(JSON.stringify({total:report.total,passed:report.passed,failed:report.failed}));process.exitCode=report.failed?1:0;
})().catch(e=>{console.error(e);process.exitCode=1;});
