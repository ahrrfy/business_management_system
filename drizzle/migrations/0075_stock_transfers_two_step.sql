-- 0075: تحويلات المخزون بخطوتين (١٤/٧): سند تحويل «بالطريق» — الإرسال يخصم من المصدر فوراً
-- (TRANSFER_OUT) والبضاعة لا تُحتسب في رصيد أي فرع حتى الاستلام؛ الفرع الوجهة يستلم بمطابقة
-- كمّيات فعلية (TRANSFER_IN بالمستلَم فقط) والعجز يبقى موثَّقاً على السند سطراً بسطر.
-- idempotent (CREATE TABLE IF NOT EXISTS — نمط 0071-0074). هجرة يدوية: snapshot مجمَّد عند 0019.

CREATE TABLE IF NOT EXISTS `stockTransfers` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`transferNumber` varchar(24) NOT NULL,
	`fromBranchId` bigint NOT NULL,
	`toBranchId` bigint NOT NULL,
	`transferStatus` enum('IN_TRANSIT','RECEIVED','CANCELLED') NOT NULL DEFAULT 'IN_TRANSIT',
	`reason` varchar(24),
	`notes` text,
	`totalSentBase` int NOT NULL DEFAULT 0,
	`totalReceivedBase` int,
	`createdBy` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`receivedBy` int,
	`receivedAt` timestamp NULL,
	`receiveNotes` text,
	`cancelledBy` int,
	`cancelledAt` timestamp NULL,
	CONSTRAINT `stockTransfers_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_transfer_number` UNIQUE(`transferNumber`),
	CONSTRAINT `stockTransfers_fromBranchId_branches_id_fk` FOREIGN KEY (`fromBranchId`) REFERENCES `branches`(`id`),
	CONSTRAINT `stockTransfers_toBranchId_branches_id_fk` FOREIGN KEY (`toBranchId`) REFERENCES `branches`(`id`),
	CONSTRAINT `stockTransfers_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`),
	CONSTRAINT `stockTransfers_receivedBy_users_id_fk` FOREIGN KEY (`receivedBy`) REFERENCES `users`(`id`),
	CONSTRAINT `stockTransfers_cancelledBy_users_id_fk` FOREIGN KEY (`cancelledBy`) REFERENCES `users`(`id`),
	INDEX `idx_transfer_from_status` (`fromBranchId`,`transferStatus`),
	INDEX `idx_transfer_to_status` (`toBranchId`,`transferStatus`),
	INDEX `idx_transfer_date` (`createdAt`)
);
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS `stockTransferLines` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`transferId` bigint NOT NULL,
	`variantId` bigint NOT NULL,
	`quantitySent` int NOT NULL,
	`quantityReceived` int,
	`note` varchar(255),
	CONSTRAINT `stockTransferLines_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_tline_transfer_variant` UNIQUE(`transferId`,`variantId`),
	CONSTRAINT `stockTransferLines_transferId_stockTransfers_id_fk` FOREIGN KEY (`transferId`) REFERENCES `stockTransfers`(`id`) ON DELETE CASCADE,
	CONSTRAINT `stockTransferLines_variantId_productVariants_id_fk` FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`),
	INDEX `idx_tline_transfer` (`transferId`),
	INDEX `idx_tline_variant` (`variantId`)
);
