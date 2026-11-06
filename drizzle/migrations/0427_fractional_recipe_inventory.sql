-- Exact material quantities. Existing whole-unit history is preserved unchanged.
-- Deploy with ERP writers quiescent; never downgrade fractional data to INT.
ALTER TABLE `branchStock` MODIFY COLUMN `quantity` DECIMAL(15,4) NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `inventoryMovements` MODIFY COLUMN `quantity` DECIMAL(15,4) NOT NULL;
--> statement-breakpoint
ALTER TABLE `inventoryMovements` MODIFY COLUMN `signedDelta` DECIMAL(15,4) NULL;
--> statement-breakpoint
ALTER TABLE `invoiceItemServiceMaterials` MODIFY COLUMN `baseQuantity` DECIMAL(15,4) NOT NULL;
--> statement-breakpoint
ALTER TABLE `workOrders` MODIFY COLUMN `baseBaseQuantity` DECIMAL(15,4) NULL;
--> statement-breakpoint
ALTER TABLE `workOrderMaterials` MODIFY COLUMN `baseQuantity` DECIMAL(15,4) NOT NULL;
--> statement-breakpoint
ALTER TABLE `productionLines` MODIFY COLUMN `baseQuantity` DECIMAL(15,4) NOT NULL;
--> statement-breakpoint
ALTER TABLE `expenseStockItems` MODIFY COLUMN `baseQuantity` DECIMAL(15,4) NOT NULL;
--> statement-breakpoint
ALTER TABLE `reservationLines` MODIFY COLUMN `baseQuantity` DECIMAL(15,4) NOT NULL;
--> statement-breakpoint
ALTER TABLE `reservationLines` MODIFY COLUMN `fulfilledBase` DECIMAL(15,4) NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `reservationStock` MODIFY COLUMN `reservedBase` DECIMAL(15,4) NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `digitalIntentInventoryReservations` MODIFY COLUMN `reservedBase` DECIMAL(15,4) NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `stockTransfers` MODIFY COLUMN `totalSentBase` DECIMAL(15,4) NOT NULL DEFAULT 0;
--> statement-breakpoint
ALTER TABLE `stockTransfers` MODIFY COLUMN `totalReceivedBase` DECIMAL(15,4) NULL;
--> statement-breakpoint
ALTER TABLE `stockTransferLines` MODIFY COLUMN `quantitySent` DECIMAL(15,4) NOT NULL;
--> statement-breakpoint
ALTER TABLE `stockTransferLines` MODIFY COLUMN `quantityReceived` DECIMAL(15,4) NULL;
--> statement-breakpoint
ALTER TABLE `stockAdjustmentRequests` MODIFY COLUMN `targetQuantity` DECIMAL(15,4) NOT NULL;
--> statement-breakpoint
ALTER TABLE `stockAdjustmentRequests` MODIFY COLUMN `expectedQuantity` DECIMAL(15,4) NOT NULL;
--> statement-breakpoint
ALTER TABLE `costRevaluationRequests` MODIFY COLUMN `expectedQuantity` DECIMAL(15,4) NOT NULL;
--> statement-breakpoint
ALTER TABLE `costUpdateWaves` MODIFY COLUMN `expectedQuantity` DECIMAL(15,4) NOT NULL;
--> statement-breakpoint
ALTER TABLE `costUpdateWaveItems` MODIFY COLUMN `expectedQuantity` DECIMAL(15,4) NOT NULL;
--> statement-breakpoint
ALTER TABLE `stocktakeItems` MODIFY COLUMN `expectedQty` DECIMAL(15,4) NOT NULL;
--> statement-breakpoint
ALTER TABLE `stocktakeItems` MODIFY COLUMN `reviewApprovedQty` DECIMAL(15,4) NULL;
--> statement-breakpoint
ALTER TABLE `stocktakeCounts` MODIFY COLUMN `qty` DECIMAL(15,4) NOT NULL;
--> statement-breakpoint
ALTER TABLE `stocktakeCountOperations` MODIFY COLUMN `requestQty` DECIMAL(15,4) NOT NULL;
--> statement-breakpoint
ALTER TABLE `stocktakeItemReviewEvents` MODIFY COLUMN `snapshotQty` DECIMAL(15,4) NULL;
--> statement-breakpoint
ALTER TABLE `stocktakeDecisions` MODIFY COLUMN `finalQty` DECIMAL(15,4) NULL;
--> statement-breakpoint
ALTER TABLE `stocktakeDecisions` MODIFY COLUMN `diffQty` DECIMAL(15,4) NULL;
--> statement-breakpoint
ALTER TABLE `documentEffects` MODIFY COLUMN `signedQuantity` DECIMAL(15,4) NOT NULL DEFAULT 0;
--> statement-breakpoint
SET @add_material_line_cost = IF(
  EXISTS(SELECT 1 FROM information_schema.COLUMNS WHERE TABLE_SCHEMA = DATABASE() AND TABLE_NAME = 'workOrderMaterials' AND COLUMN_NAME = 'lineCost'),
  'SELECT 1',
  'ALTER TABLE `workOrderMaterials` ADD COLUMN `lineCost` DECIMAL(15,2) NULL'
);
PREPARE add_material_line_cost FROM @add_material_line_cost;
EXECUTE add_material_line_cost;
DEALLOCATE PREPARE add_material_line_cost;
--> statement-breakpoint
-- Pre-cutover consumed quantities are whole units, so their historical cost is exact.
UPDATE `workOrderMaterials` SET `lineCost` = ROUND(`baseQuantity` * `unitCost`, 2) WHERE `lineCost` IS NULL;
