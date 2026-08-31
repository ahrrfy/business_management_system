-- Zero-effect maker/checker exception for a genuinely missed historical treasury count.
-- This never creates a historical physical count and never posts a receipt or ledger entry.
SET NAMES utf8mb4;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `cashMissedDailyCountExceptions` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `branchId` bigint NOT NULL,
  `businessDate` date NOT NULL,
  `carryForwardReconciliationId` bigint NOT NULL,
  `carryForwardBusinessDate` date NOT NULL,
  `carryForwardVersion` int NOT NULL,
  `carryForwardEvidenceHash` char(64) NOT NULL,
  `missingDayEvidenceHash` char(64) NOT NULL,
  `reason` varchar(500) NOT NULL,
  `evidenceReference` mediumtext NOT NULL,
  `missedDailyCountExceptionStatus` enum('PENDING','APPROVED','REJECTED') NOT NULL DEFAULT 'PENDING',
  `activeBusinessDateKey` varchar(80) NULL,
  `requestClientRequestId` varchar(64) NOT NULL,
  `requestHash` char(64) NOT NULL,
  `immutableEvidenceHash` char(64) NOT NULL,
  `requestedByUserId` int NOT NULL,
  `requestedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `version` int NOT NULL DEFAULT 1,
  `decisionClientRequestId` varchar(64) NULL,
  `decisionHash` char(64) NULL,
  `reviewedByUserId` int NULL,
  `reviewedAt` timestamp NULL,
  `decisionNote` varchar(500) NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  `updatedAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
  CONSTRAINT `cashMissedDailyCountExceptions_id` PRIMARY KEY (`id`),
  CONSTRAINT `uq_cash_missed_daily_active_date` UNIQUE (`activeBusinessDateKey`),
  CONSTRAINT `uq_cash_missed_daily_request` UNIQUE (`requestClientRequestId`),
  CONSTRAINT `uq_cash_missed_daily_decision` UNIQUE (`decisionClientRequestId`),
  CONSTRAINT `fk_cash_missed_daily_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_cash_missed_daily_carry` FOREIGN KEY (`carryForwardReconciliationId`) REFERENCES `cashDailyReconciliations` (`id`),
  CONSTRAINT `fk_cash_missed_daily_requester` FOREIGN KEY (`requestedByUserId`) REFERENCES `users` (`id`),
  CONSTRAINT `fk_cash_missed_daily_reviewer` FOREIGN KEY (`reviewedByUserId`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_cash_missed_daily_dates` CHECK (`carryForwardBusinessDate` > `businessDate`),
  CONSTRAINT `chk_cash_missed_daily_version` CHECK (`version` IN (1, 2) AND `carryForwardVersion` > 0),
  CONSTRAINT `chk_cash_missed_daily_decision_shape` CHECK (
    (`missedDailyCountExceptionStatus` = 'PENDING'
      AND `version` = 1
      AND `decisionClientRequestId` IS NULL
      AND `decisionHash` IS NULL
      AND `reviewedByUserId` IS NULL
      AND `reviewedAt` IS NULL
      AND `decisionNote` IS NULL)
    OR
    (`missedDailyCountExceptionStatus` IN ('APPROVED','REJECTED')
      AND `version` = 2
      AND `decisionClientRequestId` IS NOT NULL
      AND `decisionHash` IS NOT NULL
      AND `reviewedByUserId` IS NOT NULL
      AND `reviewedAt` IS NOT NULL
      AND `decisionNote` IS NOT NULL
      AND `reviewedByUserId` <> `requestedByUserId`)
  )
);
--> statement-breakpoint
SET @has_cmdce_branch_idx := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'cashMissedDailyCountExceptions' AND index_name = 'idx_cash_missed_daily_branch_date');
SET @sql := IF(@has_cmdce_branch_idx = 0, 'CREATE INDEX `idx_cash_missed_daily_branch_date` ON `cashMissedDailyCountExceptions` (`branchId`, `businessDate`, `missedDailyCountExceptionStatus`)', 'SELECT ''idx_cash_missed_daily_branch_date exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @has_cmdce_carry_idx := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'cashMissedDailyCountExceptions' AND index_name = 'idx_cash_missed_daily_carry');
SET @sql := IF(@has_cmdce_carry_idx = 0, 'CREATE INDEX `idx_cash_missed_daily_carry` ON `cashMissedDailyCountExceptions` (`carryForwardReconciliationId`, `carryForwardVersion`)', 'SELECT ''idx_cash_missed_daily_carry exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `cashMissedDailyCountExceptionEvents` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `exceptionId` bigint NOT NULL,
  `version` int NOT NULL,
  `missedDailyCountExceptionEventType` enum('PROPOSED','APPROVED','REJECTED') NOT NULL,
  `clientRequestId` varchar(64) NOT NULL,
  `requestHash` char(64) NOT NULL,
  `actorUserId` int NOT NULL,
  `payloadCanonical` mediumtext NOT NULL,
  `payloadHash` char(64) NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT `cashMissedDailyCountExceptionEvents_id` PRIMARY KEY (`id`),
  CONSTRAINT `uq_cash_missed_daily_event_request` UNIQUE (`clientRequestId`),
  CONSTRAINT `uq_cash_missed_daily_event_version` UNIQUE (`exceptionId`, `version`),
  CONSTRAINT `fk_cash_missed_daily_event_exception` FOREIGN KEY (`exceptionId`) REFERENCES `cashMissedDailyCountExceptions` (`id`),
  CONSTRAINT `fk_cash_missed_daily_event_actor` FOREIGN KEY (`actorUserId`) REFERENCES `users` (`id`),
  CONSTRAINT `chk_cash_missed_daily_event_version` CHECK (
    (`missedDailyCountExceptionEventType` = 'PROPOSED' AND `version` = 1)
    OR (`missedDailyCountExceptionEventType` IN ('APPROVED','REJECTED') AND `version` = 2)
  )
);
--> statement-breakpoint
SET @has_cmdce_event_idx := (SELECT COUNT(*) FROM information_schema.statistics WHERE table_schema = DATABASE() AND table_name = 'cashMissedDailyCountExceptionEvents' AND index_name = 'idx_cash_missed_daily_events_exception');
SET @sql := IF(@has_cmdce_event_idx = 0, 'CREATE INDEX `idx_cash_missed_daily_events_exception` ON `cashMissedDailyCountExceptionEvents` (`exceptionId`, `version`)', 'SELECT ''idx_cash_missed_daily_events_exception exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint

SET @has_cmdce_branch_fk := (SELECT COUNT(*) FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = 'cashMissedDailyCountExceptions' AND column_name = 'branchId' AND referenced_table_name = 'branches');
SET @sql := IF(@has_cmdce_branch_fk = 0, 'ALTER TABLE `cashMissedDailyCountExceptions` ADD CONSTRAINT `fk_cash_missed_daily_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`)', 'SELECT ''cash missed branch FK exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @has_cmdce_carry_fk := (SELECT COUNT(*) FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = 'cashMissedDailyCountExceptions' AND column_name = 'carryForwardReconciliationId' AND referenced_table_name = 'cashDailyReconciliations');
SET @sql := IF(@has_cmdce_carry_fk = 0, 'ALTER TABLE `cashMissedDailyCountExceptions` ADD CONSTRAINT `fk_cash_missed_daily_carry` FOREIGN KEY (`carryForwardReconciliationId`) REFERENCES `cashDailyReconciliations` (`id`)', 'SELECT ''cash missed carry FK exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @has_cmdce_requester_fk := (SELECT COUNT(*) FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = 'cashMissedDailyCountExceptions' AND column_name = 'requestedByUserId' AND referenced_table_name = 'users');
SET @sql := IF(@has_cmdce_requester_fk = 0, 'ALTER TABLE `cashMissedDailyCountExceptions` ADD CONSTRAINT `fk_cash_missed_daily_requester` FOREIGN KEY (`requestedByUserId`) REFERENCES `users` (`id`)', 'SELECT ''cash missed requester FK exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @has_cmdce_reviewer_fk := (SELECT COUNT(*) FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = 'cashMissedDailyCountExceptions' AND column_name = 'reviewedByUserId' AND referenced_table_name = 'users');
SET @sql := IF(@has_cmdce_reviewer_fk = 0, 'ALTER TABLE `cashMissedDailyCountExceptions` ADD CONSTRAINT `fk_cash_missed_daily_reviewer` FOREIGN KEY (`reviewedByUserId`) REFERENCES `users` (`id`)', 'SELECT ''cash missed reviewer FK exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @has_cmdce_event_exception_fk := (SELECT COUNT(*) FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = 'cashMissedDailyCountExceptionEvents' AND column_name = 'exceptionId' AND referenced_table_name = 'cashMissedDailyCountExceptions');
SET @sql := IF(@has_cmdce_event_exception_fk = 0, 'ALTER TABLE `cashMissedDailyCountExceptionEvents` ADD CONSTRAINT `fk_cash_missed_daily_event_exception` FOREIGN KEY (`exceptionId`) REFERENCES `cashMissedDailyCountExceptions` (`id`)', 'SELECT ''cash missed event exception FK exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
SET @has_cmdce_event_actor_fk := (SELECT COUNT(*) FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND table_name = 'cashMissedDailyCountExceptionEvents' AND column_name = 'actorUserId' AND referenced_table_name = 'users');
SET @sql := IF(@has_cmdce_event_actor_fk = 0, 'ALTER TABLE `cashMissedDailyCountExceptionEvents` ADD CONSTRAINT `fk_cash_missed_daily_event_actor` FOREIGN KEY (`actorUserId`) REFERENCES `users` (`id`)', 'SELECT ''cash missed event actor FK exists'' AS msg');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
--> statement-breakpoint
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
--> statement-breakpoint

SET @cmdce_contract :=
  (SELECT COUNT(*) FROM information_schema.tables WHERE table_schema = DATABASE() AND table_name IN ('cashMissedDailyCountExceptions','cashMissedDailyCountExceptionEvents'))
  + (SELECT COUNT(DISTINCT CONCAT(table_name,'.',index_name)) FROM information_schema.statistics WHERE table_schema = DATABASE() AND ((table_name = 'cashMissedDailyCountExceptions' AND index_name IN ('uq_cash_missed_daily_active_date','uq_cash_missed_daily_request','uq_cash_missed_daily_decision','idx_cash_missed_daily_branch_date','idx_cash_missed_daily_carry')) OR (table_name = 'cashMissedDailyCountExceptionEvents' AND index_name IN ('uq_cash_missed_daily_event_request','uq_cash_missed_daily_event_version','idx_cash_missed_daily_events_exception'))))
  + (SELECT COUNT(DISTINCT CONCAT(table_name,'.',constraint_name)) FROM information_schema.key_column_usage WHERE table_schema = DATABASE() AND ((table_name = 'cashMissedDailyCountExceptions' AND constraint_name IN ('fk_cash_missed_daily_branch','fk_cash_missed_daily_carry','fk_cash_missed_daily_requester','fk_cash_missed_daily_reviewer')) OR (table_name = 'cashMissedDailyCountExceptionEvents' AND constraint_name IN ('fk_cash_missed_daily_event_exception','fk_cash_missed_daily_event_actor'))) AND referenced_table_name IS NOT NULL)
  + (SELECT COUNT(*) FROM information_schema.table_constraints WHERE table_schema = DATABASE() AND constraint_type = 'CHECK' AND ((table_name = 'cashMissedDailyCountExceptions' AND constraint_name IN ('chk_cash_missed_daily_dates','chk_cash_missed_daily_version','chk_cash_missed_daily_decision_shape')) OR (table_name = 'cashMissedDailyCountExceptionEvents' AND constraint_name = 'chk_cash_missed_daily_event_version')))
  + (SELECT COUNT(*) FROM information_schema.triggers WHERE trigger_schema = DATABASE() AND trigger_name IN ('trg_cash_missed_daily_bi','trg_cash_missed_daily_bu','trg_cash_missed_daily_bd','trg_cash_missed_daily_events_bu','trg_cash_missed_daily_events_bd'));
SET @sql := IF(@cmdce_contract = 25, 'SELECT ''0314 missed-count exception contract verified'' AS msg', 'SELECT 1 FROM `__incomplete_0314_missed_count_contract__`');
PREPARE stmt FROM @sql; EXECUTE stmt; DEALLOCATE PREPARE stmt;
