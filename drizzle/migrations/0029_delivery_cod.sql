-- 0029 (٢٦/٦/٢٦): التوصيل (COD) — جهات التوصيل والعهد والترحيل.
-- وحدة محاسبة المندوب/شركة التوصيل: الإرسالية تُسجَّل عهدةً على الجهة (DELIVERY_DISPATCH)، والترحيل
-- يخصم الأجرة ويورّد الصافي (DELIVERY_REMIT + DELIVERY_FEE)، والعجز يبقى عهدة (D4). المخطّط: drizzle/schema.ts.
-- مرجع النمط: 0022 (MODIFY enum + CREATE TABLE + FK + INDEX + CHECK يدوي بفواصل عبارات).
-- تنبيه: كل عبارة مفصولة بفاصل عبارات drizzle (إغفاله يُفشل db:migrate:safe على الإنتاج بلا ظهور محلي).

-- ── ١) accountingEntries.entryType: توسعة بأربع قيم لعهدة التوصيل (إلحاق بالنهاية، يحفظ ترتيب القديم) ──
ALTER TABLE `accountingEntries` MODIFY COLUMN `entryType` enum('SALE','PURCHASE','PAYMENT_IN','PAYMENT_OUT','RETURN','ADJUST','OPENING','INTERNAL_USE','WASTAGE','CASH_HANDOVER','CASH_TRANSFER_OUT','CASH_TRANSFER_IN','DELIVERY_DISPATCH','DELIVERY_REMIT','DELIVERY_FEE','DELIVERY_WRITEOFF') NOT NULL;--> statement-breakpoint

-- ── ٢) accountingEntries.deliveryPartyId: طرف العهدة لقيود DELIVERY_* (نظير customerId/supplierId) ──
ALTER TABLE `accountingEntries` ADD `deliveryPartyId` bigint;--> statement-breakpoint
CREATE INDEX `idx_entry_delivery_party` ON `accountingEntries` (`deliveryPartyId`);--> statement-breakpoint

-- ── ٣) جدول deliveryParties (جهة توصيل: مندوب فرد/شركة) ──
CREATE TABLE `deliveryParties` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`deliveryPartyKind` enum('INDIVIDUAL','COMPANY') NOT NULL DEFAULT 'INDIVIDUAL',
	`name` varchar(255) NOT NULL,
	`phone` varchar(20),
	`phone2` varchar(20),
	`branchId` bigint,
	`nationalId` varchar(40),
	`vehicleInfo` varchar(120),
	`defaultFee` decimal(15,2) NOT NULL DEFAULT '0',
	`currentBalance` decimal(15,2) NOT NULL DEFAULT '0',
	`floatLimit` decimal(15,2),
	`notes` text,
	`isActive` boolean NOT NULL DEFAULT true,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `deliveryParties_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
ALTER TABLE `deliveryParties` ADD CONSTRAINT `deliveryParties_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_delivery_party_name` ON `deliveryParties` (`name`);--> statement-breakpoint
CREATE INDEX `idx_delivery_party_branch` ON `deliveryParties` (`branchId`);--> statement-breakpoint
CREATE INDEX `idx_delivery_party_active` ON `deliveryParties` (`isActive`);--> statement-breakpoint

-- ── ٤) جدول deliveryRemittances (دفعة ترحيل: خصم الأجرة وتوريد الصافي) ──
CREATE TABLE `deliveryRemittances` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`remittanceNumber` varchar(50) NOT NULL,
	`branchId` bigint NOT NULL,
	`partyId` bigint NOT NULL,
	`shiftId` bigint,
	`collectedTotal` decimal(15,2) NOT NULL,
	`feesTotal` decimal(15,2) NOT NULL DEFAULT '0',
	`netRemitted` decimal(15,2) NOT NULL,
	`shortfallTotal` decimal(15,2) NOT NULL DEFAULT '0',
	`receiptInId` bigint,
	`receiptOutId` bigint,
	`deliveryRemittanceStatus` enum('BALANCED','SHORT','OVER') NOT NULL,
	`receivedBy` int,
	`receivedAt` timestamp NOT NULL DEFAULT (now()),
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `deliveryRemittances_id` PRIMARY KEY(`id`),
	CONSTRAINT `deliveryRemittances_remittanceNumber_unique` UNIQUE(`remittanceNumber`)
);
--> statement-breakpoint
ALTER TABLE `deliveryRemittances` ADD CONSTRAINT `deliveryRemittances_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deliveryRemittances` ADD CONSTRAINT `deliveryRemittances_partyId_deliveryParties_id_fk` FOREIGN KEY (`partyId`) REFERENCES `deliveryParties`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deliveryRemittances` ADD CONSTRAINT `deliveryRemittances_shiftId_shifts_id_fk` FOREIGN KEY (`shiftId`) REFERENCES `shifts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deliveryRemittances` ADD CONSTRAINT `deliveryRemittances_receiptInId_receipts_id_fk` FOREIGN KEY (`receiptInId`) REFERENCES `receipts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deliveryRemittances` ADD CONSTRAINT `deliveryRemittances_receiptOutId_receipts_id_fk` FOREIGN KEY (`receiptOutId`) REFERENCES `receipts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deliveryRemittances` ADD CONSTRAINT `deliveryRemittances_receivedBy_users_id_fk` FOREIGN KEY (`receivedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_delivery_remit_number` ON `deliveryRemittances` (`remittanceNumber`);--> statement-breakpoint
CREATE INDEX `idx_delivery_remit_party` ON `deliveryRemittances` (`partyId`);--> statement-breakpoint
CREATE INDEX `idx_delivery_remit_branch` ON `deliveryRemittances` (`branchId`);--> statement-breakpoint
CREATE INDEX `idx_delivery_remit_shift` ON `deliveryRemittances` (`shiftId`);--> statement-breakpoint

-- ── ٥) جدول deliveryConsignments (إرسالية: طرد COD يربط الفاتورة↔الجهة↔الترحيل) ──
CREATE TABLE `deliveryConsignments` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`consignmentNumber` varchar(50) NOT NULL,
	`branchId` bigint NOT NULL,
	`partyId` bigint NOT NULL,
	`invoiceId` bigint NOT NULL,
	`workOrderId` bigint,
	`endCustomerId` bigint,
	`codAmount` decimal(15,2) NOT NULL,
	`collectedAmount` decimal(15,2) NOT NULL DEFAULT '0',
	`deliveryFee` decimal(15,2) NOT NULL DEFAULT '0',
	`recipientName` varchar(255),
	`recipientPhone` varchar(20),
	`deliveryAddress` text,
	`consignmentStatus` enum('DISPATCHED','DELIVERED','PARTIAL','RETURNED','WRITTEN_OFF') NOT NULL DEFAULT 'DISPATCHED',
	`remittanceId` bigint,
	`dispatchedBy` int,
	`dispatchedAt` timestamp NOT NULL DEFAULT (now()),
	`settledAt` timestamp,
	`notes` text,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `deliveryConsignments_id` PRIMARY KEY(`id`),
	CONSTRAINT `deliveryConsignments_consignmentNumber_unique` UNIQUE(`consignmentNumber`),
	CONSTRAINT `uq_consignment_invoice` UNIQUE(`invoiceId`)
);
--> statement-breakpoint
ALTER TABLE `deliveryConsignments` ADD CONSTRAINT `deliveryConsignments_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deliveryConsignments` ADD CONSTRAINT `deliveryConsignments_partyId_deliveryParties_id_fk` FOREIGN KEY (`partyId`) REFERENCES `deliveryParties`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deliveryConsignments` ADD CONSTRAINT `deliveryConsignments_invoiceId_invoices_id_fk` FOREIGN KEY (`invoiceId`) REFERENCES `invoices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deliveryConsignments` ADD CONSTRAINT `deliveryConsignments_endCustomerId_customers_id_fk` FOREIGN KEY (`endCustomerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deliveryConsignments` ADD CONSTRAINT `deliveryConsignments_remittanceId_deliveryRemittances_id_fk` FOREIGN KEY (`remittanceId`) REFERENCES `deliveryRemittances`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `deliveryConsignments` ADD CONSTRAINT `deliveryConsignments_dispatchedBy_users_id_fk` FOREIGN KEY (`dispatchedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_consignment_number` ON `deliveryConsignments` (`consignmentNumber`);--> statement-breakpoint
CREATE INDEX `idx_consignment_party_status` ON `deliveryConsignments` (`partyId`,`consignmentStatus`);--> statement-breakpoint
CREATE INDEX `idx_consignment_branch` ON `deliveryConsignments` (`branchId`);--> statement-breakpoint
CREATE INDEX `idx_consignment_remittance` ON `deliveryConsignments` (`remittanceId`);--> statement-breakpoint

-- ── ٦) FK لـaccountingEntries.deliveryPartyId (بعد إنشاء deliveryParties) ──
ALTER TABLE `accountingEntries` ADD CONSTRAINT `accountingEntries_deliveryPartyId_deliveryParties_id_fk` FOREIGN KEY (`deliveryPartyId`) REFERENCES `deliveryParties`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint

-- ── ٧) CHECKs يدوية: لا مبالغ سالبة (سابقة 0018) ──
ALTER TABLE `deliveryConsignments` ADD CONSTRAINT `chk_consignment_cod_nonneg` CHECK (`codAmount` >= 0);--> statement-breakpoint
ALTER TABLE `deliveryConsignments` ADD CONSTRAINT `chk_consignment_collected_nonneg` CHECK (`collectedAmount` >= 0);--> statement-breakpoint
ALTER TABLE `deliveryConsignments` ADD CONSTRAINT `chk_consignment_fee_nonneg` CHECK (`deliveryFee` >= 0);--> statement-breakpoint
ALTER TABLE `deliveryRemittances` ADD CONSTRAINT `chk_remit_collected_nonneg` CHECK (`collectedTotal` >= 0);--> statement-breakpoint
ALTER TABLE `deliveryParties` ADD CONSTRAINT `chk_delivery_party_fee_nonneg` CHECK (`defaultFee` >= 0);
