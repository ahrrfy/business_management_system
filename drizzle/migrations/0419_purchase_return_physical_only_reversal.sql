-- Physical-only reversals retain their source proof without inventing a ledger entry.
-- Preserve the existing unique index and FK from 0303 without recreating them.
-- One atomic ALTER is safe to replay when the column is already nullable; no DML.
ALTER TABLE `purchaseReturnReversals`
  MODIFY COLUMN `accountingEntryId` BIGINT NULL;
