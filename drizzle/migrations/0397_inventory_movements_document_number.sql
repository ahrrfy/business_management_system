ALTER TABLE `inventoryMovements` ADD COLUMN `documentNumber` varchar(50);
--> statement-breakpoint
CREATE INDEX `idx_move_doc_number` ON `inventoryMovements` (`documentNumber`);
