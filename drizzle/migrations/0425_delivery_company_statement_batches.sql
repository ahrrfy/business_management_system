-- Keep existing remittances and their unique (party, companyStatementNumber) index untouched.
-- Existing documents are linked lazily when an operator explicitly appends a separate batch.
CREATE TABLE IF NOT EXISTS `deliveryCompanyStatements` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `partyId` bigint NOT NULL,
  `branchId` bigint NOT NULL,
  `statementNumber` varchar(64) NOT NULL,
  `statementDate` date NULL,
  `attachmentUrl` text NULL,
  `createdBy` int NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_delivery_company_statement_party_number` (`partyId`, `statementNumber`),
  CONSTRAINT `fk_delivery_company_stmt_party` FOREIGN KEY (`partyId`) REFERENCES `deliveryParties` (`id`),
  CONSTRAINT `fk_delivery_company_stmt_branch` FOREIGN KEY (`branchId`) REFERENCES `branches` (`id`),
  CONSTRAINT `fk_delivery_company_stmt_creator` FOREIGN KEY (`createdBy`) REFERENCES `users` (`id`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `deliveryCompanyStatementBatches` (
  `id` bigint NOT NULL AUTO_INCREMENT,
  `statementId` bigint NOT NULL,
  `remittanceId` bigint NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (`id`),
  UNIQUE KEY `uq_delivery_statement_batch_remittance` (`remittanceId`),
  KEY `idx_delivery_statement_batch_statement` (`statementId`),
  CONSTRAINT `fk_delivery_statement_batch_header` FOREIGN KEY (`statementId`) REFERENCES `deliveryCompanyStatements` (`id`),
  CONSTRAINT `fk_delivery_statement_batch_remit` FOREIGN KEY (`remittanceId`) REFERENCES `deliveryRemittances` (`id`)
);
--> statement-breakpoint
-- A retry may see the tables after a partially completed MySQL DDL migration.
-- Never silently accept an incompatible pre-existing table or missing key.
SET @delivery_statement_contract_ok = (
  (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryCompanyStatements') = 8
  AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryCompanyStatements' AND (
    (COLUMN_NAME = 'id' AND COLUMN_TYPE = 'bigint' AND IS_NULLABLE = 'NO' AND EXTRA LIKE '%auto_increment%') OR
    (COLUMN_NAME IN ('partyId', 'branchId') AND COLUMN_TYPE = 'bigint' AND IS_NULLABLE = 'NO') OR
    (COLUMN_NAME = 'statementNumber' AND COLUMN_TYPE = 'varchar(64)' AND IS_NULLABLE = 'NO') OR
    (COLUMN_NAME = 'statementDate' AND DATA_TYPE = 'date' AND IS_NULLABLE = 'YES') OR
    (COLUMN_NAME = 'attachmentUrl' AND DATA_TYPE = 'text' AND IS_NULLABLE = 'YES') OR
    (COLUMN_NAME = 'createdBy' AND COLUMN_TYPE = 'int' AND IS_NULLABLE = 'YES') OR
    (COLUMN_NAME = 'createdAt' AND DATA_TYPE = 'timestamp' AND IS_NULLABLE = 'NO')
  )) = 8
  AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryCompanyStatementBatches') = 4
  AND (SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryCompanyStatementBatches' AND (
    (COLUMN_NAME = 'id' AND COLUMN_TYPE = 'bigint' AND IS_NULLABLE = 'NO' AND EXTRA LIKE '%auto_increment%') OR
    (COLUMN_NAME IN ('statementId', 'remittanceId') AND COLUMN_TYPE = 'bigint' AND IS_NULLABLE = 'NO') OR
    (COLUMN_NAME = 'createdAt' AND DATA_TYPE = 'timestamp' AND IS_NULLABLE = 'NO')
  )) = 4
  AND (SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE()
    AND TABLE_NAME IN ('deliveryCompanyStatements', 'deliveryCompanyStatementBatches') AND INDEX_NAME = 'PRIMARY' AND COLUMN_NAME = 'id' AND SEQ_IN_INDEX = 1 AND NON_UNIQUE = 0) = 2
  AND EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryCompanyStatements'
    AND INDEX_NAME = 'uq_delivery_company_statement_party_number' GROUP BY INDEX_NAME HAVING MAX(NON_UNIQUE) = 0 AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'partyId,statementNumber')
  AND EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryCompanyStatementBatches'
    AND INDEX_NAME = 'uq_delivery_statement_batch_remittance' GROUP BY INDEX_NAME HAVING MAX(NON_UNIQUE) = 0 AND GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'remittanceId')
  AND EXISTS (SELECT 1 FROM information_schema.STATISTICS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'deliveryCompanyStatementBatches'
    AND INDEX_NAME = 'idx_delivery_statement_batch_statement' GROUP BY INDEX_NAME HAVING GROUP_CONCAT(COLUMN_NAME ORDER BY SEQ_IN_INDEX) = 'statementId')
  AND (SELECT COUNT(*) FROM information_schema.KEY_COLUMN_USAGE WHERE TABLE_SCHEMA = DATABASE() AND REFERENCED_COLUMN_NAME = 'id' AND (
    (TABLE_NAME = 'deliveryCompanyStatements' AND COLUMN_NAME = 'partyId' AND REFERENCED_TABLE_NAME = 'deliveryParties') OR
    (TABLE_NAME = 'deliveryCompanyStatements' AND COLUMN_NAME = 'branchId' AND REFERENCED_TABLE_NAME = 'branches') OR
    (TABLE_NAME = 'deliveryCompanyStatements' AND COLUMN_NAME = 'createdBy' AND REFERENCED_TABLE_NAME = 'users') OR
    (TABLE_NAME = 'deliveryCompanyStatementBatches' AND COLUMN_NAME = 'statementId' AND REFERENCED_TABLE_NAME = 'deliveryCompanyStatements') OR
    (TABLE_NAME = 'deliveryCompanyStatementBatches' AND COLUMN_NAME = 'remittanceId' AND REFERENCED_TABLE_NAME = 'deliveryRemittances')
  )) = 5
);
--> statement-breakpoint
SET @delivery_statement_check_sql = IF(@delivery_statement_contract_ok = 1, 'SELECT 1', 'SELECT * FROM `__delivery_company_statement_contract_mismatch__`');
--> statement-breakpoint
PREPARE delivery_statement_check FROM @delivery_statement_check_sql;
--> statement-breakpoint
EXECUTE delivery_statement_check;
--> statement-breakpoint
DEALLOCATE PREPARE delivery_statement_check;
