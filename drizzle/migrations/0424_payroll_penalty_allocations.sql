-- Preserve the exact amount captured by each payroll item for each penalty.
-- Existing penalty and payroll records are intentionally not backfilled.
SET @paypen_has_snapshot = (
  SELECT COUNT(*) FROM information_schema.COLUMNS
  WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payrollItems'
    AND COLUMN_NAME = 'penaltySnapshotComplete'
);
--> statement-breakpoint
SET @paypen_snapshot_ddl = IF(
  @paypen_has_snapshot = 0,
  'ALTER TABLE `payrollItems` ADD COLUMN `penaltySnapshotComplete` boolean NOT NULL DEFAULT false',
  'SELECT 1'
);
--> statement-breakpoint
PREPARE paypen_snapshot_stmt FROM @paypen_snapshot_ddl;
--> statement-breakpoint
EXECUTE paypen_snapshot_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE paypen_snapshot_stmt;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `payrollPenaltyAllocations` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `penaltyId` bigint NOT NULL,
  `runId` bigint NOT NULL,
  `itemId` bigint NOT NULL,
  `amount` decimal(15,2) NOT NULL,
  `decisionNumberSnapshot` varchar(100) NOT NULL,
  `decisionDateSnapshot` date NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_paypenalty_penalty_run` (`penaltyId`, `runId`),
  KEY `idx_paypenalty_run` (`runId`),
  KEY `idx_paypenalty_item` (`itemId`),
  CONSTRAINT `fk_paypenalty_penalty` FOREIGN KEY (`penaltyId`) REFERENCES `employeePenalties` (`id`),
  CONSTRAINT `fk_paypenalty_run` FOREIGN KEY (`runId`) REFERENCES `payrollRuns` (`id`),
  CONSTRAINT `fk_paypenalty_item` FOREIGN KEY (`itemId`) REFERENCES `payrollItems` (`id`),
  CONSTRAINT `chk_paypenalty_amount_nonnegative` CHECK (`amount` >= 0)
);
--> statement-breakpoint
-- IF NOT EXISTS must not silently accept a partial or incompatible table.
SET @paypen_contract_ok = (
  (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payrollPenaltyAllocations'
     AND IS_NULLABLE = 'NO' AND (
       (COLUMN_NAME = 'id' AND COLUMN_TYPE = 'bigint' AND EXTRA LIKE '%auto_increment%') OR
       (COLUMN_NAME IN ('penaltyId', 'runId', 'itemId') AND COLUMN_TYPE = 'bigint') OR
       (COLUMN_NAME = 'amount' AND COLUMN_TYPE = 'decimal(15,2)') OR
       (COLUMN_NAME = 'decisionNumberSnapshot' AND COLUMN_TYPE = 'varchar(100)') OR
       (COLUMN_NAME = 'decisionDateSnapshot' AND COLUMN_TYPE = 'date') OR
       (COLUMN_NAME = 'createdAt' AND COLUMN_TYPE = 'timestamp' AND UPPER(COLUMN_DEFAULT) IN ('CURRENT_TIMESTAMP', 'CURRENT_TIMESTAMP()', 'NOW()'))
     )) = 8
  AND (SELECT COUNT(*) FROM information_schema.COLUMNS
   WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payrollItems'
     AND COLUMN_NAME = 'penaltySnapshotComplete' AND COLUMN_TYPE = 'tinyint(1)'
     AND IS_NULLABLE = 'NO' AND COLUMN_DEFAULT = '0') = 1
  AND EXISTS (SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payrollPenaltyAllocations' AND INDEX_NAME = 'PRIMARY'
    GROUP BY INDEX_NAME HAVING MAX(NON_UNIQUE) = 0 AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'id')
  AND EXISTS (SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payrollPenaltyAllocations' AND INDEX_NAME = 'uq_paypenalty_penalty_run'
    GROUP BY INDEX_NAME HAVING MAX(NON_UNIQUE) = 0 AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'penaltyId,runId')
  AND EXISTS (SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payrollPenaltyAllocations' AND INDEX_NAME = 'idx_paypenalty_run'
    GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'runId')
  AND EXISTS (SELECT 1 FROM information_schema.STATISTICS
    WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'payrollPenaltyAllocations' AND INDEX_NAME = 'idx_paypenalty_item'
    GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'itemId')
  AND (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE k
    JOIN information_schema.REFERENTIAL_CONSTRAINTS r
      ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
    WHERE k.TABLE_SCHEMA = DATABASE() AND k.TABLE_NAME = 'payrollPenaltyAllocations'
      AND k.REFERENCED_COLUMN_NAME = 'id' AND r.DELETE_RULE IN ('NO ACTION', 'RESTRICT')
      AND r.UPDATE_RULE IN ('NO ACTION', 'RESTRICT') AND (
        (k.COLUMN_NAME = 'penaltyId' AND k.REFERENCED_TABLE_NAME = 'employeePenalties') OR
        (k.COLUMN_NAME = 'runId' AND k.REFERENCED_TABLE_NAME = 'payrollRuns') OR
        (k.COLUMN_NAME = 'itemId' AND k.REFERENCED_TABLE_NAME = 'payrollItems')
      )) = 3
  AND EXISTS (SELECT 1 FROM information_schema.TABLE_CONSTRAINTS t
    JOIN information_schema.CHECK_CONSTRAINTS c
      ON c.CONSTRAINT_SCHEMA = t.CONSTRAINT_SCHEMA AND c.CONSTRAINT_NAME = t.CONSTRAINT_NAME
    WHERE t.TABLE_SCHEMA = DATABASE() AND t.TABLE_NAME = 'payrollPenaltyAllocations'
      AND t.CONSTRAINT_NAME = 'chk_paypenalty_amount_nonnegative' AND t.CONSTRAINT_TYPE = 'CHECK'
      AND t.ENFORCED = 'YES'
      AND REPLACE(REPLACE(REPLACE(REPLACE(LOWER(c.CHECK_CLAUSE), '`', ''), ' ', ''), '(', ''), ')', '') = 'amount>=0')
);
--> statement-breakpoint
SET @paypen_assert_ddl = IF(@paypen_contract_ok, 'SELECT 1', 'SELECT * FROM `__migration_0424_penalty_schema_mismatch__`');
--> statement-breakpoint
PREPARE paypen_assert_stmt FROM @paypen_assert_ddl;
--> statement-breakpoint
EXECUTE paypen_assert_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE paypen_assert_stmt;
