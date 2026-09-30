import type { ReactNode } from 'react';

export type StatusTone = 'success' | 'progress' | 'unknown' | 'action' | 'failure' | 'excluded';

const SUCCESS = new Set(['READY', 'SUCCESS', 'SUCCEEDED', 'CONFIRMED', 'FINAL', 'COMPLETE', 'VERIFIED_TRACKED_FEES']);
const FAILURE = new Set(['FAILED', 'ERROR', 'INVALID', 'MISMATCH', 'CANCELLED']);
const UNKNOWN = new Set(['UNKNOWN', 'SUBMISSION_UNKNOWN', 'OUTCOME_UNKNOWN', 'EVIDENCE_PENDING']);
const ACTION = new Set(['REQUIRES_ACTION', 'PARTIAL', 'PARTIAL_SUCCESS', 'NEEDS_REVIEW', 'REFUND_PENDING']);
const EXCLUDED = new Set(['EXCLUDED', 'UNPAID_BATCH_REFUNDED']);

export function describeStatus(value: string): { tone: StatusTone; label: string } {
  const key = value.trim().replaceAll(/[^a-zA-Z0-9]+/g, '_').toUpperCase();
  if (SUCCESS.has(key)) return { tone: 'success', label: key === 'READY' ? 'Ready' : key === 'COMPLETE' ? 'Complete' : key === 'CONFIRMED' ? 'Confirmed' : key === 'FINAL' ? 'Final' : key === 'VERIFIED_TRACKED_FEES' ? 'Verified tracked fees' : 'Succeeded' };
  if (FAILURE.has(key) || key.startsWith('INVALID')) return { tone: 'failure', label: key === 'MISMATCH' ? 'Mismatch — review' : key === 'FAILED' ? 'Failed' : 'Invalid' };
  if (UNKNOWN.has(key) || key.includes('UNKNOWN') || key.includes('EVIDENCE_PENDING')) return { tone: 'unknown', label: key.includes('EVIDENCE') ? 'Evidence pending' : 'Investigating' };
  if (ACTION.has(key) || key.includes('REVIEW') || key.includes('WARNING') || key.includes('LOW')) return { tone: 'action', label: key === 'PARTIAL' ? 'Partial' : key === 'PARTIAL_SUCCESS' ? 'Partially settled' : key === 'REFUND_PENDING' ? 'Refund pending' : 'Action required' };
  if (EXCLUDED.has(key) || key.includes('REFUNDED')) return { tone: 'excluded', label: key.includes('REFUNDED') ? 'Unpaid · batch refunded' : 'Excluded' };
  const label = key.toLowerCase().replaceAll('_', ' ').replace(/^./, character => character.toUpperCase());
  return { tone: 'progress', label };
}

export function StatusBadge({ status }: { status: string }) {
  const descriptor = describeStatus(status);
  return <span className={`st-badge st-badge--${descriptor.tone}`} data-status={status}>{descriptor.label}</span>;
}

export function Kpi({ label, value, meta, tone }: { label: string; value: string; meta: ReactNode; tone?: StatusTone }) {
  return <div className="st-kpi" role="listitem"><div className="st-kpi__label">{label}</div><div className="st-kpi__value" style={tone ? { color: `var(--status-${tone})` } : undefined}>{value}</div><div className="st-kpi__meta">{meta}</div></div>;
}

export function BatchProgress({ success, failed, pending }: { success: number; failed: number; pending: number }) {
  const total = success + failed + pending;
  const final = success + failed;
  const pct = total ? Math.floor(final / total * 100) : 0;
  const segment = (count: number) => `${total ? count / total * 100 : 0}%`;
  return <section className="st-card st-progress-card" aria-label="Batch settlement progress">
    <div className="st-progress-head"><strong>Settling {total} payments</strong><span>{pct}% final</span></div>
    <div className="st-progress" role="progressbar" aria-valuemin={0} aria-valuemax={100} aria-valuenow={pct}>
      {success > 0 && <span className="is-success" style={{ width: segment(success) }}/>} 
      {failed > 0 && <span className="is-failure" style={{ width: segment(failed) }}/>} 
      {pending > 0 && <span className="is-progress" style={{ width: segment(pending) }}/>} 
    </div>
    <div className="st-legend"><span><i className="is-success"/>Succeeded <b>{success}</b></span><span><i className="is-progress"/>In flight <b>{pending}</b></span><span><i className="is-failure"/>Failed <b>{failed}</b></span></div>
  </section>;
}
