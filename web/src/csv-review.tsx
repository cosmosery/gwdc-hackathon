import { useState } from 'react';
import { atomic, decimal, rowState, type ReviewRow } from './domain';
import './csv-review.css';

export function reviewEvidence(row:ReviewRow, rows:ReviewRow[]) {
  const evidence=row.issues.map(issue=>({label:issue.code==='UNEXPECTED_AMOUNT'?'Amount difference':issue.code==='DUPLICATE_REFERENCE'?'Repeated reference':issue.code==='INVALID_ADDRESS'?'Address check':'Validation check',detail:issue.message}));
  const actual=atomic(row.amount),expected=atomic(row.metadata.expected_amount||'');
  if(actual&&expected&&actual!==expected){
    const delta=BigInt(actual)-BigInt(expected);
    const item=evidence.find(e=>e.label==='Amount difference');
    if(item)item.detail=`Entered ${decimal(actual)} USDT; expected ${decimal(expected)} USDT. Difference: ${delta>0n?'+':''}${decimal(delta.toString())} USDT.`;
  }
  const duplicate=evidence.find(e=>e.label==='Repeated reference');
  if(duplicate)duplicate.detail=`Reference “${row.reference}” appears in records ${rows.filter(r=>!r.excluded&&r.reference===row.reference).map(r=>r.sourceRow).join(', ')}. Confirm whether these are separate payments.`;
  return evidence;
}

export function CsvReview({rows,onReview}:{rows:ReviewRow[];onReview:(row:ReviewRow)=>void}) {
  const [view,setView]=useState<'attention'|'all'>('attention');
  const [expanded,setExpanded]=useState(false);
  const active=rows.filter(r=>!r.excluded);
  const blocked=active.filter(r=>rowState(r)==='error').length;
  const pending=active.filter(r=>rowState(r)==='warning').length;
  const ready=active.filter(r=>rowState(r)==='ready').length;
  const flagged=blocked+pending;
  const visible=view==='attention'&&flagged?active.filter(r=>['error','warning'].includes(rowState(r))):rows;
  if(!rows.length)return null;
  return <section className="csv-review" aria-label="CSV review">
    <button type="button" className="csv-review-toggle" aria-expanded={expanded} onClick={()=>setExpanded(!expanded)}>
      <strong>CSV review</strong><span className={flagged?'csv-review-attention':''}>{flagged?`${blocked} to correct · ${pending} to confirm`:'No unresolved issues'}</span><span>{ready} ready · {rows.length-active.length} excluded</span><span className="csv-review-toggle-action">{expanded?'Hide details ↑':'View checks ↓'}</span>
    </button>
    {expanded&&<>
    <header className="csv-review-heading"><div><span className="editorial-label">CSV REVIEW</span><h2>{flagged?`${flagged} ${flagged===1?'record needs':'records need'} your attention.`:active.length?'Your list has been checked.':'All records are excluded.'}</h2><p>{flagged?'Review the evidence below before calculating fees.':active.length?'No unresolved validation issues. Review the details, then calculate fees.':'Restore a record to prepare a payment.'}</p></div><span className="csv-review-source">Based on this file</span></header>
    <div className="csv-review-summary" aria-live="polite"><span><b>{blocked}</b> to correct</span><span><b>{pending}</b> to confirm</span><span><b>{ready}</b> ready</span><span><b>{rows.length-active.length}</b> excluded</span></div>
    <div className="csv-review-controls"><p>Addresses, payment references, amounts and required fields checked.</p><button type="button" className="text-button" onClick={()=>setView(view==='all'?'attention':'all')}>{view==='all'?'Focus on unresolved records':'Show all records'}</button></div>
    <div className="csv-review-records">{visible.map(row=>{
      const state=rowState(row),evidence=reviewEvidence(row,rows);
      const title=state==='excluded'?'Excluded from this batch':state==='error'?'Correct this record':state==='warning'?'Confirm before including':row.acknowledged&&evidence.length?'Warning confirmed by you':'No validation issues found';
      return <article key={row.id} className={`csv-review-record ${state}`}>
        <div className="csv-review-record-heading"><span className="csv-record-index">{String(row.sourceRow).padStart(2,'0')}</span><div><h3>{row.name||'Unnamed recipient'}</h3><p>{row.reference} · {row.atomic?decimal(row.atomic):row.amount} USDT</p></div><span className="csv-review-outcome">{title}</span></div>
        <p className="csv-review-reason">{state==='error'?'This record cannot enter the payable list until its errors are fixed or it is excluded.':state==='warning'?'Check the source payment instruction, then confirm, correct or exclude this record.':state==='excluded'?'This record is outside the current payable list.':row.acknowledged&&evidence.length?'Your confirmation allows this record into the payable list. The original warning remains visible below.':'The supplied fields pass the current checks. This does not verify the recipient’s identity or authorize a payment.'}</p>
        <details><summary>View evidence and business note{evidence.length?` (${evidence.length} ${evidence.length===1?'finding':'findings'})`:''}</summary><dl>{evidence.map((e,i)=><div key={i}><dt>{e.label}</dt><dd>{e.detail}</dd></div>)}<div><dt>Expected amount</dt><dd>{row.metadata.expected_amount?`${row.metadata.expected_amount} USDT`:'Not provided; no expected-amount comparison was possible.'}</dd></div><div><dt>Business note</dt><dd className="csv-review-memo">{row.metadata.memo||'No business note provided.'}</dd></div><div><dt>Payment period</dt><dd>{row.metadata.pay_period_start} — {row.metadata.pay_period_end}</dd></div></dl><p className="csv-review-evidence-note">Business notes are shown as supplied. They do not confirm the payment amount.</p></details>
        <button type="button" className="underlined-link" onClick={()=>onReview(row)}>{state==='error'?'Correct record':state==='warning'?'Review decision':state==='excluded'?'Review excluded record':'Open record'} ↗</button>
      </article>;
    })}</div>
    <p className="csv-review-boundary">You decide what to include. Reviewing this file does not sign or send a payment.</p>
    </>}
  </section>;
}
