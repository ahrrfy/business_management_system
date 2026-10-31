-- Physical-only reversals retain their source proof without inventing a ledger entry.
-- Keep the unique index and the exact FK declaration/default actions from 0303.
-- One atomic ALTER is safe to replay when the column is already nullable; no DML.
ALTER TABLE `purchaseReturnReversals`
  DROP FOREIGN KEY `fk_prrev_entry`,
  MODIFY COLUMN `accountingEntryId` BIGINT NULL,
  ADD CONSTRAINT `fk_prrev_entry` FOREIGN KEY (`accountingEntryId`)
    REFERENCES `accountingEntries` (`id`);
