-- 0361: Root Architectural Remediation for Database Triggers & Guards
-- 1. trg_online_orders_expired_activation_bu:
--    Only blocks activation when transitioning from unconfirmed cart/pending state (OLD.orderStatus IN ('PENDING')),
--    and checks COALESCE(NEW.reservationExpiresAt, OLD.reservationExpiresAt, DATE_ADD(OLD.orderDate, INTERVAL 24 HOUR)) <= CURRENT_TIMESTAMP(3).
--    This permits legitimate rollbacks (e.g. SHIPPED -> PROCESSING on delivery cancellation) and atomic reservation renewals.
-- 2. trg_cash_missed_daily_bu:
--    Allows Owner self-approval (NEW.reviewedByUserId = NEW.requestedByUserId) per PR #962 and migrations 0333/0336.

DROP TRIGGER IF EXISTS `trg_online_orders_expired_activation_bu`;
--> statement-breakpoint
CREATE TRIGGER `trg_online_orders_expired_activation_bu`
BEFORE UPDATE ON `onlineOrders`
FOR EACH ROW
BEGIN
  IF NEW.`orderStatus` IN ('CONFIRMED', 'PROCESSING')
     AND OLD.`orderStatus` IN ('PENDING')
     AND COALESCE(
       NEW.`reservationExpiresAt`,
       OLD.`reservationExpiresAt`,
       DATE_ADD(OLD.`orderDate`, INTERVAL 24 HOUR)
     ) <= CURRENT_TIMESTAMP(3) THEN
    SIGNAL SQLSTATE '45000'
      SET MESSAGE_TEXT = 'expired online order reservation cannot be activated';
  END IF;
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
     OR NEW.`version` <> 2 THEN
    SIGNAL SQLSTATE '45000' SET MESSAGE_TEXT = 'invalid missed daily count decision';
  END IF;
  SET NEW.`activeBusinessDateKey` = IF(
    NEW.`missedDailyCountExceptionStatus` = 'APPROVED',
    CONCAT(CAST(NEW.`branchId` AS CHAR), ':', CAST(NEW.`businessDate` AS CHAR)),
    NULL
  );
END;
