-- 0192-0197 physical trigger contract for schema-push databases.
-- Full migration databases may execute this safely as a repair: every trigger is replaced idempotently.
SET NAMES utf8mb4;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_period_predecessor_bi`;
CREATE TRIGGER `trg_period_predecessor_bi` BEFORE INSERT ON `financialPeriods`
FOR EACH ROW
BEGIN
  IF NEW.`predecessorPeriodId` IS NOT NULL AND NEW.`id` IS NOT NULL
    AND NEW.`id` <> 0 AND NEW.`predecessorPeriodId` = NEW.`id` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'financial period cannot precede itself';
  END IF;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_period_predecessor_bu`;
CREATE TRIGGER `trg_period_predecessor_bu` BEFORE UPDATE ON `financialPeriods`
FOR EACH ROW
BEGIN
  IF NEW.`predecessorPeriodId` IS NOT NULL AND NEW.`predecessorPeriodId` = NEW.`id` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'financial period cannot precede itself';
  END IF;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_year_supersedes_bi`;
CREATE TRIGGER `trg_year_supersedes_bi` BEFORE INSERT ON `yearEndSnapshots`
FOR EACH ROW
BEGIN
  IF NEW.`supersedesSnapshotId` IS NOT NULL AND NEW.`id` IS NOT NULL
    AND NEW.`id` <> 0 AND NEW.`supersedesSnapshotId` = NEW.`id` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'year end snapshot cannot supersede itself';
  END IF;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_year_supersedes_bu`;
CREATE TRIGGER `trg_year_supersedes_bu` BEFORE UPDATE ON `yearEndSnapshots`
FOR EACH ROW
BEGIN
  IF NEW.`supersedesSnapshotId` IS NOT NULL AND NEW.`supersedesSnapshotId` = NEW.`id` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'year end snapshot cannot supersede itself';
  END IF;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_mcc_supersedes_bi`;
CREATE TRIGGER `trg_mcc_supersedes_bi` BEFORE INSERT ON `monthCloseCertificates`
FOR EACH ROW
BEGIN
  IF NEW.`supersedesCertificateId` IS NOT NULL AND NEW.`id` IS NOT NULL
    AND NEW.`id` <> 0 AND NEW.`supersedesCertificateId` = NEW.`id` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'month close certificate cannot supersede itself';
  END IF;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_mcc_supersedes_bu`;
CREATE TRIGGER `trg_mcc_supersedes_bu` BEFORE UPDATE ON `monthCloseCertificates`
FOR EACH ROW
BEGIN
  IF NEW.`supersedesCertificateId` IS NOT NULL AND NEW.`supersedesCertificateId` = NEW.`id` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'month close certificate cannot supersede itself';
  END IF;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_mcc_no_update`;
CREATE TRIGGER `trg_mcc_no_update` BEFORE UPDATE ON `monthCloseCertificates`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'month close certificates are immutable';
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_mcc_no_delete`;
CREATE TRIGGER `trg_mcc_no_delete` BEFORE DELETE ON `monthCloseCertificates`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'month close certificates are immutable';
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_mcce_no_update`;
CREATE TRIGGER `trg_mcce_no_update` BEFORE UPDATE ON `monthCloseCertificateEvidence`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'month close certificate evidence is immutable';
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_mcce_no_delete`;
CREATE TRIGGER `trg_mcce_no_delete` BEFORE DELETE ON `monthCloseCertificateEvidence`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'month close certificate evidence is immutable';
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_mce_no_update`;
CREATE TRIGGER `trg_mce_no_update` BEFORE UPDATE ON `monthCloseEvents`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'month close events are immutable';
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_mce_no_delete`;
CREATE TRIGGER `trg_mce_no_delete` BEFORE DELETE ON `monthCloseEvents`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'month close events are immutable';
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_year_snapshot_no_update`;
CREATE TRIGGER `trg_year_snapshot_no_update` BEFORE UPDATE ON `yearEndSnapshots`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'year end snapshots are immutable';
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_year_snapshot_no_delete`;
CREATE TRIGGER `trg_year_snapshot_no_delete` BEFORE DELETE ON `yearEndSnapshots`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'year end snapshots are immutable';
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_yerr_guard_update`;
CREATE TRIGGER `trg_yerr_guard_update` BEFORE UPDATE ON `yearEndReopenRequests`
FOR EACH ROW
BEGIN
  IF OLD.`yearEndReopenStatus` <> 'PENDING_APPROVAL' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'decided year end reopen requests are immutable';
  END IF;
  IF NOT (
    OLD.`year` <=> NEW.`year` AND
    OLD.`snapshotId` <=> NEW.`snapshotId` AND
    OLD.`certificateId` <=> NEW.`certificateId` AND
    OLD.`periodId` <=> NEW.`periodId` AND
    OLD.`clientRequestId` <=> NEW.`clientRequestId` AND
    OLD.`requestPayloadHash` <=> NEW.`requestPayloadHash` AND
    OLD.`requestedBy` <=> NEW.`requestedBy` AND
    OLD.`requestedAt` <=> NEW.`requestedAt` AND
    OLD.`reason` <=> NEW.`reason`
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'year end reopen request identity is immutable';
  END IF;
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_yerr_no_delete`;
CREATE TRIGGER `trg_yerr_no_delete` BEFORE DELETE ON `yearEndReopenRequests`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'year end reopen requests are append-only';
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_advrep_alloc_no_update`;
CREATE TRIGGER `trg_advrep_alloc_no_update` BEFORE UPDATE ON `employeeAdvanceRepaymentAllocations`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'employee advance repayment allocations are immutable';
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_advrep_alloc_no_delete`;
CREATE TRIGGER `trg_advrep_alloc_no_delete` BEFORE DELETE ON `employeeAdvanceRepaymentAllocations`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'employee advance repayment allocations are append-only';
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_accrual_event_no_update`;
CREATE TRIGGER `trg_accrual_event_no_update` BEFORE UPDATE ON `accrualObligationEvents`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'accrual obligation events are immutable';
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_accrual_event_no_delete`;
CREATE TRIGGER `trg_accrual_event_no_delete` BEFORE DELETE ON `accrualObligationEvents`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'accrual obligation events are append-only';
