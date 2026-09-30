import test from 'node:test';
import assert from 'node:assert/strict';
import { describeStatus } from '../src/design-system';

test('confirmed and verified evidence use the success treatment', () => {
  assert.deepEqual(describeStatus('CONFIRMED'), { tone: 'success', label: 'Confirmed' });
  assert.deepEqual(describeStatus('VERIFIED_TRACKED_FEES'), { tone: 'success', label: 'Verified tracked fees' });
  assert.deepEqual(describeStatus('READY'), { tone: 'success', label: 'Ready' });
  assert.deepEqual(describeStatus('COMPLETE'), { tone: 'success', label: 'Complete' });
});

test('unknown outcomes stay investigative rather than failed', () => {
  assert.deepEqual(describeStatus('SUBMISSION_UNKNOWN'), { tone: 'unknown', label: 'Investigating' });
  assert.deepEqual(describeStatus('Evidence pending'), { tone: 'unknown', label: 'Evidence pending' });
});

test('partial, failed and refunded rows remain visually distinct', () => {
  assert.equal(describeStatus('PARTIAL_SUCCESS').tone, 'action');
  assert.equal(describeStatus('FAILED').tone, 'failure');
  assert.equal(describeStatus('Unpaid · batch refunded').tone, 'excluded');
  assert.deepEqual(describeStatus('WAITING'), { tone: 'progress', label: 'Waiting' });
});
