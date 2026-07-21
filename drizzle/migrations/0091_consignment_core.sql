-- بضاعة الأمانة (برسم البيع) — ش١ الأساس. راجع docs/consignment-design-2026-07-20.md.
-- المودِع = مورّد من نوع CONSIGNOR (لا دين عند الاستلام، المستحق ينشأ لحظة البيع فقط) يرث كل بنى
-- المورّد بصفر تعديل. المنتج يُوسَم isConsignment + consignorId؛ الحصة تسكن productVariants.costPrice.
-- كل الأعمدة NULL/DEFAULT آمنة على البيانات القائمة (REGULAR/false افتراضاً).
ALTER TABLE `suppliers` ADD `supplierKind` enum('REGULAR','CONSIGNOR') NOT NULL DEFAULT 'REGULAR';--> statement-breakpoint
ALTER TABLE `suppliers` ADD `settlementCycle` varchar(20) DEFAULT 'MONTHLY';--> statement-breakpoint
ALTER TABLE `suppliers` ADD `abandonedAfterMonths` int DEFAULT 12;--> statement-breakpoint
ALTER TABLE `suppliers` ADD `autoSettleThreshold` decimal(15,2);--> statement-breakpoint
ALTER TABLE `suppliers` ADD `agreementNotes` text;--> statement-breakpoint
ALTER TABLE `suppliers` ADD `agreementAttachmentUrl` mediumtext;--> statement-breakpoint
CREATE INDEX `idx_supplier_kind` ON `suppliers` (`supplierKind`,`isActive`);--> statement-breakpoint
ALTER TABLE `products` ADD `isConsignment` boolean NOT NULL DEFAULT false;--> statement-breakpoint
ALTER TABLE `products` ADD `consignorId` bigint;--> statement-breakpoint
ALTER TABLE `products` ADD CONSTRAINT `products_consignorId_suppliers_id_fk` FOREIGN KEY (`consignorId`) REFERENCES `suppliers`(`id`) ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE INDEX `idx_product_consignor` ON `products` (`consignorId`);
