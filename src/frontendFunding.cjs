const {TronWeb}=require('tronweb');
const TOKEN='TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf';
const NILE='https://nile.trongrid.io';
async function readFundingBalance(batch,TronWebImpl=TronWeb){
  if(batch.token!==TOKEN)throw Error('Only Nile USDT funding is supported');
  if(!batch.batchId||!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(batch.executorAddress)||!/^[0-9]+$/.test(batch.totalAmount))throw Error('Invalid batch funding details');
  const web=new TronWebImpl({fullHost:NILE});
  const call=await web.transactionBuilder.triggerConstantContract(TOKEN,'balanceOf(address)',{},[{type:'address',value:batch.executorAddress}],batch.executorAddress);
  if(!call?.result?.result||!/^0x?[0-9a-f]+$/i.test(call.constant_result?.[0]||''))throw Error('Nile USDT balance query failed');
  const amount=BigInt('0x'+call.constant_result[0].replace(/^0x/i,''));
  return {batchId:batch.batchId,executorAddress:batch.executorAddress,balance:amount.toString(),required:batch.totalAmount,funded:amount>=BigInt(batch.totalAmount),network:'NILE',source:'Nile USDT balanceOf'};
}
module.exports={readFundingBalance};
