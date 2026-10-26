-- Wave 4: loyalty ledger idempotency key and multi-return ORDER_REVERSE support.
-- Creates idx_loyalty_ledger_order BEFORE dropping uq_loyalty_order_earn so
-- fk_loyalty_ledger_order keeps a leftmost index on MySQL 8.4.
SET @w4_0407_ddl = IF((SELECT COUNT(*) FROM information_schema.COLUMNS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='loyaltyLedgerEntries' AND COLUMN_NAME='idempotencyKey'), 'SELECT 1', 'ALTER TABLE `loyaltyLedgerEntries` ADD COLUMN `idempotencyKey` varchar(100) NULL');
--> statement-breakpoint
PREPARE w4_0407_stmt FROM @w4_0407_ddl;
--> statement-breakpoint
EXECUTE w4_0407_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE w4_0407_stmt;
--> statement-breakpoint
SET @w4_0407_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='loyaltyLedgerEntries' AND INDEX_NAME='uq_loyalty_ledger_idempotency'), 'SELECT 1', 'ALTER TABLE `loyaltyLedgerEntries` ADD UNIQUE INDEX `uq_loyalty_ledger_idempotency` (`idempotencyKey`)');
--> statement-breakpoint
PREPARE w4_0407_stmt FROM @w4_0407_ddl;
--> statement-breakpoint
EXECUTE w4_0407_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE w4_0407_stmt;
--> statement-breakpoint
SET @w4_0407_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='loyaltyLedgerEntries' AND INDEX_NAME='idx_loyalty_ledger_order'), 'SELECT 1', 'ALTER TABLE `loyaltyLedgerEntries` ADD INDEX `idx_loyalty_ledger_order` (`onlineOrderId`)');
--> statement-breakpoint
PREPARE w4_0407_stmt FROM @w4_0407_ddl;
--> statement-breakpoint
EXECUTE w4_0407_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE w4_0407_stmt;
--> statement-breakpoint
SET @w4_0407_ddl = IF((SELECT COUNT(*) FROM information_schema.STATISTICS WHERE TABLE_SCHEMA=DATABASE() AND TABLE_NAME='loyaltyLedgerEntries' AND INDEX_NAME='uq_loyalty_order_earn'), 'ALTER TABLE `loyaltyLedgerEntries` DROP INDEX `uq_loyalty_order_earn`', 'SELECT 1');
--> statement-breakpoint
PREPARE w4_0407_stmt FROM @w4_0407_ddl;
--> statement-breakpoint
EXECUTE w4_0407_stmt;
--> statement-breakpoint
DEALLOCATE PREPARE w4_0407_stmt;
--> statement-breakpoint
UPDATE `loyaltyLedgerEntries` SET `idempotencyKey` = CONCAT('earn:order:', `onlineOrderId`) WHERE `entryType` = 'ORDER_EARN' AND `onlineOrderId` IS NOT NULL AND `idempotencyKey` IS NULL;
