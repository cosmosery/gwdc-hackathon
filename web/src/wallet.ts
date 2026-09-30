import { AbiCoder, concat, keccak256, toUtf8Bytes } from 'ethers';
import { TOKEN, validAddress, type ReviewRow } from './domain';
const abi=AbiCoder.defaultAbiCoder();
export const NILE_CHAIN=3448148188;
export const FACTORY='TXsZ8vWS5h6c7H7XpvY4jKk1tWf1dVGYN8';
export const IMPLEMENTATION='TBhmanfkJeszULsfNv3zXb3Jx5oTPKGj5g';
export function evm(address:string){let n=0n;for(const c of address){const i='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz'.indexOf(c);if(i<0)throw Error('Invalid address');n=n*58n+BigInt(i);}const hex=n.toString(16).padStart(50,'0');return '0x'+hex.slice(2,42);}
const hashLeaf=(idx:number,recipient:string,amount:string)=>keccak256(abi.encode(['uint256','address','uint256'],[idx,evm(recipient),amount]));
export function commitment(sender:string,rows:ReviewRow[]){
 const payments=rows.map((r,idx)=>({idx,recipient:r.address,amount:r.atomic!}));
 let layer=payments.map(p=>hashLeaf(p.idx,p.recipient,p.amount));
 if(!layer.length)throw Error('Empty batch');
 while(layer.length>1){const next:string[]=[];for(let i=0;i<layer.length;i+=2){const a=layer[i],b=layer[i+1];next.push(!b?a:keccak256(concat(BigInt(a)<BigInt(b)?[a,b]:[b,a])));}layer=next;}
 const root=layer[0];return {root,total:payments.reduce((n,p)=>n+BigInt(p.amount),0n).toString(),hash:keccak256(toUtf8Bytes(JSON.stringify({sender,token:TOKEN,payments,merkleRoot:root})))};
}
export async function verifySigningContext(batch:any,context:any,sender:string,rows:ReviewRow[],approvedCap:string){
 const c=commitment(sender,rows),a=context.authorization,d=context.domain;
 if(batch.batchHash!==c.hash||batch.merkleRoot!==c.root||batch.totalAmount!==c.total||batch.recipientCount!==rows.length||context.batchId!==batch.batchId)throw Error('Engine batch does not match the reviewed CSV');
 if(![[FACTORY,IMPLEMENTATION],['TMQYoEzE4LagKinHjKE5GU3MLTtrcuGnFB','TWZ6tenu76YucUEjqpaY78d61vbn1Xwbkj']].some(([factory,implementation])=>batch.factoryAddress===factory&&batch.implementationAddress===implementation))throw Error('Unrecognized executor factory; deployment must be reviewed');
 if(!Number.isSafeInteger(batch.expiry)||batch.expiry<=Date.now()/1000)throw Error('Batch expired');
 const salt=keccak256(abi.encode(['address','bytes32','uint256','address','uint256','bytes32'],[evm(TOKEN),c.root,c.total,evm(sender),batch.expiry,keccak256(toUtf8Bytes(batch.batchId))]));
 const code='0x3d602d80600a3d3981f3363d3d373d3d3d363d73'+evm(batch.implementationAddress).slice(2)+'5af43d82803e903d91602b57fd5bf3';
 const predicted=keccak256(concat(['0x41',evm(batch.factoryAddress),salt,keccak256(code)])).slice(-40);
 if(batch.salt!==salt||!await validAddress(batch.executorAddress)||evm(batch.executorAddress).slice(2).toLowerCase()!==predicted)throw Error('Executor address does not match the committed recipients');
 if(d.name!=='GasFreeController'||d.version!=='V1.0.0'||d.chainId!==NILE_CHAIN||d.verifyingContract!=='THQGuFzL87ZqhxkgqYEryRAd7gqFqL5rdc')throw Error('Unexpected signing domain');
 if(a.user!==sender||a.token!==TOKEN||a.receiver!==batch.executorAddress||String(a.value)!==c.total||Number(a.version)!==1)throw Error('Permit differs from reviewed batch');
 if(!/^\d+$/.test(String(a.maxFee))||BigInt(a.maxFee)>BigInt(approvedCap))throw Error('Fee increased beyond the reviewed cap; request a fresh quote before signing');
 if(!Number.isSafeInteger(a.deadline)||a.deadline>Date.now()/1000+185||a.deadline>batch.expiry||a.deadline<=Date.now()/1000+10)throw Error('Invalid or stale permit deadline');
 if(!/^\d+$/.test(String(a.nonce))||!await validAddress(a.serviceProvider))throw Error('Invalid permit provider or nonce');
 const expected=[['token','address'],['serviceProvider','address'],['user','address'],['receiver','address'],['value','uint256'],['maxFee','uint256'],['deadline','uint256'],['version','uint256'],['nonce','uint256']].map(([name,type])=>({name,type}));
 if(JSON.stringify(context.types)!==JSON.stringify({PermitTransfer:expected}))throw Error('Unexpected typed data schema');
}
export function walletProvider(){const w=window as any;const p=w.tron||w.tronLink;if(!p?.request)throw Error('Open this page in Chrome with TronLink installed and unlocked');return p;}
function unsupported(error:any){return [4200,-32601].includes(error?.code)||/^Unknown method called\.?$/i.test(error?.message||'');}
function walletWeb(p:any){return p.tronWeb||(typeof window!=='undefined'?(window as any).tronWeb:undefined);}
export async function connectWallet(p=walletProvider()){
 // Reuse an explicitly authorized provider; an exposed address alone is not consent.
 if(p.ready===true&&walletWeb(p)?.ready===true&&walletWeb(p)?.defaultAddress?.base58)return assertWallet(p);
 try{await p.request({method:'eth_requestAccounts'});}
 catch(error){
   if(!unsupported(error))throw error;
   const result=await p.request({method:'tron_requestAccounts'});
   if(result?.code===4001)throw Error('Wallet connection was rejected');
   if(result?.code===4000)throw Error('A wallet connection request is already pending. Open TronLink.');
   if(result!==undefined&&result?.code!==200)throw Error('Unlock TronLink and approve the connection request');
 }
 return assertWallet(p);
}
export async function assertWallet(p:any,expected?:string){
 let chain;
 try{chain=await p.request({method:'eth_chainId'});}
 catch(error){
   if(!unsupported(error))throw error;
   // Older TronLink has no chain-id RPC. Accept only the documented Nile node.
   let node;try{node=new URL(walletWeb(p)?.fullNode?.host);}catch{throw Error('Cannot verify wallet network. Select the Nile node https://nile.trongrid.io in TronLink');}
   if(node.protocol!=='https:'||node.hostname!=='nile.trongrid.io'||node.port)throw Error('Select TRON Nile Testnet (https://nile.trongrid.io) in TronLink');
   chain=NILE_CHAIN;
 }
 if(BigInt(chain)!==BigInt(NILE_CHAIN))throw Error('Select TRON Nile Testnet in TronLink');
 const address=walletWeb(p)?.defaultAddress?.base58;
 if(!address||!await validAddress(address))throw Error('Unlock TronLink and authorize this site');
 if(expected&&address!==expected)throw Error('Wallet account changed; request a fresh quote');return address;
}
const blockedPermitProviders=new WeakSet<object>();
export class PermitTransferUnsupportedError extends Error {
 constructor(){super('TronLink blocked this website’s GasFree PermitTransfer request. No signed permit was submitted to /execute. This wallet needs a supported GasFree signing integration; reconnecting does not remove the restriction.');this.name='PermitTransferUnsupportedError';}
}
export async function signPermit(context:any,sender:string,p=walletProvider()){
 if(blockedPermitProviders.has(p))throw new PermitTransferUnsupportedError();
 await assertWallet(p,sender);
 const web=walletWeb(p);
 if(typeof web?.trx?._signTypedData!=='function')throw Error('This wallet does not support TIP-712 signing');
 let signature;
 try {signature=await web.trx._signTypedData(context.domain,context.types,context.authorization);}
 catch(error){
   const message=typeof error==='string'?error:(error as any)?.message||'';
   if(/permit\s*transfer/i.test(message)&&/third\s*party|not support/i.test(message)){
     blockedPermitProviders.add(p);throw new PermitTransferUnsupportedError();
   }
   throw error;
 }
 await assertWallet(p,sender);
 if(typeof signature!=='string'||!/^(0x)?[a-fA-F0-9]{130}$/.test(signature))throw Error('Wallet returned an invalid signature');return signature;
}
