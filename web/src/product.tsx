import { useState, type ReactNode } from 'react';
import type { Batch, BatchProgressView, Mode, ReviewRow } from './domain';
import { decimal, rowState, sum } from './domain';
import { CsvReview } from "./csv-review";
import { StatusBadge } from './design-system';

type DashboardProps = {
  mode:Mode; rows:ReviewRow[]; batch:Batch|null; progress:BatchProgressView|null;
  onCreate:()=>void; onReview:()=>void; onActivity:()=>void; onResults:()=>void; onLoadSample:()=>void;
};

export function OperationsDashboard({mode,rows,batch,progress,onCreate,onReview,onActivity,onResults,onLoadSample}:DashboardProps){
  const ready=rows.filter(row=>rowState(row)==='ready');
  const attention=rows.filter(row=>['error','warning'].includes(rowState(row))).length;
  const complete=batch?.status==='SUCCESS';
  const count=batch?.counts.total||ready.length;
  const amount=batch?.totalAmount||sum(ready);
  return <div className="client-home">
    <section className="home-intro"><div><span className="editorial-label">YOUR PAYMENT WORKSPACE</span><h1>Good work deserves<br/><em>a great payday.</em></h1><p>From the first name on your list to the last payment received.</p><button className="button" onClick={onCreate}>Create a payment batch <span>↗</span></button></div><div className="payday-art" aria-hidden="true"><div className="art-orbit orbit-one"/><div className="art-orbit orbit-two"/><span className="art-label">A LITTLE LESS ADMIN.</span><div className="art-ticket"><span className="ticket-brand">Settle.</span><div className="ticket-check">✓</div><strong>Made someone's<br/>payday.</strong><div className="ticket-rule"/><small>FROM YOUR LIST. TO THEIR WALLET.</small></div><span className="art-stamp">ALL TOGETHER<br/>ALL ACCOUNTED FOR</span></div></section>
    <div className="home-section-title"><h2>Your workspace</h2><span>{mode==='demo'?'Demo workspace':'Nile testnet'}</span></div>
    <div className="home-cards"><section className="home-payment"><span className="editorial-label">{batch?'LATEST PAYMENT':'YOUR NEXT PAYMENT'}</span><div className="home-amount">{count?decimal(amount):'—'} <span>USDT</span></div><p>{batch?`${batch.counts.success} of ${count} recipients paid`:ready.length?`${ready.length} recipients ready for review`:'A fresh start for your next payment list.'}</p><div className="home-payment-bottom"><span className={'payment-pill '+(complete?'paid':'')}>{batch?(complete?'✓ Payment delivered':batch.status==='REFUNDED'?'↩ Remaining funds returned':batch.status==='FAILED'?'Needs attention':batch.status==='READY'?'Prepared · not sent':'◷ Payment in progress'):'Ready when you are'}</span><button className="circle-link" aria-label={batch?'Track latest payment':'Start a payment'} onClick={batch?onActivity:onCreate}>↗</button></div></section>
    <section className="home-review"><span className="editorial-label">A SECOND PAIR OF EYES</span><h3>{attention?<>A few details<br/>need your attention.</>:<>A clearer list.<br/>A calmer payday.</>}</h3><p>{attention?`${attention} records need a closer look before you pay.`:'Catch address errors and amount differences before they become payment problems.'}</p><button className="underlined-link" onClick={rows.length?onReview:mode==='demo'?onLoadSample:onCreate}>{attention?'Review payment list':mode==='demo'&&!rows.length?'Explore a sample list':'Prepare your list'} <span>↗</span></button><span className="review-flower" aria-hidden="true">✳</span></section></div>
    <section className="home-history"><div className="home-section-title"><h2>Latest batch</h2>{batch&&<button className="underlined-link" onClick={onResults}>View report ↗</button>}</div>{batch?<button className="history-entry" onClick={onActivity}><span className="history-icon">↗</span><span><strong>Team payment</strong><small>{count} {count===1?'recipient':'recipients'} · USDT</small></span><span className="history-amount">{decimal(amount)} <small>USDT</small></span><StatusBadge status={batch.status}/><span>→</span></button>:<div className="home-history-empty"><span>↗</span><div><strong>Your payment history starts here.</strong><p>Each batch becomes one clear record of who was paid.</p></div></div>}</section>
  </div>;
}

export function DecisionCenter({rows,onReview}:{rows:ReviewRow[];mode:Mode;onReview:(row:ReviewRow)=>void}){
  return <CsvReview rows={rows} onReview={onReview}/>;
}

type ProgressProps = {amount:string; mode:Mode; progress:BatchProgressView|null; status:string; funded?:boolean; success:number; failed:number; pending:number; children:{recipients:ReactNode;evidence:ReactNode};};

export function BatchOperations({amount,mode,progress,status,funded=false,success,failed,pending,children}:ProgressProps){
  const [tab,setTab]=useState<'progress'|'recipients'>('progress');
  const total=success+failed+pending;
  const demoStages:BatchProgressView['stages']=[
    {key:'prepared',label:'Batch prepared',detail:'Recipients and amounts committed',state:'COMPLETE'},
    {key:'authorization',label:'Authorization submitted',detail:'Demo approval recorded; no signature sent',state:'COMPLETE'},
    {key:'funding',label:'GasFree funding',detail:'Simulated provider stage',state:status==='SUBMISSION_UNKNOWN'?'INVESTIGATING':'COMPLETE'},
    {key:'executor',label:'Executor ready',detail:'Simulated deployment stage',state:status==='SUBMISSION_UNKNOWN'?'WAITING':'COMPLETE'},
    {key:'payouts',label:'Recipient payouts',detail:`${success+failed} of ${total} rows final`,state:pending?'ACTIVE':failed?'ATTENTION':'COMPLETE'},
    {key:'reconciliation',label:'Results available',detail:'Export and reconciliation',state:pending?'WAITING':failed?'ATTENTION':'COMPLETE'}
  ];
  const stages=progress?.stages||(mode==='demo'?demoStages:demoStages.map(stage=>({...stage,state:'WAITING' as const})));
  const pct=progress?.paymentPercent??(total?Math.floor((success+failed)/total*100):0);
  if(mode==='live'&&(!progress||status==='READY'))return <><section className="not-started"><span>○</span><h2>{status==='READY'?(funded?'Batch funded; payouts have not started':'Payment has not started'):'Loading payment status…'}</h2><p>{status==='READY'?(funded?'Nile confirms the full amount at this Executor. The engine must resume the batch before recipients are paid.':'This batch is waiting for a verified Nile USDT deposit at its Executor address. Payouts have not started.'):'Checking the saved batch. No outcome is assumed while the status loads.'}</p></section>{status==='READY'&&funded&&children.recipients}</>;
  return <div className="batch-operations">
    <nav className="operation-tabs" aria-label="Payment details" role="tablist">{([['progress','Payment status'],['recipients','Recipient results']] as const).map(([key,label])=><button role="tab" aria-selected={tab===key} aria-controls={`payment-panel-${key}`} id={`payment-tab-${key}`} key={key} className={tab===key?'active':''} onClick={()=>setTab(key)}>{label}{key==='recipients'&&<span>{total}</span>}</button>)}</nav>
    {tab==='progress'&&<div className="payment-story" role="tabpanel" id="payment-panel-progress" aria-labelledby="payment-tab-progress">
      <section className={'payment-hero '+(status==='SUCCESS'?'is-delivered':'')}>
        <div className="payment-hero-copy"><span className="editorial-label">{mode==='demo'?'DEMO PAYMENT':'TEAM PAYMENT'}</span><h2>{status==='SUCCESS'?<>A payday.<br/><em>Made.</em></>:status==='REFUNDED'?<>Returned.<br/><em>Accounted for.</em></>:status==='FAILED'?<>Let’s get this<br/><em>resolved.</em></>:status==='SUBMISSION_UNKNOWN'?<>We’re checking<br/><em>your payment.</em></>:failed?<>Mostly there.<br/><em>A little to resolve.</em></>:<>On its way.<br/><em>Every step of it.</em></>}</h2><p>{status==='SUCCESS'?`${total===1?'Your recipient has':`All ${total} recipients have`} received their payment.`:status==='REFUNDED'?'The remaining funds have been returned. Open the report for the refund record.':status==='FAILED'?'This batch needs attention. Review the payment details for the recorded reason.':status==='SUBMISSION_UNKNOWN'?'The submission needs confirmation. Keep this batch open while its outcome is checked.':`${success} paid, ${pending} awaiting confirmation${failed?`, ${failed} need attention`:''}.`}</p><button className="underlined-link" onClick={()=>setTab('recipients')}>See recipient details <span>↗</span></button></div>
        <div className="payment-receipt"><div className="receipt-top"><span>Settle.</span><span className="receipt-symbol">{status==='SUCCESS'?'✓':'↗'}</span></div><span className="editorial-label">BATCH TOTAL</span><div className="receipt-amount">{decimal(amount)}<span>USDT</span></div><div className="receipt-divider"/><div className="receipt-line"><span>Recipients</span><strong>{total}</strong></div><div className="receipt-line"><span>Delivered</span><strong>{success} / {total}</strong></div><div className="receipt-line"><span>Payment status</span><strong>{status==='SUCCESS'?'Delivered':status==='REFUNDED'?'Refunded':status==='FAILED'?'Needs attention':status==='SUBMISSION_UNKNOWN'?'Checking':failed?'Needs attention':'In progress'}</strong></div><div className="receipt-bottom"><i/><span>{mode==='demo'?'SAMPLE RECEIPT · NO FUNDS SENT':'NILE TESTNET · PAYMENT RECORD'}</span><i/></div></div>
      </section>
      <section className="payment-journey"><div className="journey-heading"><div><span className="editorial-label">FROM YOU TO THEM</span><h3>The journey of your payment</h3></div><span className="journey-percent">{mode==='live'&&!progress?'Awaiting update':`${pct}%`}<small>recipient outcomes final</small></span></div><div className="journey-steps">{[{label:'List prepared',detail:'Every recipient accounted for',stage:stages[0]},{label:'Funding confirmed',detail:'Nile Executor balance verified',stage:stages[2]},{label:'Payouts submitted',detail:'Engine sends each recipient payment',stage:stages[3]},{label:'Payday delivered',detail:`${success} of ${total} recipients paid`,stage:stages[4]}].map((item,index)=><div key={item.label} className={'journey-step '+item.stage?.state.toLowerCase()}><span className="journey-node">{item.stage?.state==='COMPLETE'?'✓':String(index+1).padStart(2,'0')}</span><strong>{item.label}</strong><small>{item.detail}</small></div>)}</div></section>
      {(pending>0||failed>0)&&<div className="payment-followup"><span>◷</span><div><strong>{failed?'Some payments need a closer look.':'We’ll keep the status up to date.'}</strong><p>{failed?'Open recipient details to see the outcome of each payment.':'Payments can arrive at different times. Confirmed payments stay confirmed.'}</p></div><button className="underlined-link" onClick={()=>setTab('recipients')}>View recipients ↗</button></div>}
    </div>}

    {tab==='recipients'&&<div role="tabpanel" id="payment-panel-recipients" aria-labelledby="payment-tab-recipients">{children.recipients}</div>}
    <details className="transaction-details"><summary>Transaction details & activity</summary>{children.evidence}<section className="activity-feed">{stages.map(stage=><div className="activity-item" key={stage.key}><span className={`activity-dot ${stage.state.toLowerCase()}`}/><div><strong>{stage.label}</strong><p>{stage.detail}</p></div><StatusBadge status={stage.state}/></div>)}</section></details>
  </div>;
}
