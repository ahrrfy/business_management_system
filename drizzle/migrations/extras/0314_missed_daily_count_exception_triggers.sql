DROP TRIGGER IF EXISTS `trg_cash_missed_daily_bi`;
--> statement-breakpoint
CREATE TRIGGER `trg_cash_missed_daily_bi`
BEFORE INSERT ON `cashMissedDailyCountExceptions`
FOR EACH ROW
BEGIN
  IF NEW.`missedDailyCountExceptionStatus` <> 'PENDING' OR NEW.`version` <> 1 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'missed daily count exception must start pending';
  END IF;
  IF NEW.`businessDate` >= UTC_DATE() OR NEW.`carryForwardBusinessDate` >= UTC_DATE() THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'missed day and carry evidence must both be historical';
  END IF;
  SET NEW.`activeBusinessDateKey` = CONCAT(CAST(NEW.`branchId` AS CHAR), ':', CAST(NEW.`businessDate` AS CHAR));
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_cash_missed_daily_bu`;
--> statement-breakpoint
CREATE TRIGGER `trg_cash_missed_daily_bu`
BEFORE UPDATE ON `cashMissedDailyCountExceptions`
FOR EACH ROW
BEGIN
  IF OLD.`missedDailyCountExceptionStatus` <> 'PENDING' THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'decided missed daily count exception is immutable';
  END IF;
  IF NOT (
    OLD.`branchId` <=> NEW.`branchId`
    AND OLD.`businessDate` <=> NEW.`businessDate`
    AND OLD.`carryForwardReconciliationId` <=> NEW.`carryForwardReconciliationId`
    AND OLD.`carryForwardBusinessDate` <=> NEW.`carryForwardBusinessDate`
    AND OLD.`carryForwardVersion` <=> NEW.`carryForwardVersion`
    AND OLD.`carryForwardEvidenceHash` <=> NEW.`carryForwardEvidenceHash`
    AND OLD.`missingDayEvidenceHash` <=> NEW.`missingDayEvidenceHash`
    AND OLD.`reason` <=> NEW.`reason`
    AND OLD.`evidenceReference` <=> NEW.`evidenceReference`
    AND OLD.`requestClientRequestId` <=> NEW.`requestClientRequestId`
    AND OLD.`requestHash` <=> NEW.`requestHash`
    AND OLD.`immutableEvidenceHash` <=> NEW.`immutableEvidenceHash`
    AND OLD.`requestedByUserId` <=> NEW.`requestedByUserId`
    AND OLD.`requestedAt` <=> NEW.`requestedAt`
    AND OLD.`createdAt` <=> NEW.`createdAt`
  ) THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'missed daily count request evidence is immutable';
  END IF;
  IF NEW.`missedDailyCountExceptionStatus` NOT IN ('APPROVED','REJECTED')
     OR NEW.`version` <> 2
     OR NEW.`reviewedByUserId` = NEW.`requestedByUserId` THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'invalid missed daily count decision';
  END IF;
  SET NEW.`activeBusinessDateKey` = IF(
    NEW.`missedDailyCountExceptionStatus` = 'APPROVED',
    CONCAT(CAST(NEW.`branchId` AS CHAR), ':', CAST(NEW.`businessDate` AS CHAR)),
    NULL
  );
END;
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_cash_missed_daily_bd`;
--> statement-breakpoint
CREATE TRIGGER `trg_cash_missed_daily_bd`
BEFORE DELETE ON `cashMissedDailyCountExceptions`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'missed daily count exceptions are append-only';
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_cash_missed_daily_events_bu`;
--> statement-breakpoint
CREATE TRIGGER `trg_cash_missed_daily_events_bu`
BEFORE UPDATE ON `cashMissedDailyCountExceptionEvents`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'missed daily count exception events are immutable';
--> statement-breakpoint
DROP TRIGGER IF EXISTS `trg_cash_missed_daily_events_bd`;
--> statement-breakpoint
CREATE TRIGGER `trg_cash_missed_daily_events_bd`
BEFORE DELETE ON `cashMissedDailyCountExceptionEvents`
FOR EACH ROW SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'missed daily count exception events are append-only';
