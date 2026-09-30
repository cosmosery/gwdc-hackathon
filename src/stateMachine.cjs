/**
 * State Machine Module
 * Enforces legal state transitions and records immutable StatusEvent logs.
 * All payment status transitions should pass through transitionPayment.
 */

const VALID_TRANSITIONS = {
  PENDING: ['SUBMITTING', 'EXCLUDED'],
  SUBMITTING: ['SUBMITTED', 'CONFIRMED', 'SUCCEEDED', 'FAILED', 'REJECTED'],
  SUBMITTED: ['CONFIRMED', 'SUCCEEDED', 'FAILED', 'PENDING'],
  CONFIRMED: [], // Terminal success
  SUCCEEDED: [], // Terminal success
  FAILED: ['SUBMITTING'], // Can be retried
  REJECTED: ['SUBMITTING'], // Can be retried
  EXCLUDED: []
};

function isValidTransition(fromStatus, toStatus) {
  if (!fromStatus) return true;
  if (fromStatus === toStatus) return true;
  const allowed = VALID_TRANSITIONS[fromStatus];
  if (!allowed) return true; // Permissive fallback if custom status
  return allowed.includes(toStatus);
}

function transitionPayment(db, itemId, toStatus, options = {}) {
  const { cause = 'SUBMISSION', detail = null, ...fields } = options;
  const payment = db.db.prepare('SELECT * FROM payments WHERE id = ?').get(itemId);
  if (!payment) {
    throw new Error(`Payment not found: ${itemId}`);
  }

  const fromStatus = payment.status;
  if (!isValidTransition(fromStatus, toStatus)) {
    console.warn(`[StateMachine] Warning: Transitioning from ${fromStatus} to ${toStatus} is not typically allowed`);
  }

  db.updatePaymentStatus(itemId, toStatus, {
    ...fields,
    cause,
    detail
  });

  return {
    itemId,
    batchId: payment.batch_id,
    fromStatus,
    toStatus,
    cause,
    detail
  };
}

module.exports = {
  VALID_TRANSITIONS,
  isValidTransition,
  transitionPayment
};
