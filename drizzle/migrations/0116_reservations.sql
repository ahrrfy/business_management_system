-- الحجوزات (Reservations) — R-م٣ (٢٧/٧/٢٦): النواة. حجز ناعم (soft/ATP): لا يمسّ branchStock إطلاقاً.
--   reservations: رأس الحجز (عميل/فرع/قناة/انتهاء/حالة FSM: ACTIVE→…→FULFILLED|EXPIRED|CANCELLED|RELEASED) — بلا حذف.
--   reservationLines: بنود بوحدة الأساس + fulfilledBase للتنفيذ الجزئي.
--   reservationEvents: سجلّ أحداث تسلسليّ (تدقيق كامل بلا حذف).
--   reservationStock: المحجوز المجمّع لكل (صنف×فرع) — ATP = branchStock.quantity − reservedBase (نمط branchStock).
-- + receipts.reservationId (نمط workOrderId، بلا FK): ربط إيصال العربون قبل وجود فاتورة.
-- الوثيقة الحاكمة: docs/gifts-reservations-design-2026-07-27.md.
CREATE TABLE `reservations` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`reservationNumber` varchar(40) NOT NULL,
	`branchId` bigint NOT NULL,
	`customerId` bigint,
	`contactName` varchar(200),
	`contactPhone` varchar(32) NOT NULL,
	`reservationChannel` enum('PHONE','WALK_IN','WHATSAPP','STORE') NOT NULL DEFAULT 'PHONE',
	`reservationStatus` enum('ACTIVE','PARTIALLY_FULFILLED','FULFILLED','EXPIRED','CANCELLED','RELEASED') NOT NULL DEFAULT 'ACTIVE',
	`expiresAt` timestamp NOT NULL,
	`depositReceiptId` bigint,
	`fulfilledInvoiceId` bigint,
	`notes` text,
	`createdBy` int,
	`releasedBy` int,
	`cancelReason` varchar(300),
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `reservations_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_reservation_number` UNIQUE(`reservationNumber`)
);
--> statement-breakpoint
CREATE TABLE `reservationLines` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`reservationId` bigint NOT NULL,
	`variantId` bigint NOT NULL,
	`productUnitId` bigint NOT NULL,
	`baseQuantity` int NOT NULL,
	`fulfilledBase` int NOT NULL DEFAULT 0,
	`quotedUnitPrice` decimal(15,2),
	CONSTRAINT `reservationLines_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `reservationEvents` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`reservationId` bigint NOT NULL,
	`reservationEventType` enum('CREATE','EXTEND','PARTIAL_FULFILL','FULFILL','CANCEL','EXPIRE','RELEASE','DEPOSIT','REFUND','SYSTEM') NOT NULL,
	`fromStatus` varchar(24),
	`toStatus` varchar(24),
	`note` text,
	`userId` int,
	`createdAt` timestamp NOT NULL DEFAULT (now()),
	CONSTRAINT `reservationEvents_id` PRIMARY KEY(`id`)
);
--> statement-breakpoint
CREATE TABLE `reservationStock` (
	`id` bigint AUTO_INCREMENT NOT NULL,
	`variantId` bigint NOT NULL,
	`branchId` bigint NOT NULL,
	`reservedBase` int NOT NULL DEFAULT 0,
	`updatedAt` timestamp NOT NULL DEFAULT (now()) ON UPDATE CURRENT_TIMESTAMP,
	CONSTRAINT `reservationStock_id` PRIMARY KEY(`id`),
	CONSTRAINT `uq_reservation_stock_variant_branch` UNIQUE(`variantId`,`branchId`)
);
--> statement-breakpoint
ALTER TABLE `receipts` ADD `reservationId` bigint;--> statement-breakpoint
ALTER TABLE `reservations` ADD CONSTRAINT `reservations_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reservations` ADD CONSTRAINT `reservations_customerId_customers_id_fk` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reservations` ADD CONSTRAINT `reservations_fulfilledInvoiceId_invoices_id_fk` FOREIGN KEY (`fulfilledInvoiceId`) REFERENCES `invoices`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reservations` ADD CONSTRAINT `reservations_createdBy_users_id_fk` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reservations` ADD CONSTRAINT `reservations_releasedBy_users_id_fk` FOREIGN KEY (`releasedBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reservationLines` ADD CONSTRAINT `reservationLines_reservationId_reservations_id_fk` FOREIGN KEY (`reservationId`) REFERENCES `reservations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reservationLines` ADD CONSTRAINT `reservationLines_variantId_productVariants_id_fk` FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reservationLines` ADD CONSTRAINT `reservationLines_productUnitId_productUnits_id_fk` FOREIGN KEY (`productUnitId`) REFERENCES `productUnits`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reservationEvents` ADD CONSTRAINT `reservationEvents_reservationId_reservations_id_fk` FOREIGN KEY (`reservationId`) REFERENCES `reservations`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reservationEvents` ADD CONSTRAINT `reservationEvents_userId_users_id_fk` FOREIGN KEY (`userId`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reservationStock` ADD CONSTRAINT `reservationStock_variantId_productVariants_id_fk` FOREIGN KEY (`variantId`) REFERENCES `productVariants`(`id`) ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `reservationStock` ADD CONSTRAINT `reservationStock_branchId_branches_id_fk` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_reservation_branch_status` ON `reservations` (`branchId`,`reservationStatus`);--> statement-breakpoint
CREATE INDEX `idx_reservation_customer` ON `reservations` (`customerId`);--> statement-breakpoint
CREATE INDEX `idx_reservation_phone` ON `reservations` (`contactPhone`);--> statement-breakpoint
CREATE INDEX `idx_reservation_expires` ON `reservations` (`reservationStatus`,`expiresAt`);--> statement-breakpoint
CREATE INDEX `idx_reservation_line_res` ON `reservationLines` (`reservationId`);--> statement-breakpoint
CREATE INDEX `idx_reservation_line_variant` ON `reservationLines` (`variantId`);--> statement-breakpoint
CREATE INDEX `idx_reservation_events_res` ON `reservationEvents` (`reservationId`,`createdAt`);--> statement-breakpoint
CREATE INDEX `idx_reservation_stock_branch` ON `reservationStock` (`branchId`);--> statement-breakpoint
CREATE INDEX `idx_receipt_reservation` ON `receipts` (`reservationId`);