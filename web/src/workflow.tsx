import type { Mode } from './domain';

export function workflowState(step:number, imported:boolean, status:string, mode:Mode, signingPhase:string, funded=false){
  if(step===0)return {index:imported?1:0,title:imported?'CSV checked. Payment not sent.':'Upload your payment list.',detail:imported?'Resolve the flagged recipients, then calculate fees. Uploading a file does not send money.':'Use your existing GasFree USDT: upload → review → estimate fees → fund the vault → track payouts.',tone:'draft'};
  if(step===1)return {index:2,title:'Fees calculated. Payment not sent.',detail:'Review recipients and estimated fees, then transfer manually in TronLink → GasFree → Send. Start payouts after the deposit is confirmed.',tone:'draft'};
  if(step===5)return {index:signingPhase==='funded'?4:3,title:signingPhase==='preparing'?'Preparing your batch address…':signingPhase==='sending'?'Starting automatic payouts…':signingPhase==='funded'?'Batch funded on Nile.':'Send USDT from GasFree to your batch vault.',detail:signingPhase==='funded'?'Nile confirms the full recipient total at the batch address. You can now ask the engine to distribute it.':'Open TronLink → GasFree → Send. Approve the vault deposit from your existing GasFree USDT balance.',tone:signingPhase==='funded'?'success':'draft'};
  if(mode==='demo')return {index:step===3?5:4,title:'Demo run · no real payment was sent.',detail:'These outcomes are simulated. Switch to Live API to submit a wallet-authorized payment.',tone:'demo'};
  if(status==='SUCCESS')return {index:5,title:'Payment confirmed. All recipients paid.',detail:'This result belongs to the batch shown below, not to a newly uploaded file.',tone:'success'};
  if(status==='READY')return funded?{index:4,title:'Batch funded on Nile. Payouts have not started.',detail:'The Executor holds the full amount. Ask the engine to start payouts for this batch after reviewing its recipients.',tone:'attention'}:{index:3,title:'Waiting for the batch transfer.',detail:'The Executor has not received the full amount on Nile. Payouts have not started.',tone:'draft'};
  if(status==='PAYOUT_PENDING')return {index:4,title:'Engine is paying recipients.',detail:'The engine tracks each recipient transaction on Nile. Confirmation may take several minutes.',tone:'pending'};
  if(status==='SUBMISSION_UNKNOWN')return {index:4,title:'Submission outcome is still being checked.',detail:'The request may have reached the provider. Do not submit a second copy.',tone:'pending'};
  if(status==='FAILED')return {index:4,title:'Payment needs attention.',detail:'Open recipient results for confirmed failures and unresolved payments.',tone:'attention'};
  if(status==='REFUNDED')return {index:5,title:'Remaining funds returned.',detail:'Open the report to review payments and the refund transaction.',tone:'success'};
  if(signingPhase==='sending')return {index:4,title:'Engine is checking this funded batch…',detail:'Recipient payouts are tracked only when the engine records them.',tone:'pending'};
  if(status==='Not loaded')return {index:4,title:'Checking this batch’s execution status…',detail:'Waiting for the engine. No successful payment is assumed.',tone:'pending'};
  return {index:4,title:status==='PARTIAL_SUCCESS'?'Some recipients are paid; others need attention.':'Payment submitted. Waiting for confirmation.',detail:'Individual recipients are marked paid only after the engine confirms them.',tone:'pending'};
}

export function WorkflowGuide(props:{step:number;imported:boolean;status:string;mode:Mode;signingPhase:string;batchId:string;funded?:boolean}){
  const state=workflowState(props.step,props.imported,props.status,props.mode,props.signingPhase,props.funded);
  return <section className={'workflow-guide '+state.tone} aria-label="Current payment step">
    <ol className="workflow-track">{['Upload CSV','Review list','Calculate fees','GasFree deposit','Automatic payouts','Results'].map((label,index)=><li key={label} aria-current={index===state.index?'step':undefined} className={index===state.index?'current':index<state.index?'past':''}><span>{index+1}</span>{label}</li>)}</ol>
    <div className="workflow-message" role="status"><span className="workflow-state-icon">{state.tone==='success'?'✓':state.tone==='draft'?'○':'◷'}</span><div><strong>{state.title}</strong><p>{state.detail}</p>{props.step!==0&&props.step!==1&&props.step!==5&&props.mode==='live'&&props.batchId&&<small>Viewing batch <code>{props.batchId}</code></small>}</div></div>
  </section>;
}
