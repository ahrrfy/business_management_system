ALTER TABLE `inventoryMovements` ADD COLUMN `documentNumber` varchar(50);
--> statement-breakpoint
CREATE INDEX `idx_move_doc_number` ON `inventoryMovements` (`documentNumber`);
--> statement-breakpoint
INSERT INTO `documentCounters` (`counterKey`, `lastValue`)
SELECT 'unified_transaction_floor', 100000 + COALESCE(MAX(`id`), 0) FROM `onlineOrders`
ON DUPLICATE KEY UPDATE `counterKey` = `counterKey`;
--> statement-breakpoint
INSERT INTO `documentCounters` (`counterKey`, `lastValue`)
SELECT 'unified_transaction', 100000 + COALESCE(MAX(`id`), 0) FROM `onlineOrders`
ON DUPLICATE KEY UPDATE `lastValue` = GREATEST(`lastValue`, VALUES(`lastValue`));
