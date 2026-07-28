-- منظومة الهدايا/المجانيات (٢٧/٧/٢٦) — جدولان جديدان + توسعة enum الدفتر بـ GIFT_OUT (شريحتا G-م١ الوارد/G-م٢ الصادر).
-- الوارد (IN): بضاعة مجّانية من مورّد ⇒ صفر تكلفة تُخفِّف WAVG (existingQty×oldCost/(existingQty+freeQty))، بلا قيد PURCHASE ولا دين للمورّد.
-- الصادر (OUT): هدية للعميل ⇒ قيد GIFT_OUT (revenue=0, profit=-cost, بلا invoiceId ⇒ خارج العمولة تلقائياً) + حوكمة SOD (اعتماد مدير آخر فوق العتبة).
SET NAMES utf8mb4;
--> statement-breakpoint
CREATE TABLE `giftVouchers` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`giftNumber` varchar(32) NOT NULL,
	`direction` enum('OUT','IN') NOT NULL,
	`branchId` bigint NOT NULL,
	`customerId` bigint,
	`supplierId` bigint,
	`giftType` varchar(32),
	`reason` varchar(255),
	`sellable` boolean NOT NULL DEFAULT true,
	`supplierRef` varchar(64),
	`estimatedValue` decimal(15,2),
	`status` enum('DRAFT','PENDING_APPROVAL','APPROVED','DELIVERED','CANCELLED','REVERSED') NOT NULL DEFAULT 'DRAFT',
	`totalCost` decimal(15,2) NOT NULL DEFAULT '0',
	`notes` varchar(500),
	`signatureHash` varchar(128),
	`createdBy` int NOT NULL,
	`approvedBy` int,
	`approvedAt` timestamp NULL,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `giftVouchers_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_gift_number` UNIQUE(`giftNumber`),
	CONSTRAINT `giftVouchers_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`),
	CONSTRAINT `giftVouchers_customerId_customers_id_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`),
	CONSTRAINT `giftVouchers_supplierId_suppliers_id_fk` FOREIGN KEY (`supplierId`) REFERENCES `suppliers`(`id`),
	CONSTRAINT `giftVouchers_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`),
	CONSTRAINT `giftVouchers_approvedBy_users_id_fk` FOREIGN KEY (`approvedBy`) REFERENCES `users`(`id`)
);
--> statement-breakpoint
CREATE TABLE `giftVoucherLines` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`giftVoucherId` bigint NOT NULL,
	`variantId` bigint NOT NULL,
	`productUnitId` bigint NOT NULL,
	`quantity` decimal(15,4) NOT NULL,
	`baseQuantity` int NOT NULL,
	`unitCostSnapshot` decimal(15,2) NOT NULL DEFAULT '0',
	`lineCost` decimal(15,2) NOT NULL DEFAULT '0',
	`refSalePrice` decimal(15,2),
	CONSTRAINT `giftVoucherLines_id` PRIMARY KEY(`id`),
	CONSTRAINT `giftVoucherLines_giftVoucherId_giftVouchers_id_fk` FOREIGN KEY (`giftVoucherId`) REFERENCES `giftVouchers`(`id`),
	CONSTRAINT `giftVoucherLines_variantId_productVariants_id_fk` FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`),
	CONSTRAINT `giftVoucherLines_productUnitId_productUnits_id_fk` FOREIGN KEY (`productUnitId`) REFERENCES `productUnits`(`id`)
);
--> statement-breakpoint
CREATE INDEX `idx_gift_dir_branch_status` ON `giftVouchers` (`direction`,`branchId`,`status`);
--> statement-breakpoint
CREATE INDEX `idx_gift_customer` ON `giftVouchers` (`customerId`);
--> statement-breakpoint
CREATE INDEX `idx_gift_supplier` ON `giftVouchers` (`supplierId`);
--> statement-breakpoint
CREATE INDEX `idx_gift_created` ON `giftVouchers` (`createdAt`);
--> statement-breakpoint
CREATE INDEX `idx_giftline_voucher` ON `giftVoucherLines` (`giftVoucherId`);
--> statement-breakpoint
CREATE INDEX `idx_giftline_variant` ON `giftVoucherLines` (`variantId`);
--> statement-breakpoint
ALTER TABLE `accountingEntries` MODIFY COLUMN `entryType` enum('SALE','PURCHASE','PAYMENT_IN','PAYMENT_OUT','RETURN','ADJUST','OPENING','INTERNAL_USE','WASTAGE','CASH_HANDOVER','CASH_TRANSFER_OUT','CASH_TRANSFER_IN','DELIVERY_DISPATCH','DELIVERY_REMIT','DELIVERY_FEE','DELIVERY_WRITEOFF','EXCHANGE_DEPOSIT','EXCHANGE_WITHDRAW','EXCHANGE_FX_BUY','EXCHANGE_SETTLE','EXCHANGE_FEE','EXCHANGE_FX_DIFF','GIFT_OUT') NOT NULL;
