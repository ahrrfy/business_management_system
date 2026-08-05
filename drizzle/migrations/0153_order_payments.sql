-- ش٤ (٥/٨/٢٦) — سجلّ المال السابق للفاتورة (العرابين على مسوّدات الاستقبال).
-- الوثيقة الحاكمة: docs/reception-cashier-system-design-2026-08-05.md §٥.٣.
-- جدول واحد بثلاثة أنواع صفوف: COLLECTION / APPLICATION / REFUND؛ amount موجب دائماً
-- والاتجاه من kind؛ receiptId UNIQUE هو الإصلاح البنيوي لعلّة V3 (لا مسح ظنّي للإيصالات).
CREATE TABLE `orderPayments` (
  `id` bigint AUTO_INCREMENT NOT NULL,
  `draftId` bigint NOT NULL,
  `branchId` bigint NOT NULL,
  `customerId` bigint,
  `orderPayKind` enum('COLLECTION','APPLICATION','REFUND') NOT NULL,
  `amount` decimal(15,2) NOT NULL,
  `orderPayMethod` enum('CASH','CARD','TRANSFER','WALLET','TELECOM'),
  `receiptId` bigint,
  `shiftId` bigint,
  `parentPaymentId` bigint,
  `orderPayAppliedKind` enum('INVOICE','WORKORDER'),
  `appliedId` bigint,
  `orderPayStatus` enum('HELD','APPLIED','REFUNDED'),
  `referenceNumber` varchar(64),
  `clientRequestId` varchar(80),
  `createdBy` int NOT NULL,
  `createdAt` timestamp NOT NULL DEFAULT (now()),
  CONSTRAINT `orderPayments_id` PRIMARY KEY(`id`),
  CONSTRAINT `uq_orderpay_receipt` UNIQUE(`receiptId`),
  CONSTRAINT `uq_orderpay_request` UNIQUE(`clientRequestId`)
);--> statement-breakpoint
ALTER TABLE `orderPayments` ADD CONSTRAINT `fk_orderpay_draft` FOREIGN KEY (`draftId`) REFERENCES `receptionDrafts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `orderPayments` ADD CONSTRAINT `fk_orderpay_branch` FOREIGN KEY (`branchId`) REFERENCES `branches`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `orderPayments` ADD CONSTRAINT `fk_orderpay_customer` FOREIGN KEY (`customerId`) REFERENCES `customers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `orderPayments` ADD CONSTRAINT `fk_orderpay_receipt` FOREIGN KEY (`receiptId`) REFERENCES `receipts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `orderPayments` ADD CONSTRAINT `fk_orderpay_shift` FOREIGN KEY (`shiftId`) REFERENCES `shifts`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `orderPayments` ADD CONSTRAINT `fk_orderpay_parent` FOREIGN KEY (`parentPaymentId`) REFERENCES `orderPayments`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE `orderPayments` ADD CONSTRAINT `fk_orderpay_creator` FOREIGN KEY (`createdBy`) REFERENCES `users`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_orderpay_draft` ON `orderPayments` (`draftId`,`orderPayKind`,`orderPayStatus`);--> statement-breakpoint
CREATE INDEX `idx_orderpay_applied` ON `orderPayments` (`orderPayAppliedKind`,`appliedId`);--> statement-breakpoint
CREATE INDEX `idx_orderpay_parent` ON `orderPayments` (`parentPaymentId`);
