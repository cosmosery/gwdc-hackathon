/**
 * Reconciler Module
 * Generates evidence-qualified reconciliation reports comparing internal
 * records against on-chain balances and GasFree fees.
 */

const { checkPaidAmount } = require('./tron.cjs');

function toFixed6Decimals(val) {
  if (val === null || val === undefined) return null;
  const big = BigInt(val);
  const sign = big < 0n ? '-' : '';
  const abs = big < 0n ? -big : big;
  const str = abs.toString().padStart(7, '0');
  const integerPart = str.slice(0, -6) || '0';
  const decimalPart = str.slice(-6);
  return `${sign}${integerPart}.${decimalPart}`;
}

async function buildReconciliationReport({ db, batchId, relayerWeb }) {
  const batch = db.getBatch(batchId);
  if (!batch) return null;

  const payments = db.getPayments(batchId);
  const totalRows = payments.length;

  let excluded = 0;
  let succeeded = 0;
  let failed = 0;
  let awaitingConfirmation = 0;
  let principalPaidBig = 0n;

  for (const p of payments) {
    if (p.status === 'EXCLUDED') {
      excluded++;
    } else if (p.status === 'CONFIRMED' || p.status === 'SUCCEEDED') {
      succeeded++;
      principalPaidBig += BigInt(p.amount);
    } else if (p.status === 'FAILED' || p.status === 'REJECTED') {
      failed++;
    } else {
      awaitingConfirmation++;
    }
  }

  const payable = totalRows - excluded;

  // A missing actual fee is unknown, never an estimate or a synthetic default.
  let actualFeesTotalBig = null;
  let estimatedFeesTotalBig = null;
  try {
    const raw = JSON.parse(batch.provider_raw_response || '{}');
    const amount = value => (typeof value === 'string' && /^\d+$/.test(value)) ||
      (typeof value === 'number' && Number.isSafeInteger(value) && value >= 0)
      ? BigInt(value) : null;
    actualFeesTotalBig = amount(raw.txnTotalFee);
    estimatedFeesTotalBig = amount(raw.estimatedTotalFee);
  } catch (_) {}

  let onChainPaidAmount = null;
  let chainError = null;
  if (relayerWeb && batch.executor_address) {
    try { onChainPaidAmount = await checkPaidAmount(relayerWeb, batch.executor_address); }
    catch (_) { chainError = 'Confirmed chain payment evidence unavailable'; }
  } else { chainError = 'Chain reader unavailable'; }
  const principalDifference = onChainPaidAmount === null ? null : onChainPaidAmount - principalPaidBig;
  // FINAL is reserved for independent balance snapshots and verified fee evidence.
  // Neither is persisted by this version; successful payout alone is not FINAL.
  const reconciliationStatus = principalDifference !== null && principalDifference !== 0n ? 'MISMATCH' : 'PARTIAL';
  const nowIso = new Date().toISOString();
  const eligible = payments.filter(p => p.status !== 'EXCLUDED');
  const positions = new Map(eligible.map((p, i) => [p.id, i]));
  function allocate(total, payment) {
    if (total === null || !positions.has(payment.id) || !eligible.length) return null;
    const count = BigInt(eligible.length);
    return total / count + (BigInt(positions.get(payment.id)) < total % count ? 1n : 0n);
  }

  const items = payments.map(p => {
    let statusGroup = 'awaiting_confirmation';
    if (p.status === 'CONFIRMED' || p.status === 'SUCCEEDED') {
      statusGroup = 'success';
    } else if (p.status === 'FAILED' || p.status === 'REJECTED') {
      statusGroup = 'failure';
    } else if (p.status === 'EXCLUDED') {
      statusGroup = 'excluded';
    }

    const txHash = p.tx_id || null;
    const explorerUrl = txHash ? `https://nile.tronscan.org/#/transaction/${txHash}` : null;

    return {
      rowId: p.idx,
      refId: p.ref_id || null,
      payeeName: p.payee_name || null,
      address: p.recipient,
      amount: toFixed6Decimals(p.amount),
      memo: p.memo || null,
      originalAmount: p.original_amount ? toFixed6Decimals(p.original_amount) : null,
      status: p.status,
      statusGroup,
      traceId: batch.trace_id || null,
      txHash,
      explorerUrl,
      estimatedFee: toFixed6Decimals(allocate(estimatedFeesTotalBig, p)),
      actualFee: toFixed6Decimals(allocate(actualFeesTotalBig, p)),
      feeAllocationBasis: 'BATCH_FUNDING_FEE_EQUAL_BY_PAYABLE_ROW',
      failureReason: p.failure_reason || null,
      failureMessage: p.error_message || null,
      failureCategory: p.failure_category || null,
      nextAction: p.next_action || null,
      attempts: p.attempts || 1,
      submittedAt: p.submitted_at ? new Date(p.submitted_at).toISOString() : null,
      finalizedAt: p.finalized_at ? new Date(p.finalized_at).toISOString() : (statusGroup === 'success' ? (p.updated_at ? new Date(p.updated_at).toISOString() : nowIso) : null)
    };
  });

  // Tripartite Checks
  // Check 1: CSV vs DB Ledger Integrity
  const check1_ledgerIntegrity = {
    name: 'Check 1: CSV vs DB Ledger Integrity',
    csvRecipientCount: batch.recipient_count,
    dbPaymentRows: totalRows,
    merkleRoot: batch.merkle_root,
    matched: totalRows === batch.recipient_count
  };

  // Check 2: DB vs On-Chain Bitmap & Paid Amount
  const check2_onchainBitmap = {
    name: 'Check 2: DB vs On-Chain Execution',
    dbSucceededCount: succeeded,
    dbPrincipalPaid: toFixed6Decimals(principalPaidBig),
    onChainPaidAmount: toFixed6Decimals(onChainPaidAmount),
    contractAddress: batch.executor_address,
    matched: onChainPaidAmount === null ? null : principalPaidBig === onChainPaidAmount
  };

  // Check 3: Tripartite Balance and Fee Verification
  const check3_balanceAndFees = {
    name: 'Check 3: Tripartite Balance and Fee Verification',
    expectedDecrease: null,
    actualDecrease: null,
    difference: null,
    matched: null,
    evidenceStatus: 'UNAVAILABLE',
    reason: 'Independent balance snapshots and verified fees are not recorded'
  };

  const allChecksPassed = check1_ledgerIntegrity.matched && check2_onchainBitmap.matched && check3_balanceAndFees.matched === true;

  return {
    batchId,
    reconciliationStatus,
    reconciledAt: nowIso,
    token: 'USDT',
    decimals: 6,
    threeWayAudit: {
      check1_ledgerIntegrity,
      check2_onchainBitmap,
      check3_balanceAndFees,
      allChecksPassed
    },
    summary: {
      totalRows,
      excluded,
      payable,
      succeeded,
      failed,
      awaitingConfirmation,
      principalPaid: toFixed6Decimals(principalPaidBig),
      estimatedFeesTotal: toFixed6Decimals(estimatedFeesTotalBig),
      actualFeesTotal: toFixed6Decimals(actualFeesTotalBig),
      actualFeeSource: actualFeesTotalBig === null ? null : 'PROVIDER_REPORTED_UNVERIFIED',
      principalCheck: {
        recordedPaid: toFixed6Decimals(principalPaidBig),
        onChainPaid: toFixed6Decimals(onChainPaidAmount),
        difference: toFixed6Decimals(principalDifference),
        matched: principalDifference === null ? null : principalDifference === 0n,
        error: chainError
      },
      balanceCheck: {
        expectedDecrease: null, actualDecrease: null, difference: null, matched: null,
        evidenceStatus: 'UNAVAILABLE',
        reason: 'Independent before/after balance snapshots are not recorded'
      },
      evidence: { complete: false, missing: [
        'INDEPENDENT_BALANCE_SNAPSHOTS', 'VERIFIED_FEE_EVIDENCE',
        ...(onChainPaidAmount === null ? ['CONFIRMED_PAID_AMOUNT'] : [])
      ] }

    },
    items
  };
}

module.exports = {
  toFixed6Decimals,
  buildReconciliationReport
};
