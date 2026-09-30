import Papa from 'papaparse';
export const TOKEN = 'TXYZopYRdj2D9XRtbG411XZZ3kM5VkAeBf';
export const SENDER = 'TQZE7vxcx9qr6d8BczbYYLwfeHJ5ZbDj7c';
export const MAX_TEST_RECIPIENTS = 20;
export const MAX_TEST_AMOUNT = 1_000_000n;
export const MAX_TEST_BATCH_AMOUNT = 10_000_000n;
export type Mode = 'demo' | 'live';
export type Issue = { code: string; message: string; severity: 'error' | 'warning' };
export type ReviewRow = { id: string; sourceRow: number; reference: string; name: string; address: string; amount: string; atomic: string | null; excluded: boolean; acknowledged: boolean; issues: Issue[]; metadata: Record<string,string> };
export type Quote = { gasFreeFeeCap?:string; customerDebitCap?:string; recipientCount: number; totalAmount: string; estimatedGasFreeFee: string; estimatedRelayerFeeTrx: string; estimatedTotal: string; transactionCount: number };
export type Payment = { paymentId: string; index: number; recipient: string; amount: string; status: string; txId: string | null; errorCode?: string | null; errorMessage?: string | null };
export type Batch = { batchId: string; status: string; totalAmount: string; executorAddress: string; expiry?:number; traceId: string | null; depositTxId: string | null; counts: { total:number; pending:number; submitted:number; success:number; failed:number }; errorMessage?: string | null; refundState?: string | null; refundTxId?:string|null; refundAmount?:string|null };
export type ProgressStage = { key:string; label:string; detail:string; state:'COMPLETE'|'ACTIVE'|'WAITING'|'ATTENTION'|'INVESTIGATING' };
export type BatchProgressView = { batchId:string; status:string; currentStage:string; progressPercent:number; paymentPercent:number; isTerminal:boolean; updatedAt:string; counts:Batch['counts']; stages:ProgressStage[]; evidence:{ providerTrace:boolean; fundingTransaction:boolean; payoutTransactions:number; refundTransaction:boolean } };
export type Reconciliation = { batchId: string; reconciliationStatus: string; reconciledAt: string; token:string; decimals:number; summary: { totalRows:number; excluded:number; payable:number; succeeded:number; failed:number; awaitingConfirmation:number; principalPaid:string; estimatedFeesTotal:string|null; actualFeesTotal:string|null; balanceCheck:{expectedDecrease:string|null;actualDecrease:string|null;difference:string|null;matched:boolean|null;evidenceStatus?:string}; principalCheck?:{recordedPaid:string;onChainPaid:string|null;difference:string|null;matched:boolean|null;error:string|null}; evidence?:{complete:boolean;missing:string[]} }; items: unknown[] };
export const requiredHeaders = ['payment_reference','worker_id','recipient_name','worker_type','country_code','recipient_address','token','amount','pay_period_start','pay_period_end','compensation_type'];
const optionalHeaders = ['project_reference','performance_reference','expected_amount','memo'];
export function atomic(value:string): string | null {
  if (!/^(0|[1-9]\d*)(\.\d{1,6})?$/.test(value)) return null;
  const [whole, fraction = ''] = value.split('.');
  const n = BigInt(whole) * 1000000n + BigInt(fraction.padEnd(6,'0'));
  return n > 0n && n < 2n ** 256n ? n.toString() : null;
}
export function decimal(value:string, trim=true):string {
  const n=BigInt(value); const abs=n<0n?-n:n;
  const f=(abs%1000000n).toString().padStart(6,'0');
  return (n<0n?'-':'')+(abs/1000000n).toLocaleString('en-US')+(trim ? (f.replace(/0+$/,'') ? '.'+f.replace(/0+$/,'') : '') : '.'+f);
}
export function short(value:string|null|undefined) { return value ? value.slice(0,7)+'…'+value.slice(-6) : 'Not available'; }
export async function validAddress(value:string): Promise<boolean> {
  if (!/^T[1-9A-HJ-NP-Za-km-z]{33}$/.test(value)) return false;
  const alphabet='123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz';
  let n=0n; for (const c of value) n=n*58n+BigInt(alphabet.indexOf(c));
  const bytes=new Uint8Array(25); for(let i=24;i>=0;i--){bytes[i]=Number(n&255n);n>>=8n;}
  if(n!==0n || bytes[0]!==65) return false;
  const first=await crypto.subtle.digest('SHA-256',bytes.slice(0,21));
  const hash=new Uint8Array(await crypto.subtle.digest('SHA-256',first));
  return bytes.slice(21).every((v,i)=>v===hash[i]);
}
function validDate(v:string){return /^\d{4}-\d{2}-\d{2}$/.test(v)&&!Number.isNaN(Date.parse(v))&&new Date(v).toISOString().slice(0,10)===v;}
export async function reviewRows(rows:ReviewRow[]):Promise<ReviewRow[]> {
  const references=new Map<string,number>();
  for(const row of rows.filter(r=>!r.excluded)) references.set(row.reference,(references.get(row.reference)||0)+1);
  return Promise.all(rows.map(async row=>{
    const issues:Issue[]=[]; const add=(code:string,message:string,severity:'error'|'warning'='error')=>issues.push({code,message,severity});
    for(const key of requiredHeaders) if(!row.metadata[key]?.trim()) add('MISSING_FIELD',`Missing ${key}`);
    if(!await validAddress(row.address)) add('INVALID_ADDRESS','Invalid TRON address or checksum');
    const amount=atomic(row.amount); if(!amount) add('INVALID_AMOUNT','Use a positive USDT amount with up to 6 decimal places');
    if(amount&&BigInt(amount)>MAX_TEST_AMOUNT) add('TEST_AMOUNT_LIMIT','Test mode allows up to 1 USDT per recipient');
    if(row.metadata.token!=='USDT') add('UNSUPPORTED_TOKEN','Only Nile USDT is supported');
    if(!['EMPLOYEE','FREELANCER'].includes(row.metadata.worker_type)) add('WORKER_TYPE','Unknown worker type');
    if(!/^[A-Z]{2}$/.test(row.metadata.country_code)) add('COUNTRY_CODE','Use a two-letter country code');
    if(!validDate(row.metadata.pay_period_start)||!validDate(row.metadata.pay_period_end)||row.metadata.pay_period_end<row.metadata.pay_period_start) add('PAY_PERIOD','Invalid payment period');
    if(!['SALARY','CONTRACT_FEE','BONUS','COMMISSION','OTHER'].includes(row.metadata.compensation_type)) add('COMPENSATION_TYPE','Unknown compensation type');
    if(row.metadata.compensation_type==='OTHER'&&!row.metadata.memo) add('MEMO_REQUIRED','Add a memo for OTHER compensation');
    if((references.get(row.reference)||0)>1) add('DUPLICATE_REFERENCE','Repeated payment reference in this file','warning');
    if(row.metadata.expected_amount){const expected=atomic(row.metadata.expected_amount); if(!expected)add('EXPECTED_AMOUNT','Invalid expected amount'); else if(amount&&amount!==expected)add('UNEXPECTED_AMOUNT','Amount differs from the expected amount','warning');}
    return {...row,atomic:amount,issues};
  }));
}
export async function parseCsv(text:string):Promise<ReviewRow[]> {
  const parsed=Papa.parse<string[]>(text.replace(/^\uFEFF/,''),{skipEmptyLines:'greedy'});
  if(parsed.errors.length) throw Error('CSV could not be read: '+parsed.errors[0].message);
  const [rawHeaders,...records]=parsed.data; if(!rawHeaders) throw Error('The file is empty');
  const headers=rawHeaders.map(x=>x.trim());
  if(new Set(headers).size!==headers.length) throw Error('Duplicate CSV headers');
  const missing=requiredHeaders.filter(h=>!headers.includes(h)); if(missing.length)throw Error('Missing columns: '+missing.join(', '));
  const unknown=headers.filter(h=>!requiredHeaders.includes(h)&&!optionalHeaders.includes(h));if(unknown.length)throw Error('Unknown columns: '+unknown.join(', '));
  if(records.length===0||records.length>MAX_TEST_RECIPIENTS)throw Error(`Test CSV must contain 1–${MAX_TEST_RECIPIENTS} records`);
  const rows=records.map((cells,i)=>{
    if(cells.length!==headers.length)throw Error(`Record ${i+1} has ${cells.length} fields; expected ${headers.length}`);
    const metadata=Object.fromEntries(headers.map((h,j)=>[h,cells[j].trim()]));
    return {id:`row-${i+1}`,sourceRow:i+1,reference:metadata.payment_reference,name:metadata.recipient_name,address:metadata.recipient_address,amount:metadata.amount,atomic:null,excluded:false,acknowledged:false,issues:[],metadata} as ReviewRow;
  });
  return reviewRows(rows);
}
export function rowState(r:ReviewRow){ return r.excluded?'excluded':r.issues.some(i=>i.severity==='error')?'error':r.issues.length&&!r.acknowledged?'warning':'ready'; }
export function payable(rows:ReviewRow[]){return rows.filter(r=>rowState(r)==='ready');}
export function sum(rows:ReviewRow[]){return rows.reduce((n,r)=>n+BigInt(r.atomic||'0'),0n).toString();}
export function exportCsv(records:Record<string,unknown>[]):string {return Papa.unparse(records,{escapeFormulae:true});}
export function sampleCsv(){return Papa.unparse([
  {payment_reference:'TEST-NILE-001',worker_id:'W001',recipient_name:'Test recipient 1',worker_type:'EMPLOYEE',country_code:'KR',recipient_address:SENDER,token:'USDT',amount:'0.01',pay_period_start:'2026-09-01',pay_period_end:'2026-09-30',compensation_type:'OTHER',expected_amount:'0.01',memo:'Small Nile test payment'},
  {payment_reference:'TEST-NILE-002',worker_id:'W002',recipient_name:'Test recipient 2',worker_type:'FREELANCER',country_code:'KR',recipient_address:SENDER,token:'USDT',amount:'0.02',pay_period_start:'2026-09-01',pay_period_end:'2026-09-30',compensation_type:'OTHER',expected_amount:'0.02',memo:'Small Nile test payment'},
  {payment_reference:'TEST-NILE-003',worker_id:'W003',recipient_name:'Test recipient 3',worker_type:'EMPLOYEE',country_code:'KR',recipient_address:SENDER,token:'USDT',amount:'0.03',pay_period_start:'2026-09-01',pay_period_end:'2026-09-30',compensation_type:'OTHER',expected_amount:'0.03',memo:'Small Nile test payment'},
]);}
