import test from 'node:test';
import assert from 'node:assert/strict';
import {cashRetryKind} from './retry-policy.mjs';

test('cash replay admits identified transport/concurrency failures and refuses business failures', () => {
  assert.equal(cashRetryKind(503, 'D1_ERROR: Network connection lost.'), 'transport');
  assert.equal(cashRetryKind(503, 'CASH_WRITER_UNAVAILABLE'), 'transport');
  assert.equal(cashRetryKind(503, 'CASH_WRITER_EXECUTION_UNCERTAIN'), 'transport');
  assert.equal(cashRetryKind(503, 'CASH_WRITER_QUEUE_FULL'), null);
  assert.equal(cashRetryKind(409, 'STALE_SNAPSHOT_RETRY_SAME_REQUEST'), 'concurrency');
  assert.equal(cashRetryKind(409, 'RECOVERY_PREFIX_PENDING_RETRY_SAME_REQUEST'), 'concurrency');
  for (const [status,code] of [[503,'INSUFFICIENT_STOCK'],[503,'BAD_REQUEST'],[503,'RECOVERY_PREFIX_INVALID'],[409,'IDEMPOTENCY_PAYLOAD_MISMATCH'],[409,'PRIMARY_REQUEST_MISMATCH'],[401,'UNAUTHORIZED'],[503,'UNKNOWN_ERROR'],[200,'D1_ERROR: Network connection lost.']])
    assert.equal(cashRetryKind(status,code), null, status+' '+code);
});
