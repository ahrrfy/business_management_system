-- 0195: immutable post-recognition employee-advance snapshot for the
-- certified termination statement. The value is part of the service's
-- settlementSnapshotHash canonical payload and never follows later repayments.
ALTER TABLE `employeeTerminations`
  ADD COLUMN `remainingAdvanceAtRecognition` decimal(15,2) NOT NULL DEFAULT '0.00' AFTER `advanceRecovery`,
  ADD CONSTRAINT `chk_term_advance_snapshot_nonnegative`
    CHECK (`remainingAdvanceAtRecognition` >= 0);
