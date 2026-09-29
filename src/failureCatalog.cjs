/**
 * Failure Catalog Module
 * Classifies runtime errors into categories and provides actionable next steps.
 */

function classifyFailure(error, context = {}) {
  const msg = typeof error === 'string' ? error : (error?.message || '');

  // 1. User Action needed: Insufficient Funds
  if ((/insufficient/i.test(msg) && /balance/i.test(msg)) || /balance.*less than/i.test(msg) || /not enough balance/i.test(msg) || /insufficient funds/i.test(msg)) {
    return {
      category: 'USER_ACTION',
      reason: 'INSUFFICIENT_BALANCE',
      message: 'USDT balance is insufficient for transfer or fee',
      nextAction: 'TOP_UP_USDT'
    };
  }

  // 2. User Action needed: Out of Energy / TRX (Relayer / Account)
  if (/OUT_OF_ENERGY/i.test(msg) || /energy.*exceeded/i.test(msg) || /not enough energy/i.test(msg) || /insufficient.*fee/i.test(msg) || /trx/i.test(msg)) {
    return {
      category: 'USER_ACTION',
      reason: 'INSUFFICIENT_FEE',
      message: 'Insufficient Energy or TRX to execute transaction',
      nextAction: 'TOP_UP_TRX'
    };
  }

  // 3. User Action needed: Signature Deadline or Batch Expiration
  if (/expired/i.test(msg) || /deadline/i.test(msg)) {
    return {
      category: 'USER_ACTION',
      reason: 'DEADLINE_EXPIRED',
      message: 'Permit deadline or batch execution period has expired',
      nextAction: 'RE_SIGN'
    };
  }

  // 4. Auto Retry: Nonce mismatch
  if (/noncenotmatch/i.test(msg) || /nonce.*mismatch/i.test(msg) || /invalid nonce/i.test(msg)) {
    return {
      category: 'AUTO_RETRY',
      reason: 'NONCE_MISMATCH',
      message: 'Nonce mismatch with provider/account state',
      nextAction: 'SYNC_NONCE_AND_RETRY'
    };
  }

  // 5. Auto Retry: Network timeout, RPC glitch, pending status
  if (/timeout/i.test(msg) || /timed out/i.test(msg) || /pending/i.test(msg) || /gateway/i.test(msg) || /fetch failed/i.test(msg) || /econnrefused/i.test(msg) || /rate limit/i.test(msg)) {
    return {
      category: 'AUTO_RETRY',
      reason: 'NETWORK_TIMEOUT',
      message: 'Transient network or RPC timeout occurred',
      nextAction: 'RETRY_PAYOUT'
    };
  }

  // 6. Manual Review: Contract Revert or cryptographic proof mismatch
  if (/revert/i.test(msg) || /proof/i.test(msg) || /tamper/i.test(msg)) {
    return {
      category: 'MANUAL_REVIEW',
      reason: 'ONCHAIN_REVERT',
      message: msg || 'Smart contract execution reverted on chain',
      nextAction: 'CHECK_EXPLORER'
    };
  }

  // 7. Default
  return {
    category: 'MANUAL_REVIEW',
    reason: 'UNKNOWN_ERROR',
    message: msg || 'An unknown error occurred during execution',
    nextAction: 'MANUAL_REVIEW'
  };
}

module.exports = { classifyFailure };
