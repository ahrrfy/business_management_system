-- Additive payer-source evidence only; never infer payment or rewrite historical cash.
ALTER TABLE `purchaseOrders` ADD COLUMN `shippingFundingSource` enum('ACCRUAL','DRAWER') NOT NULL DEFAULT 'ACCRUAL';
--> statement-breakpoint
ALTER TABLE `purchaseOrders` ADD COLUMN `shippingFundingShiftId` bigint;
--> statement-breakpoint
ALTER TABLE `purchaseOrders` ADD CONSTRAINT `purchaseOrders_shippingFundingShiftId_shifts_id_fk` FOREIGN KEY (`shippingFundingShiftId`) REFERENCES `shifts`(`id`) ON DELETE RESTRICT;
--> statement-breakpoint
ALTER TABLE `purchaseOrderRevisions` ADD COLUMN `shippingFundingSource` enum('ACCRUAL','DRAWER') NOT NULL DEFAULT 'ACCRUAL';
--> statement-breakpoint
ALTER TABLE `purchaseOrderRevisions` ADD COLUMN `shippingFundingShiftId` bigint;
--> statement-breakpoint
ALTER TABLE `purchaseOrderRevisions` ADD CONSTRAINT `purchaseOrderRevisions_shippingFundingShiftId_shifts_id_fk` FOREIGN KEY (`shippingFundingShiftId`) REFERENCES `shifts`(`id`) ON DELETE RESTRICT;
