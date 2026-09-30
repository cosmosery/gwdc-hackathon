// Read-only compatibility for engines whose clients construct PermitTransfer.
const {getProviderConfig,getAccountInfo,DOMAIN_NILE,TYPES_PERMIT}=require('./gasfree.cjs');
async function signingContext(batch) {
  if(batch.status!=='READY')throw Error('Batch is not ready for a new signature');
  const deadline=Math.min(Math.floor(Date.now()/1000)+180,Number(batch.expiry));
  if(deadline<=Date.now()/1000+15)throw Error('Batch is too close to expiry');
  const [config,account]=await Promise.all([getProviderConfig(),getAccountInfo(batch.sender)]);
  const asset=account.assets.find(a=>a.tokenAddress===batch.token);
  if(!asset||!config.tokens.some(t=>t.supported&&t.tokenAddress===batch.token)||!config.providers.length)throw Error('Token or provider unavailable');
  if(account.allowSubmit===false||account.allow_submit===false)throw Error('GasFree account cannot submit right now');
  const fee=BigInt(asset.transferFee)+(account.active?0n:BigInt(asset.activateFee));
  if(fee<0n)throw Error('Invalid provider fee');
  const authorization={token:batch.token,serviceProvider:config.providers[0].address,user:batch.sender,receiver:batch.executorAddress,value:String(batch.totalAmount),maxFee:(fee*2n).toString(),deadline,version:1,nonce:String(account.nonce)};
  for(const key of ['value','maxFee','nonce'])if(!/^\d+$/.test(authorization[key])||!Number.isSafeInteger(Number(authorization[key])))throw Error('Invalid permit integer');
  return {batchId:batch.batchId,domain:DOMAIN_NILE,types:TYPES_PERMIT,authorization,estimatedGasFreeFee:fee.toString(),gasFreeAddress:account.gasFreeAddress};
}
module.exports={signingContext};
