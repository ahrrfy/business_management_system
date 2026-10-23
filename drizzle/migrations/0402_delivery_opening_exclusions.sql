-- Exclude an original opening only with a durable, immutable evidence record.
-- No source ledger, cash, receipt, invoice, inventory or GL row is rewritten.
CREATE TABLE IF NOT EXISTS `deliveryOpeningExclusions` (
  `ledgerEntryId` BIGINT NOT NULL,
  `partyId` BIGINT NOT NULL,
  `branchId` BIGINT NULL,
  `openingAmount` DECIMAL(15,2) NOT NULL,
  `reason` ENUM('NATIVE_CUSTODY_OVERLAP','LEGACY_CUSTODY_REPRESENTED') NOT NULL,
  `evidenceHash` VARCHAR(64) NOT NULL,
  `evidence` JSON NOT NULL,
  `createdBy` INT NOT NULL,
  `createdAt` TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`ledgerEntryId`),
  CONSTRAINT `fk_delivery_opening_source` FOREIGN KEY (`ledgerEntryId`) REFERENCES `deliveryLedgerEntries` (`id`),
  CONSTRAINT `deliveryOpeningExclusions_partyId_deliveryParties_id_fk` FOREIGN KEY (`partyId`) REFERENCES `deliveryParties` (`id`),
  CONSTRAINT `deliveryOpeningExclusions_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `deliveryOpeningExclusions_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_delivery_opening_exclusion_amount` CHECK (`openingAmount` > 0)
) ENGINE=InnoDB;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_delivery_opening_exclusion_bi`;
--> statement-breakpoint
CREATE TRIGGER `trg_delivery_opening_exclusion_bi` BEFORE INSERT ON `deliveryOpeningExclusions`
FOR EACH ROW
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM `deliveryLedgerEntries` src
    WHERE src.id=NEW.ledgerEntryId AND src.partyId=NEW.partyId
      AND src.branchId <=> NEW.branchId AND src.amount=NEW.openingAmount
      AND src.consignmentId IS NULL AND src.entryType='COD_COLLECTED'
      AND src.eventKey=CONCAT('BACKFILL:PARTY:',src.partyId,':CASH_CUSTODY')
  ) OR CHAR_LENGTH(NEW.evidenceHash)<>64 OR JSON_LENGTH(NEW.evidence)=0 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Opening exclusion requires matching original opening and evidence';
  END IF;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_delivery_opening_exclusion_bu`;
--> statement-breakpoint
CREATE TRIGGER `trg_delivery_opening_exclusion_bu` BEFORE UPDATE ON `deliveryOpeningExclusions`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Opening exclusion evidence is immutable';
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_delivery_opening_exclusion_bd`;
--> statement-breakpoint
CREATE TRIGGER `trg_delivery_opening_exclusion_bd` BEFORE DELETE ON `deliveryOpeningExclusions`
FOR EACH ROW
SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT='Opening exclusion evidence is immutable';
